import upperFirst from 'lodash/upperFirst';
import { memo, useRef, useState } from 'react';
import { openComments, RESOLVED, type ThreadScope, threadScope } from '../../shared/derive';
import type { ActivityEntry, AgentStatus } from '../../shared/view';
import { plural, relativeTime } from '../format';
import { useNarrow, useNow } from '../hooks';
import { ReviewPanel } from '../proposal/ReviewPanel';
import { useReadOnly } from '../readOnly';
import { isSeen, useSeen } from '../seen';
import { useSendOnKey } from '../sendKey';
import { type Connection, deepEqual, useConnection, useSelector } from '../store';
import { type PanelTab, quietly, useActions, useBusy, useUiState } from '../ui';
import { Attachments, usePastes } from './Attachments';
import { ActivityIcon, CommentIcon, PanelIcon, ReviewIcon, SendIcon } from './icons';
import { type PaneSize, ResizeHandle, useStoredWidth } from './Resizer';
import { AgentDots, ThreadDialog, ThreadRow } from './Thread';

/** What the agent is doing right now, and whether it is busy enough to animate. */
export function describeAgentNow(connection: Connection, agent: AgentStatus): { busy: boolean; label: string } {
    if (connection === 'closed') return { busy: false, label: 'finished' };
    if (connection !== 'live') return { busy: false, label: 'Unknown until the page reconnects' };
    if (agent.working)
        return { busy: true, label: agent.editing ? `Editing ${agent.editing}` : upperFirst(agent.doing ?? 'thinking') };
    if (agent.mode === 'waiting') return { busy: false, label: 'Waiting for you' };
    if (agent.mode === 'push') return { busy: false, label: 'Listening for your changes' };
    return { busy: false, label: agent.queued ? `Offline · ${plural(agent.queued, 'change')} queued` : 'Offline' };
}

/** The feed's live first row: the agent's current state, animated while it works, and what its subagents are doing. */
export function AgentNow() {
    const connection = useConnection();
    const agent = useSelector((view) => view.agent, deepEqual);
    const { busy, label } = describeAgentNow(connection, agent);
    return (
        <div className={`agent-now${busy ? ' is-busy' : ''}${agent.mode === 'offline' ? ' is-offline' : ''}`}>
            <span className="agent-now-dot" aria-hidden="true" />
            <span className="agent-now-label">
                Agent <span className="agent-now-state">{label}</span>
            </span>
            {busy && <AgentDots />}
            {agent.subagents && (
                <ul className="agent-now-subagents" aria-label="Subagents">
                    {agent.subagents.map((task, index) => (
                        <li key={index}>{upperFirst(task)}</li>
                    ))}
                </ul>
            )}
        </div>
    );
}

interface EntryProps {
    entry: ActivityEntry;
    now: number;
}

/** Links an entry to its record; an entry without one renders as plain text. */
function RefLink({ refId, children }: { refId: string | undefined; children: React.ReactNode }) {
    const { goTo } = useActions();
    if (!refId) return <span>{children}</span>;
    return (
        <a
            href={`#${refId}`}
            onClick={(event) => {
                event.preventDefault();
                goTo(refId);
            }}
        >
            {children}
        </a>
    );
}

/** An entry's time, relative to `now`. */
function When({ entry, now }: EntryProps) {
    return (
        <time className="activity-time" dateTime={entry.at}>
            {relativeTime(entry.at, now)}
        </time>
    );
}

/** A question the agent added: a card while it waits for an answer, a quiet line once resolved. */
function QuestionEntry({ entry, now }: EntryProps) {
    const status = useSelector((view) => (entry.ref ? view.questions[entry.ref]?.status : undefined));
    const resolved = status !== undefined && RESOLVED.has(status);
    return (
        <li className={`activity-question${resolved ? ' is-resolved' : ''}`}>
            <RefLink refId={entry.ref}>
                <span className="activity-head">
                    <span className="activity-eyebrow">
                        {resolved ? `${entry.title} · ${status}` : `New question · ${entry.ref ?? entry.title}`}
                    </span>
                    <When entry={entry} now={now} />
                </span>
                <span className="activity-question-title">{entry.detail}</span>
            </RefLink>
        </li>
    );
}

