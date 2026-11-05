import { useState } from 'react';
import { z } from 'zod';
import { type QuizRecord, quizPlace } from '../../shared/quiz';
import type { View } from '../../shared/view';
import { QuizIcon } from '../components/icons';
import { Markdown, TitleMarkdown } from '../components/Markdown';
import { Modal } from '../components/Modal';
import { readJson, storageScope, writeJson } from '../local';
import { useReadOnly } from '../readOnly';
import { deepEqual, useSelector } from '../store';
import { quietly, useActions, useBusy, useUiState } from '../ui';
import { readViewed } from '../viewed';

/**
 * Quiz me: the agent's multiple-choice questions on what the reader has seen, to check themselves against it. Each
 * shows whether the pick was right, why, and where it was read. The picks are this browser's own.
 */

const picksSchema = z.record(z.string(), z.number().int().min(0));
type Picks = z.infer<typeof picksSchema>;

/** The localStorage key a page's quiz picks are kept under, by its `storageScope`. */
function picksKey(scope: string): string {
    return `planroom:${scope}:quiz-picks`;
}

/** A page's quiz picks in this browser: the choice picked for each question, by its id. */
function readPicks(scope: string): Picks {
    return picksSchema.safeParse(readJson(picksKey(scope))).data ?? {};
}

/** Where "Show me where" goes for a question: the block, slide, finding or read-through page it is about. */
function quizTarget(view: View, about: string): string | undefined {
    const place = quizPlace(view, about);
    if (!place) return undefined;
    if (place.kind === 'block') return place.section ? `block:${place.block.id}` : `slide:${place.slide.id}`;
    if (place.kind === 'item') return `item:${place.item.id}`;
    return `page:${place.page.id}`;
}

/** Quiz me is offered on a plan's write-up and anywhere in a review, while the session takes requests. */
function useQuizOffered(): boolean {
    const { tab } = useUiState();
    const kind = useSelector((view) => view.kind);
    const readOnly = useReadOnly();
    return !readOnly && (kind === 'review' || (kind === 'plan' && tab === 'writeup'));
}

/** One question: its choices until one is picked, then which was right and why, and a way back to where it was read. */
function QuizCard({
    question,
    number,
    pick,
    onPick,
    onShow
}: {
    question: QuizRecord;
    number: number;
    pick: number | undefined;
    onPick: (choice: number) => void;
    onShow: (() => void) | undefined;
}) {
    const answered = pick !== undefined;
    const right = pick === question.answer;
    return (
        <li className="quiz-card">
            <div className="quiz-question">
                <span className="mono muted">{number}</span>
                <div className="prose">
                    <Markdown source={question.question} />
                </div>
            </div>
            <div className="quiz-choices" role="group" aria-label={`Question ${number}'s choices`}>
                {question.choices.map((choice, index) => {
                    const state = !answered ? '' : index === question.answer ? ' is-right' : index === pick ? ' is-wrong' : '';
                    return (
                        <button
                            key={`${index}-${choice}`}
                            type="button"
                            className={`quiz-choice${state}`}
                            disabled={answered}
                            aria-pressed={index === pick}
                            onClick={() => onPick(index)}
                        >
                            <span>
                                <TitleMarkdown source={choice} />
                            </span>
                            {answered && index === question.answer && <span className="quiz-mark">Right answer</span>}
                            {answered && index === pick && !right && <span className="quiz-mark">Your pick</span>}
                        </button>
                    );
                })}
            </div>
            {answered && (
                <div className={`quiz-reveal ${right ? 'is-right' : 'is-wrong'}`}>
                    <span className="strong">{right ? 'Right.' : 'Not quite.'}</span>
                    <div className="prose">
                        <Markdown source={question.explanation} />
                    </div>
                    {onShow && (
                        <button type="button" className="button-link small" onClick={onShow}>
                            Show me where
                        </button>
                    )}
                </div>
            )}
        </li>
    );
}

