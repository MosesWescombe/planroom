import { useState } from 'react';
import { endHow } from '../../shared/derive';
import { useReadOnly } from '../readOnly';
import { useSelector } from '../store';
import { quietly, useActions, useBusy } from '../ui';
import { Modal } from './Modal';

/**
 * Ends the agent session: Cancel until the proposal has validated, Finish from then on. Both ask first, since the
 * session is read-only afterwards. Hidden once the session is read-only.
 */
export function EndSessionButton({ className = 'button-secondary button-small' }: { className?: string }) {
    const how = useSelector((view) => endHow(view));
    const review = useSelector((view) => view.kind === 'review');
    const readOnly = useReadOnly();
    const { send } = useActions();
    const [confirming, setConfirming] = useState(false);
    const [busy, track] = useBusy();
    if (readOnly) return null;
    const label = how === 'finished' ? 'Finish' : 'Cancel';
    return (
        <>
            <button type="button" className={className} onClick={() => setConfirming(true)}>
                {label}
            </button>
            {confirming && (
                <Modal label={`${label} the session`} onClose={() => setConfirming(false)} className="dialog dialog-narrow">
                    <h2 className="dialog-title">{label} the session?</h2>
                    <p>
                        {review
                            ? 'The agent stops, the review becomes read-only and its worktree is removed. Ask Claude to review it again to pick it up.'
                            : how === 'finished'
                              ? 'The agent stops and this session becomes read-only. The change folder stays as it is.'
                              : 'The agent stops planning and this session becomes read-only. Nothing is proposed.'}
                    </p>
                    <div className="dialog-actions">
                        <button type="button" className="button-secondary" onClick={() => setConfirming(false)}>
                            Keep going
                        </button>
                        <button
                            type="button"
                            className="button-primary"
                            disabled={busy}
                            onClick={() => quietly(track(send({ type: 'session.end' })).then(() => setConfirming(false)))}
                        >
                            {label} session
                        </button>
                    </div>
                </Modal>
            )}
        </>
    );
}
