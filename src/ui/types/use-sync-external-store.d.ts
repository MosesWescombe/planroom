/** The React 17 shim for `useSyncExternalStore`, with a selector. The package ships no types. */
declare module 'use-sync-external-store/shim/with-selector' {
    export function useSyncExternalStoreWithSelector<Snapshot, Selection>(
        subscribe: (onStoreChange: () => void) => () => void,
        getSnapshot: () => Snapshot,
        getServerSnapshot: undefined | null | (() => Snapshot),
        selector: (snapshot: Snapshot) => Selection,
        isEqual?: (a: Selection, b: Selection) => boolean
    ): Selection;
}
