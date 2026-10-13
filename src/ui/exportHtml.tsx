/**
 * Export HTML: the open tab's main column as one standalone file, drawn as on screen at the chosen page width and in
 * the chosen theme, which for "System" follows the reader's. The page's own stylesheets are inlined with their
 * `@media print` rules applied unconditionally, so the file drops the same controls Export PDF does and reads as a
 * document; printing it gives the same pages. Images and diagrams keep their full-screen button, run by a small script
 * in the file. Images are inlined as data URLs.
 * ponytail: the fonts load from Google Fonts as the page's do, so offline the file falls back to system fonts; inline
 * them as data URLs if the file must look identical offline.
 */
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { CloseIcon } from './components/icons';
import {
    FIT_MAX,
    INTERACTIVE,
    MAX_SCALE,
    MIN_SCALE,
    STEP,
    WHEEL_LINE,
    WHEEL_RATE,
    ZOOM_KEYS,
    ZoomView
} from './components/ZoomView';
import { applyTheme, readPreference, type ThemePreference } from './theme';

/** Fetches an image's bytes; injected in tests. */
export type BlobLoader = (url: string) => Promise<Blob>;

const fetchBlob: BlobLoader = async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    return response.blob();
};

/**
 * Lays the column out as a page of its own, at the page width the root's `data-width` picks, where the app's shell and
 * print rules leave it full width and unpadded. On screen the full-screen buttons the print rules drop come back, and
 * the full-screen view is a native dialog styled as the page's.
 */
const STANDALONE = `
body { margin: 0; background: var(--surface); }
#main { max-width: var(--page-width); margin: 0 auto; padding: 56px max(16px, 4vw) 80px; }
@media screen { .block-tools { display: flex !important; } }
dialog.modal { position: fixed; border: none; color: inherit; }
dialog.modal::backdrop { background: var(--scrim); }
`;

/**
 * Both themes' tokens, picked by the reader's colour scheme: the file's theme when the page follows the system. Print
 * keeps the light ones, as Export PDF does.
 */
function systemThemeCss(page: Document): string {
    const tokens = (name: 'light' | 'dark') => {
        const probe = page.createElement('div');
        applyTheme(name, probe);
        return probe.style.cssText;
    };
    return `:root { ${tokens('light')} }\n@media screen and (prefers-color-scheme: dark) { :root { ${tokens('dark')} } }`;
}

/**
 * The CSS of every readable stylesheet, with `@media print` rules unwrapped so they apply on screen too. A sheet that
 * cannot be read, such as the cross-origin Google Fonts one, comes back as a link to it instead.
 */
export function collectStyles(sheets: Iterable<CSSStyleSheet>): { css: string; links: string[] } {
    const css: string[] = [];
    const links: string[] = [];
    for (const sheet of sheets) {
        let rules: CSSRuleList;
        try {
            rules = sheet.cssRules;
        } catch {
            if (sheet.href) links.push(sheet.href);
            continue;
        }
        for (const rule of rules) {
            if (rule instanceof CSSMediaRule && rule.media.mediaText === 'print') {
                for (const inner of rule.cssRules) css.push(inner.cssText);
            } else {
                css.push(rule.cssText);
            }
        }
    }
    return { css: css.join('\n'), links };
}

/** Copies form state React keeps in properties, which cloning drops, onto the copy as attributes. */
function copyFormState(source: Element, copy: Element): void {
    const live = source.querySelectorAll('input, textarea');
    const copied = copy.querySelectorAll('input, textarea');
    live.forEach((field, index) => {
        const target = copied[index];
        if (!target) return;
        if (field instanceof HTMLTextAreaElement) target.textContent = field.value;
        else if (field instanceof HTMLInputElement && (field.type === 'checkbox' || field.type === 'radio'))
            target.toggleAttribute('checked', field.checked);
        else if (field instanceof HTMLInputElement) target.setAttribute('value', field.value);
    });
}

/** Reads a blob as a data URL. */
function dataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}

