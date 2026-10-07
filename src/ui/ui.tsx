import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { type PageInput, postEvent, RequestError } from './api';
import { readSetting, writeSetting } from './local';
import { useStore } from './store';

/** A plan's four phase tabs, or a review's three: the walkthrough deck, its findings and the comments to post. */
export type Tab = 'interrogate' | 'directions' | 'writeup' | 'proposal' | 'walkthrough' | 'findings' | 'comments';
export type PanelTab = 'review' | 'activity' | 'comments';
export type Drawer = 'nav' | 'panel' | undefined;

/**
 * A record the page can navigate to: `Q-12`, `section:s4`, `block:b1`, `thread:C-1`, `file:specs/x/spec.md`, and in a
 * review `slide:why-1` and `item:I-3`.
 */
export type Target = string;

export interface Notice {
    id: number;
    text: string;
}

/** UI state that changes: which tab, panel, drawer and file are showing, and the notices. */
export interface UiState {
    tab: Tab;
    /** Which Directions tab is showing: a direction id, or undefined for the overview. */
    direction: string | undefined;
    panelCollapsed: boolean;
    panelTab: PanelTab;
    drawer: Drawer;
    file: string | undefined;
    notices: Notice[];
    /** A review's slide on show, by id; undefined for the first. */
    slide: string | undefined;
    /** A review's round on show; undefined for the current one. */
    round: number | undefined;
}

/** Stable actions. Components that only act (cards, blocks) use these and never re-render for UI state. */
export interface UiActions {
    setTab: (tab: Tab) => void;
    setDirection: (direction: string | undefined) => void;
    /** Switch to whatever shows `target` and scroll it into view. */
    goTo: (target: Target) => void;
    setPanelCollapsed: (collapsed: boolean) => void;
    setPanelTab: (tab: PanelTab) => void;
    setDrawer: (drawer: Drawer) => void;
    setFile: (file: string | undefined) => void;
    setSlide: (slide: string | undefined) => void;
    setRound: (round: number | undefined) => void;
    /** Send a page event; a refusal is shown as a notice and rethrown for the caller. */
    send: (request: PageInput) => Promise<{ seq?: number }>;
    notify: (text: string) => void;
    dismiss: (id: number) => void;
}

const StateContext = createContext<UiState | null>(null);
const ActionsContext = createContext<UiActions | null>(null);

/** The UI state; the component re-renders whenever any of it changes. Throws outside a `UiProvider`. */
export function useUiState(): UiState {
    const state = useContext(StateContext);
    if (!state) throw new Error('useUiState needs a UiProvider');
    return state;
}

/** The stable UI actions, which never cause a re-render. Throws outside a `UiProvider`. */
export function useActions(): UiActions {
    const actions = useContext(ActionsContext);
    if (!actions) throw new Error('useActions needs a UiProvider');
    return actions;
}

const PANEL_KEY = 'planroom:panel-collapsed';

/** The element id a target renders under. */
export function elementIdFor(target: Target): string {
    if (/^Q-\d+$/.test(target)) return `q-${target}`;
    if (!target.includes(':')) return target;
    const [kind, ...rest] = target.split(':');
    return `${kind}-${rest.join(':')}`;
}

/** The phase tab that shows a target, or undefined when no tab switch is needed. */
function tabFor(target: Target): Tab | undefined {
    if (/^Q-\d+$/.test(target) || target === 'understanding' || target.startsWith('suggestion:')) return 'interrogate';
    if (target.startsWith('section:') || target.startsWith('block:')) return 'writeup';
    if (target.startsWith('file:')) return 'proposal';
    if (target.startsWith('slide:')) return 'walkthrough';
    if (target.startsWith('item:')) return 'findings';
    return undefined;
}

/** Scroll an element into view and focus it, once a tab switch has rendered. */
function reveal(id: string): void {
    // Wait for a tab switch to render, then bring the element into view and focus it for keyboard users.
    window.requestAnimationFrame(() => {
        const element = document.getElementById(id);
        if (!element) return;
        element.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
        if (!element.hasAttribute('tabindex')) element.setAttribute('tabindex', '-1');
        element.focus?.({ preventScroll: true });
    });
}

