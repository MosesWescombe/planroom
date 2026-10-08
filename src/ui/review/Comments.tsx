import { useEffect, useMemo, useState } from 'react';
import {
    commentsMarkdown,
    type DerivedComment,
    deriveComments,
    describeCodeAnchor,
    type EarlierLabel,
    findingsUnlocked,
    POST_AS_DRAFTS,
    type RoundRecord,
    SIGN_OFF,
    SIGN_OFF_LOCK,
    unreacted
} from '../../shared/review';
import { CodeViewer } from '../code/CodeViewer';
import { CheckIcon, WarningIcon } from '../components/icons';
import { BitbucketMarkdown } from '../components/Markdown';
import { Modal } from '../components/Modal';
import { Rail } from '../components/Rail';
import { plural } from '../format';
import { useReadOnly } from '../readOnly';
import { deepEqual, useSelector } from '../store';
import { quietly, useActions, useBusy } from '../ui';
import { BitbucketComment, CommentEditor } from './BitbucketComment';
import { FileTreeSelect } from './FileTreeSelect';
import { KIND_NAMES } from './Findings';
import { useIsCurrentRound, useShownRound } from './hooks';

/** Where each comment came from, as its card says. */
const SOURCES: Record<DerivedComment['source'], string> = {
    agree: 'You agreed',
    reword: 'You reworded it',
    note: 'Your comment',
    summary: 'Summary'
};

/**
 * One comment as Bitbucket will show it, anchored to its diff lines, with how much of it is the reviewer's own, its
 * sign-off and its task, and what happened when it was posted.
 */
function CommentCard({ comment, round, editable }: { comment: DerivedComment; round: RoundRecord; editable: boolean }) {
    const { send } = useActions();
    const [busy, track] = useBusy();
    const [editing, setEditing] = useState(false);
    const [text, setText] = useState(comment.text);
    const post = round.posts[comment.key];
    const sent = post?.id !== undefined || Boolean(post?.dropped);
    const choose = (choice: { task?: boolean; unsigned?: boolean }) =>
        quietly(send({ type: 'comment.choose', key: comment.key, ...choice }));
    const title = useSelector((view) => (comment.itemId ? view.items[comment.itemId]?.kind : undefined));
    const note = useSelector((view) => (comment.source === 'note' ? view.notes[comment.key.slice(5)] : undefined), deepEqual);
    // The summary has its own editor below it.
    const canEdit = editable && !sent && comment.source !== 'summary';
    // A finding's comment saves as a reword of it; a comment of the reviewer's own saves in place.
    const save = () =>
        quietly(
            track(
                note
                    ? send({ type: 'note.save', id: note.id, ...(note.anchor ? { anchor: note.anchor } : {}), text })
                    : send({ type: 'item.react', itemId: comment.itemId!, verdict: 'reword', text })
            ).then(() => setEditing(false))
        );
    return (
        <BitbucketComment
            round={round.n}
            anchor={comment.anchor}
            body={comment.body}
            id={`comment-${comment.key}`}
            summary={comment.key === 'summary'}
            target={`comment:${comment.key}`}
            editor={
                editing ? (
                    <form
                        className="reaction-form"
                        onSubmit={(event) => {
                            event.preventDefault();
                            save();
                        }}
                    >
                        <CommentEditor
                            id={`edit-${comment.key}`}
                            label="Edit the comment"
                            value={text}
                            signed={comment.signed}
                            onChange={setText}
                        />
                        <div className="row">
                            <button type="submit" className="button-primary button-small" disabled={busy || !text.trim()}>
                                Save
                            </button>
                            <button type="button" className="button-text" onClick={() => setEditing(false)}>
                                Cancel
                            </button>
                        </div>
                    </form>
                ) : undefined
            }
            tag={
                <span className="chip">
                    {SOURCES[comment.source]}
                    {title ? ` · ${KIND_NAMES[title]}` : ''}
                </span>
            }
        >
            <footer className="bb-foot">
                {comment.yours !== null && (
                    <span className="small" title="The share of words that are yours, by a word diff against the agent's draft">
                        {comment.yours}% yours
                    </span>
                )}
                {comment.yours !== null && (
                    <label
                        className="toggle-inline"
                        title={comment.locked ? `Locked until more than ${SIGN_OFF_LOCK}% is yours` : undefined}
                    >
                        <input
                            type="checkbox"
                            checked={comment.signed}
                            disabled={!editable || comment.locked || sent}
                            onChange={(event) => choose({ unsigned: !event.target.checked })}
                        />
                        <span>Sign "{SIGN_OFF}"</span>
                        {comment.locked && <span className="small muted">(locked: agent text)</span>}
                    </label>
                )}
                <label className="toggle-inline">
                    <input
                        type="checkbox"
                        checked={comment.task}
                        disabled={!editable || sent}
                        onChange={(event) => choose({ task: event.target.checked })}
                    />
                    <span>Make it a task</span>
                </label>
                {canEdit && !editing && (
                    <button
                        type="button"
                        className="button-link small"
                        onClick={() => {
                            setText(comment.text);
                            setEditing(true);
                        }}
                    >
                        Edit
                    </button>
                )}
                {note && canEdit && (
                    <button
                        type="button"
                        className="button-link small"
                        disabled={busy}
                        onClick={() => quietly(track(send({ type: 'note.delete', id: note.id })))}
                    >
                        Delete
                    </button>
                )}
                {post?.id !== undefined && (
                    <span className="small posted-mark">
                        <CheckIcon /> {POST_AS_DRAFTS ? 'Draft on Bitbucket' : 'Posted'}
                        {post.taskId !== undefined ? ', with its task' : ''}
                    </span>
                )}
                {post?.dropped && <span className="small muted">Dropped: its lines changed</span>}
                {post?.error && (
                    <span className="small error-text" role="alert">
                        <WarningIcon size={13} /> {post.error}
                    </span>
                )}
            </footer>
        </BitbucketComment>
    );
}