/** Swaps each image's URL for its bytes, so the file stands alone. An image that fails to load keeps its URL. */
async function inlineImages(copy: Element, load: BlobLoader): Promise<void> {
    await Promise.all(
        [...copy.querySelectorAll('img')].map(async (image) => {
            if (!image.src || image.src.startsWith('data:')) return;
            try {
                image.setAttribute('src', await dataUrl(await load(image.src)));
            } catch {
                // The page shows the same broken image; the export is no worse for it.
            }
        })
    );
}

/**
 * Keeps each `html` block live in the file: the page frames it from the page server, which a file cannot reach, so its
 * document moves into the frame's `srcdoc`, its policy still first in its head and the frame still sandboxed. A block
 * that cannot be read keeps its frame, empty.
 */
async function inlineFrames(copy: Element, load: BlobLoader): Promise<void> {
    await Promise.all(
        [...copy.querySelectorAll<HTMLIFrameElement>('iframe[data-html-block]')].map(async (frame) => {
            const src = frame.getAttribute('src');
            if (!src) return;
            try {
                frame.setAttribute('srcdoc', await (await load(new URL(src, document.baseURI).href)).text());
                frame.removeAttribute('src');
            } catch {
                // The page shows the same empty frame.
            }
        })
    );
}

/** Keeps the full-screen button of each image and diagram, which the file's script opens, and drops every other block tool. */
function keepFullScreen(copy: Element): void {
    for (const tools of copy.querySelectorAll('.block-tools')) {
        const button = tools.parentElement?.hasAttribute('data-zoom-label')
            ? tools.querySelector('[aria-label="Full screen"]')
            : null;
        if (button) tools.replaceChildren(button);
        else tools.remove();
    }
}

/** The dialog `fullScreen` opens, drawn by the page's own close icon and zoom view and kept in the file as a template. */
function fullScreenTemplate(page: Document): HTMLTemplateElement {
    const host = page.createElement('div');
    const root = createRoot(host);
    flushSync(() =>
        root.render(
            <dialog className="modal fullscreen fullscreen-zoom">
                <button type="button" className="icon-button modal-close" aria-label="Close">
                    <CloseIcon />
                </button>
                <ZoomView label="Full screen">{null}</ZoomView>
            </dialog>
        )
    );
    const template = page.createElement('template');
    template.id = 'full-screen';
    template.innerHTML = host.innerHTML;
    root.unmount();
    return template;
}

/** ZoomView's limits and keys, handed to the file's script, which cannot import them. */
const ZOOM = { MIN_SCALE, MAX_SCALE, STEP, FIT_MAX, WHEEL_LINE, WHEEL_RATE, ZOOM_KEYS, INTERACTIVE };

/**
 * The file's full screen, as ZoomView's on the page: a block's picture moved into a dialog, fitted to the screen, and
 * back when it closes, so no id in it is doubled. The wheel,
 * the buttons or + and − zoom, keeping the point under the cursor in place; the level or 0 fits again. Drag, the
 * scrollbars or the arrow keys move it. Escape, Close or the backdrop close it. The file runs it from its source, so it
 * uses nothing outside its own body but `zoom`.
 * ponytail: it repeats ZoomView's measure, fit and zoom logic by hand, sharing only the constants, so a fix to one must
 * be copied to the other; move both onto one framework-free zoom controller if they drift.
 */
