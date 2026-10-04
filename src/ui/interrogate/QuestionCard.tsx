import {
    type KeyboardEvent,
    memo,
    type MouseEvent,
    type ReactElement,
    type RefCallback,
    useCallback,
    useEffect,
    useRef,
    useState
} from 'react';
import { createPortal } from 'react-dom';
import {
    answerProblem,
    ASSUMPTION_HOLDS,
    describeAnswer,
    isInfo,
    type Answer,
    type QuestionRecord
} from '../../shared/questions';
import { BlockView } from '../blocks/Block';
import { commentOnWhole } from '../comments/composer';
import { CheckIcon, DashIcon, MergeIcon, WarningIcon } from '../components/icons';
import { LinkedText, QuestionLink } from '../components/LinkedText';
import { Markdown } from '../components/Markdown';
import { ThreadDialog, ThreadRow } from '../components/Thread';
import { relativeTime } from '../format';
import { useNow } from '../hooks';
import { useReadOnly } from '../readOnly';
import { useSendOnKey } from '../sendKey';
import { deepEqual, useRecord, useSelector } from '../store';
import { quietly, useActions, useBusy } from '../ui';
import { DirectionsInput } from './Directions';
import { type AnswerDraft, hasContent, lengthProblem, toAnswer, useDraft, withoutRemovedPicks } from './drafts';

const LETTERS = 'ABCDEFGHIJKL';

/** An option's label as a choice shows it: lettered on a single-choice question. */
function optionLabel(question: QuestionRecord, index: number): string {
    const option = question.options?.[index];
    return option ? (question.input === 'single' ? `${LETTERS[index]} · ${option.label}` : option.label) : '';
}

/** A question's status as a badge. An open assumption reads as unconfirmed. */
function StatusBadge({ question }: { question: QuestionRecord }) {
    switch (question.status) {
        case 'answered':
            return <span className="badge badge-answered">Answered</span>;
        case 'needs-review':
            return <span className="badge badge-attention">Needs review</span>;
        case 'conflict':
            return (
                <span className="badge badge-attention">
                    <WarningIcon size={11} />
                    Needs a look
                </span>
            );
        case 'closed':
            return <span className="badge badge-closed">Closed</span>;
        case 'merged':
            return <span className="badge badge-closed">Merged</span>;
        default:
            return <span className="badge badge-open">{question.input === 'assumption' ? 'Unconfirmed' : 'Open'}</span>;
    }
}

const IMPACT = { high: 'High impact', medium: 'Medium impact', low: 'Low impact' } as const;

/**
 * A card's name: its `Q-<n>` id, except the one directions question, which closes the explore stage rather than
 * asking one more thing, so it is named for what it is.
 */
function QuestionId({ question }: { question: QuestionRecord }) {
    if (question.input === 'directions') return <span className="badge badge-directions">Directions</span>;
    return <span className="q-id">{question.id}</span>;
}

/** An assumption card reads differently from a question: the agent states something, the user confirms or corrects it. */
function KindBadge({ question }: { question: QuestionRecord }) {
    if (question.input === 'assumption') return <span className="badge badge-kind">Assumption</span>;
    if (isInfo(question)) return <span className="badge badge-kind">Info</span>;
    return null;
}

/** The card class that marks an assumption or the directions question. */
function kindClass(question: QuestionRecord): string {
    if (question.input === 'assumption') return ' is-assumption';
    return question.input === 'directions' ? ' is-directions' : '';
}

/** How the one-line answered card introduces the answer. */
function answeredLabel(question: QuestionRecord): string {
    return question.input === 'directions' ? 'Investigating:' : 'You answered:';
}

/** Why the agent asks, what it found, where it looked, and any diagram, above the options. */
function Context({ question }: { question: QuestionRecord }) {
    const context = question.context;
    if (!context) return null;
    return (
        <div className="q-context">
            {context.why && (
                <div className="q-why">
                    <Markdown source={context.why} />
                </div>
            )}
            {context.findings && context.findings.length > 0 && (
                <ul className="q-findings">
                    {context.findings.map((finding) => (
                        <li key={finding}>
                            <Markdown source={finding} />
                        </li>
                    ))}
                </ul>
            )}
            {context.refs && context.refs.length > 0 && (
                // Where the agent looked, to check its findings against: useful on demand, so closed by default.
                <details className="q-refs">
                    <summary>Sources ({context.refs.length})</summary>
                    <div className="q-refs-list">
                        {context.refs.map((ref) => (
                            <code key={ref} className="ref-chip">
                                {ref}
                            </code>
                        ))}
                    </div>
                </details>
            )}
            {context.blocks?.map((block, index) => (
                <BlockView key={index} block={{ ...block, id: `${question.id}-context-${index}` }} placement="question" />
            ))}
        </div>
    );
}

