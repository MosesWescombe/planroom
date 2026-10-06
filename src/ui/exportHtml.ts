/**
 * Export HTML: the open tab's main column as one standalone file, drawn as on screen in the current theme. The page's
 * own stylesheets are inlined with their `@media print` rules applied unconditionally, so the file drops the same
 * controls Export PDF does and reads as a document; printing it gives the same pages. Images are inlined as data URLs.
 * ponytail: the fonts load from Google Fonts as the page's do, so offline the file falls back to system fonts; inline
 * them as data URLs if the file must look identical offline.
 */

/** Fetches an image's bytes; injected in tests. */
export type BlobLoader = (url: string) => Promise<Blob>;

const fetchBlob: BlobLoader = async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    return response.blob();
};

/** Lays the column out as a page of its own, where the app's shell and print rules leave it full width and unpadded. */
const STANDALONE = `
body { margin: 0; background: var(--surface); }
#main { max-width: 860px; margin: 0 auto; padding: 56px max(16px, 4vw) 80px; }
`;

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

/** The standalone HTML document for `main`, a column of `page`, with the page's title, root attributes and styles. */
export async function buildHtml(main: HTMLElement, page: Document = document, load: BlobLoader = fetchBlob): Promise<string> {
    const out = page.implementation.createHTMLDocument(page.title);
    // The root carries the theme tokens and the theme name the diagrams were drawn for.
    for (const attribute of page.documentElement.attributes) out.documentElement.setAttribute(attribute.name, attribute.value);
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
    style.textContent = `${css}\n${STANDALONE}`;
    out.head.append(style);

    // Cloned in the page, so relative image URLs still resolve, then adopted.
    const copy = main.cloneNode(true) as HTMLElement;
    copyFormState(main, copy);
    await inlineImages(copy, load);
    out.body.append(copy);
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
