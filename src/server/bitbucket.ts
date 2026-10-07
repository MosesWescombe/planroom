import { git } from './worktree.js';

/**
 * The Bitbucket Cloud REST API, as much of it as a review uses: a pull request, its comments, and creating comments
 * and tasks. Only the Planroom server holds the credentials: they are read from the environment and git, used in the
 * Authorization header, and never logged, stored, or sent to the page or the agent.
 */

/** A pull request by workspace, repo and number. */
export interface PullRequestRef {
    workspace: string;
    repo: string;
    number: number;
}

export interface PullRequestInfo {
    title: string;
    description: string;
    author?: string;
    link: string;
    source: { branch: string; commit: string; repo: string };
    destination: { branch: string; commit: string };
}

/** A comment on a pull request, as a review reads it. */
export interface PullRequestComment {
    id: number;
    parent?: number;
    author: string;
    text: string;
    at: string;
    deleted: boolean;
}

/** Where an inline comment sits: a line on the new side of the diff (`to`), or on the old side (`from`). */
export interface InlineAnchor {
    path: string;
    to?: number;
    from?: number;
}

export interface BitbucketClient {
    pullRequest(pr: PullRequestRef): Promise<PullRequestInfo>;
    comments(pr: PullRequestRef): Promise<PullRequestComment[]>;
    /** Create a comment, a draft when `pending`, and resolve with its id. */
    createComment(
        pr: PullRequestRef,
        comment: { body: string; inline?: InlineAnchor; parent?: number; pending: boolean }
    ): Promise<number>;
    /** Create a task on a comment and resolve with its id. */
    createTask(pr: PullRequestRef, task: { comment: number; body: string; pending: boolean }): Promise<number>;
    resolveComment(pr: PullRequestRef, id: number): Promise<void>;
    resolveTask(pr: PullRequestRef, id: number): Promise<void>;
}

/** A request Bitbucket refused, with its HTTP status. */
export class BitbucketError extends Error {
    constructor(
        message: string,
        readonly status: number
    ) {
        super(message);
    }
}

const API = 'https://api.bitbucket.org/2.0';
/** The scopes a review's token needs: reading and commenting on PRs, and the repo when the diff needs it. */
export const TOKEN_SCOPES = 'read:pullrequest:bitbucket (and read:repository:bitbucket if the diff needs it)';
/** How often a rate-limited request is tried in all. */
const ATTEMPTS = 4;

/** Wait `ms` milliseconds. */
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The parts of a Bitbucket response a review reads. */
interface Raw {
    id?: number;
    title?: string;
    description?: string;
    author?: { display_name?: string };
    user?: { display_name?: string };
    links?: { html?: { href?: string } };
    source?: { branch?: { name?: string }; commit?: { hash?: string }; repository?: { full_name?: string } };
    destination?: { branch?: { name?: string }; commit?: { hash?: string } };
    content?: { raw?: string };
    parent?: { id?: number };
    created_on?: string;
    deleted?: boolean;
    values?: Raw[];
    next?: string;
    error?: { message?: string };
}

/**
 * A Bitbucket client over `fetch`: basic auth with the account email and API token when given, anonymous otherwise (a
 * public repo reads without them), and a rate-limited request retried after its `Retry-After`.
 */