/**
 * The comments on this question, each a row that opens its thread in a dialog, where the agent's reply shows in
 * full with its diagrams. Sits outside the question's anchor target, so its text never shifts comment offsets.
 */
function Clarifications({ question }: { question: QuestionRecord }) {
    const target = `question:${question.id}`;
    const ids = useSelector(
        (view) =>
            Object.values(view.threads)
                .filter((thread) => thread.anchor?.target === target)
                .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
                .map((thread) => thread.id),
        deepEqual
    );
    const [open, setOpen] = useState<string>();
    if (ids.length === 0) return null;
    return (
        <section className="q-clarify" aria-label={`Comments on ${question.id}`}>
            <h4 className="eyebrow">Clarifications</h4>
            <ul className="q-clarify-list">
                {ids.map((id) => (
                    <li key={id}>
                        <ThreadRow id={id} onOpen={() => setOpen(id)} />
                    </li>
                ))}
            </ul>
            {open && <ThreadDialog id={open} title={`${question.id} · ${question.title}`} onClose={() => setOpen(undefined)} />}
        </section>
    );
}

/** Where a card layout shows the question's Clarifications. */
type ClarificationsSlot = RefCallback<HTMLElement>;

/**
 * A question's Clarifications, kept mounted whichever layout its card shows, so a status change that swaps the layout
 * keeps an open thread and its half-typed reply. They render through a portal into one element that each layout's
 * slot adopts (the reverse-portal pattern). Moving that element drops focus, so the slot puts it back.
 */
function useClarifications(question: QuestionRecord | undefined): [ReactElement | null, ClarificationsSlot] {
    const [host] = useState(() => {
        const element = document.createElement('div');
        element.style.display = 'contents';
        return element;
    });
    const focused = useRef<HTMLElement | null>(null);
    const slot = useCallback(
        (element: HTMLElement | null) => {
            if (!element) {
                // React detaches the old slot while its layout is still on the page, before the host leaves with it.
                const active = document.activeElement;
                focused.current = active instanceof HTMLElement && host.contains(active) ? active : null;
                return;
            }
            element.appendChild(host);
            focused.current?.focus();
            focused.current = null;
        },
        [host]
    );
    return [question ? createPortal(<Clarifications question={question} />, host) : null, slot];
}

/** The place in a card layout that shows the question's Clarifications. */
function ClarificationsHere({ slot }: { slot: ClarificationsSlot }) {
    return <div ref={slot} style={{ display: 'contents' }} />;
}

/** An assumption holds, or the user says what is actually the case. */
function AssumptionInput({
    question,
    draft,
    setDraft,
    previous,
    disabled
}: {
    question: QuestionRecord;
    draft: AnswerDraft;
    setDraft: (next: AnswerDraft) => void;
    previous?: Answer;
    disabled: boolean;
}) {
    const holds = draft.choice === ASSUMPTION_HOLDS;
    const correcting = draft.text !== undefined;
    const last = (mine: boolean) => (previous && mine ? <span className="last-answer">your last answer</span> : null);
    return (
        <div className="q-inputs">
            <div className="chip-row" role="group" aria-label="Does this hold?">
                <button
                    type="button"
                    className={`choice-chip${holds ? ' is-pressed' : ''}`}
                    aria-pressed={holds}
                    disabled={disabled}
                    onClick={() => setDraft({ ...draft, choice: holds ? undefined : ASSUMPTION_HOLDS, text: undefined })}
                >
                    Holds
                    {last(previous?.choice === ASSUMPTION_HOLDS)}
                </button>
                <button
                    type="button"
                    className={`choice-chip is-own${correcting ? ' is-pressed' : ''}`}
                    aria-pressed={correcting}
                    disabled={disabled}
                    onClick={() => setDraft({ ...draft, choice: undefined, text: correcting ? undefined : '' })}
                >
                    Not quite…
                    {last(Boolean(previous?.text))}
                </button>
            </div>
            {correcting && (!disabled || draft.text) && (
                <>
                    <label className="visually-hidden" htmlFor={`answer-${question.id}-correction`}>
                        What is actually the case
                    </label>
                    <textarea
                        id={`answer-${question.id}-correction`}
                        className="grow-text"
                        rows={2}
                        placeholder="What is actually the case?"
                        value={draft.text ?? ''}
                        autoFocus={!draft.text}
                        disabled={disabled}
                        onChange={(event) => setDraft({ ...draft, text: event.target.value })}
                    />
                </>
            )}
        </div>
    );
}

