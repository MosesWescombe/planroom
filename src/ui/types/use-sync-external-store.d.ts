/** React's `useSyncExternalStore` with a selector, which React itself does not export. The package ships no types. */
declare module 'use-sync-external-store/with-selector' {
    export function useSyncExternalStoreWithSelector<Snapshot, Selection>(
        subscribe: (onStoreChange: () => void) => () => void,
        getSnapshot: () => Snapshot,
        getServerSnapshot: undefined | null | (() => Snapshot),
        selector: (snapshot: Snapshot) => Selection,
        isEqual?: (a: Selection, b: Selection) => boolean
    ): Selection;
}
