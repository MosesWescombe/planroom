import {
    type CodeAnchor,
    currentRound,
    type EarlierRecord,
    type ReviewRecord,
    type ReviewTarget,
    type RoundRecord
} from '../shared/review.js';
import { REVIEW_ROOT } from '../shared/state.js';
import { azureAccess, azurePullRequest, azureRepo } from './azure.js';
import { bitbucketAccess, bitbucketPullRequest, bitbucketRepo } from './bitbucket.js';
import { RejectedError } from './draft.js';
import type { HostAccess, PullRequestRef, RepoRef } from './hosts.js';
import { buildLineIndex } from './lineIndex.js';
import {
    changedFiles,
    changedLines,
    commitOf,
    defaultBranch,
    fetchBranch,
    fileAt,
    git,
    isAncestor,
    mergeBase,
    mergeCommit,
    originUrl
} from './worktree.js';

/**
 * Opening a review: what its target names, the commits to review, and the rounds a review moves through as the author
 * pushes. Everything here reads git and, for a PR, its host, Bitbucket Cloud or Azure DevOps, which the `origin`
 * remote names; it writes nothing but the merge commit a round after a merge of the destination diffs from.
 */

/** What a review needs besides its session: access to the PR host and where this machine keeps its preferences. */
export interface ReviewHost {
    access: HostAccess;
    preferencesFile: string;
}

/** The repo a remote URL points at on Bitbucket Cloud or Azure DevOps, or undefined when it is on neither. */
export function remoteRepo(url: string): RepoRef | undefined {
    return bitbucketRepo(url) ?? azureRepo(url);
}

/**
 * Access to the host the repo's `origin` is on: Azure DevOps for an Azure DevOps remote, and Bitbucket for any other,
 * whose credentials say what to set up when a PR is reviewed there.
 */
export async function hostAccess(repoRoot: string, env: NodeJS.ProcessEnv = process.env): Promise<HostAccess> {
    const url = await originUrl(repoRoot);
    return url && azureRepo(url) ? azureAccess(env) : bitbucketAccess(repoRoot, env);
}

/** What a review target names: a pull request, by link or by number, or else a local branch. */
export type ParsedTarget = { kind: 'pr'; number: number; repo?: RepoRef } | { kind: 'branch'; branch: string };

/**
 * Read a review target: a Bitbucket or Azure DevOps PR link, a bare PR number (`412`, `#412` or `!412`), or a local
 * branch name.
 */
export function parseTarget(target: string): ParsedTarget {
    const trimmed = target.trim();
    const link = bitbucketPullRequest(trimmed) ?? azurePullRequest(trimmed);
    if (link) {
        const { number, ...repo } = link;
        return { kind: 'pr', number, repo };
    }
    const number = /^[#!]?(\d+)$/.exec(trimmed);
    if (number) return { kind: 'pr', number: Number(number[1]) };
    return { kind: 'branch', branch: trimmed };
}

/** A repo as a reader names it: `workspace/repo`, or `organization/project/repo` on Azure DevOps. */
function repoName(repo: RepoRef): string {
    return [repo.workspace, repo.project, repo.repo].filter(Boolean).join('/');
}

/** Whether two refs name one repo; the hosts match names without regard to case. */
function sameRepo(a: RepoRef, b: RepoRef): boolean {
    return a.host === b.host && repoName(a).toLowerCase() === repoName(b).toLowerCase();
}

/** A target resolved to the review it names and the commits to review now. */
export interface ResolvedTarget {
    /** `pr-<number>` or `branch-<name>`, kebab-case. */
    id: string;
    target: ReviewTarget;
    title: string;
    description: string;
    author?: string;
    link?: string;
    source?: string;
    destination?: string;
    /** The commit under review, in full. */
    head: string;
    /** Where the change left its base: the merge base with the destination or default branch. */
    base: string;
}

/** A branch name as a review id's kebab-case tail. */
export function branchSlug(branch: string): string {
    return (
        branch
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 80)
            .replace(/-+$/, '') || 'branch'
    );
}

/** The PR a review is of, as its host's client addresses it. */
export function pullRequestOf(target: ReviewTarget): PullRequestRef | undefined {
    if (target.kind !== 'pr') return undefined;
    const { kind: _kind, ...pr } = target;
    return pr;
}

/** Refuse with one issue at `target`. */
function refuse(message: string, status: 400 | 404 | 409 = 400): never {
    throw new RejectedError([{ path: 'target', message }], status);
}