/**
 * The input types. `previous` marks the answer the user gave before the agent changed the question.
 * `disabled` shows a saved answer read-only, without the empty text boxes it did not use.
 */
function Inputs({
    question,
    draft,
    setDraft,
    previous,
    disabled = false
}: {
    question: QuestionRecord;
    draft: AnswerDraft;
    setDraft: (next: AnswerDraft) => void;
    previous?: Answer;
    disabled?: boolean;
}) {
    if (question.input === 'assumption') {
        return <AssumptionInput question={question} draft={draft} setDraft={setDraft} previous={previous} disabled={disabled} />;
    }
    if (question.input === 'directions') {
        return <DirectionsInput question={question} draft={draft} setDraft={setDraft} previous={previous} disabled={disabled} />;
    }
    const options = question.options ?? [];
    const name = `answer-${question.id}`;
    const lastAnswer = (id: string) =>
        previous && (previous.choice === id || previous.choices?.includes(id)) ? (
            <span className="last-answer">your last answer</span>
        ) : null;

    if (question.input === 'freeform') {
        return (
            <div className="q-inputs">
                <label className="visually-hidden" htmlFor={`${name}-text`}>
                    Your answer
                </label>
                <textarea
                    id={`${name}-text`}
                    className="grow-text"
                    rows={3}
                    placeholder="Write your answer…"
                    value={draft.text ?? ''}
                    disabled={disabled}
                    onChange={(event) => setDraft({ ...draft, text: event.target.value })}
                />
            </div>
        );
    }

    if (question.input === 'single') {
        return (
            <fieldset className="q-inputs">
                <legend className="visually-hidden">Pick one</legend>
                {options.map((option, index) => {
                    const selected = draft.choice === option.id;
                    return (
                        <label key={option.id} className={`option-card${selected ? ' is-selected' : ''}`}>
                            <input
                                type="radio"
                                name={name}
                                checked={selected}
                                disabled={disabled}
                                onChange={() => setDraft({ ...draft, choice: option.id, text: undefined })}
                            />
                            <span className="option-body">
                                <span className="option-label">
                                    <span>{optionLabel(question, index)}</span>
                                    {option.recommended && <span className="recommends">Agent recommends</span>}
                                    {lastAnswer(option.id)}
                                </span>
                                {option.detail && <span className="option-detail">{option.detail}</span>}
                                {option.tradeoff && <span className="option-tradeoff">Trade-off: {option.tradeoff}</span>}
                            </span>
                        </label>
                    );
                })}
                {question.allowOther && (!disabled || draft.text) && (
                    <>
                        <label className="visually-hidden" htmlFor={`${name}-other`}>
                            Your own answer
                        </label>
                        <textarea
                            id={`${name}-other`}
                            className="grow-text"
                            rows={1}
                            placeholder="Or write your own answer…"
                            value={draft.text ?? ''}
                            disabled={disabled}
                            onChange={(event) =>
                                setDraft({
                                    ...draft,
                                    text: event.target.value,
                                    choice: event.target.value.trim() ? undefined : draft.choice
                                })
                            }
                        />
                    </>
                )}
            </fieldset>
        );
    }

    const multi = question.input === 'multi';
    const writing = !multi && draft.text !== undefined;
    return (
        <div className="q-inputs">
            <div className="chip-row" role="group" aria-label={multi ? 'Pick any that apply' : 'Pick one'}>
                {options.map((option) => {
                    const pressed = multi ? Boolean(draft.choices?.includes(option.id)) : draft.choice === option.id;
                    return (
                        <button
                            key={option.id}
                            type="button"
                            className={`choice-chip${pressed ? ' is-pressed' : ''}${option.recommended ? ' is-recommended' : ''}`}
                            aria-pressed={pressed}
                            disabled={disabled}
                            title={option.detail}
                            onClick={() =>
                                multi
                                    ? setDraft({
                                          ...draft,
                                          choices: pressed
                                              ? (draft.choices ?? []).filter((id) => id !== option.id)
                                              : [...(draft.choices ?? []), option.id]
                                      })
                                    : setDraft({ ...draft, choice: pressed ? undefined : option.id, text: undefined })
                            }
                        >
                            {option.label}
                            {option.recommended && <span className="visually-hidden"> (agent recommends)</span>}
                            {lastAnswer(option.id)}
                        </button>
                    );
                })}
                {!multi && (
                    <button
                        type="button"
                        className={`choice-chip is-own${writing ? ' is-pressed' : ''}`}
                        aria-pressed={writing}
                        disabled={disabled}
                        onClick={() => setDraft({ ...draft, choice: undefined, text: writing ? undefined : '' })}
                    >
                        Write my own…
                    </button>
                )}
            </div>
            {(writing || (multi && question.allowOther)) && (!disabled || draft.text) && (
                <>
                    <label className="visually-hidden" htmlFor={`${name}-own`}>
                        Your own answer
                    </label>
                    <textarea
                        id={`${name}-own`}
                        className="grow-text"
                        rows={1}
                        placeholder={multi ? 'Anything else? (optional)' : 'Your own answer…'}
                        value={draft.text ?? ''}
                        autoFocus={writing && !draft.text}
                        disabled={disabled}
                        onChange={(event) => setDraft({ ...draft, text: event.target.value })}
                    />
                </>
            )}
        </div>
    );
}

