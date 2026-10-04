import { memo, useEffect, useState } from 'react';
import type { ThreadRecord } from '../../shared/records';
import { BlockView } from '../blocks/Block';
import { useAnchorState } from '../comments/anchorStatus';
import { plural, relativeTime } from '../format';
import { useNow } from '../hooks';
import { useReadOnly } from '../readOnly';
import { isSeen, markSeen, useSeen } from '../seen';
import { useSendOnKey } from '../sendKey';
import { useRecord, useSelector } from '../store';
import { quietly, useActions, useBusy } from '../ui';
import { Attachments, usePastes } from './Attachments';
import { Markdown } from './Markdown';
import { Modal } from './Modal';

/** Three bouncing dots: the agent is on it. */
export function AgentDots() {
    return (
        <span className="agent-now-dots" aria-hidden="true">
            <span />
            <span />
            <span />
        </span>
    );
}

const INTENT: Record<NonNullable<ThreadRecord['intent']>, string> = {
    question: 'Question',
    change: 'Change this',
    wrong: "It's wrong"
};

/** A message's author badge: AI for the agent, You for the user. */
function Avatar({ author }: { author: 'user' | 'agent' }) {
    return author === 'agent' ? (
        <span className="avatar avatar-agent" aria-label="Agent">
            AI
        </span>
    ) : (
        <span className="avatar avatar-user" aria-label="You">
            You
        </span>
    );
}

/**
 * A comment thread or a direct-message thread in full, as its dialog shows it: every message as markdown, the
 * agent's diagrams and what its replies touched.
 */
export const Thread = memo(function Thread({ id }: { id: string }) {
    const thread = useRecord('threads', id);
    const anchorState = useAnchorState(id);
    const { send, goTo } = useActions();
    const readOnly = useReadOnly();
    const [reply, setReply] = useState('');
    const [replying, setReplying] = useState(false);
    const [busy, track] = useBusy();
    const sendOnKey = useSendOnKey();
    const pastes = usePastes();
    const now = useNow();
    if (!thread) return null;
    const resolved = thread.status === 'resolved';

    const sendReply = () => {
        const text = reply.trim();
        const attachments = pastes.items.length ? pastes.items : undefined;
        if ((!text && !attachments) || busy || pastes.uploading) return;
        quietly(
            track(send({ type: 'thread.reply', threadId: thread.id, text, attachments })).then(() => {
                setReply('');
                pastes.clear();
                setReplying(false);
            })
        );
    };

    return (
        <article
            className={`thread${resolved ? ' is-resolved' : ''}`}
            aria-label={`${thread.kind === 'message' ? 'Message' : 'Comment'} ${thread.id}`}
        >
            {thread.anchor && (
                <div className="thread-head">
                    {/* The dialog's title already names a whole-question comment's target. */}
                    {thread.anchor.quote && (
                        <p className={`thread-quote${anchorState === 'detached' ? ' is-detached' : ''}`}>
                            {thread.anchor.quote.exact}
                        </p>
                    )}
                    <div className="thread-meta">
                        {thread.intent && <span className="chip">{INTENT[thread.intent]}</span>}
                        {anchorState === 'detached' && (
                            <span className="chip chip-attention">Detached · the quoted text is gone</span>
                        )}
                        {resolved && <span className="chip">Resolved</span>}
                    </div>
                </div>
            )}
            {thread.messages.map((message) => (
                <div key={message.id} className="thread-message">
                    <Avatar author={message.author} />
                    <div className="thread-body">
                        {message.text && (
                            <div className="prose thread-text">
                                <Markdown source={message.text} document />
                            </div>
                        )}
                        <Attachments items={message.attachments} />
                        {message.blocks?.map((block, index) => (
                            <BlockView key={index} block={{ ...block, id: `${message.id}-block-${index}` }} placement="thread" />
                        ))}
                        {message.touched && message.touched.length > 0 && (
                            <ul className="touched">
                                {message.touched.map((item) => (
                                    <li key={`${item.ref}-${item.note}`}>
                                        <span className="dot dot-agent" aria-hidden="true" />
                                        <a
                                            href={`#${item.ref}`}
                                            onClick={(event) => {
                                                event.preventDefault();
                                                goTo(item.ref);
                                            }}
                                        >
                                            {item.note}
                                        </a>
                                    </li>
                                ))}
                            </ul>
                        )}
                        <span className="thread-time">{relativeTime(message.at, now)}</span>
                    </div>
                </div>
            ))}
            {!readOnly && (
                <div className="thread-actions">
                    {replying ? (
                        <form
                            className="reply-form"
                            onSubmit={(event) => {
                                event.preventDefault();
                                sendReply();
                            }}
                        >
                            <label className="visually-hidden" htmlFor={`reply-${thread.id}`}>
                                Reply
                            </label>
                            <textarea
                                id={`reply-${thread.id}`}
                                rows={2}
                                value={reply}
                                onChange={(event) => setReply(event.target.value)}
                                onKeyDown={(event) => sendOnKey(event, sendReply)}
                                onPaste={pastes.onPaste}
                                autoFocus
                            />
                            <Attachments items={pastes.items} onRemove={pastes.remove} />
                            <div className="row-end">
                                <button
                                    type="button"
                                    className="button-text"
                                    onClick={() => {
                                        pastes.clear();
                                        setReplying(false);
                                    }}
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    className="button-primary button-small"
                                    disabled={busy || pastes.uploading || (!reply.trim() && !pastes.items.length)}
                                >
                                    Send
                                </button>
                            </div>
                        </form>
                    ) : (
                        <>
                            <button type="button" className="button-text" onClick={() => setReplying(true)}>
                                Reply
                            </button>
                            {thread.kind === 'comment' && !resolved && (
                                <button
                                    type="button"
                                    className="button-text muted"
                                    disabled={busy}
                                    onClick={() => quietly(track(send({ type: 'comment.resolve', threadId: thread.id })))}
                                >
                                    Resolve
                                </button>
                            )}
                        </>
                    )}
                </div>
            )}
        </article>
    );
});

