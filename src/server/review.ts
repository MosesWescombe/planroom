import {
    type CodeAnchor,
    currentRound,
    type EarlierRecord,
    type ReviewRecord,
    type ReviewTarget,
    type RoundRecord
} from '../shared/review.js';
import { REVIEW_ROOT } from '../shared/state.js';
import { type BitbucketAccess, bitbucketRepo, type PullRequestRef, parseTarget } from './bitbucket.js';
import { RejectedError } from './draft.js';
import {
    changedFiles,
    changedLines,
    commitOf,
    defaultBranch,
    fetchBranch,
    fileAt,
    git,
    mergeBase,
    originUrl
} from './worktree.js';

/**
 * Opening a review: what its target names, the commits to review, and the rounds a review moves through as the author
 * pushes. Everything here reads git and, for a PR, Bitbucket; it writes nothing.
 */

/** What a review needs besides its session: Bitbucket access and where this machine keeps its preferences. */
export interface ReviewHost {
    access: BitbucketAccess;
    preferencesFile: string;
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

/** The PR a review is of, as the Bitbucket client addresses it. */
export function pullRequestOf(target: ReviewTarget): PullRequestRef | undefined {
    return target.kind === 'pr' ? { workspace: target.workspace, repo: target.repo, number: target.number } : undefined;
}

/** Refuse with one issue at `target`. */
function refuse(message: string, status: 400 | 404 | 409 = 400): never {
    throw new RejectedError([{ path: 'target', message }], status);
}

/**
 * Resolve a review target: a PR link names its workspace, repo and number; a bare number takes them from `origin`;
 * anything else is a local branch, reviewed against its merge base with the default branch without any network call.
 * A PR's source and destination branches are fetched so its commits can be read here.
 */
export async function resolveTarget(repoRoot: string, raw: string, access: BitbucketAccess): Promise<ResolvedTarget> {
    const parsed = parseTarget(raw);
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
    const origin = url ? bitbucketRepo(url) : undefined;
    const repo = parsed.repo ?? origin;
    if (!repo)
        refuse(
            url
                ? `Could not determine the workspace and repo: origin (${url}) is not on bitbucket.org. Give the PR link instead.`
                : 'Could not determine the workspace and repo: this checkout has no origin remote. Give the PR link instead.'
        );
    if (!origin || origin.workspace !== repo.workspace || origin.repo !== repo.repo)
        refuse(`This checkout is not of ${repo.workspace}/${repo.repo}: review it from a checkout of that repo.`);
    const ref = { ...repo, number: parsed.number };
    const pr = await access.client.pullRequest(ref);
    if (pr.source.repo !== `${repo.workspace}/${repo.repo}`)
        // ponytail: a fork's PR needs its commits fetched from the fork; add a remote for it when that is needed.
        refuse(`Pull request ${parsed.number} comes from the fork ${pr.source.repo}, which a review cannot fetch yet.`);
    await fetchBranch(repoRoot, pr.source.branch);
    await fetchBranch(repoRoot, pr.destination.branch);
    const head = await commitOf(repoRoot, pr.source.commit);
    const destination = await commitOf(repoRoot, pr.destination.commit);
    if (!head || !destination) refuse(`Fetched ${pr.source.branch}, but commit ${pr.source.commit} is not in it`, 409);
    return {
        id: `pr-${parsed.number}`,
        target: { kind: 'pr', workspace: repo.workspace, repo: repo.repo, number: parsed.number },
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
 * The round after the review's current one, for the author's push to `head`: the diff from the reviewed head to it,
 * and every comment posted in an earlier round and not yet resolved, with the author's replies from its thread. A
 * comment whose lines the push removed is labelled outdated.
 */
export async function nextRound(
    repoRoot: string,
    review: ReviewRecord,
    head: string,
    access: BitbucketAccess,
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
    return {
        n: previous.n + 1,
        base: previous.head,
        head,
        files: await changedFiles(repoRoot, previous.head, head),
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