/** Something you did: one muted line, its detail (your answer, your message) folded away. */
function YoursEntry({ entry, now }: EntryProps) {
    const head = (
        <span className="activity-head">
            <span className="activity-title">{entry.title}</span>
            <When entry={entry} now={now} />
        </span>
    );
    if (!entry.detail)
        return (
            <li className="activity-yours">
                <RefLink refId={entry.ref}>{head}</RefLink>
            </li>
        );
    return (
        <li className="activity-yours is-expandable">
            <details>
                <summary>{head}</summary>
                <p className="activity-detail">
                    {entry.detail}
                    {entry.ref && (
                        <>
                            {' '}
                            <RefLink refId={entry.ref}>Show</RefLink>
                        </>
                    )}
                </p>
            </details>
        </li>
    );
}

const DOTS: Record<string, string> = { attention: 'dot-agent', closed: 'dot-closed' };

/** Any other change: bold with a filled dot until what it links to has been on screen, then quiet. */
function ChangeEntry({ entry, now, seen }: EntryProps & { seen: boolean }) {
    return (
        <li className={`activity-change${seen ? ' is-seen' : ''}`}>
            <span className={`dot ${DOTS[entry.kind ?? ''] ?? 'dot-accent'}`} aria-hidden="true" />
            <div>
                <span className="activity-head">
                    <RefLink refId={entry.ref}>
                        {!seen && <span className="visually-hidden">Unread: </span>}
                        <strong className="activity-title">{entry.title}</strong>
                    </RefLink>
                    <When entry={entry} now={now} />
                </span>
                {entry.detail && <span className="activity-detail">{entry.detail}</span>}
            </div>
        </li>
    );
}

/** The Activity tab: what the agent is on now, then the feed, newest first. */
const Activity = memo(function Activity() {
    const activity = useSelector((view) => view.activity);
    const seen = useSeen();
    const now = useNow();
    return (
        <>
            <AgentNow />
            {activity.length === 0 ? (
                <p className="empty">Nothing yet. The agent&apos;s changes and yours appear here as they happen.</p>
            ) : (
                <ol className="activity">
                    {activity.map((entry) =>
                        entry.kind === 'question' ? (
                            <QuestionEntry key={entry.id} entry={entry} now={now} />
                        ) : entry.kind === 'yours' ? (
                            <YoursEntry key={entry.id} entry={entry} now={now} />
                        ) : (
                            <ChangeEntry key={entry.id} entry={entry} now={now} seen={isSeen(seen, entry)} />
                        )
                    )}
                </ol>
            )}
        </>
    );
});

const SCOPE_TITLES: Record<ThreadScope, string> = {
    interrogate: 'On questions',
    writeup: 'On the write-up',
    proposal: 'On the proposal',
    review: 'On the review',
    message: 'Messages to the agent'
};

/** What a comment thread's dialog is titled, by where the comment sits. */
const DIALOG_TITLES: Record<ThreadScope, string> = {
    interrogate: 'Comment on a question',
    writeup: 'Comment on the write-up',
    proposal: 'Comment on the proposal',
    review: 'Comment on the review',
    message: 'Message to the agent'
};

