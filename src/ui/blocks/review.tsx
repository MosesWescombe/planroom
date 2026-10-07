import {
    type CSSProperties,
    createContext,
    type FormEvent,
    useContext,
    useEffect,
    useId,
    useMemo,
    useRef,
    useState
} from 'react';
import { RISK_AREAS, type YourTakeConfig } from '../../shared/blocks';
import { comparePoints, TAKE_TITLES, type TakeAnswer } from '../../shared/review';
import { LinkedText } from '../components/LinkedText';
import { Markdown } from '../components/Markdown';
import { usePrinting, useReducedMotion } from '../hooks';
import { useReadOnly } from '../readOnly';
import { deepEqual, useSelector } from '../store';
import { quietly, useActions, useBusy } from '../ui';
import type { BlockProps } from './Block';
import { ImageBlock } from './basic';
import { GraphDiagram, SequenceDiagram } from './diagrams';
import { flowGraph, layoutGraph, layoutSequence } from './layout';
import { usePins } from './pins';

/** A step-through as the deck drives it: `move` takes it a step and says whether it could. */
export interface Stepper {
    move(direction: 1 | -1): boolean;
}

/** How a step-through on the slide on show offers the deck its steps; the arrow keys move it before the deck. */
export const StepperContext = createContext<((stepper: Stepper) => () => void) | undefined>(undefined);

/** `analogy`: what the change is like, part by part, and where the comparison stops holding. */
export function AnalogyBlock({ id, config, placement }: BlockProps<'analogy'>) {
    return (
        <div className="analogy">
            <div className="analogy-head">
                <span className="eyebrow">This change is like</span>
                <span className="analogy-title">{config.title}</span>
            </div>
            {config.illustration && <ImageBlock id={`${id}-illustration`} config={config.illustration} placement={placement} />}
            <dl className="analogy-pairs">
                {config.pairs.map((pair) => (
                    <div key={`${pair.real}-${pair.like}`} className="analogy-pair">
                        <dt>
                            <LinkedText text={pair.real} />
                        </dt>
                        <dd>
                            <span aria-hidden="true" className="analogy-arrow">
                                is like
                            </span>
                            <LinkedText text={pair.like} />
                            {pair.note && <span className="small muted">{pair.note}</span>}
                        </dd>
                    </div>
                ))}
            </dl>
            {config.breaks && (
                <p className="analogy-breaks">
                    <span className="strong">Where it breaks down: </span>
                    <LinkedText text={config.breaks} />
                </p>
            )}
        </div>
    );
}

/**
 * `stepThrough`: a diagram walked a step at a time, each step lighting its nodes or messages under its caption. The
 * arrow keys and buttons move it; on a slide the deck hands it the keys first. Under reduced motion, and in print, every
 * step shows at once, which is its final state.
 */
export function StepThroughBlock({ id, config }: BlockProps<'stepThrough'>) {
    const reduced = useReducedMotion();
    const printing = usePrinting();
    const all = reduced || printing;
    const [step, setStep] = useState(0);
    const at = useRef(step);
    at.current = step;
    const register = useContext(StepperContext);
    const { steps, diagram } = config;
    const move = (direction: 1 | -1): boolean => {
        const next = at.current + direction;
        if (all || next < 0 || next >= steps.length) return false;
        setStep(next);
        return true;
    };
    const moveRef = useRef(move);
    moveRef.current = move;
    useEffect(() => register?.({ move: (direction) => moveRef.current(direction) }), [register]);
    const shown = all ? steps : [steps[step]!];
    const pins = usePins(id);
    const flow = useMemo(() => (diagram.type === 'flow' ? layoutGraph(flowGraph(diagram.config)) : undefined), [diagram]);
    const sequence = useMemo(() => (diagram.type === 'sequence' ? layoutSequence(diagram.config) : undefined), [diagram]);
    return (
        <div
            className="step-through"
            tabIndex={0}
            onKeyDown={(event) => {
                if (event.key === 'ArrowRight' || event.key === 'ArrowLeft')
                    if (move(event.key === 'ArrowRight' ? 1 : -1)) {
                        event.preventDefault();
                        event.stopPropagation();
                    }
            }}
        >
            {flow && <GraphDiagram layout={flow} highlight={new Set(shown.flatMap((each) => each.nodes))} pins={pins} />}
            {sequence && (
                <SequenceDiagram layout={sequence} highlight={new Set(shown.flatMap((each) => each.messages))} pins={pins} />
            )}
            {all ? (
                <ol className="step-captions">
                    {steps.map((each, index) => (
                        <li key={index}>
                            <LinkedText text={each.caption} />
                        </li>
                    ))}
                </ol>
            ) : (
                <div className="step-controls">
                    <button
                        type="button"
                        className="button-secondary button-small"
                        disabled={step === 0}
                        onClick={() => move(-1)}
                    >
                        Back
                    </button>
                    <p className="step-caption" aria-live="polite">
                        <span className="mono muted">
                            {step + 1}/{steps.length}
                        </span>{' '}
                        <LinkedText text={steps[step]!.caption} />
                    </p>
                    <button
                        type="button"
                        className="button-secondary button-small"
                        disabled={step === steps.length - 1}
                        onClick={() => move(1)}
                    >
                        Next step
                    </button>
                </div>
            )}
        </div>
    );
}

