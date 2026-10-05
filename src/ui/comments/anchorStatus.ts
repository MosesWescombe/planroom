import { useSyncExternalStoreWithSelector } from 'use-sync-external-store/with-selector';

/**
 * Where each comment thread's anchor currently is: on the page and still matching
 * (`attached`), on the page but its quote is gone (`detached`), or its target is not
 * rendered right now (`hidden`, e.g. on another tab). The highlighter writes it after
 * every re-resolution; threads read it.
 */
export type AnchorState = 'attached' | 'detached' | 'hidden';

const states = new Map<string, AnchorState>();
const listeners = new Set<() => void>();
let snapshot: ReadonlyMap<string, AnchorState> = new Map();

/** Replace every anchor's state, notifying readers only when something changed. */
export function setAnchorStates(next: ReadonlyMap<string, AnchorState>): void {
    let changed = next.size !== states.size;
    for (const [id, state] of next) if (states.get(id) !== state) changed = true;
    if (!changed) return;
    states.clear();
    for (const [id, state] of next) states.set(id, state);
    snapshot = new Map(states);
    for (const listener of listeners) listener();
}

/** Listen for anchor state changes. Returns the unsubscribe. */
function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** Where a thread's anchor currently is, or undefined before the highlighter has placed it. */
export function useAnchorState(threadId: string): AnchorState | undefined {
    return useSyncExternalStoreWithSelector(
        subscribe,
        () => snapshot,
        undefined,
        (map) => map.get(threadId)
    );
}