export function httpBitbucket(
    auth: { email: string; token: string } | undefined,
    options: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; api?: string } = {}
): BitbucketClient {
    const send = options.fetch ?? fetch;
    const sleep = options.sleep ?? wait;
    const api = options.api ?? API;
    const headers: Record<string, string> = { accept: 'application/json' };
    if (auth) headers.authorization = `Basic ${Buffer.from(`${auth.email}:${auth.token}`).toString('base64')}`;

    const request = async (method: string, url: string, body?: unknown): Promise<Raw> => {
        for (let attempt = 1; ; attempt += 1) {
            const response = await send(url.startsWith('http') ? url : `${api}${url}`, {
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
            const json: Raw = text ? (JSON.parse(text) as Raw) : {};
            if (response.ok) return json;
            const reason = json.error?.message ?? response.statusText;
            if (response.status === 401 || response.status === 403)
                throw new BitbucketError(
                    `Bitbucket refused the request (${response.status}): ${reason}. BITBUCKET_API_TOKEN needs the scopes ${TOKEN_SCOPES}, and must belong to the account of your git email.`,
                    response.status
                );
            throw new BitbucketError(`Bitbucket answered ${response.status}: ${reason}`, response.status);
        }
    };
    const path = (pr: PullRequestRef) =>
        `/repositories/${encodeURIComponent(pr.workspace)}/${encodeURIComponent(pr.repo)}/pullrequests/${pr.number}`;
    const idOf = (raw: Raw): number => {
        if (typeof raw.id !== 'number') throw new BitbucketError('Bitbucket returned no id', 502);
        return raw.id;
    };

    return {
        async pullRequest(pr) {
            const raw = await request('GET', path(pr));
            return {
                title: raw.title ?? `Pull request #${pr.number}`,
                description: raw.description ?? '',
                ...(raw.author?.display_name ? { author: raw.author.display_name } : {}),
                link: raw.links?.html?.href ?? `https://bitbucket.org/${pr.workspace}/${pr.repo}/pull-requests/${pr.number}`,
                source: {
                    branch: raw.source?.branch?.name ?? '',
                    commit: raw.source?.commit?.hash ?? '',
                    repo: raw.source?.repository?.full_name ?? `${pr.workspace}/${pr.repo}`
                },
                destination: { branch: raw.destination?.branch?.name ?? '', commit: raw.destination?.commit?.hash ?? '' }
            };
        },
        async comments(pr) {
            const comments: PullRequestComment[] = [];
            for (let url: string | undefined = `${path(pr)}/comments?pagelen=100`; url; ) {
                const page = await request('GET', url);
                for (const raw of page.values ?? [])
                    comments.push({
                        id: idOf(raw),
                        ...(raw.parent?.id !== undefined ? { parent: raw.parent.id } : {}),
                        author: raw.user?.display_name ?? 'Someone',
                        text: raw.content?.raw ?? '',
                        at: raw.created_on ?? '',
                        deleted: Boolean(raw.deleted)
                    });
                url = page.next;
            }
            return comments;
        },
        async createComment(pr, comment) {
            const raw = await request('POST', `${path(pr)}/comments`, {
                content: { raw: comment.body },
                ...(comment.inline ? { inline: comment.inline } : {}),
                ...(comment.parent !== undefined ? { parent: { id: comment.parent } } : {}),
                pending: comment.pending
            });
            return idOf(raw);
        },
        async createTask(pr, task) {
            const raw = await request('POST', `${path(pr)}/tasks`, {
                content: { raw: task.body },
                comment: { id: task.comment },
                pending: task.pending
            });
            return idOf(raw);
        },
        async resolveComment(pr, id) {
            await request('POST', `${path(pr)}/comments/${id}/resolve`);
        },
        async resolveTask(pr, id) {
            await request('PUT', `${path(pr)}/tasks/${id}`, { state: 'RESOLVED' });
        }
    };
}

/** What a review target names: a pull request, by link or by number, or else a local branch. */
export type ParsedTarget =
    | { kind: 'pr'; number: number; repo?: { workspace: string; repo: string } }
    | { kind: 'branch'; branch: string };

/** Read a review target: a Bitbucket PR link, a bare PR number (`412` or `#412`), or a local branch name. */
export function parseTarget(target: string): ParsedTarget {
    const trimmed = target.trim();
    const link = /^https?:\/\/(?:[^@/]+@)?bitbucket\.org\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)/.exec(trimmed);
    if (link) return { kind: 'pr', number: Number(link[3]), repo: { workspace: link[1]!, repo: link[2]! } };
    const number = /^#?(\d+)$/.exec(trimmed);
    if (number) return { kind: 'pr', number: Number(number[1]) };
    return { kind: 'branch', branch: trimmed };
}

/** The Bitbucket workspace and repo a remote URL points at, or undefined when it is not a Bitbucket Cloud remote. */
export function bitbucketRepo(url: string): { workspace: string; repo: string } | undefined {
    const match = /bitbucket\.org[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
    return match ? { workspace: match[1]!, repo: match[2]! } : undefined;
}

/** A Bitbucket client and whether it can post: without both credentials it reads anonymously and posting is off. */
export interface BitbucketAccess {
    client: BitbucketClient;
    ready: boolean;
    /** What to set up, while it cannot post. */
    problem?: string;
}

/** The git email of the repo, which Bitbucket API tokens sign in with. */
async function gitEmail(repoRoot: string): Promise<string | undefined> {
    try {
        return (await git(repoRoot, ['config', 'user.email'])).trim() || undefined;
    } catch {
        return undefined;
    }
}

/** Bitbucket access from `BITBUCKET_API_TOKEN` and the repo's `git config user.email`. */
export async function bitbucketAccess(repoRoot: string, env: NodeJS.ProcessEnv = process.env): Promise<BitbucketAccess> {
    const token = env.BITBUCKET_API_TOKEN?.trim();
    const email = await gitEmail(repoRoot);
    if (token && email) return { client: httpBitbucket({ email, token }), ready: true };
    const problem = token
        ? 'Set your git email (git config user.email) to the email of the Atlassian account the API token belongs to, then reconnect planroom-review in /mcp.'
        : `Set BITBUCKET_API_TOKEN to a Bitbucket API token with the scopes ${TOKEN_SCOPES} (Atlassian account settings, Security, API tokens), then restart Claude Code.`;
    return { client: httpBitbucket(undefined), ready: false, problem };
}
