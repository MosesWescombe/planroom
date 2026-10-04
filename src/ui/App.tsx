import { useEffect } from 'react';
import { useSyncExternalStoreWithSelector } from 'use-sync-external-store/shim/with-selector';
import { pagePhase } from '../shared/derive';
import { PlanBrowser } from './components/PlanSwitcher';
import { Shell, tabForPhase } from './components/Shell';
import { keepScroll } from './scrollKeeper';
import { StoreContext, type ViewStore } from './store';
import { UiProvider } from './ui';

/** The page: waits for the first snapshot, then renders the shell over the store, or the plan browser when it is one. */
export function App({ store }: { store: ViewStore }) {
    const changeId = useSyncExternalStoreWithSelector(store.subscribe, store.getView, undefined, (view) => view?.changeId);
    const browsing = useSyncExternalStoreWithSelector(store.subscribe, store.getBrowsing, undefined, (value) => value);
    useEffect(() => keepScroll(store, () => document.getElementById('main')), [store]);
    useEffect(() => {
        if (changeId) document.title = `${changeId} · Planroom`;
        else if (browsing) document.title = 'Plans · Planroom';
    }, [changeId, browsing]);
    const view = store.getView();
    return (
        <StoreContext.Provider value={store}>
            {browsing ? (
                <UiProvider initialTab="interrogate">
                    <PlanBrowser readOnly={browsing.readOnly} />
                </UiProvider>
            ) : changeId && view ? (
                <UiProvider initialTab={tabForPhase(pagePhase(view))}>
                    <Shell />
                </UiProvider>
            ) : (
                <div className="loading" role="status">
                    Connecting to Planroom…
                </div>
            )}
        </StoreContext.Provider>
    );
}
