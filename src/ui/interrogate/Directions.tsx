import { type KeyboardEvent, useState } from 'react';
import type { Answer, QuestionRecord } from '../../shared/questions';
import { BlockView } from '../blocks/Block';
import { CheckIcon } from '../components/icons';
import { Markdown } from '../components/Markdown';
import type { AnswerDraft } from './drafts';

const LETTERS = 'ABCDEFGHIJKL';

/**
 * The directions question's input: a tab per direction with its description, trade-off and supporting blocks, and a
 * checkbox to investigate it. Every panel stays rendered, the inactive ones hidden, so a comment anchored to a
 * direction's text keeps its place whichever tab is showing. `previous` marks the directions picked before the agent
 * changed the question.
 */
export function DirectionsInput({
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
    const options = question.options ?? [];
    const [active, setActive] = useState(() => (options.find((option) => option.recommended) ?? options[0])?.id);
    const current = options.find((option) => option.id === active) ?? options[0];
    const picked = draft.choices ?? [];
    const name = `directions-${question.id}`;
    const toggle = (id: string) =>
        setDraft({ ...draft, choices: picked.includes(id) ? picked.filter((choice) => choice !== id) : [...picked, id] });

    // Arrow keys move between tabs, as the ARIA tabs pattern expects.
    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
        if (!step || !current) return;
        event.preventDefault();
        const next = options[(options.indexOf(current) + step + options.length) % options.length]!;
        setActive(next.id);
        document.getElementById(`${name}-tab-${next.id}`)?.focus();
    };

    return (
        <div className="q-inputs directions">
            <div className="direction-tabs" role="tablist" aria-label="Directions" onKeyDown={onKeyDown}>
                {options.map((option, index) => {
                    const selected = option.id === current?.id;
                    const investigating = picked.includes(option.id);
                    return (
                        <button
                            key={option.id}
                            type="button"
                            role="tab"
                            id={`${name}-tab-${option.id}`}
                            className={`direction-tab${investigating ? ' is-picked' : ''}`}
                            aria-selected={selected}
                            aria-controls={`${name}-panel-${option.id}`}
                            tabIndex={selected ? 0 : -1}
                            onClick={() => setActive(option.id)}
                        >
                            <span className="direction-letter">{LETTERS[index]}</span>
                            <span className="direction-tab-label">{option.label}</span>
                            {investigating && (
                                <span className="direction-picked">
                                    <CheckIcon />
                                    <span className="visually-hidden"> (investigating)</span>
                                </span>
                            )}
                        </button>
                    );
                })}
            </div>
            {options.map((option) => (
                <div
                    key={option.id}
                    role="tabpanel"
                    id={`${name}-panel-${option.id}`}
                    aria-labelledby={`${name}-tab-${option.id}`}
                    className="direction-panel"
                    hidden={option.id !== current?.id}
                >
                    <div className="option-label">
                        <span>{option.label}</span>
                        {option.recommended && <span className="recommends">Agent recommends</span>}
                        {previous?.choices?.includes(option.id) && <span className="last-answer">your last answer</span>}
                    </div>
                    {option.detail && (
                        <div className="direction-detail">
                            <Markdown source={option.detail} />
                        </div>
                    )}
                    {option.tradeoff && <p className="option-tradeoff">Trade-off: {option.tradeoff}</p>}
                    {option.blocks?.map((block, index) => (
                        <BlockView
                            key={index}
                            block={{ ...block, id: `${question.id}-${option.id}-${index}` }}
                            placement="question"
                        />
                    ))}
                    <label className={`direction-pick${picked.includes(option.id) ? ' is-selected' : ''}`}>
                        <input
                            type="checkbox"
                            checked={picked.includes(option.id)}
                            disabled={disabled}
                            onChange={() => toggle(option.id)}
                        />
                        Investigate this direction
                    </label>
                </div>
            ))}
            {question.allowOther && (!disabled || draft.text) && (
                <>
                    <label className="visually-hidden" htmlFor={`${name}-other`}>
                        Another direction
                    </label>
                    <textarea
                        id={`${name}-other`}
                        className="grow-text"
                        rows={1}
                        placeholder="Or suggest another direction…"
                        value={draft.text ?? ''}
                        disabled={disabled}
                        onChange={(event) => setDraft({ ...draft, text: event.target.value })}
                    />
                </>
            )}
        </div>
    );
}
