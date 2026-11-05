import type { CodeAnchor, PrHost } from '../shared/review.js';

/**
 * What a review needs from the host its pull request is on, Bitbucket Cloud or Azure DevOps: the pull request, the open
 * one from a branch, its comments, and creating and resolving comments. Only the Planroom server holds the credentials:
 * they are read from the environment, git or the Azure CLI, used in the Authorization header, and never logged, stored,
 * or sent to the page or the agent.
 */

/** A repo on a host: a Bitbucket workspace's repo, or a repo of an Azure DevOps organization's project. */
export interface RepoRef {
    host: PrHost;
    /** The Bitbucket workspace, or the Azure DevOps organization. */
    workspace: string;
    /** The Azure DevOps project; Bitbucket has none. */
    project?: string;
    repo: string;
}

/** A pull request by its repo and number. */
export interface PullRequestRef extends RepoRef {
    number: number;
}

export interface PullRequestInfo {
    title: string;
    description: string;
    author?: string;
    link: string;
    source: { branch: string; commit: string };
    destination: { branch: string; commit: string };
    /** The fork it comes from, when it is not from the repo itself. */
    fork?: string;
}

/**
 * A comment on a pull request, as a review reads it. On Azure DevOps, a thread's first comment carries the thread's id
 * and every reply in it has the thread as its `parent`.
 */
export interface PullRequestComment {
    id: number;
    parent?: number;
    author: string;
    text: string;
    at: string;
    deleted: boolean;
}

/** A comment to create: on the pull request, on a file, or on lines of one, or else a reply to `parent`. */
export interface NewComment {
    body: string;
    anchor?: CodeAnchor;
    /** The text of the anchor's last line, for a host that selects lines by column. */
    lastLine?: string;
    parent?: number;
    /** A draft the reviewer publishes on the host, where it has drafts. */
    pending: boolean;
}

export interface PullRequestClient {
    pullRequest(pr: PullRequestRef): Promise<PullRequestInfo>;
    /** The number of the newest open pull request from `branch` of the repo itself, not a fork, if there is one. */
    openPullRequest(repo: RepoRef, branch: string): Promise<number | undefined>;
    comments(pr: PullRequestRef): Promise<PullRequestComment[]>;
    /** Create a comment and resolve with its id, which a reply names as its `parent`. */
    createComment(pr: PullRequestRef, comment: NewComment): Promise<number>;
    /** Create a task on a comment and resolve with its id, on a host that has tasks. */
    createTask?(pr: PullRequestRef, task: { comment: number; body: string; pending: boolean }): Promise<number>;
    resolveComment(pr: PullRequestRef, id: number): Promise<void>;
    resolveTask?(pr: PullRequestRef, id: number): Promise<void>;
}

/** A client and whether it can post: without credentials it reads anonymously and posting is off. */
export interface HostAccess {
    client: PullRequestClient;
    ready: boolean;
    /** What to set up, while it cannot post. */
    problem?: string;
}

/** A request the host refused, with its HTTP status. */
export class HostError extends Error {
    constructor(
        message: string,
        readonly status: number
    ) {
        super(message);
    }
}

/** How often a rate-limited request is tried in all. */
const ATTEMPTS = 4;

/** Wait `ms` milliseconds. */
export const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A host's answer: its status, and its body parsed when it is JSON. */
export interface JsonAnswer {
    ok: boolean;
    status: number;
    statusText: string;
    json?: unknown;
}

/**
 * Send one request with a JSON body, if any, retrying a rate-limited one (429) after its `Retry-After`, or with a
 * growing wait without one.
 */
export async function requestJson(
    send: typeof fetch,
    sleep: (ms: number) => Promise<void>,
    url: string,
    init: { method: string; headers: Record<string, string>; body?: unknown }
): Promise<JsonAnswer> {
    const { method, headers, body } = init;
    for (let attempt = 1; ; attempt += 1) {
        const response = await send(url, {
            method,
            headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) })
        });
        if (response.status === 429 && attempt < ATTEMPTS) {
            const after = Number(response.headers.get('retry-after'));
            await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 2 ** attempt * 500);
            continue;
        }
        const text = await response.text();
        let json: unknown;
        try {
            json = text ? JSON.parse(text) : {};
        } catch {
            json = undefined;
        }
        return { ok: response.ok, status: response.status, statusText: response.statusText, json };
    }
}
