import { useState } from 'react';
import { phase1Gate } from '../../shared/derive';
import { isInfo } from '../../shared/questions';
import { QuestionGroups, QuestionsPage } from '../interrogate/Interrogate';
import { useReadOnly } from '../readOnly';
import { deepEqual, useSelector } from '../store';
import { quietly, useActions, useBusy } from '../ui';

/**
 * An ask's one control, floating at the bottom right: send the answers to the agent, which ends the ask. With questions
 * still unanswered it asks first. Hidden once the answers are sent.
 */
function SendAnswers() {
    const gate = useSelector(
        (view) => ({
            asked: Object.values(view.questions).some((question) => !isInfo(question)),
            open: phase1Gate(view).unresolved.length
        }),
        deepEqual
    );
    const readOnly = useReadOnly();
    const { send } = useActions();
    const [confirming, setConfirming] = useState(false);
    const [busy, track] = useBusy();
    if (readOnly) return null;
    const sendAnswers = () => quietly(track(send({ type: 'ask.done' })).then(() => setConfirming(false)));
    if (confirming) {
        return (
            <div className="phase-gate is-confirming">
                <span className="small">
                    Send your answers with {gate.open} question{gate.open === 1 ? '' : 's'} unanswered?
                </span>
                <div className="row">
                    <button type="button" className="button-text" onClick={() => setConfirming(false)}>
                        Cancel
                    </button>
                    <button type="button" className="button-primary" disabled={busy} onClick={sendAnswers}>
                        Send anyway
                    </button>
                </div>
            </div>
        );
    }
    return (
        <div className="phase-gate">
            <button
                type="button"
                className="button-primary"
                disabled={!gate.asked || busy}
                title={gate.asked ? undefined : 'The agent has not asked anything yet'}
                onClick={() => (gate.open ? setConfirming(true) : sendAnswers())}
            >
                Send answers to the agent
            </button>
        </div>
    );
}

/**
 * An ask: questions an agent puts to the user mid-task, with no phases. The navigator, then the question and info cards
 * by group, and the button that sends the answers back.
 */
export function Ask() {
    const output = useSelector((view) => view.output);
    const empty = useSelector((view) => Object.keys(view.questions).length === 0);
    return (
        <QuestionsPage
            eyebrow="QUESTIONS FROM THE AGENT"
            head={
                <p className="lede">
                    Answer what you can, select any text to comment on it, or message the agent. Send your answers when you are
                    done
                    {output ? (
                        <>
                            , and they are also saved to <code>{output}</code>.
                        </>
                    ) : (
                        '.'
                    )}
                </p>
            }
            gate={<SendAnswers />}
        >
            <QuestionGroups scope={null} />
            {empty && <p className="muted">The agent is writing its questions. They appear here.</p>}
        </QuestionsPage>
    );
}
