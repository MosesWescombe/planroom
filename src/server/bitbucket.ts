import type { CodeAnchor } from '../shared/review.js';
import {
    type HostAccess,
    HostError,
    type PullRequestClient,
    type PullRequestComment,
    type PullRequestRef,
    type RepoRef,
    requestJson,
    wait
} from './hosts.js';
import { git } from './worktree.js';

/**
 * The Bitbucket Cloud REST API, as much of it as a review uses: a pull request, the open one from a branch, its
 * comments, and creating comments and tasks. Only the Planroom server holds the credentials: they are read from the
 * environment and git, used in the Authorization header, and never logged, stored, or sent to the page or the agent.
 */

const API = 'https://api.bitbucket.org/2.0';
/** The scopes a review's token needs: reading PRs, commenting on them, and the repo when the diff needs it. */
export const TOKEN_SCOPES =
    'read:pullrequest:bitbucket and write:pullrequest:bitbucket (and read:repository:bitbucket if the diff needs it)';

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

/** A comment's place as Bitbucket takes it: a line on either side of the diff, a file, or none for the summary. */
function inlineOf(anchor: CodeAnchor | undefined): { path: string; to?: number; from?: number } | undefined {
    if (!anchor) return undefined;
    if (anchor.start === undefined) return { path: anchor.file };
    const line = anchor.end ?? anchor.start;
    return anchor.side === 'old' ? { path: anchor.file, from: line } : { path: anchor.file, to: line };
}

/**
 * A Bitbucket client over `fetch`: basic auth with the account email and API token when given, anonymous otherwise (a
 * public repo reads without them), and a rate-limited request retried after its `Retry-After`.
 */
export function httpBitbucket(
    auth: { email: string; token: string } | undefined,
    options: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; api?: string } = {}
): PullRequestClient {
    const send = options.fetch ?? fetch;
    const sleep = options.sleep ?? wait;
    const api = options.api ?? API;
    const headers: Record<string, string> = { accept: 'application/json' };
    if (auth) headers.authorization = `Basic ${Buffer.from(`${auth.email}:${auth.token}`).toString('base64')}`;

    const request = async (method: string, url: string, body?: unknown): Promise<Raw> => {
        const answer = await requestJson(send, sleep, url.startsWith('http') ? url : `${api}${url}`, {
            method,
            headers,
            ...(body === undefined ? {} : { body })
        });
        const json = (answer.json ?? {}) as Raw;
        if (answer.ok) return json;
        const reason = json.error?.message ?? answer.statusText;
        if (answer.status === 401 || answer.status === 403)
            throw new HostError(
                `Bitbucket refused the request (${answer.status}): ${reason}. BITBUCKET_API_TOKEN needs the scopes ${TOKEN_SCOPES}, and must belong to the account of your git email.`,
                answer.status
            );
        throw new HostError(`Bitbucket answered ${answer.status}: ${reason}`, answer.status);
    };
    const pulls = (repo: RepoRef) =>
        `/repositories/${encodeURIComponent(repo.workspace)}/${encodeURIComponent(repo.repo)}/pullrequests`;
    const path = (pr: PullRequestRef) => `${pulls(pr)}/${pr.number}`;
    const idOf = (raw: Raw): number => {
        if (typeof raw.id !== 'number') throw new HostError('Bitbucket returned no id', 502);
        return raw.id;
    };

    return {
        async pullRequest(pr) {
            const raw = await request('GET', path(pr));
            const own = `${pr.workspace}/${pr.repo}`;
            const from = raw.source?.repository?.full_name ?? own;
            return {
                title: raw.title ?? `Pull request #${pr.number}`,
                description: raw.description ?? '',
                ...(raw.author?.display_name ? { author: raw.author.display_name } : {}),
                link: raw.links?.html?.href ?? `https://bitbucket.org/${pr.workspace}/${pr.repo}/pull-requests/${pr.number}`,
                source: { branch: raw.source?.branch?.name ?? '', commit: raw.source?.commit?.hash ?? '' },
                destination: { branch: raw.destination?.branch?.name ?? '', commit: raw.destination?.commit?.hash ?? '' },
                ...(from === own ? {} : { fork: from })
            };
        },
        async openPullRequest(repo, branch) {
            const query = `source.branch.name = "${branch.replace(/["\\]/g, '\\$&')}"`;
            const page = await request('GET', `${pulls(repo)}?state=OPEN&sort=-updated_on&q=${encodeURIComponent(query)}`);
            const own = `${repo.workspace}/${repo.repo}`;
            return page.values?.find((raw) => (raw.source?.repository?.full_name ?? own) === own)?.id;
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
            const inline = inlineOf(comment.anchor);
            const raw = await request('POST', `${path(pr)}/comments`, {
                content: { raw: comment.body },
                ...(inline ? { inline } : {}),
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

/** The Bitbucket workspace and repo a remote URL points at, or undefined when it is not a Bitbucket Cloud remote. */
export function bitbucketRepo(url: string): RepoRef | undefined {
    const match = /bitbucket\.org[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
    return match ? { host: 'bitbucket', workspace: match[1]!, repo: match[2]! } : undefined;
}

/** A Bitbucket PR link's repo and number, or undefined when `link` is not one. */
export function bitbucketPullRequest(link: string): PullRequestRef | undefined {
    const match = /^https?:\/\/(?:[^@/]+@)?bitbucket\.org\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)/.exec(link);
    return match ? { host: 'bitbucket', workspace: match[1]!, repo: match[2]!, number: Number(match[3]) } : undefined;
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
export async function bitbucketAccess(repoRoot: string, env: NodeJS.ProcessEnv = process.env): Promise<HostAccess> {
    const token = env.BITBUCKET_API_TOKEN?.trim();
    const email = await gitEmail(repoRoot);
    if (token && email) return { client: httpBitbucket({ email, token }), ready: true };
    const problem = token
        ? 'Set your git email (git config user.email) to the email of the Atlassian account the API token belongs to, then reconnect planroom-review in /mcp.'
        : `Set BITBUCKET_API_TOKEN to a Bitbucket API token with the scopes ${TOKEN_SCOPES} (Atlassian account settings, Security, API tokens), then restart Claude Code.`;
    return { client: httpBitbucket(undefined), ready: false, problem };
}