/**
 * The open PR from `branch` in the `origin` repo on its host, if there is one. Without an origin on a host, or when the
 * host cannot be asked, there is none.
 */
async function openPullRequestFrom(repoRoot: string, branch: string, access: HostAccess): Promise<number | undefined> {
    const url = await originUrl(repoRoot);
    const repo = url ? remoteRepo(url) : undefined;
    if (!repo) return undefined;
    try {
        return await access.client.openPullRequest(repo, branch);
    } catch (error) {
        console.error(`planroom: could not look up an open PR from ${branch}; reviewing the branch`, error);
        return undefined;
    }
}

/**
 * Resolve a review target: a PR link names its host, repo and number; a bare number takes them from `origin`; anything
 * else is a branch: the open PR from it in the `origin` repo on its host, or with none, or when `local`, the
 * local branch, reviewed against its merge base with the default branch without any further network call. A PR's
 * source and destination branches are fetched so its commits can be read here.
 */
export async function resolveTarget(repoRoot: string, raw: string, access: HostAccess, local = false): Promise<ResolvedTarget> {
    let parsed = parseTarget(raw);
    const open = parsed.kind === 'branch' && !local ? await openPullRequestFrom(repoRoot, parsed.branch, access) : undefined;
    if (open !== undefined) parsed = { kind: 'pr', number: open };
    if (parsed.kind === 'branch') {
        const { branch } = parsed;
        const head = (await commitOf(repoRoot, `refs/heads/${branch}`)) ?? (await commitOf(repoRoot, branch));
        if (!head) refuse(`"${branch}" is not a PR link, a PR number or a branch of this repo`, 404);
        const baseBranch = await defaultBranch(repoRoot);
        const base = await mergeBase(repoRoot, baseBranch, head);
        const subjects = (await git(repoRoot, ['log', '--format=- %s', `${base}..${head}`])).trim();
        return {
            id: `branch-${branchSlug(branch)}`,
            target: { kind: 'branch', branch, base: baseBranch },
            title: branch,
            description: subjects,
            source: branch,
            destination: baseBranch,
            head,
            base
        };
    }
    const url = await originUrl(repoRoot);
    const origin = url ? remoteRepo(url) : undefined;
    const repo = parsed.repo ?? origin;
    if (!repo)
        refuse(
            url
                ? `Could not determine the workspace and repo: origin (${url}) is not on Bitbucket Cloud or Azure DevOps. Give the PR link instead.`
                : 'Could not determine the workspace and repo: this checkout has no origin remote. Give the PR link instead.'
        );
    if (!origin || !sameRepo(origin, repo))
        refuse(`This checkout is not of ${repoName(repo)}: review it from a checkout of that repo.`);
    // The origin's own spelling, which the host's client was made for.
    const ref = { ...origin, number: parsed.number };
    const pr = await access.client.pullRequest(ref);
    if (pr.fork)
        // ponytail: a fork's PR needs its commits fetched from the fork; add a remote for it when that is needed.
        refuse(`Pull request ${parsed.number} comes from the fork ${pr.fork}, which a review cannot fetch yet.`);
    await fetchBranch(repoRoot, pr.source.branch);
    await fetchBranch(repoRoot, pr.destination.branch);
    const head = await commitOf(repoRoot, pr.source.commit);
    const destination = await commitOf(repoRoot, pr.destination.commit);
    if (!head || !destination) refuse(`Fetched ${pr.source.branch}, but commit ${pr.source.commit} is not in it`, 409);
    return {
        id: `pr-${parsed.number}`,
        target: { kind: 'pr', ...ref },
        title: pr.title,
        description: pr.description,
        ...(pr.author ? { author: pr.author } : {}),
        link: pr.link,
        source: pr.source.branch,
        destination: pr.destination.branch,
        head,
        base: await mergeBase(repoRoot, destination, head)
    };
}

/** A new review of `resolved`: its summary and round 1, from the merge base to the head. */
export async function freshReview(repoRoot: string, resolved: ResolvedTarget, now: string): Promise<ReviewRecord> {
    const { id, head, base, target, title, description, author, link, source, destination } = resolved;
    return {
        target,
        title,
        description,
        ...(author ? { author } : {}),
        ...(link ? { link } : {}),
        ...(source ? { source } : {}),
        ...(destination ? { destination } : {}),
        worktree: `${REVIEW_ROOT}/${id}/worktree`,
        rounds: [
            {
                n: 1,
                base,
                head,
                files: await changedFiles(repoRoot, base, head),
                index: await buildLineIndex(repoRoot, base, head),
                startedAt: now,
                summary: {},
                posts: {},
                earlier: {}
            }
        ]
    };
}