/** The optional note field under an answer. */
function Note({
    id,
    draft,
    setDraft,
    disabled = false
}: {
    id: string;
    draft: AnswerDraft;
    setDraft: (next: AnswerDraft) => void;
    disabled?: boolean;
}) {
    return (
        <div className="note-field">
            <label htmlFor={`note-${id}`}>Add a note (optional)</label>
            <textarea
                id={`note-${id}`}
                rows={2}
                value={draft.note ?? ''}
                disabled={disabled}
                onChange={(event) => setDraft({ ...draft, note: event.target.value })}
            />
        </div>
    );
}

/** "You: Plans table + per-key override. Overrides need an expiry date." */
function YourAnswer({ question, answer, label = 'You:' }: { question: QuestionRecord; answer: Answer; label?: string }) {
    return (
        <p className="your-answer">
            <span className="muted">{label}</span> {describeAnswer(question, answer)}
            {answer.note && (
                <>
                    {'. '}
                    <em>{answer.note}</em>
                </>
            )}
        </p>
    );
}

/**
 * The question's context and options, kept hidden in the commentable text of a layout that shows only its title and
 * answer, so a comment quoting them still attaches, as the directions card keeps its inactive panels.
 */
function HiddenText({ question }: { question: QuestionRecord }) {
    return (
        <div hidden>
            <Context question={question} />
            {!isInfo(question) && <Inputs question={question} draft={{}} setDraft={() => undefined} disabled />}
        </div>
    );
}

/** An info card asks nothing: the agent's context for the reader, with the same findings, sources and blocks. */
function Info({ question, slot }: { question: QuestionRecord; slot: ClarificationsSlot }) {
    const readOnly = useReadOnly();
    return (
        <article id={`q-${question.id}`} className="q-card is-info" aria-labelledby={`q-title-${question.id}`} data-scroll-anchor>
            <div className="q-head">
                <div className="q-head-start">
                    <QuestionId question={question} />
                    <KindBadge question={question} />
                </div>
            </div>
            <div data-anchor-target={`question:${question.id}`} className="q-anchor">
                <h3 id={`q-title-${question.id}`} className="q-title q-title-medium">
                    {question.title}
                </h3>
                <Context question={question} />
            </div>
            <ClarificationsHere slot={slot} />
            {!readOnly && (
                <footer className="q-footer">
                    <button
                        type="button"
                        className="button-text"
                        onClick={() => commentOnWhole(`question:${question.id}`, 'question')}
                    >
                        Ask to clarify
                    </button>
                </footer>
            )}
        </article>
    );
}

