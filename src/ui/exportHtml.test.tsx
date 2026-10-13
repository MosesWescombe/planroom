import { afterEach, describe, expect, it, vi } from 'vitest';
import { blockRecord, sectionRecord } from '../test/fixtures';
import { makeView, renderWith, storeWith } from '../test/harness';
import { BlockView } from './blocks/Block';
import { type BlobLoader, buildHtml } from './exportHtml';
import { themes } from './theme';

afterEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    document.documentElement.removeAttribute('style');
    document.documentElement.removeAttribute('data-width');
    document.title = '';
});

const noImages: BlobLoader = async () => new Blob();

/** Exports `body`'s `#main` and parses the file back. */
async function exported(body: string, preference: 'light' | 'dark' | 'system' = 'light') {
    document.body.innerHTML = body;
    const html = await buildHtml(document.getElementById('main')!, document, noImages, preference);
    return new DOMParser().parseFromString(html, 'text/html');
}

describe('Export HTML', () => {
    it('saves the column standalone: print rules applied, form state kept, images inlined, title escaped', async () => {
        document.head.innerHTML = '<style>.doc { color: red; } @media print { .block-tools { display: none; } }</style>';
        document.title = 'add-x · <Planroom>';
        document.documentElement.style.setProperty('--paper', '#F6F4EE');
        document.body.innerHTML =
            '<div class="rail">Contents</div><main id="main"><input type="checkbox"><img src="api/assets/a.png" alt="A"></main>';
        const main = document.getElementById('main')!;
        main.querySelector('input')!.checked = true;
        const requested: string[] = [];
        const load: BlobLoader = async (url) => {
            requested.push(url);
            return new Blob(['png'], { type: 'image/png' });
        };

        const html = await buildHtml(main, document, load, 'light');
        const out = new DOMParser().parseFromString(html, 'text/html');

        expect(html.startsWith('<!doctype html>')).toBe(true);
        expect(out.title).toBe('add-x · <Planroom>');
        expect(out.documentElement.style.getPropertyValue('--paper')).toBe('#F6F4EE');
        const css = out.querySelector('style')!.textContent;
        expect(css).toContain('.doc { color: red; }');
        expect(css).toContain('.block-tools { display: none; }');
        expect(css).not.toContain('@media print');
        expect(out.querySelector('.rail')).toBeNull();
        expect(out.querySelector('#main input')!.hasAttribute('checked')).toBe(true);
        expect(requested).toEqual([new URL('api/assets/a.png', document.baseURI).href]);
        expect(out.querySelector('#main img')!.getAttribute('src')).toBe('data:image/png;base64,cG5n');
        // Exporting leaves the page itself alone.
        expect(main.querySelector('img')!.getAttribute('src')).toBe('api/assets/a.png');
    });

    it('keeps the page width setting', async () => {
        document.documentElement.dataset.width = 'wide';
        const out = await exported('<main id="main"></main>');

        expect(out.documentElement.dataset.width).toBe('wide');
        expect(out.querySelector('style')!.textContent).toContain('#main { max-width: var(--page-width);');
    });

    it('draws a chosen theme as on screen, and under "System" follows the reader', async () => {
        document.documentElement.style.setProperty('--paper', themes.dark.paper);
        document.title = 'plan';

        const dark = await exported('<main id="main"></main>', 'dark');
        expect(dark.documentElement.style.getPropertyValue('--paper')).toBe(themes.dark.paper);
        expect(dark.querySelector('style')!.textContent).not.toContain('prefers-color-scheme');

        const system = await exported('<main id="main"></main>', 'system');
        expect(system.documentElement.style.getPropertyValue('--paper')).toBe('');
        expect(system.documentElement.style.getPropertyValue('--print-title')).toBe('"plan"');
        const css = system.querySelector('style')!.textContent;
        expect(css).toContain(`--paper: ${themes.light.paper}`);
        expect(css).toMatch(
            new RegExp(`@media screen and \\(prefers-color-scheme: dark\\) \\{ :root \\{ [^}]*--paper: ${themes.dark.paper}`)
        );
    });

    it('keeps the full-screen button of images and diagrams, which moves the picture into a zooming dialog', async () => {
        const flow = {
            id: 'f1',
            type: 'flow',
            config: {
                nodes: [
                    { id: 'a', label: 'Request' },
                    { id: 'b', label: 'Limiter' }
                ],
                edges: [{ from: 'a', to: 'b' }]
            },
            caption: 'Flow',
            refs: ['Q-1']
        };
        const text = { id: 't1', type: 'text', config: { body: 'Text' } };
        const store = storeWith(
            makeView({
                blocks: [blockRecord(flow.id, flow.type, flow.config), blockRecord(text.id, text.type, text.config)],
                sections: [sectionRecord('s1', 1, [flow.id, text.id])]
            })
        );
        const { container } = renderWith(
            store,
            <main id="main">
                <BlockView block={flow} placement="writeup" />
                <BlockView block={text} placement="writeup" />
            </main>,
            'writeup'
        );
        const main = container.querySelector('main');
        if (!main) throw new Error('No #main');
        const html = await buildHtml(main, document, noImages, 'light');
        const out = new DOMParser().parseFromString(html, 'text/html');
        const [picture, plain] = out.querySelectorAll('.block');
        expect([...picture!.querySelectorAll('.block-tools button')].map((button) => button.ariaLabel)).toEqual(['Full screen']);
        expect(plain!.querySelector('.block-tools')).toBeNull();
        expect(out.querySelector('style')!.textContent).toContain('@media screen { .block-tools { display: flex !important; } }');

        // Run the file's script as the file would, against its own markup. jsdom has no dialogs.
        HTMLDialogElement.prototype.showModal = function showModal() {
            this.open = true;
        };
        HTMLDialogElement.prototype.close = function close() {
            this.open = false;
            this.dispatchEvent(new Event('close'));
        };
        const listen = vi.spyOn(document, 'addEventListener');
        try {
            document.body.innerHTML = out.body.innerHTML;
            new Function(out.querySelector('script')!.textContent)();
            document.querySelector<HTMLButtonElement>('[aria-label="Full screen"]')!.click();

            const dialog = document.querySelector('dialog')!;
            expect(dialog.open).toBe(true);
            // Named as the page names it, the caption without its question refs.
            expect(dialog.getAttribute('aria-label')).toBe('Flow');
            // Moved, not copied, so the diagram's ids stay single.
            expect(dialog.querySelector('.zoom-content .block-body svg')).not.toBeNull();
            expect(document.querySelectorAll('.block-body')).toHaveLength(2);
            const level = dialog.querySelector('.zoom-level')!;
            expect(level.textContent).toBe('100%');
            dialog.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click();
            expect(level.textContent).toBe('125%');
            dialog.querySelector('.zoom-viewport')!.dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true }));
            expect(level.textContent).toBe('100%');

            dialog.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click();
            expect(document.querySelector('dialog')).toBeNull();
            expect(document.querySelector('figure[data-zoom-label] > .block-body svg')).not.toBeNull();
        } finally {
            for (const [type, listener] of listen.mock.calls) document.removeEventListener(type, listener);
            listen.mockRestore();
            Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
            Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
        }
    });
});
