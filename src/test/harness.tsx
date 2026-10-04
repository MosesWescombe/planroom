import { cleanup, render, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, vi } from 'vitest';
import type { SessionState } from '../shared/state';
import type { View } from '../shared/view';
import { StoreContext, ViewStore } from '../ui/store';
import { type Tab, UiProvider } from '../ui/ui';
import { stateWith } from './fixtures';

/** A page view built from a session state, with the live fields the server adds. */
export function makeView(parts: Parameters<typeof stateWith>[0] = {}, extra: Partial<View> = {}): View {
    const {
        lastEvent: _lastEvent,
        counters: _counters,
        schemaVersion: _schema,
        agentCursor: _cursor,
        ...state
    }: SessionState = stateWith(parts);
    return {
        ...state,
        agent: { mode: 'waiting', queued: 0 },
        activity: [],
        revisions: [],
        proposal: { files: [], scannedAt: '2026-09-29T00:00:00.000Z' },
        validating: false,
        ...extra
    };
}

/** A live store holding `view`. */
export function storeWith(view: View): ViewStore {
    const store = new ViewStore();
    store.snapshot(view);
    store.setConnection('live');
    return store;
}

/** Render inside the store and UI providers the page gives every component. */
export function renderWith(store: ViewStore, element: ReactElement, tab: Tab = 'interrogate'): RenderResult {
    return render(
        <StoreContext.Provider value={store}>
            <UiProvider initialTab={tab}>{element}</UiProvider>
        </StoreContext.Provider>
    );
}

/** `value`, failing the test when it is null or undefined; a checked stand-in for a non-null assertion. */
export function defined<T>(value: T | null | undefined): T {
    if (value === null || value === undefined) throw new Error(`Expected a value, got ${String(value)}`);
    return value;
}

/** `value` as an instance of `type`, failing the test when it is anything else, a missing element included. */
export function instance<T>(value: unknown, type: abstract new (...args: never[]) => T): T {
    if (value instanceof type) return value;
    throw new Error(`Expected a ${type.name}, got ${String(value)}`);
}

/** Every page event the components posted, parsed. */
export const posted: Record<string, unknown>[] = [];

/** Stub fetch: page events succeed with an increasing seq, unless `refuse` says otherwise. */
export function stubFetch(refuse?: (body: Record<string, unknown>) => { status: number; error: string } | undefined): void {
    let seq = 0;
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
            if (url === 'api/events') {
                const body: Record<string, unknown> = JSON.parse(String(init?.body));
                const refusal = refuse?.(body);
                if (refusal)
                    return new Response(
                        JSON.stringify({ error: refusal.error, issues: [{ path: '', message: refusal.error }] }),
                        { status: refusal.status }
                    );
                posted.push(body);
                seq += 1;
                return new Response(JSON.stringify({ seq }), { status: 200 });
            }
            return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
        })
    );
}

beforeEach(() => {
    posted.length = 0;
    window.localStorage.clear();
    for (const cookie of document.cookie.split('; ').filter(Boolean))
        document.cookie = `${cookie.split('=')[0]}=; max-age=0; path=/`;
    stubFetch();
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});