/** Lines of a textarea as list points, blank ones dropped. */
function points(text: string): string[] {
    return text
        .split('\n')
        .map((line) => line.replace(/^\s*[-*]\s*/, '').trim())
        .filter(Boolean);
}

/** The form a take asks with, by its kind. It hands back an answer once the reviewer has given one. */
function TakeForm({ config, onAnswer, busy }: { config: YourTakeConfig; onAnswer: (answer: TakeAnswer) => void; busy: boolean }) {
    const [guess, setGuess] = useState('');
    const [own, setOwn] = useState('');
    const [pros, setPros] = useState('');
    const [cons, setCons] = useState('');
    const [ratings, setRatings] = useState<Partial<Record<(typeof RISK_AREAS)[number], number>>>({});
    const [choice, setChoice] = useState<number>();
    const name = useId();
    let answer: TakeAnswer | undefined;
    const guessed = own.trim() || guess;
    if (config.kind === 'predict') answer = guessed ? { kind: 'predict', guess: guessed } : undefined;
    if (config.kind === 'prosCons')
        answer =
            points(pros).length + points(cons).length > 0
                ? { kind: 'prosCons', pros: points(pros), cons: points(cons) }
                : undefined;
    if (config.kind === 'risk') answer = Object.keys(ratings).length ? { kind: 'risk', ratings } : undefined;
    if (config.kind === 'check') answer = choice === undefined ? undefined : { kind: 'check', choice };
    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (answer) onAnswer(answer);
    };
    return (
        <form className="take-form" onSubmit={submit}>
            {config.kind === 'predict' && (
                <>
                    <p className="take-prompt">{config.prompt}</p>
                    {config.options?.map((option) => (
                        <label key={option} className="take-option">
                            <input
                                type="radio"
                                name={name}
                                checked={guess === option && !own}
                                onChange={() => setGuess(option)}
                            />
                            <span>{option}</span>
                        </label>
                    ))}
                    <label className="take-field">
                        <span className="small muted">{config.options ? 'Or in your own words' : 'Your guess'}</span>
                        <input className="field-input" value={own} onChange={(event) => setOwn(event.target.value)} />
                    </label>
                </>
            )}
            {config.kind === 'prosCons' && (
                <>
                    <p className="take-prompt">{config.prompt ?? 'What are the pros and cons, as you see them?'}</p>
                    <div className="take-columns">
                        <label className="take-field">
                            <span className="small muted">Pros, one a line</span>
                            <textarea rows={4} value={pros} onChange={(event) => setPros(event.target.value)} />
                        </label>
                        <label className="take-field">
                            <span className="small muted">Cons, one a line</span>
                            <textarea rows={4} value={cons} onChange={(event) => setCons(event.target.value)} />
                        </label>
                    </div>
                </>
            )}
            {config.kind === 'risk' && (
                <>
                    <p className="take-prompt">{config.prompt ?? 'How risky is this change? 1 is low, 5 is high.'}</p>
                    {/* The scale's ends say which way it runs, so nobody rates quality where risk is asked. */}
                    <div className="risk-row risk-scale" aria-hidden="true">
                        <span className="risk-area" />
                        <span className="small strong">Low risk</span>
                        <span className="grow" />
                        <span className="small strong">High risk</span>
                    </div>
                    {RISK_AREAS.map((area) => (
                        <fieldset key={area} className="risk-row">
                            <legend className="risk-area">{area}</legend>
                            {[1, 2, 3, 4, 5].map((value) => (
                                <label key={value} className="risk-choice">
                                    <input
                                        type="radio"
                                        name={`${name}-${area}`}
                                        aria-label={`${area} ${value}${value === 1 ? ', low risk' : value === 5 ? ', high risk' : ''}`}
                                        checked={ratings[area] === value}
                                        onChange={() => setRatings({ ...ratings, [area]: value })}
                                    />
                                    <span>{value}</span>
                                </label>
                            ))}
                        </fieldset>
                    ))}
                </>
            )}
            {config.kind === 'check' && (
                <>
                    <p className="take-prompt">{config.question}</p>
                    {config.options.map((option, index) => (
                        <label key={option} className="take-option">
                            <input type="radio" name={name} checked={choice === index} onChange={() => setChoice(index)} />
                            <span>{option}</span>
                        </label>
                    ))}
                </>
            )}
            <div className="row">
                <button type="submit" className="button-primary button-small" disabled={!answer || busy}>
                    Lock in my take
                </button>
                <span className="small muted">The agent's view shows once you answer.</span>
            </div>
        </form>
    );
}

