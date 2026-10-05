import isEqual from 'lodash/isEqual';
import { createContext, useContext } from 'react';
import { flushSync } from 'react-dom';
import { useSyncExternalStoreWithSelector } from 'use-sync-external-store/with-selector';
import { isMapPatch, MAP_FIELDS, type MapField, type Patch, type View } from '../shared/view';

/**
 * The page's link to the server: the event stream's state, independent of the agent's. `closed`: Planroom stopped
 * serving this session after the accept or end, so the page no longer reconnects.
 */
export type Connection = 'connecting' | 'live' | 'reconnecting' | 'closed';

type Listener = () => void;

/**
 * The normalized page state: the server's view, replaced record by record. A record
 * object is only replaced when the server sends a new version of it, so components
 * that select one record re-render exactly when that record changes. A reconnect's
 * snapshot keeps the old object of each record whose value is unchanged, so it
 * re-renders only what changed while the stream was down. It compares values, not
 * versions: a record deleted by undo and re-created restarts at version 1.
 */
export class ViewStore {
    private view: View | undefined;
    private browsing: { readOnly: boolean } | undefined;
    private connection: Connection = 'connecting';
    private readonly listeners = new Set<Listener>();
    private readonly hooks = new Set<{ before: () => void; after: () => void }>();

    /** The current view, undefined before the first snapshot. An arrow, so it can be passed unbound. */
    getView = (): View | undefined => this.view;

    /** Set when the page is the plan browser, which shows no plan; `readOnly` when the plans it opens are read-only. */
    getBrowsing = (): { readOnly: boolean } | undefined => this.browsing;

    /** The event stream's state. An arrow, so it can be passed unbound. */
    getConnection = (): Connection => this.connection;

    /** Listen for any change to the view or the connection. Returns the unsubscribe. */
    subscribe = (listener: Listener): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    /** Run `before` just before and `after` just after each update reaches the DOM, e.g. to keep scroll steady. */
    around(before: () => void, after: () => void): () => void {
        const hook = { before, after };
        this.hooks.add(hook);
        return () => this.hooks.delete(hook);
    }

    /** Take the server's whole view, keeping the old object of every record and field whose value is unchanged. */
    snapshot(next: View): void {
        const current = this.view;
        if (!current) {
            this.commit(next);
            return;
        }
        const merged = { ...next } as View;
        const target = merged as unknown as Record<string, unknown>;
        const old = current as unknown as Record<string, unknown>;
        for (const key of Object.keys(next) as (keyof View)[]) {
            if (MAP_FIELDS.includes(key as MapField)) {
                const before = old[key] as Record<string, unknown>;
                const after = target[key] as Record<string, unknown>;
                const records = Object.fromEntries(
                    Object.entries(after).map(([id, value]) => [id, isEqual(before[id], value) ? before[id] : value])
                );
                const unchanged =
                    Object.keys(records).length === Object.keys(before).length &&
                    Object.entries(records).every(([id, value]) => before[id] === value);
                target[key] = unchanged ? before : records;
            } else if (isEqual(old[key], target[key])) {
                target[key] = old[key];
            }
        }
        this.commit(merged);
    }

    /**
     * Apply the server's patches: a map patch replaces or deletes one record, any other replaces its whole field.
     * Ignored before the first snapshot.
     */
    apply(patches: readonly Patch[]): void {
        if (!this.view || patches.length === 0) return;
        const next = { ...this.view } as unknown as Record<string, unknown>;
        for (const patch of patches) {
            if (isMapPatch(patch)) {
                const records = { ...(next[patch.field] as Record<string, unknown>) };
                if (patch.value === null) delete records[patch.id];
                else records[patch.id] = patch.value;
                next[patch.field] = records;
            } else {
                next[patch.field] = patch.value;
            }
        }
        this.commit(next as unknown as View);
    }

    /** Make the page the plan browser, as the server said. */
    browse(readOnly: boolean): void {
        this.browsing = { readOnly };
        this.notify();
    }

    /** Record the event stream's state, notifying only when it changed. */
    setConnection(connection: Connection): void {
        if (connection === this.connection) return;
        this.connection = connection;
        this.notify();
    }

    /** Swap in the new view and notify. */
    private commit(view: View): void {
        this.view = view;
        this.notify();
    }

    /** Tell every listener in one synchronous React batch, so the DOM has the update when the `around` hooks' `after` runs. */
    private notify(): void {
        for (const hook of this.hooks) hook.before();
        flushSync(() => {
            for (const listener of [...this.listeners]) listener();
        });
        for (const hook of this.hooks) hook.after();
    }
}

/** The page's `ViewStore`, provided at the root. */
export const StoreContext = createContext<ViewStore | null>(null);

/** The page's `ViewStore`. Throws outside a `StoreContext` provider. */
export function useStore(): ViewStore {
    const store = useContext(StoreContext);
    if (!store) throw new Error('useStore needs a StoreContext provider');
    return store;
}

/** Select from the loaded view; the component re-renders only when the selection changes. */
export function useSelector<T>(selector: (view: View) => T, equal: (a: T, b: T) => boolean = Object.is): T {
    const store = useStore();
    return useSyncExternalStoreWithSelector(
        store.subscribe,
        store.getView,
        undefined,
        (view) => {
            if (!view) throw new Error('useSelector before the first snapshot');
            return selector(view);
        },
        equal
    );
}

/** One record, by field and id. Re-renders only when that record's version changes. */
export function useRecord<F extends MapField>(field: F, id: string): View[F][string] | undefined {
    return useSelector((view) => view[field][id] as View[F][string] | undefined);
}

/** The event stream's state; the component re-renders when it changes. */
export function useConnection(): Connection {
    const store = useStore();
    return useSyncExternalStoreWithSelector(store.subscribe, store.getConnection, undefined, (connection) => connection);
}

/** Deep equality for selectors that build new arrays or objects. */
export const deepEqual = isEqual;
