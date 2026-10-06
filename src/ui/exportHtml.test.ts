import { afterEach, describe, expect, it } from 'vitest';
import { type BlobLoader, buildHtml } from './exportHtml';

afterEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    document.documentElement.removeAttribute('style');
});

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

        const html = await buildHtml(main, document, load);
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
});