/** A thread in the Comments tab: a row naming what it is on, opening the whole thread in a dialog. */
const PanelThread = memo(function PanelThread({ id, scope }: { id: string; scope: ThreadScope }) {
    const { goTo } = useActions();
    const [open, setOpen] = useState(false);
    const on = useSelector((view) => {
        const anchor = view.threads[id]?.anchor;
        const question = anchor?.target.startsWith('question:') ? view.questions[anchor.target.slice(9)] : undefined;
        return {
            target: anchor?.target.replace(/^question:/, ''),
            quote: anchor?.quote?.exact,
            question: question && `${question.id} · ${question.title}`
        };
    }, deepEqual);
    const { target } = on;
    return (
        <>
            <ThreadRow id={id} heading={on.quote ?? on.question} elementId={`thread-${id}`} onOpen={() => setOpen(true)} />
            {open && (
                <ThreadDialog
                    id={id}
                    title={on.question ?? DIALOG_TITLES[scope]}
                    onClose={() => setOpen(false)}
                    onShow={target ? () => goTo(target) : undefined}
                />
            )}
        </>
    );
});

/** The Comments tab: threads grouped by where they sit, oldest first, with each group's resolved threads folded away. */
const Comments = memo(function Comments() {
    const groups = useSelector((view) => {
        const threads = Object.values(view.threads).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        const order: ThreadScope[] = ['interrogate', 'writeup', 'proposal', 'review', 'message'];
        return order
            .map((scope) => ({
                scope,
                open: threads
                    .filter((thread) => threadScope(thread, view.kind) === scope && thread.status === 'open')
                    .map((thread) => thread.id),
                resolved: threads
                    .filter((thread) => threadScope(thread, view.kind) === scope && thread.status === 'resolved')
                    .map((thread) => thread.id)
            }))
            .filter((group) => group.open.length + group.resolved.length > 0);
    }, deepEqual);
    if (groups.length === 0) {
        return (
            <p className="empty">No comments yet. Select any text on the page to comment on it, or press C with text selected.</p>
        );
    }
    return (
        <div className="comments">
            {groups.map((group) => (
                <section key={group.scope} className="comment-group" aria-label={SCOPE_TITLES[group.scope]}>
                    <h3 className="eyebrow">{SCOPE_TITLES[group.scope]}</h3>
                    {group.open.map((id) => (
                        <PanelThread key={id} id={id} scope={group.scope} />
                    ))}
                    {group.resolved.length > 0 && (
                        <details className="resolved-threads">
                            <summary>{group.resolved.length} resolved</summary>
                            {group.resolved.map((id) => (
                                <PanelThread key={id} id={id} scope={group.scope} />
                            ))}
                        </details>
                    )}
                </section>
            ))}
        </div>
    );
});

/** The box for messaging the agent directly, pastes included. Hidden while the session is read-only. */
function MessageBox({ inputRef }: { inputRef: React.RefObject<HTMLTextAreaElement | null> }) {
    const { send } = useActions();
    const readOnly = useReadOnly();
    const [text, setText] = useState('');
    const [busy, track] = useBusy();
    const sendOnKey = useSendOnKey();
    const pastes = usePastes();
    if (readOnly) return null;
    const submit = () => {
        const message = text.trim();
        const attachments = pastes.items.length ? pastes.items : undefined;
        if ((!message && !attachments) || busy || pastes.uploading) return;
        quietly(
            track(send({ type: 'message.send', text: message, attachments })).then(() => {
                setText('');
                pastes.clear();
            })
        );
    };
    return (
        <form
            className="message-box"
            onSubmit={(event) => {
                event.preventDefault();
                submit();
            }}
        >
            <label htmlFor="agent-message">Message the agent</label>
            <textarea
                id="agent-message"
                ref={inputRef}
                rows={2}
                placeholder="It sees this whole page. Ask it to add, merge or reword anything…"
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => sendOnKey(event, submit)}
                onPaste={pastes.onPaste}
            />
            <Attachments items={pastes.items} onRemove={pastes.remove} />
            <div className="row-end">
                <button
                    type="submit"
                    className="button-primary button-small"
                    disabled={busy || pastes.uploading || (!text.trim() && !pastes.items.length)}
                >
                    Send
                </button>
            </div>
        </form>
    );
}

const PANEL_SIZE: PaneSize = { key: 'planroom:panel-width', initial: 528, min: 280, maxShare: 0.6 };

