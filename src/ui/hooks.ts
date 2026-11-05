import { type RefObject, useEffect, useRef, useState, useSyncExternalStore } from 'react';
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

/**
 * Call `onShown` once `ref`'s element has been on screen for `ms` while `active`: at least half of it, or half the
 * screen for one taller than that. Scrolling it away restarts the count.
 */
export function useOnScreenFor(ref: RefObject<HTMLElement | null>, active: boolean, ms: number, onShown: () => void): void {
    const latest = useRef(onShown);
    latest.current = onShown;
    useEffect(() => {
        const element = ref.current;
        if (!active || !element || typeof IntersectionObserver === 'undefined') return undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const observer = new IntersectionObserver(
            (entries) => {
                const entry = entries[entries.length - 1];
                if (!entry) return;
                const screen = entry.rootBounds?.height ?? window.innerHeight;
                const onScreen =
                    entry.isIntersecting &&
                    entry.intersectionRect.height >= 0.5 * Math.min(entry.boundingClientRect.height, screen);
                if (onScreen && !timer) timer = setTimeout(() => latest.current(), ms);
                if (!onScreen && timer) {
                    clearTimeout(timer);
                    timer = undefined;
                }
            },
            // Small steps too, so an element many screens tall still reports reaching half the screen.
            { threshold: [0, 0.01, 0.02, 0.05, 0.1, 0.15, 0.2, 0.25, 0.5, 0.75, 1] }
        );
        observer.observe(element);
        return () => {
            observer.disconnect();
            clearTimeout(timer);
        };
    }, [ref, active, ms]);
}
