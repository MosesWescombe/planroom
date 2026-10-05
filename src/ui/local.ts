import type { View } from '../shared/view';

/**
 * Per-browser conveniences. Settings (theme, widths, send key, collapsed panes) are
 * cookies, which ignore the port, so every Planroom on this machine shares them;
 * localStorage is per port, and each Planroom gets a new one, so it keeps only one
 * session's change state (drafts, seen activity). Storage can be missing or throw
 * (private windows, blocked site data), so every access is guarded and the page
 * works without it.
 */

/**
 * The page's part of a localStorage key: its change id, and for a plan from another repo that repo, since a plan here
 * can share its id. Asks and plans have separate servers, so separate ports.
 */
export function storageScope({ changeId, elsewhere }: Pick<View, 'changeId' | 'elsewhere'>): string {
    return elsewhere ? `${elsewhere}:${changeId}` : changeId;
}

/** Browsers cap a cookie's life at 400 days; every write renews it. */
const SETTING_MAX_AGE = 400 * 24 * 60 * 60;

/** A setting shared by every Planroom on this machine, or undefined when it is missing or cookies are unavailable. */
export function readSetting(key: string): string | undefined {
    try {
        const prefix = `${encodeURIComponent(key)}=`;
        const pair = document.cookie.split('; ').find((cookie) => cookie.startsWith(prefix));
        return pair === undefined ? undefined : decodeURIComponent(pair.slice(prefix.length));
    } catch {
        return undefined;
    }
}

/**
 * Store a setting for every Planroom on this machine, or remove it when `value` is undefined. The path is `/`
 * because each session's token is in its path.
 */
export function writeSetting(key: string, value: string | undefined): void {
    const cookie = value === undefined ? '; max-age=0' : `${encodeURIComponent(value)}; max-age=${SETTING_MAX_AGE}`;
    try {
        document.cookie = `${encodeURIComponent(key)}=${cookie}; path=/; samesite=strict`;
    } catch {
        // Cookies are unavailable; the value lives only as long as the page.
    }
}

/** A stored string, or undefined when it is missing or storage is unavailable. */
function readLocal(key: string): string | undefined {
    try {
        return window.localStorage.getItem(key) ?? undefined;
    } catch {
        return undefined;
    }
}

/** Store a value, or remove the key when `value` is undefined. */
function writeLocal(key: string, value: string | undefined): void {
    try {
        if (value === undefined) window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, value);
    } catch {
        // Storage is unavailable; the value lives only as long as the page.
    }
}

/** A stored JSON value, unvalidated: callers parse it with a schema, since anything can be in storage. */
export function readJson(key: string): unknown {
    const raw = readLocal(key);
    if (raw === undefined) return undefined;
    try {
        return JSON.parse(raw);
    } catch {
        return undefined;
    }
}

/** Store a value as JSON, or remove the key when `value` is undefined. */
export function writeJson(key: string, value: unknown): void {
    writeLocal(key, value === undefined ? undefined : JSON.stringify(value));
}