export function fullScreen(zoom: typeof ZOOM): void {
    const { MIN_SCALE, MAX_SCALE, STEP, FIT_MAX, WHEEL_LINE, WHEEL_RATE, ZOOM_KEYS, INTERACTIVE } = zoom;
    document.addEventListener('click', (event) => {
        const button = event.target instanceof Element ? event.target.closest('.block-tools button') : null;
        const block = button?.closest('.block');
        const body = block?.querySelector('.block-body');
        if (!block || !body) return;
        const markup = document.querySelector<HTMLTemplateElement>('template#full-screen')?.content.firstElementChild;
        const dialog = markup && document.importNode(markup, true);
        if (!(dialog instanceof HTMLDialogElement)) return;
        const view = dialog.querySelector<HTMLElement>('.zoom-viewport');
        const sizer = dialog.querySelector<HTMLElement>('.zoom-sizer');
        const content = dialog.querySelector<HTMLElement>('.zoom-content');
        const level = dialog.querySelector<HTMLButtonElement>('.zoom-level');
        const zoomOut = dialog.querySelector<HTMLButtonElement>('[aria-label="Zoom out"]');
        const zoomIn = dialog.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]');
        if (!view || !sizer || !content || !level || !zoomOut || !zoomIn) return;
        const label = block.getAttribute('data-zoom-label') || 'Full screen';
        dialog.setAttribute('aria-label', label);
        view.setAttribute('aria-label', label);
        const home = document.createComment('');
        body.replaceWith(home);
        content.append(body);

        let scale = 1;
        let fit = 1;
        let zoomed = false;
        let size = { width: 0, height: 0 };
        const clamp = (next: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
        const show = (next: number) => {
            scale = clamp(next);
            content.style.transform = `scale(${scale})`;
            sizer.style.width = `${size.width * scale}px`;
            sizer.style.height = `${size.height * scale}px`;
            level.textContent = `${Math.round(scale * 100)}%`;
            zoomOut.disabled = scale <= MIN_SCALE;
            zoomIn.disabled = scale >= MAX_SCALE;
        };
        // As ZoomView measures: laid out at the viewport's width, narrowed to the pictures' span, then fitted.
        const measure = () => {
            const room = view.clientWidth;
            content.style.width = `${room}px`;
            const boxes = [...content.querySelectorAll('svg, img')]
                .filter((picture) => !picture.closest('button'))
                .map((picture) => picture.getBoundingClientRect());
            const span = boxes.length
                ? (Math.max(...boxes.map((box) => box.right)) - Math.min(...boxes.map((box) => box.left))) / scale
                : 0;
            const width = span > 0 && span < room ? Math.ceil(span) : room;
            content.style.width = `${width}px`;
            size = { width, height: content.offsetHeight };
            fit = size.height > 0 ? clamp(Math.min(FIT_MAX, room / width, view.clientHeight / size.height)) : 1;
            show(zoomed ? scale : fit);
        };
        // Keeps `at`, a point in the view, still; the middle of the view by default.
        const zoomTo = (next: number, at = { x: view.clientWidth / 2, y: view.clientHeight / 2 }) => {
            const target = clamp(next);
            if (target === scale) return;
            const ratio = target / scale;
            const focus = { x: view.scrollLeft + at.x, y: view.scrollTop + at.y };
            zoomed = true;
            show(target);
            view.scrollLeft = focus.x * ratio - at.x;
            view.scrollTop = focus.y * ratio - at.y;
        };
        const fitToScreen = () => {
            zoomed = false;
            show(fit);
            view.scrollLeft = 0;
            view.scrollTop = 0;
        };
        zoomOut.addEventListener('click', () => zoomTo(scale / STEP));
        zoomIn.addEventListener('click', () => zoomTo(scale * STEP));
        level.addEventListener('click', fitToScreen);
        dialog.querySelector('.modal-close')?.addEventListener('click', () => dialog.close());
        dialog.addEventListener('keydown', (key) => {
            if (key.ctrlKey || key.metaKey || key.altKey) return;
            const step = ZOOM_KEYS[key.key];
            if (step) zoomTo(scale * step);
            else if (key.key === '0') fitToScreen();
            else return;
            key.preventDefault();
        });
        // The wheel zooms; a sideways swipe with no vertical part still scrolls.
        view.addEventListener(
            'wheel',
            (wheel) => {
                if (wheel.deltaY === 0) return;
                wheel.preventDefault();
                const unit =
                    wheel.deltaMode === WheelEvent.DOM_DELTA_LINE
                        ? WHEEL_LINE
                        : wheel.deltaMode === WheelEvent.DOM_DELTA_PAGE
                          ? view.clientHeight
                          : 1;
                const box = view.getBoundingClientRect();
                zoomTo(scale * WHEEL_RATE ** -(wheel.deltaY * unit), { x: wheel.clientX - box.left, y: wheel.clientY - box.top });
            },
            { passive: false }
        );
        // A mouse drags the view; touch keeps the browser's own panning.
        let drag: { x: number; y: number; left: number; top: number } | undefined;
        view.addEventListener('pointerdown', (press) => {
            if (press.pointerType !== 'mouse' || press.button !== 0) return;
            if (press.target instanceof Element && press.target.closest(INTERACTIVE)) return;
            press.preventDefault();
            view.setPointerCapture?.(press.pointerId);
            drag = { x: press.clientX, y: press.clientY, left: view.scrollLeft, top: view.scrollTop };
        });
        view.addEventListener('pointermove', (move) => {
            if (!drag) return;
            view.scrollLeft = drag.left - (move.clientX - drag.x);
            view.scrollTop = drag.top - (move.clientY - drag.y);
        });
        const endDrag = () => {
            drag = undefined;
        };
        view.addEventListener('pointerup', endDrag);
        view.addEventListener('pointercancel', endDrag);
        // A press on the backdrop lands on the dialog itself, outside its box.
        dialog.addEventListener('mousedown', (press) => {
            const box = dialog.getBoundingClientRect();
            const outside =
                press.clientX < box.left || press.clientX > box.right || press.clientY < box.top || press.clientY > box.bottom;
            if (press.target === dialog && outside) dialog.close();
        });
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : undefined;
        dialog.addEventListener('close', () => {
            observer?.disconnect();
            home.replaceWith(body);
            dialog.remove();
        });
        document.body.append(dialog);
        dialog.showModal();
        view.focus({ preventScroll: true });
        observer?.observe(view);
        observer?.observe(content);
    });
}