/**
 * The summary: the agent's draft from your takes and triage, edited here, deleted or brought back. `signed` says whether
 * it posts with the sign-off.
 */
function Summary({ round, editable, signed }: { round: RoundRecord; editable: boolean; signed: boolean }) {
    const { send } = useActions();
    const [busy, track] = useBusy();
    const { summary } = round;
    const shown = summary.text ?? summary.draft ?? '';
    const [text, setText] = useState(shown);
    const [editing, setEditing] = useState(false);
    useEffect(() => {
        if (!editing) setText(shown);
    }, [shown, editing]);
    if (!editable) return null;
    if (summary.deleted)
        return (
            <p className="small muted summary-deleted">
                You deleted the summary, so none is posted.{' '}
                <button
                    type="button"
                    className="button-link"
                    onClick={() => quietly(send({ type: 'summary.edit', deleted: false }))}
                >
                    Bring it back
                </button>
            </p>
        );
    if (!editing)
        return (
            <div className="row summary-tools">
                <button type="button" className="button-secondary button-small" onClick={() => setEditing(true)}>
                    {shown ? 'Edit the summary' : 'Write a summary'}
                </button>
                {shown && (
                    <button
                        type="button"
                        className="button-link small"
                        onClick={() => quietly(send({ type: 'summary.edit', deleted: true }))}
                    >
                        Delete it
                    </button>
                )}
                {!summary.draft && <span className="small muted">The agent drafts one from your takes and triage.</span>}
            </div>
        );
    return (
        <form
            className="reaction-form"
            onSubmit={(event) => {
                event.preventDefault();
                quietly(track(send({ type: 'summary.edit', text })).then(() => setEditing(false)));
            }}
        >
            <CommentEditor
                id="summary-text"
                label="The summary comment, posted last"
                value={text}
                signed={signed}
                onChange={setText}
            />
            <div className="row">
                <button type="submit" className="button-primary button-small" disabled={busy}>
                    Save
                </button>
                {summary.draft && (
                    <button type="button" className="button-text" onClick={() => setText(summary.draft ?? '')}>
                        Back to the agent's draft
                    </button>
                )}
                <button type="button" className="button-text" onClick={() => setEditing(false)}>
                    Cancel
                </button>
            </div>
        </form>
    );
}

