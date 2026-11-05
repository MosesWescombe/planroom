import { type CSSProperties, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CodeWalkConfig } from '../../shared/blocks';
import { PseudoCode } from '../code/CodeViewer';
import { openComposer } from '../comments/composer';
import { captureRange, commentable } from '../comments/selection';
import { CheckIcon, CommentIcon } from '../components/icons';
import { Markdown, plainTitle, TitleMarkdown } from '../components/Markdown';
import { usePrinting } from '../hooks';
import { useReadOnly } from '../readOnly';
import { StepperContext } from '../stepper';
import type { BlockProps } from './Block';
import { Excerpt } from './basic';

type WalkStep = CodeWalkConfig['steps'][number];

/**
 * The functions the step at `at` runs inside, outermost first, from each step's `fn` and call `depth`: a step deeper than
 * the one before is in a function it called, and a shallower one has returned to its caller. A step without `fn` stays
 * in the function its depth was last in. A depth skipped on the way in has no name and is left out.
 */
export function callStack(steps: readonly Pick<WalkStep, 'fn' | 'depth'>[], at: number): string[] {
    const frames: (string | undefined)[] = [];
    for (const step of steps.slice(0, at + 1)) {
        frames.length = step.depth + 1;
        if (step.fn) frames[step.depth] = step.fn;
    }
    return frames.filter((fn): fn is string => fn !== undefined);
}

/** Whether a step can show its real code: it names its file and lines. */
function hasCode(step: WalkStep): step is WalkStep & { file: string; lines: string } {
    return step.file !== undefined && step.lines !== undefined;
}

/**
 * One step large: where it is in the calls, its title, what it does in words, and its pseudo code with a switch to the
 * real code, or the real code alone. `real` is the walk's choice, kept from step to step.
 */
function StepDetail({
    step,
    stack,
    real,
    onReal,
    titleRef
}: {
    step: WalkStep;
    stack: string[];
    real: boolean;
    onReal: (real: boolean) => void;
    titleRef?: React.Ref<HTMLSpanElement>;
}) {
    const both = step.pseudo !== undefined && hasCode(step);
    const showReal = hasCode(step) && (step.pseudo === undefined || real);
    return (
        <>
            {stack.length > 0 && (
                <ol className="walk-stack" aria-label="Call stack">
                    {stack.map((fn, at) => (
                        <li key={at}>
                            <code>{fn}</code>
                        </li>
                    ))}
                </ol>
            )}
            <h3 className="walk-step-title">
                <span ref={titleRef}>
                    <TitleMarkdown source={step.title} />
                </span>
            </h3>
            {step.note && (
                <div className="prose walk-note">
                    <Markdown source={step.note} />
                </div>
            )}
            {(step.pseudo !== undefined || hasCode(step)) && (
                <div className="walk-code">
                    {both && (
                        <span role="tablist" aria-label="How the step shows" className="segmented">
                            <button type="button" role="tab" aria-selected={!real} onClick={() => onReal(false)}>
                                Pseudo code
                            </button>
                            <button type="button" role="tab" aria-selected={real} onClick={() => onReal(true)}>
                                Real code
                            </button>
                        </span>
                    )}
                    {showReal ? (
                        <Excerpt
                            file={step.file}
                            lines={step.lines}
                            {...(step.lang ? { lang: step.lang } : {})}
                            title={`${step.file} · ${step.lines.replace('-', '–')}`}
                        />
                    ) : (
                        <PseudoCode source={step.pseudo ?? ''} aria-label="Pseudo code" />
                    )}
                </div>
            )}
        </>
    );
}

/**
 * `codeWalk`: a path through the code a step at a time. The steps are listed on the left, each indented by its call
 * depth and named by the function it jumps into; the step on show is large on the right, with the call stack, its words,
 * and its pseudo code a switch away from the real code. The arrow keys, the buttons and the list move it, and on a slide
 * the deck hands it the keys first. Where the page takes comments, each step can be asked about: the question quotes its
 * title. In print every step shows in order.
 */