/**
 * A thread folded to one row: what was asked and where the conversation stands, with an agent reply marked new
 * until the thread has been opened. Clicking it opens the thread.
 * `heading` names what it is on; `elementId` makes the row the thread's place on the page, for links and unread.
 */
export const ThreadRow = memo(function ThreadRow({
    id,
    heading,
    elementId,
    onOpen
}: {
    id: string;
    heading?: string;
    elementId?: string;
    onOpen: () => void;
}) {
    const thread = useRecord('threads', id);
    const anchorState = useAnchorState(id);
    const agentOn = useSelector((view) => (view.agent.working && view.agent.thread === id ? view.agent.doing : undefined));
    const now = useNow();
    const seen = useSeen();
    if (!thread) return null;
    const last = thread.messages.at(-1);
    const replied = last?.author === 'agent';
    const unread = replied && !isSeen(seen, { ref: `thread:${id}`, at: last.at });
    const figures = thread.messages.reduce((sum, message) => sum + (message.blocks?.length ?? 0), 0);
    return (
        <button
            type="button"
            id={elementId}
            className={`thread-row${thread.status === 'resolved' ? ' is-resolved' : ''}${unread ? ' is-unread' : ''}`}
            onClick={onOpen}
        >
            {heading && (
                <span className={`thread-row-heading${anchorState === 'detached' ? ' is-detached' : ''}`}>{heading}</span>
            )}
            <span className="thread-row-ask">{thread.messages[0]?.text || 'Pasted content'}</span>
            <span className={`thread-row-meta${unread ? ' is-unread' : ''}`}>
                {unread && <span className="dot dot-agent" aria-hidden="true" />}
                {unread ? (
                    `New reply from the agent · ${relativeTime(last.at, now)}`
                ) : replied ? (
                    `Agent replied ${relativeTime(last.at, now)}`
                ) : agentOn ? (
                    <>
                        Agent {agentOn}
                        <AgentDots />
                    </>
                ) : (
                    <>
                        Waiting for the agent
                        {thread.status !== 'resolved' && <AgentDots />}
                    </>
                )}
                {figures > 0 && ` · ${plural(figures, 'figure')}`}
                {anchorState === 'detached' && ' · Detached, the quoted text is gone'}
                {thread.status === 'resolved' && ' · Resolved'}
            </span>
        </button>
    );
});

/**
 * A thread open over the page, its latest message marked seen while it shows. `onShow` adds a way out to what
 * the thread is on.
 */
export function ThreadDialog({
    id,
    title,
    onClose,
    onShow
}: {
    id: string;
    title: string;
    onClose: () => void;
    onShow?: () => void;
}) {
    const changeId = useSelector((view) => view.changeId);
    const lastAt = useSelector((view) => {
        const thread = view.threads[id];
        return thread && (thread.messages.at(-1)?.at ?? thread.updatedAt);
    });
    useEffect(() => {
        if (lastAt) markSeen(changeId, `thread:${id}`, lastAt);
    }, [changeId, id, lastAt]);
    return (
        <Modal label={title} onClose={onClose} className="dialog-thread">
            <h2 className="dialog-title">{title}</h2>
            {onShow && (
                <button
                    type="button"
                    className="button-text dialog-show"
                    onClick={() => {
                        onClose();
                        onShow();
                    }}
                >
                    Show on the page
                </button>
            )}
            <Thread id={id} />
        </Modal>
    );
}
