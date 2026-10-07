import { useEffect, useState, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';

/** The current time, refreshed every `intervalMs`, for relative timestamps. */
export function useNow(intervalMs = 15_000): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
        return () => window.clearInterval(timer);
    }, [intervalMs]);
    return now;
}

/** Whether the viewport is below the narrow-layout breakpoint. */
export function useNarrow(query = '(max-width: 959.98px)'): boolean {
    const [narrow, setNarrow] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia(query).matches);
    useEffect(() => {
        if (typeof window.matchMedia !== 'function') return undefined;
        const media = window.matchMedia(query);
        const update = () => setNarrow(media.matches);
        update();
        media.addEventListener('change', update);
        return () => media.removeEventListener('change', update);
    }, [query]);
    return narrow;
}

/** Whether the reader's system asks for reduced motion: slides then change without animating and step-throughs show every step. */
export function useReducedMotion(): boolean {
    return useNarrow('(prefers-reduced-motion: reduce)');
}

let printing = false;
const printListeners = new Set<() => void>();

/**
 * Put the page in print mode while the PDF prints or the HTML export copies the page: a review's deck then lays out
 * every slide, each step-through in its final state, instead of the one slide on screen.
 */
export function setPrinting(on: boolean): void {
    if (printing === on) return;
    printing = on;
    flushSync(() => {
        for (const listener of printListeners) listener();
    });
}

/** Whether the page is being printed or exported. */
export function usePrinting(): boolean {
    return useSyncExternalStore(
        (listener) => {
            printListeners.add(listener);
            return () => printListeners.delete(listener);
        },
        () => printing
    );
}
