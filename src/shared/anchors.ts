import type { Anchor } from './records.js';

/** Characters of context kept either side of a quote. */
export const CONTEXT_LENGTH = 32;

/**
 * Capture an anchor over the plain text of a target element, following the W3C Web
 * Annotation TextPositionSelector and TextQuoteSelector.
 */
export function captureAnchor(target: string, text: string, start: number, end: number): Anchor {
    return {
        target,
        position: { start, end },
        quote: {
            exact: text.slice(start, end),
            prefix: text.slice(Math.max(0, start - CONTEXT_LENGTH), start),
            suffix: text.slice(end, end + CONTEXT_LENGTH)
        }
    };
}

export interface ResolvedAnchor {
    start: number;
    end: number;
    /** Which selector found it: the stored offsets, the quote with its context, the quote alone, or none (the whole target). */
    method: 'position' | 'context' | 'quote' | 'target';
}

/** Every index at which `needle` occurs in `haystack`. */
function occurrences(haystack: string, needle: string): number[] {
    const found: number[] = [];
    for (let index = haystack.indexOf(needle); index !== -1; index = haystack.indexOf(needle, index + 1)) found.push(index);
    return found;
}

/** The occurrence closest to where the anchor used to start. */
function nearest(candidates: number[], origin: number): number | undefined {
    return candidates.reduce<number | undefined>(
        (best, candidate) => (best === undefined || Math.abs(candidate - origin) < Math.abs(best - origin) ? candidate : best),
        undefined
    );
}

/**
 * Re-attach an anchor to the current text of its target. Tries the stored offsets,
 * then the quote with its full context, then the quote alone, nearest to where it
 * was. Returns null when the quote is gone, and the thread shows as detached. An
 * anchor without a quote covers the whole target and never detaches.
 */
export function resolveAnchor(text: string, anchor: Anchor): ResolvedAnchor | null {
    if (!anchor.quote || !anchor.position) return { start: 0, end: text.length, method: 'target' };
    const { exact, prefix, suffix } = anchor.quote;
    const { start } = anchor.position;
    if (text.slice(start, start + exact.length) === exact) return { start, end: start + exact.length, method: 'position' };

    const inContext = nearest(occurrences(text, prefix + exact + suffix), start - prefix.length);
    if (inContext !== undefined) {
        const found = inContext + prefix.length;
        return { start: found, end: found + exact.length, method: 'context' };
    }

    const alone = nearest(occurrences(text, exact), start);
    if (alone !== undefined) return { start: alone, end: alone + exact.length, method: 'quote' };
    return null;
}

/** What a comment is on, for short labels: its quote cut to `max` characters, or the question id for a whole question. */
export function describeAnchor(anchor: Anchor, max = 60): string {
    return anchor.quote ? `"${anchor.quote.exact.slice(0, max)}"` : anchor.target.replace(/^question:/, '');
}
