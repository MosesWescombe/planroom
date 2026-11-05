import { execFile } from 'node:child_process';
import type { CodeAnchor } from '../shared/review.js';
import {
    type HostAccess,
    HostError,
    type PullRequestClient,
    type PullRequestRef,
    type RepoRef,
    requestJson,
    wait
} from './hosts.js';

/**
 * The Azure DevOps Services REST API, as much of it as a review uses: a pull request, the open one from a branch, its
 * comment threads, and creating, replying to and resolving threads. Azure DevOps has no draft comments and no tasks:
 * each comment is a thread, published at once and active until someone resolves it, as its own page makes them. The
 * credentials are a personal access token from `AZURE_DEVOPS_EXT_PAT`, or else the Azure CLI's sign-in, and stay on
 * the Planroom server like Bitbucket's.
 */

const API = 'https://dev.azure.com';
const API_VERSION = '7.1';
/** Azure DevOps' application id, the resource an Azure CLI token is asked for. */
const RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';
/** A thread's status, by the REST API's numbers. */
const ACTIVE = 1;
const FIXED = 2;
/** How a reviewer signs in, said wherever Azure DevOps refuses them. */
export const SIGN_IN =
    'Sign in with az login and reconnect planroom-review in /mcp, or set AZURE_DEVOPS_EXT_PAT to a personal access token with the Code (Read & write) scope and restart Claude Code.';
/** How long before a token expires it is fetched again. */
const REFRESH_MS = 5 * 60_000;

/** The parts of an Azure DevOps response a review reads. */
interface Raw {
    id?: number;
    pullRequestId?: number;
    title?: string;
    description?: string;
    createdBy?: { displayName?: string };
    repository?: { webUrl?: string };
    sourceRefName?: string;
    targetRefName?: string;
    lastMergeSourceCommit?: { commitId?: string };
    lastMergeTargetCommit?: { commitId?: string };
    forkSource?: { repository?: { name?: string; project?: { name?: string } } };
    comments?: Raw[];
    parentCommentId?: number;
    author?: { displayName?: string };
    content?: string;
    publishedDate?: string;
    isDeleted?: boolean;
    commentType?: string;
    value?: Raw[];
    message?: string;
}

/** A thread's place: the file, and on lines of it, the whole lines from the start of the first to the end of the last. */
function threadContext(anchor: CodeAnchor, lastLine: string | undefined): Record<string, unknown> {
    const filePath = `/${anchor.file}`;
    if (anchor.start === undefined) return { filePath };
    const side = anchor.side === 'old' ? 'left' : 'right';
    return {
        filePath,
        [`${side}FileStart`]: { line: anchor.start, offset: 1 },
        [`${side}FileEnd`]: { line: anchor.end ?? anchor.start, offset: (lastLine?.length ?? 0) + 1 }
    };
}