/** A question the agent is still writing: its title so far, and the Clarifications the rewrite may answer. */
function Streaming({ question, slot }: { question: QuestionRecord; slot: ClarificationsSlot }) {
    return (
        <article
            id={`q-${question.id}`}
            className="q-card is-streaming"
            aria-busy="true"
            aria-label={`${question.id}, being written`}
            data-scroll-anchor
        >
            <div className="q-head">
                <QuestionId question={question} />
                <span className="badge badge-writing">
                    <span className="dot dot-accent" aria-hidden="true" />
                    Agent is writing…
                </span>
            </div>
            <div className="q-title q-title-streaming">
                {question.title}
                <span className="caret" aria-hidden="true" />
            </div>
            <div className="skeleton-rows" aria-hidden="true">
                <span />
                <span />
            </div>
            <ClarificationsHere slot={slot} />
        </article>
    );
}

/**
 * A closed or merged question folded to its title and reason, with its Clarifications kept beside it so an open
 * thread survives the agent closing the question.
 */
function Collapsed({ question, slot }: { question: QuestionRecord; slot: ClarificationsSlot }) {
    const { send } = useActions();
    const readOnly = useReadOnly();
    const [busy, track] = useBusy();
    const merged = question.status === 'merged';
    return (
        <article
            id={`q-${question.id}`}
            className="q-card is-collapsed"
            aria-labelledby={`q-title-${question.id}`}
            data-scroll-anchor
        >
            <span className={merged ? 'merge-mark' : 'state-mark state-closed'} aria-hidden="true">
                {merged ? <MergeIcon /> : <DashIcon />}
            </span>
            <div className="q-answered-main">
                <div className="q-collapsed-body" data-anchor-target={`question:${question.id}`}>
                    <div className="q-inline-head">
                        <QuestionId question={question} />
                        <h3 id={`q-title-${question.id}`} className="q-title-struck">
                            {question.title}
                        </h3>
                    </div>
                    <HiddenText question={question} />
                    <span className="q-reason">
                        {merged ? (
                            <>
                                Merged into <QuestionLink id={question.mergedInto ?? ''} />
                                {question.closedReason ? `: ${question.closedReason}` : ''}
                            </>
                        ) : (
                            <>
                                Closed by agent: <LinkedText text={question.closedReason ?? ''} />
                            </>
                        )}
                    </span>
                </div>
                <ClarificationsHere slot={slot} />
            </div>
            {!readOnly && (
                <button
                    type="button"
                    className="button-link"
                    disabled={busy}
                    onClick={() => quietly(track(send({ type: 'question.reopen', questionId: question.id })))}
                >
                    Reopen
                </button>
            )}
        </article>
    );
}

/** A question whose answer contradicts another: both answers, and which should win. */
function Conflict({ question, slot }: { question: QuestionRecord; slot: ClarificationsSlot }) {
    const other = useRecord('questions', question.conflict?.with ?? '');
    const { send } = useActions();
    const readOnly = useReadOnly();
    const [busy, track] = useBusy();
    const resolve = (choice: 'keep' | 'change-other') =>
        quietly(track(send({ type: 'conflict.resolve', questionId: question.id, choice })));
    const otherId = question.conflict?.with ?? '';
    return (
        <article
            id={`q-${question.id}`}
            className="q-card is-attention"
            aria-labelledby={`q-title-${question.id}`}
            data-scroll-anchor
        >
            <div className="q-head">
                <div className="q-head-start">
                    <QuestionId question={question} />
                    <StatusBadge question={question} />
                </div>
            </div>
            <div data-anchor-target={`question:${question.id}`} className="q-anchor">
                <h3 id={`q-title-${question.id}`} className="q-title-small">
                    {question.title}
                </h3>
                <HiddenText question={question} />
                {question.answer && <YourAnswer question={question} answer={question.answer} />}
                <div className="conflict-box">
                    This contradicts <QuestionLink id={otherId} />
                    {other?.answer ? (
                        <>
                            {', where you answered '}
                            <strong>{describeAnswer(other, other.answer)}</strong>
                        </>
                    ) : null}
                    . <LinkedText text={question.conflict?.reason ?? ''} /> Which should win?
                </div>
            </div>
            <ClarificationsHere slot={slot} />
            {!readOnly && (
                <div className="row">
                    <button
                        type="button"
                        className="button-secondary button-small"
                        disabled={busy}
                        onClick={() => resolve('keep')}
                    >
                        {question.answer ? `Keep "${describeAnswer(question, question.answer)}"` : 'Keep this question'}
                    </button>
                    <button
                        type="button"
                        className="button-secondary button-small"
                        disabled={busy}
                        onClick={() => resolve('change-other')}
                    >
                        Change {otherId}
                    </button>
                </div>
            )}
        </article>
    );
}