/**
 * The standalone HTML document for `main`, a column of `page`, with the page's title, root attributes and styles.
 * `preference` is the theme setting: the root's tokens draw the file in the theme on screen, except for `system`, where
 * the file follows its reader's colour scheme.
 * ponytail: under `system`, Mermaid diagrams keep the colours of the theme they were drawn in, as Mermaid bakes them into
 * its SVG; draw both and pick by the colour scheme if that shows.
 */
export async function buildHtml(
    main: HTMLElement,
    page: Document = document,
    load: BlobLoader = fetchBlob,
    preference: ThemePreference = readPreference()
): Promise<string> {
    const out = page.implementation.createHTMLDocument(page.title);
    // The root carries the theme tokens, the theme name the diagrams were drawn for and the page width.
    for (const attribute of page.documentElement.attributes) out.documentElement.setAttribute(attribute.name, attribute.value);
    // Its inline style is the theme's tokens alone (theme.ts), which would outrank the stylesheet's.
    if (preference === 'system') out.documentElement.removeAttribute('style');
    // A JSON string is a valid CSS string: the running head when the file is printed.
    out.documentElement.style.setProperty('--print-title', JSON.stringify(page.title));
    const charset = out.createElement('meta');
    charset.setAttribute('charset', 'utf-8');
    const viewport = out.createElement('meta');
    viewport.name = 'viewport';
    viewport.content = 'width=device-width, initial-scale=1';
    out.head.prepend(charset, viewport);
    const { css, links } = collectStyles(page.styleSheets);
    for (const href of links) {
        const link = out.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        out.head.append(link);
    }
    const style = out.createElement('style');
    style.textContent = [css, STANDALONE, preference === 'system' ? systemThemeCss(page) : ''].join('\n');
    out.head.append(style);

    // Cloned in the page, so relative image URLs still resolve, then adopted.
    const copy = main.cloneNode(true) as HTMLElement;
    copyFormState(main, copy);
    keepFullScreen(copy);
    await inlineImages(copy, load);
    await inlineFrames(copy, load);
    const script = out.createElement('script');
    script.textContent = `(${fullScreen})(${JSON.stringify(ZOOM)});`;
    out.body.append(copy, fullScreenTemplate(page), script);
    return `<!doctype html>\n${out.documentElement.outerHTML}`;
}

/** Saves the open tab's column, `#main`, as `fileName`. */
export async function exportHtml(fileName: string): Promise<void> {
    const main = document.getElementById('main');
    if (!main) return;
    const url = URL.createObjectURL(new Blob([await buildHtml(main)], { type: 'text/html;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    // Revoked later, not at once: the browser may still be reading it for the download.
    setTimeout(() => URL.revokeObjectURL(url), 40_000);
}