/** A branch's name from its ref. */
const branchOf = (ref: string | undefined) => ref?.replace(/^refs\/heads\//, '') ?? '';

/** A repo's page, for a link when the API gives none. */
const webRepo = (repo: RepoRef) =>
    `${API}/${encodeURIComponent(repo.workspace)}/${encodeURIComponent(repo.project ?? repo.repo)}/_git/${encodeURIComponent(repo.repo)}`;

/**
 * An Azure DevOps client over `fetch`: each request carries the header `authorization` resolves to when given, and goes
 * anonymous otherwise (a public project reads without it). A rate-limited request is retried after its `Retry-After`.
 */
export function httpAzure(
    authorization: (() => Promise<string>) | undefined,
    options: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; api?: string } = {}
): PullRequestClient {
    const send = options.fetch ?? fetch;
    const sleep = options.sleep ?? wait;
    const api = options.api ?? API;

    const request = async (method: string, path: string, query: Record<string, string> = {}, body?: unknown): Promise<Raw> => {
        const headers: Record<string, string> = { accept: 'application/json' };
        if (authorization) headers.authorization = await authorization();
        const url = `${api}${path}?${new URLSearchParams({ ...query, 'api-version': API_VERSION })}`;
        const answer = await requestJson(send, sleep, url, { method, headers, ...(body === undefined ? {} : { body }) });
        const json = answer.json as Raw | undefined;
        // Without valid credentials Azure DevOps can answer 203 with its sign-in page instead of a refusal.
        if (answer.ok && json) return json;
        if (answer.ok || answer.status === 401 || answer.status === 403)
            throw new HostError(
                `Azure DevOps refused the request (${answer.ok ? 'it answered with its sign-in page' : answer.status}): ${json?.message ?? answer.statusText}. ${SIGN_IN}`,
                answer.ok ? 401 : answer.status
            );
        throw new HostError(`Azure DevOps answered ${answer.status}: ${json?.message ?? answer.statusText}`, answer.status);
    };
    const repoPath = (repo: RepoRef) => {
        if (!repo.project) throw new HostError(`${repo.workspace}/${repo.repo} names no Azure DevOps project`, 400);
        return `/${encodeURIComponent(repo.workspace)}/${encodeURIComponent(repo.project)}/_apis/git/repositories/${encodeURIComponent(repo.repo)}`;
    };
    const prPath = (pr: PullRequestRef) => `${repoPath(pr)}/pullRequests/${pr.number}`;
    const idOf = (raw: Raw): number => {
        if (typeof raw.id !== 'number') throw new HostError('Azure DevOps returned no id', 502);
        return raw.id;
    };

    return {
        async pullRequest(pr) {
            const raw = await request('GET', prPath(pr));
            const fork = raw.forkSource?.repository;
            return {
                title: raw.title ?? `Pull request ${pr.number}`,
                description: raw.description ?? '',
                ...(raw.createdBy?.displayName ? { author: raw.createdBy.displayName } : {}),
                link: `${raw.repository?.webUrl ?? webRepo(pr)}/pullrequest/${pr.number}`,
                source: { branch: branchOf(raw.sourceRefName), commit: raw.lastMergeSourceCommit?.commitId ?? '' },
                destination: { branch: branchOf(raw.targetRefName), commit: raw.lastMergeTargetCommit?.commitId ?? '' },
                ...(raw.forkSource ? { fork: [fork?.project?.name, fork?.name].filter(Boolean).join('/') || 'a fork' } : {})
            };
        },
        async openPullRequest(repo, branch) {
            const page = await request('GET', `${repoPath(repo)}/pullrequests`, {
                'searchCriteria.sourceRefName': `refs/heads/${branch}`,
                'searchCriteria.status': 'active'
            });
            return page.value?.find((raw) => !raw.forkSource)?.pullRequestId;
        },
        async comments(pr) {
            const page = await request('GET', `${prPath(pr)}/threads`);
            return (page.value ?? []).flatMap((thread) => {
                const id = idOf(thread);
                return (thread.comments ?? [])
                    .filter((comment) => comment.commentType !== 'system')
                    .map((comment) => ({
                        ...(comment.parentCommentId ? { id: comment.id ?? 0, parent: id } : { id }),
                        author: comment.author?.displayName ?? 'Someone',
                        text: comment.content ?? '',
                        at: comment.publishedDate ?? '',
                        deleted: Boolean(comment.isDeleted)
                    }));
            });
        },
        async createComment(pr, comment) {
            // Azure DevOps has no drafts, so `pending` has nothing to change: the comment is published.
            const posted = { content: comment.body, commentType: 1 };
            if (comment.parent !== undefined) {
                await request('POST', `${prPath(pr)}/threads/${comment.parent}/comments`, {}, { ...posted, parentCommentId: 1 });
                return comment.parent;
            }
            const raw = await request(
                'POST',
                `${prPath(pr)}/threads`,
                {},
                {
                    comments: [{ ...posted, parentCommentId: 0 }],
                    status: ACTIVE,
                    ...(comment.anchor ? { threadContext: threadContext(comment.anchor, comment.lastLine) } : {})
                }
            );
            return idOf(raw);
        },
        async resolveComment(pr, id) {
            await request('PATCH', `${prPath(pr)}/threads/${id}`, {}, { status: FIXED });
        }
    };
}

/** Each part of a URL's path, decoded, or undefined when one does not decode. */
function decoded(parts: (string | undefined)[]): string[] | undefined {
    try {
        return parts.map((part) => decodeURIComponent(part ?? ''));
    } catch {
        return undefined;
    }
}

/**
 * The organization, project and repo an Azure DevOps remote or web URL points at, or undefined when it is not one:
 * `https://dev.azure.com/<org>/<project>/_git/<repo>`, the older `https://<org>.visualstudio.com/<project>/_git/<repo>`
 * and their SSH forms. A repo named like its project may leave the project out.
 */