/** The form for a comment of the reviewer's own on a line or a file of the diff, in a dialog; `onDone` closes it. */
function NoteDialog({ round, onDone }: { round: RoundRecord; onDone: () => void }) {
    const { send } = useActions();
    const [busy, track] = useBusy();
    const [file, setFile] = useState('');
    const [side, setSide] = useState<'new' | 'old'>('new');
    const [line, setLine] = useState('');
    const [text, setText] = useState('');
    const start = Number(line);
    return (
        <Modal label="Add a comment of your own" onClose={onDone} className="dialog dialog-note">
            <h2 className="dialog-title">Add a comment of your own</h2>
            <form
                className="note-form"
                onSubmit={(event) => {
                    event.preventDefault();
                    const anchor = file ? { file, side, ...(line && start > 0 ? { start } : {}) } : undefined;
                    quietly(track(send({ type: 'note.save', ...(anchor ? { anchor } : {}), text })).then(onDone));
                }}
            >
                <div className="row note-where">
                    <FileTreeSelect
                        paths={round.files.map((changed) => changed.path)}
                        value={file}
                        onChange={setFile}
                        noneLabel="The pull request"
                    />
                    {file && (
                        <>
                            <select
                                className="field-select"
                                aria-label="Side"
                                value={side}
                                onChange={(event) => setSide(event.target.value === 'old' ? 'old' : 'new')}
                            >
                                <option value="new">New line</option>
                                <option value="old">Old line</option>
                            </select>
                            <input
                                className="field-input"
                                aria-label="Line, or blank for the whole file"
                                placeholder="Line"
                                inputMode="numeric"
                                value={line}
                                onChange={(event) => setLine(event.target.value.replace(/\D/g, ''))}
                            />
                        </>
                    )}
                </div>
                <CommentEditor id="note-text" label="Your comment" value={text} signed={false} onChange={setText} />
                <div className="row">
                    <button type="submit" className="button-primary button-small" disabled={busy || !text.trim()}>
                        Add comment
                    </button>
                    <button type="button" className="button-text" onClick={onDone}>
                        Cancel
                    </button>
                </div>
            </form>
        </Modal>
    );
}

/** The button that opens the form for a comment of the reviewer's own. */
function NoteForm({ round }: { round: RoundRecord }) {
    const [open, setOpen] = useState(false);
    if (round.files.length === 0) return null;
    return (
        <>
            <button type="button" className="button-secondary button-small note-open" onClick={() => setOpen(true)}>
                Add a comment of your own
            </button>
            {open && <NoteDialog round={round} onDone={() => setOpen(false)} />}
        </>
    );
}

const LABELS: Record<EarlierLabel, string> = {
    addressed: 'Addressed',
    partly: 'Partly addressed',
    'not-addressed': 'Not addressed',
    outdated: 'Outdated'
};

