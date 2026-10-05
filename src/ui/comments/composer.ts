import { useSyncExternalStoreWithSelector } from 'use-sync-external-store/with-selector';
import type { Anchor, CommentIntent } from '../../shared/records';
import { targetSelector } from './selection';

/** The comment being composed: what it is anchored to, its intent, and where to show the composer. */
export interface Composition {
    anchor: Anchor;
    intent: CommentIntent;
    /** Viewport position of the selection, for placing the composer next to it. */
    at?: { top: number; left: number; bottom: number };
}

let current: Composition | undefined;
const listeners = new Set<() => void>();

/** Tell every listener the composition changed. */
function emit(): void {
    for (const listener of listeners) listener();
}

/** Open the composer for a new comment, replacing any comment being composed. */
export function openComposer(composition: Composition): void {
    current = composition;
    emit();
}

/** Close the composer, dropping the comment being composed. */
export function closeComposer(): void {
    current = undefined;
    emit();
}

/** The comment being composed, if any. */
export function useComposition(): Composition | undefined {
    return useSyncExternalStoreWithSelector(
        (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        () => current,
        undefined,
        (value) => value
    );
}

/**
 * Comment on a whole target, anchored to its id rather than a quote of its text: what every comment button opens
 * ("Ask to clarify", a block's comment, "Correct it"). Nothing is highlighted; only a comment on selected text is.
 */
export function commentOnWhole(target: string, intent: CommentIntent): void {
    const rect = document.querySelector(targetSelector(target))?.getBoundingClientRect();
    openComposer({ anchor: { target }, intent, at: rect && { top: rect.top, left: rect.left, bottom: rect.bottom } });
}