/** Whether every line `anchor` names was removed by the change behind `lines`, or its whole file was. */
async function outdated(repoRoot: string, from: string, to: string, anchor: CodeAnchor | undefined): Promise<boolean> {
    if (!anchor?.start || anchor.side === 'old') return false;
    if (!(await fileAt(repoRoot, to, anchor.file))) return true;
    const { removed } = await changedLines(repoRoot, from, to, anchor.file);
    for (let line = anchor.start; line <= (anchor.end ?? anchor.start); line += 1) if (!removed.has(line)) return false;
    return true;
}

/**
 * The commit a round after the first diffs from: the reviewed head, with `destination` (where the new head left the
 * destination branch) merged in when the head took in more of it, so a merge of the destination stays out of the
 * round. A merge that conflicts keeps the reviewed head.
 */
async function roundBase(repoRoot: string, reviewedHead: string, destination: string): Promise<string> {
    if (await isAncestor(repoRoot, destination, reviewedHead)) return reviewedHead;
    // ponytail: on a conflict the round also shows the merged-in work; resolving it as the head did would drop that.
    return (
        (await mergeCommit(repoRoot, reviewedHead, destination, 'Planroom: the reviewed head with the destination merged in')) ??
        reviewedHead
    );
}

/**
 * The round after the review's current one, for the author's push to `head`, which left the destination branch at
 * `destination`: the diff to it from the reviewed head (see `roundBase`), and every comment posted in an earlier round
 * and not yet resolved, with the author's replies from its thread. A comment whose lines the push removed is labelled
 * outdated.
 */
export async function nextRound(
    repoRoot: string,
    review: ReviewRecord,
    head: string,
    destination: string,
    access: HostAccess,
    now: string
): Promise<RoundRecord> {
    const previous = currentRound(review);
    const carried: [string, EarlierRecord][] = Object.entries(previous.earlier).filter(([, entry]) => !entry.resolvedAt);
    const posted: [string, EarlierRecord][] = Object.entries(previous.posts).flatMap(([key, post]) =>
        post.id !== undefined && key !== 'summary'
            ? [[`${previous.n}/${key}`, { round: previous.n, key, post, replies: [] }]]
            : []
    );
    const earlier = Object.fromEntries([...carried, ...posted]);
    const pr = pullRequestOf(review.target);
    const thread = pr
        ? await access.client.comments(pr).catch((error: unknown) => {
              console.error('planroom: could not read the PR comments for the next round', error);
              return [];
          })
        : [];
    for (const [key, entry] of Object.entries(earlier)) {
        const replies = thread
            .filter((comment) => comment.parent === entry.post.id && !comment.deleted)
            .map((comment) => ({ author: comment.author, text: comment.text, at: comment.at }));
        const gone = await outdated(repoRoot, previous.head, head, entry.post.anchor);
        earlier[key] = { ...entry, replies, ...(gone ? { label: 'outdated' as const } : {}) };
    }
    const base = await roundBase(repoRoot, previous.head, destination);
    return {
        n: previous.n + 1,
        base,
        head,
        files: await changedFiles(repoRoot, base, head),
        index: await buildLineIndex(repoRoot, base, head),
        startedAt: now,
        summary: {},
        posts: {},
        earlier
    };
}

/**
 * Where `anchor`'s lines are at `to`: the first line's text found nearest its old place, keeping the range's length.
 * Not found, it falls back to the whole file, and with the file gone, to no anchor at all.
 */
export async function reanchor(repoRoot: string, from: string, to: string, anchor: CodeAnchor): Promise<CodeAnchor | undefined> {
    const after = await fileAt(repoRoot, to, anchor.file);
    if (!after) return undefined;
    if (anchor.start === undefined) return anchor;
    const line = (await fileAt(repoRoot, from, anchor.file))?.[anchor.start - 1];
    const span = (anchor.end ?? anchor.start) - anchor.start;
    const matches = after.flatMap((text, index) => (text === line ? [index + 1] : []));
    if (line === undefined || line.trim() === '' || matches.length === 0) return { file: anchor.file, side: anchor.side };
    const start = matches.reduce((best, candidate) =>
        Math.abs(candidate - anchor.start!) < Math.abs(best - anchor.start!) ? candidate : best
    );
    return { ...anchor, start, ...(anchor.end !== undefined ? { end: start + span } : {}) };
}