/** One side's points, each marked shared with the other side or only this one's. */
function PointList({ title, items, shared, only }: { title: string; items: string[]; shared: boolean[]; only: string }) {
    return (
        <div className="take-points">
            <span className="small strong">{title}</span>
            {items.length === 0 ? (
                <span className="small muted">None</span>
            ) : (
                <ul>
                    {items.map((item, index) => (
                        <li key={`${index}-${item}`} className={shared[index] ? 'is-shared' : 'is-different'}>
                            <LinkedText text={item} />
                            <span className="take-mark">{shared[index] ? 'shared' : only}</span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

/** The reviewer's answer beside the agent's view, written when the slide was made and shown only now. */
function Reveal({ config, answer }: { config: YourTakeConfig; answer: TakeAnswer }) {
    const { goTo } = useActions();
    if (config.kind === 'predict' && answer.kind === 'predict')
        return (
            <div className="take-reveal">
                <div className="take-columns">
                    <div className="take-answer">
                        <span className="eyebrow">Your guess</span>
                        <p>{answer.guess}</p>
                    </div>
                    <div className="take-answer is-agent">
                        <span className="eyebrow">What happens</span>
                        <p className="strong">{config.answer}</p>
                    </div>
                </div>
                <div className="prose take-why">
                    <Markdown source={config.explanation} />
                </div>
            </div>
        );
    if (config.kind === 'prosCons' && answer.kind === 'prosCons') {
        const pros = comparePoints(answer.pros, config.pros);
        const cons = comparePoints(answer.cons, config.cons);
        return (
            <div className="take-reveal take-columns">
                <div>
                    <span className="eyebrow">You</span>
                    <PointList title="Pros" items={answer.pros} shared={pros.mine} only="only you" />
                    <PointList title="Cons" items={answer.cons} shared={cons.mine} only="only you" />
                </div>
                <div>
                    <span className="eyebrow">The agent</span>
                    <PointList title="Pros" items={config.pros} shared={pros.agents} only="only the agent" />
                    <PointList title="Cons" items={config.cons} shared={cons.agents} only="only the agent" />
                </div>
            </div>
        );
    }
    if (config.kind === 'risk' && answer.kind === 'risk')
        return (
            <div className="take-reveal">
                <table className="risk-compare">
                    <caption className="small muted">Risk by area, 1 low to 5 high: yours and the agent's</caption>
                    <thead>
                        <tr>
                            <th scope="col">Area</th>
                            {[1, 2, 3, 4, 5].map((value) => (
                                <th key={value} scope="col">
                                    {value}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {RISK_AREAS.map((area) => (
                            <tr key={area}>
                                <th scope="row">{area}</th>
                                {[1, 2, 3, 4, 5].map((value) => (
                                    <td key={value}>
                                        {answer.ratings[area] === value && (
                                            <span className="risk-mark is-yours" title="You">
                                                You
                                            </span>
                                        )}
                                        {config.ratings[area] === value && (
                                            <span className="risk-mark is-agent" title="The agent">
                                                Agent
                                            </span>
                                        )}
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
                {config.why && (
                    <div className="prose">
                        <Markdown source={config.why} />
                    </div>
                )}
            </div>
        );
    if (config.kind === 'check' && answer.kind === 'check') {
        const right = answer.choice === config.correct;
        return (
            <div className={`take-reveal ${right ? 'is-right' : 'is-wrong'}`}>
                <p className="strong">{right ? 'Right.' : `Not quite: it is "${config.options[config.correct]}".`}</p>
                {!right && <p className="small muted">You picked "{config.options[answer.choice]}". No score is kept.</p>}
                {config.explanation && (
                    <div className="prose">
                        <Markdown source={config.explanation} />
                    </div>
                )}
                {!right && config.slide && (
                    <button type="button" className="button-link" onClick={() => goTo(`slide:${config.slide}`)}>
                        See the slide that explains it
                    </button>
                )}
            </div>
        );
    }
    return null;
}

/** The prompt alone, for a take shown where it cannot be answered, or printed unanswered. */
function Prompt({ config }: { config: YourTakeConfig }) {
    const prompt =
        config.kind === 'predict'
            ? config.prompt
            : config.kind === 'check'
              ? config.question
              : (config.prompt ?? TAKE_TITLES[config.kind]);
    return <p className="take-prompt">{prompt}</p>;
}

/**
 * `yourTake`: the reviewer commits to their own view before seeing the agent's. Answering logs the answer for the agent,
 * then shows the agent's view beside it; until then the agent's view is not on the page at all.
 */
export function YourTakeBlock({ id, config, placement }: BlockProps<'yourTake'>) {
    const take = useSelector((view) => view.takes[id], deepEqual);
    const printing = usePrinting();
    const readOnly = useReadOnly();
    const { send } = useActions();
    const [busy, track] = useBusy();
    const answerable = placement === 'slide' && !readOnly && !printing;
    return (
        <div className={`take${take ? ' is-answered' : ''}`}>
            <span className="eyebrow">Your take · {TAKE_TITLES[config.kind]}</span>
            {take ? (
                <>
                    <Prompt config={config} />
                    <Reveal config={config} answer={take.answer} />
                </>
            ) : answerable ? (
                <TakeForm
                    config={config}
                    busy={busy}
                    onAnswer={(answer) => quietly(track(send({ type: 'take.answer', blockId: id, answer })))}
                />
            ) : (
                <>
                    <Prompt config={config} />
                    <span className="small muted">Not answered.</span>
                </>
            )}
        </div>
    );
}

/**
 * `html`: an interactive visual in a sandboxed frame. The page server serves the frame's document under its own
 * policy, so it runs its script but cannot reach the network, the page, its storage or its cookies. If the frame ever
 * loads anything else, as a script setting `location` would, it is loaded afresh. Only a block with its own id runs.
 */
export function HtmlBlock({ id, config }: BlockProps<'html'>) {
    const [generation, setGeneration] = useState(0);
    const loads = useRef(0);
    const runs = Boolean(useSelector((view) => view.blocks[id]?.type === 'html'));
    return (
        <div className="html-block" style={{ '--frame-height': `${config.height}px` } as CSSProperties}>
            <span className="html-label small muted">{config.title} · interactive, sandboxed</span>
            {runs ? (
                <iframe
                    key={generation}
                    className="html-frame"
                    title={`${config.title}: ${config.alt}`}
                    sandbox="allow-scripts"
                    src={`api/frame/${encodeURIComponent(id)}`}
                    data-html-block={id}
                    onLoad={() => {
                        loads.current += 1;
                        // The first load is the block itself; any later one is the frame navigating away.
                        if (loads.current > 1) {
                            loads.current = 0;
                            setGeneration((value) => value + 1);
                        }
                    }}
                />
            ) : (
                <p className="block-note">{config.alt}. Interactive visuals run on the walkthrough's slides.</p>
            )}
        </div>
    );
}
