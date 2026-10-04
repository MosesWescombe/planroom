import { useState } from 'react';
import { acceptGate, canRequestChanges, tracedAnswers } from '../../shared/derive';
import { countDelta } from '../../shared/specDelta';
import { useReadOnly } from '../readOnly';
import { deepEqual, useSelector } from '../store';
import { quietly, useActions, useBusy } from '../ui';

/**
 * Phase 3's review: the change at a glance, its task groups, the next step, and accept or request changes once the
 * submitted change has validated.
 */
export function ReviewPanel() {
    const review = useSelector((view) => {
        const counts = view.proposal.files.reduce(
            (sum, file) => {
                if (!file.spec) return sum;
                const delta = countDelta(file.spec);
                return {
                    added: sum.added + delta.ADDED,
                    modified: sum.modified + delta.MODIFIED + delta.REMOVED + delta.RENAMED
                };
            },
            { added: 0, modified: 0 }
        );
        const tasks = view.proposal.files.find((file) => file.kind === 'tasks')?.tasks ?? [];
        const gate = acceptGate(view);
        return {
            changeId: view.changeId,
            markdown: view.format === 'markdown',
            counts,
            tasks,
            traced: tracedAnswers(view),
            gate,
            accepted: Boolean(view.phases.acceptedAt),
            unlocked: view.phases.proposalUnlocked,
            hasProposalComment: canRequestChanges(view, undefined)
        };
    }, deepEqual);
    const readOnly = useReadOnly();
    const { send, setTab } = useActions();
    const [requesting, setRequesting] = useState(false);
    const [message, setMessage] = useState('');
    const [busy, track] = useBusy();
    const taskTotal = review.tasks.reduce((sum, group) => sum + group.total, 0);
    const canRequest = review.hasProposalComment || Boolean(message.trim());

    return (
        <div className="review">
            {/* A Markdown plan has no requirements, tasks or traces to count. */}
            {!review.markdown && (
                <section className="review-block">
                    <h3 className="eyebrow">CHANGE AT A GLANCE</h3>
                    <div className="glance">
                        <div className="glance-tile">
                            <span className="glance-value">{review.counts.added}</span>
                            <span className="small">requirement{review.counts.added === 1 ? '' : 's'} added</span>
                        </div>
                        <div className="glance-tile">
                            <span className="glance-value">{review.counts.modified}</span>
                            <span className="small">requirement{review.counts.modified === 1 ? '' : 's'} modified</span>
                        </div>
                        <div className="glance-tile">
                            <span className="glance-value">{taskTotal}</span>
                            <span className="small">
                                tasks in {review.tasks.length} group{review.tasks.length === 1 ? '' : 's'}
                            </span>
                        </div>
                        <div className="glance-tile">
                            <span className="glance-value">
                                {review.traced.traced}/{review.traced.answered}
                            </span>
                            <span className="small">answers traced</span>
                        </div>
                    </div>
                </section>
            )}
            {review.tasks.length > 0 && (
                <section className="review-block">
                    <h3 className="eyebrow">TASKS.MD</h3>
                    <ol className="task-groups">
                        {review.tasks.map((group, index) => (
                            <li key={group.title}>
                                <span>
                                    <span className="mono muted">{index + 1}</span> {group.title}
                                </span>
                                <span className="mono muted">{group.total}</span>
                            </li>
                        ))}
                    </ol>
                </section>
            )}
            <section className="review-block next-step">
                <span className="strong">Next step</span>
                <span className="small">
                    {review.accepted
                        ? `Accepted. Break the ${review.markdown ? 'plan' : 'change'} into tickets in Claude Code with:`
                        : 'Accepting makes this session read-only. Nothing is implemented until you decompose it:'}
                </span>
                <code className="command">/decompose {review.changeId}</code>
            </section>
            {!readOnly && !review.unlocked && (
                <p className="small muted">You can accept or request changes once the change validates.</p>
            )}
            {!readOnly && review.unlocked && (
                <div className="review-actions">
                    <button
                        type="button"
                        className="button-primary button-large"
                        disabled={!review.gate.canAccept || busy}
                        aria-describedby={review.gate.reason ? 'accept-reason' : undefined}
                        onClick={() => quietly(track(send({ type: 'proposal.accept' })))}
                    >
                        Accept proposal
                    </button>
                    {review.gate.reason && (
                        <span id="accept-reason" className="small muted">
                            {review.gate.reason}
                        </span>
                    )}
                    {requesting ? (
                        <form
                            className="request-form"
                            onSubmit={(event) => {
                                event.preventDefault();
                                const text = message.trim();
                                quietly(
                                    track(send({ type: 'proposal.requestChanges', ...(text ? { text } : {}) })).then(() => {
                                        setMessage('');
                                        setRequesting(false);
                                    })
                                );
                            }}
                        >
                            <label htmlFor="request-changes">What should change?</label>
                            <textarea
                                id="request-changes"
                                rows={3}
                                value={message}
                                onChange={(event) => setMessage(event.target.value)}
                                autoFocus
                            />
                            {!canRequest && (
                                <span className="small muted">Leave a comment on the proposal or write what should change.</span>
                            )}
                            <div className="row-end">
                                <button type="button" className="button-text" onClick={() => setRequesting(false)}>
                                    Cancel
                                </button>
                                <button type="submit" className="button-secondary" disabled={!canRequest || busy}>
                                    Send to agent
                                </button>
                            </div>
                        </form>
                    ) : (
                        <button type="button" className="button-secondary button-large" onClick={() => setRequesting(true)}>
                            Request changes
                        </button>
                    )}
                    <button type="button" className="button-text" onClick={() => setTab('writeup')}>
                        Back to write-up
                    </button>
                </div>
            )}
        </div>
    );
}
