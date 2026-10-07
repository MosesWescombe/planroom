import type { NewLoggedEvent } from '../shared/events.js';
import {
    type CodeAnchor,
    currentRound,
    type DerivedComment,
    deriveComments,
    POST_AS_DRAFTS,
    type PostRecord,
    type RoundRecord
} from '../shared/review.js';
import type { SessionState } from '../shared/state.js';
import type { BitbucketClient, InlineAnchor } from './bitbucket.js';
import type { Draft } from './draft.js';
import { pullRequestOf, reanchor } from './review.js';
import { changedLines, commitOf, fetchBranch, fileAt } from './worktree.js';

/**
 * Post: the Planroom server sends a round's comments to Bitbucket from the same records, through the same derivation,
 * the preview renders, so each body sent is the body the reviewer saw. It checks the PR head first, records each
 * comment's id the moment Bitbucket returns it, and a retry sends only what failed.
 */

/** What posting needs from its session. */
export interface PostingContext {
    repoRoot: string;
    client: BitbucketClient;
    /** The session's committed state now. */
    state: () => SessionState;
    /** Apply a change through a draft, persisted before it resolves, logging the event it returns. */
    change: (fn: (draft: Draft) => NewLoggedEvent | undefined) => Promise<void>;
    /** Whether the session closed, which stops posting. */
    closed: () => boolean;
}

/** A comment's place as Bitbucket takes it: a line on either side of the diff, a file, or none for the summary. */
function inlineOf(anchor: CodeAnchor | undefined): InlineAnchor | undefined {
    if (!anchor) return undefined;
    if (anchor.start === undefined) return { path: anchor.file };
    const line = anchor.end ?? anchor.start;
    return anchor.side === 'old' ? { path: anchor.file, from: line } : { path: anchor.file, to: line };
}

