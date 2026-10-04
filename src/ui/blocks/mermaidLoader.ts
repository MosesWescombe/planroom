/** Load Mermaid on demand. It is a large bundle, so it is fetched only when a `mermaid` block renders. */
export async function loadMermaid() {
    const module = await import('mermaid');
    return module.default;
}
