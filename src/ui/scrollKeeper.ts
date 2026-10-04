import type { ViewStore } from './store';

/** Whether the browser keeps scroll steady itself when content above the viewport changes size. */
export function hasNativeScrollAnchoring(): boolean {
    return typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('overflow-anchor', 'auto');
}

/** The element to hold still: the first record starting in view, else the last one reaching into view. */
function pickAnchor(container: HTMLElement): { element: Element; top: number } | undefined {
    const top = container.getBoundingClientRect().top;
    let fallback: { element: Element; top: number } | undefined;
    for (const element of container.querySelectorAll('[data-scroll-anchor]')) {
        const rect = element.getBoundingClientRect();
        if (rect.top >= top - 1) return { element, top: rect.top };
        if (rect.bottom > top) fallback = { element, top: rect.top };
    }
    return fallback;
}

/**
 * Keep what the user is reading where it is when an update changes the size of
 * something above it. CSS scroll anchoring does this natively; where the browser
 * lacks `overflow-anchor`, measure an anchor before each update and restore its
 * position after, which the store's synchronous, batched commit makes exact.
 */
export function keepScroll(
    store: ViewStore,
    container: () => HTMLElement | null,
    native = hasNativeScrollAnchoring()
): () => void {
    if (native) return () => undefined;
    let held: { element: Element; top: number } | undefined;
    return store.around(
        () => {
            const element = container();
            held = element ? pickAnchor(element) : undefined;
        },
        () => {
            const element = container();
            if (element && held?.element.isConnected) {
                const delta = held.element.getBoundingClientRect().top - held.top;
                if (delta !== 0) element.scrollTop += delta;
            }
            held = undefined;
        }
    );
}
