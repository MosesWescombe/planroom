import { useState } from 'react';
import { outstandingItems, phase1Gate } from '../../shared/derive';
import type { Outstanding } from '../../shared/records';
import { planDir } from '../../shared/state';
import { CheckIcon, WarningIcon } from '../components/icons';
import { Modal } from '../components/Modal';
import { deepEqual, useSelector } from '../store';
import { quietly, useActions, useBusy } from '../ui';

/** Where an outstanding item lives on the page. */
function targetOf(item: Outstanding): string {
    switch (item.kind) {
        case 'section':
            return `section:${item.ref}`;
        case 'assumption':
            return `block:${item.ref}`;
        case 'comment':
            return `thread:${item.ref}`;
        default:
            return item.ref;
    }
}

/** Submit: blocked while items are outstanding (unless "Submit anyway"), then ready. Submitting opens the Proposal tab. */
export function SubmitDialog({ onClose }: { onClose: () => void }) {
    const view = useSelector(
        (current) => ({
            changeId: current.changeId,
            format: current.format,
            revision: current.revision,
            outstanding: outstandingItems(current),
            questions: phase1Gate(current, current.phases.phase1.direction),
            specs: current.proposal.files.filter((file) => file.kind === 'spec').length
        }),
        deepEqual
    );
    const { send, goTo, setTab, setPanelTab } = useActions();
    const [anyway, setAnyway] = useState(false);
    const [validate, setValidate] = useState(true);
    const [busy, track] = useBusy();

    if (view.outstanding.length > 0 && !anyway) {
        const unresolvedQuestions = view.questions.total - view.questions.resolved;
        return (
            <Modal label="Not quite ready" onClose={onClose} className="dialog dialog-narrow">
                <h2 className="dialog-title">Not quite ready</h2>
                <p className="small">Resolve these so the proposal doesn&apos;t bake in guesses.</p>
                <ul className="outstanding">
                    {view.outstanding.map((item) => (
                        <li key={`${item.kind}-${item.ref}`} className="outstanding-item">
                            <WarningIcon />
                            <span className="grow">{item.label}</span>
                            <a
                                href={`#${targetOf(item)}`}
                                onClick={(event) => {
                                    event.preventDefault();
                                    onClose();
                                    goTo(targetOf(item));
                                }}
                            >
                                Go
                            </a>
                        </li>
                    ))}
                    {unresolvedQuestions === 0 && (
                        <li className="outstanding-item is-ok">
                            <span className="state-mark state-answered" aria-hidden="true">
                                <CheckIcon size={9} />
                            </span>
                            <span className="grow">
                                {view.questions.total} of {view.questions.total} questions resolved
                            </span>
                        </li>
                    )}
                </ul>
                <div className="dialog-actions spread">
                    <button type="button" className="button-text" onClick={() => setAnyway(true)}>
                        Submit anyway
                    </button>
                    <button
                        type="button"
                        className="button-primary"
                        onClick={() => {
                            onClose();
                            goTo(targetOf(view.outstanding[0]!));
                        }}
                    >
                        Review items
                    </button>
                </div>
            </Modal>
        );
    }

    const markdown = view.format === 'markdown';
    const heading = markdown ? 'Write this up as a Markdown plan' : 'Propose this as an OpenSpec change';
    return (
        <Modal label={heading} onClose={onClose} className="dialog">
            <h2 className="dialog-title">{heading}</h2>
            <p className="small">
                The agent turns write-up v{view.revision} into {markdown ? 'a plan file' : 'a change folder'}. You&apos;ll review
                it in the Proposal tab before anything is implemented.
            </p>
            {anyway && view.outstanding.length > 0 && (
                <p className="warning-note">
                    <WarningIcon /> {view.outstanding.length} outstanding item{view.outstanding.length === 1 ? '' : 's'} will be
                    recorded with the submission.
                </p>
            )}
            <div className="field">
                <span className="field-label">Change id</span>
                <code className="field-value">{view.changeId}</code>
            </div>
            <div className="field">
                <span className="field-label">The agent will write</span>
                {markdown ? (
                    <code className="field-value">
                        {planDir(view.format, view.changeId)}/{view.changeId}.md
                    </code>
                ) : (
                    <ul className="file-grid">
                        <li>proposal.md</li>
                        <li>design.md</li>
                        <li>tasks.md</li>
                        <li>spec deltas{view.specs ? ` (${view.specs})` : ''}</li>
                    </ul>
                )}
            </div>
            {!markdown && (
                <label className="toggle-row">
                    <span>
                        <span className="strong">Validate strictly after writing</span>
                        <span className="mono small muted">openspec validate --strict</span>
                    </span>
                    <input type="checkbox" checked={validate} onChange={(event) => setValidate(event.target.checked)} />
                </label>
            )}
            <div className="dialog-actions">
                <button type="button" className="button-secondary" onClick={onClose}>
                    Cancel
                </button>
                <button
                    type="button"
                    className="button-primary"
                    disabled={busy}
                    onClick={() =>
                        quietly(
                            track(
                                send({
                                    type: 'phase.submit',
                                    changeId: view.changeId,
                                    revision: view.revision,
                                    validate,
                                    anyway: anyway || undefined
                                })
                            ).then(() => {
                                onClose();
                                setTab('proposal');
                                setPanelTab('review');
                            })
                        )
                    }
                >
                    {markdown ? 'Submit & write plan' : 'Submit & propose'}
                </button>
            </div>
        </Modal>
    );
}