export function azureRepo(url: string): RepoRef | undefined {
    const trimmed = url.trim();
    const https =
        /^(?:https?:\/\/)?(?:[^@/]+@)?dev\.azure\.com\/([^/?#]+)\/(?:([^/?#]+)\/)?_git\/([^/?#]+)/i.exec(trimmed) ??
        /^(?:https?:\/\/)?(?:[^@/]+@)?([^./@]+)\.visualstudio\.com\/(?:DefaultCollection\/)?(?:([^/?#]+)\/)?_git\/([^/?#]+)/i.exec(
            trimmed
        );
    const ssh = /(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)(?::\d+)?[:/]v3\/([^/]+)\/([^/]+)\/([^/?#]+?)\/?$/i.exec(
        trimmed
    );
    const match = https ?? ssh;
    const parts = match && decoded([match[1], match[2] ?? match[3], match[3]]);
    if (!parts) return undefined;
    const [workspace, project, repo] = parts as [string, string, string];
    return { host: 'azure', workspace, project, repo };
}

/** An Azure DevOps PR link's repo and number, or undefined when `link` is not one. */
export function azurePullRequest(link: string): PullRequestRef | undefined {
    const number = /\/_git\/[^/?#]+\/pullrequest\/(\d+)/i.exec(link);
    const repo = number && azureRepo(link);
    return repo ? { ...repo, number: Number(number[1]) } : undefined;
}

/** A token for Azure DevOps and when it expires, in milliseconds since the epoch. */
export interface AzureToken {
    token: string;
    expiresAt: number;
}

/** A token for Azure DevOps from the Azure CLI's sign-in, as `az account get-access-token` gives one. */
export function azureCliToken(): Promise<AzureToken> {
    return new Promise((resolve, reject) => {
        execFile(
            'az',
            ['account', 'get-access-token', '--resource', RESOURCE, '--output', 'json'],
            { timeout: 60_000 },
            (error, stdout, stderr) => {
                if (error) {
                    const why =
                        (error as NodeJS.ErrnoException).code === 'ENOENT'
                            ? 'the Azure CLI (az) is not installed'
                            : stderr.trim().split('\n')[0] || error.message;
                    reject(new HostError(`Could not get an Azure DevOps token from the Azure CLI: ${why}. ${SIGN_IN}`, 401));
                    return;
                }
                try {
                    const parsed = JSON.parse(stdout) as { accessToken?: string; expires_on?: number };
                    if (!parsed.accessToken) throw new Error('no token');
                    // An older Azure CLI gives no `expires_on`: fetch again in ten minutes.
                    const expiresAt = parsed.expires_on ? parsed.expires_on * 1000 : Date.now() + 10 * 60_000;
                    resolve({ token: parsed.accessToken, expiresAt });
                } catch {
                    reject(new HostError(`The Azure CLI gave no Azure DevOps token. ${SIGN_IN}`, 401));
                }
            }
        );
    });
}

/** A bearer header from `fetchToken`'s last token, fetched again once it is within five minutes of expiring. */
export function freshBearer(fetchToken: () => Promise<AzureToken>, now: () => number = Date.now): () => Promise<string> {
    let current: AzureToken | undefined;
    return async () => {
        if (!current || current.expiresAt - now() < REFRESH_MS) current = await fetchToken();
        return `Bearer ${current.token}`;
    };
}

/**
 * Azure DevOps access: a personal access token from `AZURE_DEVOPS_EXT_PAT`, or else the Azure CLI's sign-in, checked
 * once here. Without either it reads anonymously and cannot post.
 */
export async function azureAccess(
    env: NodeJS.ProcessEnv = process.env,
    cliToken: () => Promise<AzureToken> = azureCliToken
): Promise<HostAccess> {
    const pat = env.AZURE_DEVOPS_EXT_PAT?.trim();
    if (pat) {
        const header = `Basic ${Buffer.from(`:${pat}`).toString('base64')}`;
        return { client: httpAzure(async () => header), ready: true };
    }
    const bearer = freshBearer(cliToken);
    try {
        await bearer();
        return { client: httpAzure(bearer), ready: true };
    } catch (error) {
        return { client: httpAzure(undefined), ready: false, problem: error instanceof Error ? error.message : SIGN_IN };
    }
}