/** A failed request in words for a notice: the server's reasons when it gave any. */
export function describeError(error: unknown): string {
    if (error instanceof RequestError && error.issues.length) return error.issues.map((issue) => issue.message).join('; ');
    return error instanceof Error ? error.message : 'The page could not reach Planroom';
}

/**
 * Holds the UI state and its actions: the tab and direction, the panel and drawers, the open file and the notices. The
 * panel's collapsed state is remembered in this browser.
 */
export function UiProvider({ initialTab, children }: { initialTab: Tab; children: ReactNode }) {
    const store = useStore();
    const [tab, setTab] = useState<Tab>(initialTab);
    const [direction, setDirection] = useState<string | undefined>();
    const [panelCollapsed, setCollapsed] = useState(() => readSetting(PANEL_KEY) === '1');
    const [panelTab, setPanelTab] = useState<PanelTab>(initialTab === 'proposal' ? 'review' : 'activity');
    const [drawer, setDrawer] = useState<Drawer>();
    const [file, setFile] = useState<string | undefined>();
    const [slide, setSlide] = useState<string | undefined>();
    const [round, setRound] = useState<number | undefined>();
    const [notices, setNotices] = useState<Notice[]>([]);
    const noticeId = useRef(0);

    const actions = useMemo<UiActions>(() => {
        const notify = (text: string) => {
            noticeId.current += 1;
            const id = noticeId.current;
            setNotices((current) => [...current.slice(-3), { id, text }]);
            window.setTimeout(() => setNotices((current) => current.filter((notice) => notice.id !== id)), 8000);
        };
        const setPanelCollapsed = (collapsed: boolean) => {
            setCollapsed(collapsed);
            writeSetting(PANEL_KEY, collapsed ? '1' : undefined);
        };
        return {
            setTab,
            setDirection,
            setPanelCollapsed,
            setPanelTab,
            setDrawer,
            setFile,
            setSlide,
            setRound,
            notify,
            dismiss: (id) => setNotices((current) => current.filter((notice) => notice.id !== id)),
            goTo: (target) => {
                if (target.startsWith('thread:')) {
                    setPanelCollapsed(false);
                    setPanelTab('comments');
                    setDrawer((current) => (current ? 'panel' : current));
                } else {
                    const next = tabFor(target);
                    // A shared question lives on Interrogate; a direction's own lives on its tab in Directions.
                    const direction = next === 'interrogate' ? store.getView()?.questions[target]?.direction : undefined;
                    if (next) setTab(direction ? 'directions' : next);
                    if (next === 'interrogate') setDirection(direction);
                    if (target.startsWith('file:')) setFile(target.slice(5));
                    // A slide shows on its own; one of an earlier round shows that round.
                    if (target.startsWith('slide:')) {
                        const id = target.slice(6);
                        const view = store.getView();
                        const of = view?.slides[id]?.round;
                        const last = view?.review?.rounds.at(-1)?.n;
                        setRound(of === last ? undefined : of);
                        setSlide(id);
                    }
                    setDrawer(undefined);
                }
                reveal(elementIdFor(target));
            },
            send: async (request) => {
                try {
                    return await postEvent(request);
                } catch (error) {
                    notify(describeError(error));
                    throw error;
                }
            }
        };
    }, [store]);

    const state = useMemo<UiState>(
        () => ({ tab, direction, panelCollapsed, panelTab, drawer, file, notices, slide, round }),
        [tab, direction, panelCollapsed, panelTab, drawer, file, notices, slide, round]
    );
    return (
        <ActionsContext.Provider value={actions}>
            <StateContext.Provider value={state}>{children}</StateContext.Provider>
        </ActionsContext.Provider>
    );
}

/** Run an action, swallowing the error it already reported as a notice. */
export function quietly(promise: Promise<unknown>): void {
    promise.catch(() => undefined);
}

/** Track a send in flight, for disabling a button while it runs. */
export function useBusy(): [boolean, <T>(promise: Promise<T>) => Promise<T>] {
    const [busy, setBusy] = useState(false);
    const track = useCallback(async <T,>(promise: Promise<T>): Promise<T> => {
        setBusy(true);
        try {
            return await promise;
        } finally {
            setBusy(false);
        }
    }, []);
    return [busy, track];
}