/** Your comments from earlier rounds: how each stands now, the code that shows it, the author's replies, and resolving. */
function Earlier({ round, editable }: { round: RoundRecord; editable: boolean }) {
    const { send, goTo } = useActions();
    const followups = useSelector(
        (view) =>
            Object.fromEntries(
                Object.values(view.items)
                    .filter((item) => item.round === round.n && item.replyTo && !item.withdrawn)
                    .map((item) => [item.replyTo!, item.id])
            ),
        deepEqual
    );
    const entries = Object.entries(round.earlier);
    if (entries.length === 0) return null;
    return (
        <section className="earlier" aria-label="Your earlier comments">
            <h2 className="eyebrow">Your earlier comments</h2>
            {entries.map(([key, entry]) => (
                <article key={key} className="bb-card is-earlier">
                    <header className="bb-head">
                        <span className={`badge label-${entry.label ?? 'none'}`}>
                            {entry.label ? LABELS[entry.label] : 'Not labelled yet'}
                        </span>
                        <span className="small muted">
                            Round {entry.round}
                            {entry.post.anchor ? ` · ${describeCodeAnchor(entry.post.anchor)}` : ''}
                        </span>
                        {entry.resolvedAt && <span className="chip">Resolved</span>}
                    </header>
                    {entry.note && <p className="earlier-note">{entry.note}</p>}
                    {entry.replies.length > 0 && (
                        <ul className="replies">
                            {entry.replies.map((reply, index) => (
                                <li key={index}>
                                    <span className="strong">{reply.author}:</span> {reply.text}
                                </li>
                            ))}
                        </ul>
                    )}
                    <details className="earlier-fold">
                        <summary>Your comment</summary>
                        <div className="bb-body">
                            <BitbucketMarkdown source={entry.post.body} />
                        </div>
                    </details>
                    {entry.code && (
                        <details className="earlier-fold">
                            <summary>The code that shows it</summary>
                            <CodeViewer source={entry.code} format="diff" label="The code that shows it" title="What changed" />
                        </details>
                    )}
                    {followups[key] && (
                        <button type="button" className="button-link small" onClick={() => goTo(`item:${followups[key]}`)}>
                            The agent drafted a follow-up ({followups[key]})
                        </button>
                    )}
                    {entry.label === 'addressed' && !entry.resolvedAt && (
                        <label className="toggle-inline">
                            <input
                                type="checkbox"
                                checked={Boolean(entry.confirmed)}
                                disabled={!editable}
                                onChange={(event) =>
                                    quietly(send({ type: 'earlier.confirm', key, confirmed: event.target.checked }))
                                }
                            />
                            <span>Resolve its thread and task when you post</span>
                        </label>
                    )}
                </article>
            ))}
        </section>
    );
}

/** For a comment on lines the author has changed since: re-anchor it, drop it, or post it as it is. */
type Choice = 'reanchor' | 'drop' | 'anyway';

/**
 * Post, and how it went: the head check's choices, "posted 6 of 7" with the failures to retry, or the link to finish
 * the review in Bitbucket. Off while credentials are missing, with what to set. A local branch copies the comments as
 * Markdown instead, which sends nothing anywhere.
 */