/** The quiz over the page: the questions so far, the score, the agent's note, and More for another set. */
function QuizDialog({
    picks,
    onPick,
    onMore,
    busy,
    onClose
}: {
    picks: Picks;
    onPick: (id: string, choice: number) => void;
    onMore: () => void;
    busy: boolean;
    onClose: () => void;
}) {
    const quiz = useSelector((view) => view.quiz);
    const targets = useSelector((view) => view.quiz.questions.map((question) => quizTarget(view, question.about)), deepEqual);
    const scope = useSelector(storageScope);
    const { goTo } = useActions();
    const answered = quiz.questions.filter((question) => picks[question.id] !== undefined);
    const right = answered.filter((question) => picks[question.id] === question.answer).length;
    const nothingRead = quiz.questions.length === 0 && readViewed(scope).length === 0;
    const pending = Boolean(quiz.requestedAt);
    return (
        <Modal label="Quiz me" onClose={onClose} className="dialog quiz-dialog">
            <h2 className="dialog-title">Quiz me</h2>
            <p className="small muted">Questions on what you have read so far, to check yourself against it.</p>
            {answered.length > 0 && (
                <p className="quiz-score" role="status">
                    {right} of {answered.length} right
                </p>
            )}
            {quiz.questions.length > 0 && (
                <ol className="quiz-list">
                    {quiz.questions.map((question, index) => {
                        const target = targets[index];
                        return (
                            <QuizCard
                                key={question.id}
                                question={question}
                                number={index + 1}
                                pick={picks[question.id]}
                                onPick={(choice) => onPick(question.id, choice)}
                                onShow={
                                    target
                                        ? () => {
                                              onClose();
                                              goTo(target);
                                          }
                                        : undefined
                                }
                            />
                        );
                    })}
                </ol>
            )}
            {pending && (
                <p className="small muted" role="status">
                    The agent is writing questions on what you have read…
                </p>
            )}
            {!pending && quiz.note && (
                <div className="prose quiz-note">
                    <Markdown source={quiz.note} />
                </div>
            )}
            {nothingRead && (
                <p className="small muted">Nothing to quiz you on yet: questions come from what you have read on the page.</p>
            )}
            <div className="dialog-actions">
                <button type="button" className="button-secondary" disabled={busy || pending || nothingRead} onClick={onMore}>
                    {quiz.questions.length ? 'More questions' : 'Ask for questions'}
                </button>
            </div>
        </Modal>
    );
}

/**
 * The rail's Quiz me button, with the number of questions not yet answered, and its dialog. With no questions yet, a
 * press asks the agent for them and the button shows as loading until the first one comes through; it opens the dialog
 * once there are questions, before anything is read, or to show the agent's note. More asks for another set. `compact`
 * is the collapsed rail's icon button.
 */
export function QuizButton({ compact = false }: { compact?: boolean }) {
    const offered = useQuizOffered();
    const scope = useSelector(storageScope);
    const questions = useSelector((view) => view.quiz.questions);
    const requested = useSelector((view) => Boolean(view.quiz.requestedAt));
    const note = useSelector((view) => view.quiz.note);
    const { send } = useActions();
    const [busy, track] = useBusy();
    const [picks, setPicks] = useState(() => readPicks(scope));
    const [open, setOpen] = useState(false);
    if (!offered) return null;
    const unanswered = questions.filter((question) => picks[question.id] === undefined).length;
    const ask = () => {
        const seen = readViewed(scope);
        if (seen.length) quietly(track(send({ type: 'quiz.request', seen })));
    };
    const loading = questions.length === 0 && (requested || busy);
    const show = () => {
        if (questions.length === 0 && !requested && !note && readViewed(scope).length) ask();
        else setOpen(true);
    };
    const pick = (id: string, choice: number) => {
        const next = { ...picks, [id]: choice };
        setPicks(next);
        writeJson(picksKey(scope), next);
    };
    const label = loading
        ? 'Quiz me, the agent is writing your questions'
        : unanswered
          ? `Quiz me, ${unanswered} unanswered`
          : 'Quiz me';
    const icon = loading ? <span className="spinner" aria-hidden="true" /> : <QuizIcon />;
    const count = !loading && unanswered > 0 && <span className="quiz-count">{unanswered}</span>;
    return (
        <>
            {compact ? (
                <button
                    type="button"
                    className="icon-button quiz-compact"
                    aria-label={label}
                    aria-busy={loading}
                    title={label}
                    disabled={loading}
                    onClick={show}
                >
                    {icon}
                    {count}
                </button>
            ) : (
                <div className="rail-foot">
                    <button
                        type="button"
                        className="button-secondary quiz-button"
                        aria-label={label}
                        aria-busy={loading}
                        disabled={loading}
                        onClick={show}
                    >
                        {icon}
                        <span>{loading ? 'Writing your quiz…' : 'Quiz me'}</span>
                        {count}
                    </button>
                </div>
            )}
            {open && <QuizDialog picks={picks} onPick={pick} onMore={ask} busy={busy} onClose={() => setOpen(false)} />}
        </>
    );
}