export function CodeWalkBlock({ config }: BlockProps<'codeWalk'>) {
    const { steps } = config;
    const printing = usePrinting();
    const readOnly = useReadOnly();
    const [chosen, setChosen] = useState(0);
    // A walk re-sent with fewer steps shows its last.
    const at = Math.min(chosen, steps.length - 1);
    const [seen, setSeen] = useState<ReadonlySet<number>>(() => new Set([0]));
    const [real, setReal] = useState(false);
    const [askable, setAskable] = useState(false);
    const root = useRef<HTMLDivElement>(null);
    const list = useRef<HTMLOListElement>(null);
    const title = useRef<HTMLSpanElement>(null);
    const current = useRef(at);
    current.current = at;
    const register = useContext(StepperContext);

    const go = (to: number): boolean => {
        if (to < 0 || to >= steps.length || to === current.current) return false;
        setChosen(to);
        setSeen((before) => new Set(before).add(to));
        return true;
    };
    const goRef = useRef(go);
    goRef.current = go;
    useEffect(() => register?.({ move: (direction) => goRef.current(current.current + direction) }), [register]);
    // Asking needs a commentable place around the walk: the write-up, a slide or a read-through page, not a reply.
    useLayoutEffect(() => setAskable(root.current !== null && commentable(root.current)), []);
    // Keep the step on show in sight in the list, scrolling the list alone, never the page.
    useEffect(() => {
        const box = list.current;
        const item = box?.children[at] as HTMLElement | undefined;
        if (!box || !item) return;
        if (item.offsetTop < box.scrollTop) box.scrollTop = item.offsetTop;
        else if (item.offsetTop + item.offsetHeight > box.scrollTop + box.clientHeight)
            box.scrollTop = item.offsetTop + item.offsetHeight - box.clientHeight;
    }, [at]);

    const ask = (from: HTMLElement) => {
        if (!title.current) return;
        const range = document.createRange();
        range.selectNodeContents(title.current);
        const captured = captureRange(range);
        const { top, left, bottom } = from.getBoundingClientRect();
        if (captured) openComposer({ anchor: captured.anchor, intent: 'question', at: { top, left, bottom } });
    };

    if (printing)
        return (
            <div className="code-walk is-print">
                {config.title && <p className="walk-title strong">{config.title}</p>}
                <ol className="walk-print">
                    {steps.map((step, index) => (
                        <li key={index}>
                            <StepDetail step={step} stack={callStack(steps, index)} real={false} onReal={() => undefined} />
                        </li>
                    ))}
                </ol>
            </div>
        );

    const step = steps[at]!;
    const progress = `Step ${at + 1} of ${steps.length}`;
    return (
        <div
            ref={root}
            className="code-walk"
            role="group"
            aria-label={config.title ? `Code walk: ${config.title}` : 'Code walk'}
            tabIndex={0}
            onKeyDown={(event) => {
                if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
                if (go(at + (event.key === 'ArrowRight' ? 1 : -1))) {
                    event.preventDefault();
                    event.stopPropagation();
                }
            }}
        >
            <div className="walk-head">
                {config.title && <span className="walk-title">{config.title}</span>}
                <span className="walk-count mono small muted">
                    {progress} · {seen.size} seen
                </span>
                <div
                    className="walk-progress"
                    role="progressbar"
                    aria-label="Progress"
                    aria-valuemin={0}
                    aria-valuemax={steps.length}
                    aria-valuenow={at + 1}
                >
                    {steps.map((_, index) => (
                        <span key={index} className={index <= at ? 'is-done' : undefined} />
                    ))}
                </div>
            </div>
            <div className="walk-body">
                <ol ref={list} className="walk-steps" aria-label="Steps">
                    {steps.map((each, index) => {
                        const jumps = each.fn !== undefined && each.fn !== steps[index - 1]?.fn;
                        return (
                            <li key={index} style={{ '--depth': Math.min(each.depth, 4) } as CSSProperties}>
                                <button
                                    type="button"
                                    className={`walk-step-row${seen.has(index) ? ' is-seen' : ''}`}
                                    aria-current={index === at ? 'step' : undefined}
                                    onClick={() => go(index)}
                                >
                                    <span className="walk-step-n mono">{index + 1}</span>
                                    <span className="walk-step-text">
                                        {jumps && <code className="walk-fn">{each.fn}</code>}
                                        <span>{plainTitle(each.title)}</span>
                                    </span>
                                    {seen.has(index) && index !== at && (
                                        <span className="walk-seen" role="img" aria-label="seen">
                                            <CheckIcon size={9} />
                                        </span>
                                    )}
                                </button>
                            </li>
                        );
                    })}
                </ol>
                <section className="walk-step" aria-label={`${progress}: ${plainTitle(step.title)}`}>
                    <p className="visually-hidden" aria-live="polite">
                        {progress}: {plainTitle(step.title)}
                    </p>
                    <StepDetail step={step} stack={callStack(steps, at)} real={real} onReal={setReal} titleRef={title} />
                    <div className="walk-nav">
                        <button
                            type="button"
                            className="button-secondary button-small"
                            disabled={at === 0}
                            onClick={() => go(at - 1)}
                        >
                            Back
                        </button>
                        {askable && !readOnly && (
                            <button
                                type="button"
                                className="button-link small walk-ask"
                                onClick={(event) => ask(event.currentTarget)}
                            >
                                <CommentIcon size={14} /> Ask about this step
                            </button>
                        )}
                        <span className="grow" />
                        <button
                            type="button"
                            className="button-primary button-small"
                            disabled={at === steps.length - 1}
                            onClick={() => go(at + 1)}
                        >
                            Next step
                        </button>
                    </div>
                </section>
            </div>
        </div>
    );
}
