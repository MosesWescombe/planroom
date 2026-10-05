import { useEffect, useState } from 'react';
import { z } from 'zod';
import type { ActivityEntry } from '../shared/view';
import { readJson, storageScope, writeJson } from './local';
import { useSelector } from './store';
import { elementIdFor, useUiState } from './ui';

/**
 * Which activity entries this browser has seen, kept per change in localStorage: for each entry `ref`, the time of
 * the newest entry about it that has been seen. Both times are the server's, so the browser's clock never matters.
 */
const seenSchema = z.record(z.string(), z.string());
export type Seen = z.infer<typeof seenSchema>;

const listeners = new Set<() => void>();

/** The localStorage key a page's seen entries are kept under, by its `storageScope`. */
function seenKey(scope: string): string {
    return `planroom:${scope}:seen`;
}

/** A page's seen entries, or none when nothing valid is stored. */
function readSeen(scope: string): Seen {
    return seenSchema.safeParse(readJson(seenKey(scope))).data ?? {};
}

/** Record that the entries about `ref` up to `at` have been seen. */
export function markSeen(scope: string, ref: string, at: string): void {
    const seen = readSeen(scope);
    if ((seen[ref] ?? '') >= at) return;
    writeJson(seenKey(scope), { ...seen, [ref]: at });
    listeners.forEach((listener) => listener());
}

/** An entry is unread until what it links to has been on screen; one that links nowhere has nothing to open. */
export function isSeen(seen: Seen, entry: Pick<ActivityEntry, 'ref' | 'at'>): boolean {
    return entry.ref === undefined || (seen[entry.ref] ?? '') >= entry.at;
}

/** Entries shown as unread until seen: agent and server changes, not your own actions or new-question cards. */
function tracked(entry: ActivityEntry): entry is ActivityEntry & { ref: string } {
    return entry.ref !== undefined && entry.kind !== 'yours' && entry.kind !== 'question';
}

/** What this browser has seen, updated live, including by other tabs on the same page. */
export function useSeen(): Seen {
    const scope = useSelector(storageScope);
    const [seen, setSeen] = useState(() => readSeen(scope));
    useEffect(() => {
        const update = () => setSeen(readSeen(scope));
        update();
        listeners.add(update);
        window.addEventListener('storage', update);
        return () => {
            listeners.delete(update);
            window.removeEventListener('storage', update);
        };
    }, [scope]);
    return seen;
}

/** Whether the page is in front, so nothing counts as seen while the user is in another tab. */
function useInFront(): boolean {
    const [inFront, setInFront] = useState(() => document.visibilityState !== 'hidden');
    useEffect(() => {
        const update = () => setInFront(document.visibilityState !== 'hidden');
        document.addEventListener('visibilitychange', update);
        return () => document.removeEventListener('visibilitychange', update);
    }, []);
    return inFront;
}

/**
 * Mark unread entries seen once their target is on screen: a question or section once it scrolls into view. A reply
 * is left to its thread's dialog, since a thread's row shows only the ask. Re-observes whenever the tabs change,
 * since that mounts different targets.
 */
export function useTrackSeen(): void {
    const scope = useSelector(storageScope);
    const activity = useSelector((view) => view.activity);
    const seen = useSeen();
    const { tab, panelTab, panelCollapsed, drawer } = useUiState();
    const inFront = useInFront();
    useEffect(() => {
        if (!inFront || typeof IntersectionObserver === 'undefined') return undefined;
        // The newest unread entry per target; the feed is newest first.
        const newest = new Map<string, string>();
        for (const entry of activity) {
            if (!tracked(entry) || entry.ref.startsWith('thread:') || isSeen(seen, entry) || newest.has(entry.ref)) continue;
            newest.set(entry.ref, entry.at);
        }
        const targets = new Map<Element, [ref: string, at: string]>();
        const observer = new IntersectionObserver((records) => {
            for (const record of records) {
                const target = targets.get(record.target);
                if (!target || record.intersectionRatio <= 0) continue;
                observer.unobserve(record.target);
                markSeen(scope, ...target);
            }
        });
        newest.forEach((at, ref) => {
            const element = document.getElementById(elementIdFor(ref));
            if (!element) return;
            targets.set(element, [ref, at]);
            observer.observe(element);
        });
        return () => observer.disconnect();
    }, [scope, activity, seen, tab, panelTab, panelCollapsed, drawer, inFront]);
}