/**
 * One question, rendered on its own. It subscribes to its own record, so an agent
 * update to another question never re-renders it, and its unsaved selection and note
 * live in a local draft that survives reloads and is never sent until saved. An answered
 * question shows as one line; "View" opens it read-only, and a double-click edits it.
 * Its Clarifications stay mounted whichever layout its status picks.
 */
export const QuestionCard = memo(function QuestionCard({ id }: { id: string }) {
    const question = useRecord('questions', id);
    const changeId = useSelector((view) => view.changeId);
    const readOnly = useReadOnly();
    const { send } = useActions();
    const [draft, setDraft, clearDraft] = useDraft(changeId, id);
    const [busy, track] = useBusy();
    const [view, setView] = useState(false);
    const now = useNow();
    const sendOnKey = useSendOnKey();
    const [clarifications, slot] = useClarifications(question);

    // A reworded question keeps a draft only if it still fits the new options. A question still being written may
    // have none of its options yet, so its draft waits for the full question.
    useEffect(() => {
        if (!question || question.status === 'streaming' || !hasContent(draft)) return;
        const fitted = withoutRemovedPicks(question, draft);
        if (fitted !== draft) setDraft(fitted);
    }, [question, draft, setDraft]);

    if (!question) return null;
    // Every layout keeps the one Clarifications element, so a status change never remounts an open thread.
    const withClarifications = (layout: ReactElement) => (
        <>
            {layout}
            {clarifications}
        </>
    );
    if (question.status === 'streaming') return withClarifications(<Streaming question={question} slot={slot} />);
    if (question.status === 'closed' || question.status === 'merged') {
        return withClarifications(<Collapsed question={question} slot={slot} />);
    }
    if (question.status === 'conflict') return withClarifications(<Conflict question={question} slot={slot} />);
    if (isInfo(question)) return withClarifications(<Info question={question} slot={slot} />);

    const answered = question.status === 'answered' && !draft.editing;
    const viewing = answered && view && !readOnly && Boolean(question.answer);
    const needsReview = question.status === 'needs-review';
    const save = (value: Answer) =>
        quietly(
            track(send({ type: 'answer.submit', questionId: question.id, version: question.contentVersion, answer: value })).then(
                () => clearDraft()
            )
        );

    const edit = () => {
        const { choice, choices, text, note } = question.answer!;
        setView(false);
        setDraft({ choice, choices, text, note, editing: true });
    };
    const editOnDoubleClick = (event: MouseEvent<HTMLElement>) => {
        // Live controls and the full-screen block view keep their own double-click.
        if ((event.target as Element).closest('button, a, summary, .modal-backdrop')) return;
        window.getSelection()?.removeAllRanges();
        edit();
    };

    if (answered && question.answer && !viewing) {
        return withClarifications(
            <article
                id={`q-${question.id}`}
                className={`q-card is-answered${kindClass(question)}`}
                aria-labelledby={`q-title-${question.id}`}
                data-scroll-anchor
            >
                <span className="state-mark state-answered" aria-hidden="true">
                    <CheckIcon size={12} />
                </span>
                <div className="q-answered-main">
                    <div className="q-answered-body" data-anchor-target={`question:${question.id}`}>
                        <div className="q-inline-head">
                            <QuestionId question={question} />
                            <KindBadge question={question} />
                            <h3 id={`q-title-${question.id}`} className="q-title-small">
                                {question.title}
                            </h3>
                        </div>
                        <HiddenText question={question} />
                        <YourAnswer question={question} answer={question.answer} label={answeredLabel(question)} />
                    </div>
                    <ClarificationsHere slot={slot} />
                </div>
                {!readOnly && (
                    <button type="button" className="button-link" onClick={() => setView(true)}>
                        View
                    </button>
                )}
            </article>
        );
    }

    // Viewing shows the saved answer in the inputs; editing and open questions show the draft.
    const shown: AnswerDraft = viewing ? question.answer! : draft;
    const tooLong = lengthProblem(draft);
    const problem = tooLong ?? answerProblem(question, toAnswer(draft));
    // "Still right" keeps the last answer's picks the question still offers.
    const kept = question.answer && toAnswer(withoutRemovedPicks(question, question.answer));
    const keptProblem = kept && answerProblem(question, kept);
    const dirty = !viewing && hasContent(draft);
    const selected =
        draft.choice !== undefined ||
        Boolean(draft.choices?.length) ||
        (question.input !== 'freeform' && Boolean(draft.text?.trim()));
    const title = question.impact === 'high' ? 'q-title' : 'q-title q-title-medium';
    const canSave = !viewing && (!needsReview || dirty);
    const saveDraft = () => {
        if (canSave && !busy && problem === null) save(toAnswer(draft));
    };
    // The send key saves from any of the card's text boxes. A box that handled the key itself, like a
    // clarification reply, has already prevented it.
    const saveOnKey = (event: KeyboardEvent<HTMLElement>) => {
        if (event.defaultPrevented || !(event.target instanceof HTMLTextAreaElement)) return;
        sendOnKey(event, saveDraft);
    };

    return withClarifications(
        <article
            id={`q-${question.id}`}
            className={
                (viewing
                    ? 'q-card is-viewing'
                    : `q-card is-open${needsReview ? ' is-attention' : ''}${dirty ? ' is-active' : ''}`) + kindClass(question)
            }
            aria-labelledby={`q-title-${question.id}`}
            data-scroll-anchor
            onDoubleClick={viewing ? editOnDoubleClick : undefined}
            onKeyDown={readOnly ? undefined : saveOnKey}
        >
            <div className="q-head">
                <div className="q-head-start">
                    <QuestionId question={question} />
                    <KindBadge question={question} />
                    <StatusBadge question={question} />
                    {question.impact && (
                        <span className={question.impact === 'high' ? 'badge badge-impact-high' : 'badge badge-impact'}>
                            {IMPACT[question.impact]}
                        </span>
                    )}
                    {question.links?.dependsOn?.length ? (
                        <span className="q-follow">
                            Follows{' '}
                            {question.links.dependsOn.map((dependency) => (
                                <QuestionLink key={dependency} id={dependency} />
                            ))}
                        </span>
                    ) : null}
                </div>
                <span className="q-note">
                    {viewing
                        ? 'Double-click to edit'
                        : dirty && !readOnly
                          ? `Draft kept locally${tooLong ? ` · ${tooLong}` : ''}`
                          : needsReview && question.changedByAgentAt
                            ? `Reworded by agent · ${relativeTime(question.changedByAgentAt, now)}`
                            : ''}
                </span>
            </div>
            <div data-anchor-target={`question:${question.id}`} className="q-anchor">
                <h3 id={`q-title-${question.id}`} className={title}>
                    {question.title}
                </h3>
                <Context question={question} />
                {!readOnly && (
                    <Inputs
                        question={question}
                        draft={shown}
                        setDraft={setDraft}
                        previous={needsReview ? (question.answer ?? undefined) : undefined}
                        disabled={viewing}
                    />
                )}
            </div>
            {readOnly && question.answer && <YourAnswer question={question} answer={question.answer} />}
            {!readOnly && (viewing ? Boolean(shown.note) : selected) && (
                <Note id={question.id} draft={shown} setDraft={setDraft} disabled={viewing} />
            )}
            <ClarificationsHere slot={slot} />
            {!readOnly && (
                <footer className="q-footer">
                    <button
                        type="button"
                        className="button-text"
                        onClick={() => commentOnWhole(`question:${question.id}`, 'question')}
                    >
                        Ask to clarify
                    </button>
                    <div className="row">
                        {viewing && (
                            <>
                                <button type="button" className="button-text" onClick={() => setView(false)}>
                                    Close
                                </button>
                                <button type="button" className="button-secondary" onClick={edit}>
                                    Edit
                                </button>
                            </>
                        )}
                        {(dirty || draft.editing) && (
                            <button type="button" className="button-text" onClick={clearDraft}>
                                {draft.editing ? 'Cancel' : 'Discard'}
                            </button>
                        )}
                        {needsReview && kept && !dirty && (
                            <button
                                type="button"
                                className="button-primary"
                                disabled={busy || keptProblem !== null}
                                title={keptProblem ?? undefined}
                                onClick={() => save(kept)}
                            >
                                Still right - save
                            </button>
                        )}
                        {canSave && (
                            <button
                                type="button"
                                className="button-primary"
                                disabled={busy || problem !== null}
                                title={problem ?? undefined}
                                onClick={saveDraft}
                            >
                                Save answer
                            </button>
                        )}
                    </div>
                </footer>
            )}
        </article>
    );
});