/** A task's text: the comment's first line of prose, cut to a task's length. */
function taskText(comment: DerivedComment): string {
    const line = comment.text.split('\n').find((candidate) => candidate.trim() && !candidate.startsWith('```')) ?? 'Follow up';
    const plain = line.replace(/^[#>*\-\s]+/, '').trim();
    return plain.length > 200 ? `${plain.slice(0, 199)}…` : plain;
}

/** An error in words for the page, never with a request's credentials, which no error here carries. */
function reason(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Record one comment's outcome in the current round's posts. */
function record(key: string, post: PostRecord): (draft: Draft) => undefined {
    return (draft) => {
        const round = currentRound(draft.state.review!);
        draft.updateRound(round.n, (current) => ({ ...current, posts: { ...current.posts, [key]: post } }));
        return undefined;
    };
}

/**
 * The comments not yet sent that sit on lines the author changed since `round.head`, which moved to `head`: each needs
 * the reviewer to choose re-anchor, drop or post anyway.
 */
async function onChangedLines(repoRoot: string, round: RoundRecord, head: string, comments: DerivedComment[]): Promise<string[]> {
    const keys: string[] = [];
    for (const comment of comments) {
        const { anchor } = comment;
        if (round.posts[comment.key]?.id !== undefined || !anchor || anchor.side === 'old') continue;
        if (!(await fileAt(repoRoot, head, anchor.file))) {
            keys.push(comment.key);
            continue;
        }
        if (anchor.start === undefined) continue;
        const { touched } = await changedLines(repoRoot, round.head, head, anchor.file);
        for (let line = anchor.start; line <= (anchor.end ?? anchor.start); line += 1)
            if (touched.has(line)) {
                keys.push(comment.key);
                break;
            }
    }
    return keys;
}

/**
 * Post the current round: check the head, then create each comment not yet sent, the summary last, then the tasks,
 * then resolve the earlier comments the reviewer confirmed. It never throws: the outcome lands in the round's
 * `posting`, `posts` and `postedAt`, and a `review.posted` event when it ran to the end.
 */
export async function postRound(context: PostingContext, choices: Record<string, 'reanchor' | 'drop' | 'anyway'>): Promise<void> {
    const { repoRoot, client } = context;
    const stopWith = (patch: Pick<RoundRecord, 'posting'>) =>
        context.change((draft) => {
            draft.updateRound(currentRound(draft.state.review!).n, (current) => ({ ...current, ...patch }));
            return undefined;
        });
    try {
        const state = context.state();
        const review = state.review!;
        const pr = pullRequestOf(review.target)!;
        const round = currentRound(review);
        const comments = deriveComments(state, round.n);

        const info = await client.pullRequest(pr);
        let movedTo: string | undefined;
        if (!round.head.startsWith(info.source.commit)) {
            await fetchBranch(repoRoot, info.source.branch);
            movedTo = await commitOf(repoRoot, info.source.commit);
            if (!movedTo) throw new Error(`the PR head moved to ${info.source.commit}, which could not be fetched`);
            const keys = await onChangedLines(repoRoot, round, movedTo, comments);
            if (keys.some((key) => !choices[key])) {
                await stopWith({ posting: { state: 'moved', at: new Date().toISOString(), moved: { head: movedTo, keys } } });
                return;
            }
        }

        const sent = { ...round.posts };
        for (const comment of comments) {
            if (context.closed()) return;
            if (sent[comment.key]?.id !== undefined || sent[comment.key]?.dropped) continue;
            const at = new Date().toISOString();
            const choice = choices[comment.key];
            if (choice === 'drop') {
                sent[comment.key] = { body: comment.body, dropped: true, at };
                await context.change(record(comment.key, sent[comment.key]!));
                continue;
            }
            const anchor =
                choice === 'reanchor' && movedTo && comment.anchor
                    ? await reanchor(repoRoot, round.head, movedTo, comment.anchor)
                    : comment.anchor;
            const parent = comment.replyTo ? round.earlier[comment.replyTo]?.post.id : undefined;
            const inline = inlineOf(anchor);
            try {
                const id = await client.createComment(pr, {
                    body: comment.body,
                    ...(inline ? { inline } : {}),
                    ...(parent !== undefined ? { parent } : {}),
                    pending: POST_AS_DRAFTS
                });
                sent[comment.key] = { id, body: comment.body, ...(anchor ? { anchor } : {}), at };
            } catch (error) {
                sent[comment.key] = { body: comment.body, ...(anchor ? { anchor } : {}), error: reason(error), at };
            }
            await context.change(record(comment.key, sent[comment.key]!));
        }

        for (const comment of comments) {
            const post = sent[comment.key];
            if (context.closed()) return;
            if (!comment.task || post?.id === undefined || post.taskId !== undefined) continue;
            try {
                const taskId = await client.createTask(pr, {
                    comment: post.id,
                    body: taskText(comment),
                    pending: POST_AS_DRAFTS
                });
                sent[comment.key] = { ...post, taskId };
            } catch (error) {
                sent[comment.key] = { ...post, error: `the task failed: ${reason(error)}` };
            }
            await context.change(record(comment.key, sent[comment.key]!));
        }

        const resolved: Record<string, string> = {};
        const failedResolves: string[] = [];
        for (const [key, entry] of Object.entries(round.earlier)) {
            if (!entry.confirmed || entry.resolvedAt || entry.post.id === undefined) continue;
            try {
                await client.resolveComment(pr, entry.post.id);
                if (entry.post.taskId !== undefined) await client.resolveTask(pr, entry.post.taskId);
                resolved[key] = new Date().toISOString();
            } catch (error) {
                failedResolves.push(key);
                console.error(`planroom: could not resolve ${key}: ${reason(error)}`);
            }
        }

        const failed = [
            ...comments.filter((comment) => sent[comment.key]?.error !== undefined).map((comment) => comment.key),
            ...failedResolves
        ];
        const posted = comments.filter((comment) => sent[comment.key]?.id !== undefined).length;
        await context.change((draft) => {
            const n = currentRound(draft.state.review!).n;
            const now = draft.now;
            draft.updateRound(n, (current) => {
                const earlier = Object.fromEntries(
                    Object.entries(current.earlier).map(([key, entry]) => [
                        key,
                        resolved[key] ? { ...entry, resolvedAt: resolved[key] } : entry
                    ])
                );
                const { posting: _posting, ...rest } = current;
                return failed.length
                    ? { ...rest, earlier, posting: { state: 'partial', at: now } }
                    : { ...rest, earlier, postedAt: now };
            });
            draft.note({
                title: failed.length ? `Posted ${posted} of ${comments.length} comments` : 'Posted the review',
                ...(failed.length
                    ? { detail: `${failed.length} failed; retry to send only those`, kind: 'attention' as const }
                    : {})
            });
            return { type: 'review.posted', round: n, posted, total: comments.length, failed, drafts: POST_AS_DRAFTS };
        });
    } catch (error) {
        await stopWith({ posting: { state: 'error', at: new Date().toISOString(), error: reason(error) } });
    }
}
