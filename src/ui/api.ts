import type { PageRequest } from '../shared/events';
import type { Issue } from '../shared/issues';
import type { Revision } from '../shared/revisions';
import type { PlanListing, StreamMessage } from '../shared/view';

/**
 * The page's calls to its own server. Every path is relative, so it stays under the
 * session token in the page's URL (`/<token>/api/...`).
 */

/** A request the server refused, with its reasons. */
export class RequestError extends Error {
    /** `status` is the HTTP status; `issues` are the server's reasons, empty when it gave none. */
    constructor(
        message: string,
        readonly status: number,
        readonly issues: Issue[]
    ) {
        super(message);
    }
}

/** Read a response's JSON body, throwing a `RequestError` with the server's reasons when it is not OK. */
async function json<T>(response: Response): Promise<T> {
    const body = (await response.json().catch(() => ({}))) as { error?: string; issues?: Issue[] };
    if (!response.ok)
        throw new RequestError(body.error ?? `The server answered ${response.status}`, response.status, body.issues ?? []);
    return body as T;
}

/** The input the page sends: the parsed request, before server-side defaults. */
export type PageInput = PageRequest extends infer R
    ? R extends { type: 'phase.submit' }
        ? Omit<R, 'anyway'> & { anyway?: boolean }
        : R
    : never;

/** Post a page event. Resolves with the event's `seq` once it is persisted. */
export async function postEvent(request: PageInput): Promise<{ seq?: number }> {
    const response = await fetch('api/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request)
    });
    return json(response);
}

/** Fetch revision `n` in full, for the history and diff views. */
export async function fetchRevision(n: number): Promise<Revision> {
    return json(await fetch(`api/revisions/${n}`));
}

export interface CodeExcerpt {
    file: string;
    start: number;
    end: number;
    lines: string[];
}

/** Fetch lines of a git-tracked file for a `code` excerpt. `lines` is a line number or a range such as "12-15". */
export async function fetchExcerpt(file: string, lines: string): Promise<CodeExcerpt> {
    return json(await fetch(`api/code?${new URLSearchParams({ file, lines }).toString()}`));
}

/** One review round's diff of `file`, cached per round and file: a round's commits never change. */
const diffs = new Map<string, Promise<string>>();

/** Fetch a review round's unified diff of one file. A failed fetch is forgotten, so the next asks again. */
export function fetchDiff(round: number, file: string): Promise<string> {
    const key = JSON.stringify([round, file]);
    let patch = diffs.get(key);
    if (!patch) {
        patch = fetch(`api/review/diff?${new URLSearchParams({ round: String(round), file }).toString()}`)
            .then((response) => json<{ patch: string }>(response))
            .then((body) => body.patch);
        patch.catch(() => diffs.delete(key));
        diffs.set(key, patch);
    }
    return patch;
}

/** Save a pasted image in the change's assets. Resolves with its asset name. */
export async function uploadAsset(image: Blob): Promise<string> {
    const response = await fetch('api/assets', { method: 'POST', headers: { 'content-type': image.type }, body: image });
    return (await json<{ asset: string }>(response)).asset;
}

/** Every plan in this repo and in the other repos Planroom has run in, most recently changed first, and how they open. */
export async function fetchPlans(): Promise<PlanListing> {
    return json(await fetch('api/plans'));
}

/**
 * Switch Planroom to another plan, or with `repoRoot` show another repo's plan read-only. Resolves with that plan's
 * page URL, for the page to load.
 */
export async function openPlan(changeId: string, repoRoot?: string): Promise<string> {
    const response = await fetch('api/plans/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ changeId, repoRoot })
    });
    return (await json<{ url: string }>(response)).url;
}

/** The URL an `asset:<name>` image is served at; `still` asks for an SVG with its animation taken out. */
export function assetUrl(src: string, still = false): string {
    const name = encodeURIComponent(src.replace(/^asset:/, ''));
    return still && /\.svg$/i.test(name) ? `api/assets/${name}?still=1` : `api/assets/${name}`;
}

/**
 * Follow the server's event stream: a snapshot on every (re)connect, then patches.
 * EventSource reconnects by itself until the server says the session is closed; this reports each state change.
 */
export function openStream(handlers: {
    onMessage: (message: Exclude<StreamMessage, { type: 'closed' }>) => void;
    onState: (state: 'live' | 'reconnecting' | 'closed') => void;
}): () => void {
    const source = new EventSource('api/stream');
    source.onopen = () => handlers.onState('live');
    source.onerror = () => handlers.onState('reconnecting');
    source.onmessage = (event: MessageEvent<string>) => {
        let message: StreamMessage;
        try {
            message = JSON.parse(event.data) as StreamMessage;
        } catch {
            // A malformed frame is skipped; the next snapshot corrects any gap.
            return;
        }
        if (message.type !== 'closed') {
            handlers.onMessage(message);
            return;
        }
        source.close();
        handlers.onState('closed');
    };
    return () => source.close();
}