function PostBar({ round, comments, ready }: { round: RoundRecord; comments: DerivedComment[]; ready: boolean }) {
    const review = useSelector((view) => view.review, deepEqual);
    const postable = useSelector((view) => view.postable, deepEqual);
    const { send } = useActions();
    const [busy, track] = useBusy();
    const [choices, setChoices] = useState<Record<string, Choice>>({});
    const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
    if (!review) return null;
    if (review.target.kind === 'branch') {
        const copy = () =>
            Promise.resolve()
                .then(() => navigator.clipboard.writeText(commentsMarkdown(review.title, comments)))
                .then(
                    () => setCopied('copied'),
                    () => setCopied('failed')
                );
        return (
            <footer className="submit-bar">
                <div className="submit-text">
                    <span className="submit-title">A local branch has no pull request</span>
                    <span className="submit-detail">Copy the comments as Markdown; nothing is sent anywhere.</span>
                </div>
                <button type="button" className="button-inverse" disabled={comments.length === 0} onClick={() => void copy()}>
                    {copied === 'copied' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy as Markdown'}
                </button>
            </footer>
        );
    }
    const posted = comments.filter((comment) => round.posts[comment.key]?.id !== undefined).length;
    const post = (picked?: Record<string, Choice>) =>
        quietly(track(send({ type: 'comments.post', ...(picked ? { choices: picked } : {}) })));
    const { posting } = round;
    if (round.postedAt)
        return (
            <footer className="submit-bar">
                <div className="submit-text">
                    <span className="submit-title">
                        {POST_AS_DRAFTS ? `Posted ${plural(posted, 'draft comment')}` : `Published ${plural(posted, 'comment')}`}
                    </span>
                    <span className="submit-detail">
                        {POST_AS_DRAFTS
                            ? 'Finish the review in Bitbucket to publish them, with one notification to the author.'
                            : 'Bitbucket drafts could not be used, so the comments were published, the summary last.'}
                    </span>
                </div>
                {review.link && (
                    <a className="button-inverse" href={review.link} target="_blank" rel="noopener noreferrer">
                        Open in Bitbucket
                    </a>
                )}
            </footer>
        );
    if (posting?.state === 'posting')
        return (
            <footer className="submit-bar" aria-busy="true">
                <div className="submit-text">
                    <span className="submit-title">Posting…</span>
                    <span className="submit-detail">
                        {posted} of {comments.length} sent. Each comment's id is kept as it lands, so nothing posts twice.
                    </span>
                </div>
            </footer>
        );
    if (posting?.state === 'moved') {
        const keys = posting.moved?.keys ?? [];
        const all = keys.every((key) => choices[key]);
        return (
            <section className="head-moved" aria-label="The pull request moved">
                <h2 className="strong">The author pushed while you reviewed</h2>
                <p className="small">
                    {plural(keys.length, 'comment sits', 'comments sit')} on lines that changed. Choose for each: move it to where
                    its line is now, drop it, or post it where it is.
                </p>
                {keys.map((key) => {
                    const comment = comments.find((candidate) => candidate.key === key);
                    return (
                        <div key={key} className="row moved-row">
                            <span className="grow small">
                                {comment?.anchor ? describeCodeAnchor(comment.anchor) : key}: {comment?.text.slice(0, 80)}
                            </span>
                            <select
                                className="field-select"
                                aria-label={`What to do with ${key}`}
                                value={choices[key] ?? ''}
                                onChange={(event) => {
                                    const value = event.target.value;
                                    if (value === 'reanchor' || value === 'drop' || value === 'anyway')
                                        setChoices({ ...choices, [key]: value });
                                }}
                            >
                                <option value="" disabled>
                                    Choose…
                                </option>
                                <option value="reanchor">Re-anchor</option>
                                <option value="drop">Drop</option>
                                <option value="anyway">Post anyway</option>
                            </select>
                        </div>
                    );
                })}
                <button type="button" className="button-primary" disabled={!all || busy} onClick={() => post(choices)}>
                    Post
                </button>
            </section>
        );
    }
    const failed = comments.filter((comment) => round.posts[comment.key]?.error);
    return (
        <footer className="submit-bar">
            <div className="submit-text">
                <span className="submit-title">
                    {posting?.state === 'partial'
                        ? `Posted ${posted} of ${comments.length}`
                        : posting?.state === 'error'
                          ? 'Post stopped'
                          : `Ready to post ${plural(comments.length, 'comment')}`}
                </span>
                <span className="submit-detail">
                    {!postable?.ready
                        ? postable?.problem
                        : posting?.state === 'partial'
                          ? `${plural(failed.length, 'comment')} failed; Retry sends only ${failed.length === 1 ? 'that one' : 'those'}.`
                          : posting?.state === 'error'
                            ? posting.error
                            : !ready
                              ? 'Every finding needs a reaction first.'
                              : POST_AS_DRAFTS
                                ? 'They go up as drafts; you finish the review in Bitbucket.'
                                : 'They are published at once, the summary last.'}
                </span>
            </div>
            <button
                type="button"
                className="button-inverse"
                disabled={!postable?.ready || !ready || busy || comments.length === 0}
                onClick={() => post()}
            >
                {posting?.state === 'partial' || posting?.state === 'error'
                    ? 'Retry'
                    : POST_AS_DRAFTS
                      ? 'Post as drafts'
                      : 'Post'}
            </button>
        </footer>
    );
}

/** The rail: the comments in posting order, by where they sit. */
function CommentList({ comments }: { comments: DerivedComment[] }) {
    return (
        <nav className="rail" aria-label="Comments">
            <div className="nav-heading">
                COMMENTS <span className="mono">{comments.length}</span>
            </div>
            <ol className="contents">
                {comments.map((comment) => (
                    <li key={comment.key}>
                        <a
                            className="nav-item"
                            href={`#comment-${comment.key}`}
                            onClick={(event) => {
                                event.preventDefault();
                                document.getElementById(`comment-${comment.key}`)?.scrollIntoView?.({ block: 'start' });
                            }}
                        >
                            <span className="nav-name">{comment.anchor ? describeCodeAnchor(comment.anchor) : 'Summary'}</span>
                        </a>
                    </li>
                ))}
            </ol>
        </nav>
    );
}

/**
 * The Comments tab: every comment the round would post, drawn as Bitbucket will show it, then Post. Opening it with
 * every finding reacted to moves the review to its preview; until then it lists the findings still waiting.
 */
export function CommentsTab() {
    const round = useShownRound();
    const current = useIsCurrentRound(round);
    const readOnly = useReadOnly();
    const parts = useSelector(
        (view) => ({
            comments: deriveComments(view, round.n),
            waiting: unreacted(view, round.n).map((item) => ({ id: item.id, title: item.title }))
        }),
        deepEqual
    );
    const { send, goTo } = useActions();
    const unlocked = findingsUnlocked(round);
    const editable = current && !readOnly && !round.postedAt && round.posting?.state !== 'posting';
    const waiting = parts.waiting.length;
    useEffect(() => {
        if (current && !readOnly && unlocked && !round.previewing && !round.postedAt && waiting === 0)
            quietly(send({ type: 'comments.open' }));
    }, [current, readOnly, unlocked, round.previewing, round.postedAt, waiting, send]);
    const inline = useMemo(() => parts.comments.filter((comment) => comment.key !== 'summary'), [parts.comments]);
    const summary = parts.comments.find((comment) => comment.key === 'summary');
    return (
        <>
            <Rail>
                <CommentList comments={parts.comments} />
            </Rail>
            <main className="main" id="main">
                <div className="main-inner">
                    <header className="page-head">
                        <div className="eyebrow">Comments · round {round.n}</div>
                        <h1>What you will post</h1>
                        <p className="lede">
                            Each comment as Bitbucket will show it. Agent text ends with "{SIGN_OFF}" until more than half of it
                            is yours; only what you agreed with, reworded or wrote yourself is here.
                        </p>
                    </header>
                    {!unlocked && <p className="muted">The comments come once you have finished or skipped the walkthrough.</p>}
                    {unlocked && waiting > 0 && (
                        <div className="callout callout-risk" role="status">
                            <div className="callout-text">
                                <span className="callout-title">
                                    {plural(waiting, 'finding still needs', 'findings still need')} a reaction
                                </span>
                                <ul className="waiting">
                                    {parts.waiting.map((item) => (
                                        <li key={item.id}>
                                            <button type="button" className="button-link" onClick={() => goTo(`item:${item.id}`)}>
                                                {item.id}: {item.title}
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        </div>
                    )}
                    <Earlier round={round} editable={editable} />
                    {inline.map((comment) => (
                        <CommentCard key={comment.key} comment={comment} round={round} editable={editable} />
                    ))}
                    {unlocked && editable && <NoteForm round={round} />}
                    {summary && <CommentCard comment={summary} round={round} editable={editable} />}
                    {unlocked && (
                        <Summary
                            round={round}
                            editable={editable}
                            signed={summary?.signed ?? round.summary.draft !== undefined}
                        />
                    )}
                    {unlocked && current && !readOnly && (
                        <PostBar round={round} comments={parts.comments} ready={waiting === 0 && Boolean(round.previewing)} />
                    )}
                </div>
            </main>
        </>
    );
}