/** The side panel: review (Phase 3), activity and comments, with the message box. Collapses to an icon strip. */
export function SidePanel() {
    const { tab, panelCollapsed, panelTab } = useUiState();
    const { setPanelCollapsed, setPanelTab } = useActions();
    const openCount = useSelector((view) => openComments(view).length);
    const liveDot = useSelector((view) => view.agent.mode !== 'offline' || Boolean(view.agent.editing));
    const messageRef = useRef<HTMLTextAreaElement>(null);
    // A drawer on a narrow screen always opens expanded.
    const narrow = useNarrow();
    const [width, setWidth] = useStoredWidth(PANEL_SIZE);
    const tabsShown: PanelTab[] = tab === 'proposal' ? ['review', 'activity', 'comments'] : ['activity', 'comments'];
    const current = tabsShown.includes(panelTab) ? panelTab : 'activity';

    const expandTo = (next: PanelTab | 'message') => {
        setPanelCollapsed(false);
        if (next === 'message') window.requestAnimationFrame(() => messageRef.current?.focus());
        else setPanelTab(next);
    };

    if (panelCollapsed && !narrow) {
        return (
            <aside className="panel is-collapsed" aria-label="Side panel, collapsed">
                <button
                    type="button"
                    className="icon-button"
                    aria-label="Expand side panel"
                    title="Expand panel"
                    onClick={() => setPanelCollapsed(false)}
                >
                    <PanelIcon open={false} />
                </button>
                <span className="strip-rule" aria-hidden="true" />
                {tab === 'proposal' && (
                    <button type="button" className="icon-button" aria-label="Review" onClick={() => expandTo('review')}>
                        <ReviewIcon />
                    </button>
                )}
                <button
                    type="button"
                    className="icon-button has-badge"
                    aria-label="Activity"
                    onClick={() => expandTo('activity')}
                >
                    <ActivityIcon />
                    {liveDot && <span className="live-dot" aria-hidden="true" />}
                </button>
                <button
                    type="button"
                    className="icon-button has-badge"
                    aria-label={`Comments, ${openCount} open`}
                    onClick={() => expandTo('comments')}
                >
                    <CommentIcon />
                    {openCount > 0 && <span className="count-badge">{openCount}</span>}
                </button>
                <button type="button" className="icon-button" aria-label="Message the agent" onClick={() => expandTo('message')}>
                    <SendIcon />
                </button>
            </aside>
        );
    }

    const labels: Record<PanelTab, string> = { review: 'Review', activity: 'Activity', comments: 'Comments' };
    return (
        <aside className="panel" aria-label="Side panel" style={narrow ? undefined : { width }}>
            {!narrow && (
                <ResizeHandle label="Resize side panel" edge="left" size={PANEL_SIZE} width={width} setWidth={setWidth} />
            )}
            <div className="panel-head">
                <div role="tablist" aria-label="Side panel" className="panel-tabs">
                    {tabsShown.map((id) => (
                        <button
                            key={id}
                            type="button"
                            role="tab"
                            id={`panel-tab-${id}`}
                            aria-selected={current === id}
                            aria-controls="panel-body"
                            className="panel-tab"
                            onClick={() => setPanelTab(id)}
                        >
                            {labels[id]}
                            {id === 'comments' && openCount > 0 && <span className="count">{openCount}</span>}
                        </button>
                    ))}
                </div>
                <button
                    type="button"
                    className="icon-button wide-only"
                    aria-label="Collapse side panel"
                    title="Collapse panel"
                    onClick={() => setPanelCollapsed(true)}
                >
                    <PanelIcon open />
                </button>
            </div>
            <div className="panel-body" id="panel-body" role="tabpanel" aria-labelledby={`panel-tab-${current}`}>
                {current === 'review' && <ReviewPanel />}
                {current === 'activity' && <Activity />}
                {current === 'comments' && <Comments />}
            </div>
            <MessageBox inputRef={messageRef} />
        </aside>
    );
}
