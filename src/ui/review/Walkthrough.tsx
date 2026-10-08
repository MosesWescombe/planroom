import { memo, useCallback, useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import {
    CHAPTER_TITLES,
    CHAPTERS,
    DEFAULT_PREFERENCES,
    deckSlides,
    impactMapOf,
    type ReviewerSettings,
    type RoundRecord,
    shownSlides
} from '../../shared/review';
import { BlockView } from '../blocks/Block';
import { sendImpact } from '../blocks/impact';
import { CheckIcon } from '../components/icons';
import { Rail } from '../components/Rail';
import { ReviewerFields } from '../components/Settings';
import { AgentNow } from '../components/SidePanel';
import { plural } from '../format';
import { usePrinting, useReducedMotion } from '../hooks';
import { useReadOnly } from '../readOnly';
import { StepperContext, useSteppers } from '../stepper';
import { deepEqual, useRecord, useSelector } from '../store';
import { quietly, useActions, useBusy, useUiState } from '../ui';
import { useIsCurrentRound, useShownRound } from './hooks';

/** One block of a slide, re-rendered only when its own version changes. */
const SlideBlock = memo(function SlideBlock({ id }: { id: string }) {
    const block = useRecord('blocks', id);
    if (!block) return null;
    return (
        <div id={`block-${id}`} className="slide-block">
            <BlockView block={block} placement="slide" />
        </div>
    );
});

/**
 * One slide: its chapter and place, its title, which a comment can anchor to, and its blocks laid out as a section's
 * are. An `html` block alone on a slide fills it.
 */
function Slide({ id, number, total }: { id: string; number: number; total: number }) {
    const slide = useRecord('slides', id);
    const fills = useSelector((view) => {
        const only = slide?.blocks.length === 1 ? slide.blocks[0] : undefined;
        return typeof only === 'string' && view.blocks[only]?.type === 'html';
    });
    if (!slide) return null;
    return (
        <section id={`slide-${id}`} className={`slide${fills ? ' is-fill' : ''}`} aria-labelledby={`slide-title-${id}`}>
            <div className="eyebrow">
                {CHAPTER_TITLES[slide.chapter]}
                <span className="mono">
                    {' '}
                    · {number} of {total}
                </span>
            </div>
            <h2 id={`slide-title-${id}`} className="slide-title">
                <span data-anchor-target={`slide:${id}`}>{slide.title}</span>
            </h2>
            {slide.blocks.map((item) =>
                typeof item === 'string' ? (
                    <SlideBlock key={item} id={item} />
                ) : (
                    <div key={item.join(' ')} className="section-row">
                        {item.map((blockId) => (
                            <SlideBlock key={blockId} id={blockId} />
                        ))}
                    </div>
                )
            )}
        </section>
    );
}

/**
 * Until the reviewer starts the round's review: how many reviewer subagents the agent sends off and at what model and
 * effort, offered from Settings. The agent starts none before this.
 */
function StartReview({ round }: { round: RoundRecord }) {
    const preferred = useSelector((view) => view.preferences?.reviewers, deepEqual);
    const [choice, setChoice] = useState<ReviewerSettings>();
    const current = useIsCurrentRound(round);
    const readOnly = useReadOnly();
    const { send } = useActions();
    const [busy, track] = useBusy();
    if (!current || readOnly || round.reviewers) return null;
    const reviewers = choice ?? preferred ?? DEFAULT_PREFERENCES.reviewers;
    return (
        <section className="start-review" aria-labelledby="start-review-title">
            <h2 id="start-review-title">Start the review</h2>
            <p className="small muted">
                Choose the agents that review this change. Claude reads it meanwhile, and starts them when you press Start. Set
                the defaults in Settings.
            </p>
            <ReviewerFields value={reviewers} onChange={setChoice} />
            <button
                type="button"
                className="button-primary"
                disabled={busy}
                onClick={() => quietly(track(send({ type: 'reviewers.start', reviewers })))}
            >
                Start review
            </button>
        </section>
    );
}

/**
 * While the agent builds the deck: an animated bar, what the agent and its subagents are doing, and how far the deck
 * and review are. The deck replaces it whole once the agent publishes; `label` names what is being built.
 */
function Building({ round, label = 'Building the walkthrough' }: { round: RoundRecord; label?: string }) {
    const drafted = useSelector((view) => deckSlides(view, round.n).length);
    const planned = round.outline?.length;
    const { pictures, review } = round.progress ?? {};
    return (
        <div className="deck-building">
            <StartReview round={round} />
            <div className="loading-bar" role="progressbar" aria-label={label} />
            <AgentNow />
            <ul className="progress-list small muted">
                <li>{planned ? `${drafted} of ${plural(planned, 'slide')}` : plural(drafted, 'slide')} drafted</li>
                {pictures && (
                    <li>
                        {pictures.drawn} of {plural(pictures.total, 'picture')} drawn
                    </li>
                )}
                {review && <li>Review: {review}</li>}
            </ul>
        </div>
    );
}

/** Where Trade-offs sits in the deck while the agent writes it from the reviewer's concerns. */
const PENDING = 'tradeoffs-pending';

/** Trade-offs while the agent investigates the reviewer's concerns and writes it: its place in the deck, building. */
function TradeoffsPending({ round }: { round: RoundRecord }) {
    return (
        <section className="slide">
            <div className="eyebrow">{CHAPTER_TITLES.tradeoffs}</div>
            <Building round={round} label="Writing Trade-offs" />
        </section>
    );
}

/** Every slide, one to a printed page, for Export: each step-through in its final state and each take as answered. */
function PrintedDeck({ slides }: { slides: string[] }) {
    return (
        <div className="deck-print">
            {slides.map((id, index) => (
                <div key={id} className="print-slide">
                    <Slide id={id} number={index + 1} total={slides.length} />
                </div>
            ))}
        </div>
    );
}

/** Whether a key press is someone typing, which the deck leaves alone. */
function typing(target: EventTarget | null): boolean {
    return (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
            ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) ||
            Boolean(target.closest('dialog, .modal')))
    );
}

/** The chapter progress bar: a segment per slide, grouped by chapter, the one on show filled, Trade-offs while pending too. */
function ChapterBar({ slides, index, onJump }: { slides: string[]; index: number; onJump: (index: number) => void }) {
    const chapters = useSelector(
        (view) => slides.map((id) => view.slides[id]?.chapter ?? (id === PENDING ? 'tradeoffs' : 'why')),
        deepEqual
    );
    const titles = useSelector(
        (view) => slides.map((id) => (id === PENDING ? 'Trade-offs, being written' : (view.slides[id]?.title ?? id))),
        deepEqual
    );
    return (
        <nav className="chapter-bar" aria-label="Slides">
            {CHAPTERS.map((chapter) => (
                <div key={chapter} className="chapter">
                    <span className="chapter-name">{CHAPTER_TITLES[chapter]}</span>
                    <div className="chapter-segments">
                        {slides.map((id, position) =>
                            chapters[position] === chapter ? (
                                <button
                                    key={id}
                                    type="button"
                                    className={`segment${position === index ? ' is-current' : position < index ? ' is-read' : ''}`}
                                    aria-label={`Slide ${position + 1}: ${titles[position]}`}
                                    aria-current={position === index ? 'step' : undefined}
                                    onClick={() => onJump(position)}
                                />
                            ) : null
                        )}
                    </div>
                </div>
            ))}
        </nav>
    );
}

/** Every slide as a card, to jump to one. */
function Overview({ slides, index, onPick }: { slides: string[]; index: number; onPick: (index: number) => void }) {
    const cards = useSelector(
        (view) =>
            slides.map((id) => ({
                id,
                chapter: view.slides[id]?.chapter ?? 'why',
                title: view.slides[id]?.title ?? id,
                blocks: view.slides[id]?.blocks.flat().length ?? 0
            })),
        deepEqual
    );
    return (
        <ol className="overview" aria-label="All slides">
            {cards.map((card, position) => (
                <li key={card.id}>
                    <button
                        type="button"
                        className={`overview-card${position === index ? ' is-current' : ''}`}
                        onClick={() => onPick(position)}
                    >
                        <span className="eyebrow">
                            {CHAPTER_TITLES[card.chapter]} <span className="mono">· {position + 1}</span>
                        </span>
                        <span className="overview-title">{card.title}</span>
                        <span className="small muted">{plural(card.blocks, 'block')}</span>
                    </button>
                </li>
            ))}
        </ol>
    );
}

/**
 * The published deck, one slide at a time at full width. The arrow keys move a step-through on the slide first, then
 * the deck; the chapter bar and the overview jump anywhere. Slides change through the View Transitions API, and not at
 * all under reduced motion. Moving on from the impact map sends the reviewer's concerns to the agent, and Trade-offs
 * holds its place, building, until the agent publishes it. Its last slide finishes the walkthrough, which unlocks the
 * findings; "Skip to findings" does the same at any point, sending the concerns first, and both are logged.
 */
function Deck({ round }: { round: RoundRecord }) {
    const slides = useSelector((view) => shownSlides(view, round).map((slide) => slide.id), deepEqual);
    const chapters = useSelector((view) => shownSlides(view, round).map((slide) => slide.chapter), deepEqual);
    const impactSlide = useSelector((view) => impactMapOf(view, round.n)?.slideId);
    const pending = !round.tradeoffsAt;
    const steps = pending ? [...slides, PENDING] : slides;
    const { slide } = useUiState();
    const { setSlide, setTab, send } = useActions();
    const current = useIsCurrentRound(round);
    const readOnly = useReadOnly();
    const reduced = useReducedMotion();
    const printing = usePrinting();
    const [overview, setOverview] = useState(false);
    const [busy, track] = useBusy();
    // On Trade-offs' place when the agent publishes it, the reviewer moves on to its first slide.
    const index =
        slide === PENDING
            ? pending
                ? slides.length
                : Math.max(0, chapters.indexOf('tradeoffs'))
            : Math.max(0, slide === undefined ? 0 : slides.indexOf(slide));
    const impactAt = impactSlide === undefined ? -1 : slides.indexOf(impactSlide);
    const unsent = impactAt >= 0 && current && !readOnly && !round.impact?.sentAt;
    const { register, move } = useSteppers();

    const go = useCallback(
        (next: number) => {
            const id = steps[next];
            if (id === undefined) return;
            if (unsent && index <= impactAt && next > impactAt) quietly(sendImpact(send));
            const change = () => flushSync(() => setSlide(id));
            const transition = (document as Document & { startViewTransition?: (update: () => void) => unknown })
                .startViewTransition;
            if (!reduced && transition) transition.call(document, change);
            else change();
            setOverview(false);
        },
        [steps, setSlide, reduced, unsent, index, impactAt, send]
    );

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (typing(event.target) || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
            const direction =
                event.key === 'ArrowRight' || event.key === 'PageDown'
                    ? 1
                    : event.key === 'ArrowLeft' || event.key === 'PageUp'
                      ? -1
                      : 0;
            if (event.key === 'Escape' && overview) setOverview(false);
            if (!direction || overview) return;
            event.preventDefault();
            if (!move(direction)) go(index + direction);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [go, move, index, overview]);

    const done = round.walkthrough;
    const finish = () => quietly(track(send({ type: 'walkthrough.done', how: 'finished' })).then(() => setTab('findings')));
    const skip = () =>
        quietly(
            track(
                (unsent ? sendImpact(send) : Promise.resolve()).then(() => send({ type: 'walkthrough.done', how: 'skipped' }))
            ).then(() => setTab('findings'))
        );
    const last = index === steps.length - 1;
    const id = steps[index];
    return (
        <>
            <div className="deck-screen">
                <div className="deck-head">
                    <ChapterBar slides={steps} index={index} onJump={go} />
                    <button
                        type="button"
                        className="button-secondary button-small"
                        aria-pressed={overview}
                        onClick={() => setOverview(!overview)}
                    >
                        {overview ? 'Back to the slide' : 'Overview'}
                    </button>
                </div>
                {overview ? (
                    <Overview slides={slides} index={index} onPick={go} />
                ) : id === PENDING ? (
                    <div className="slide-frame" key={id}>
                        <TradeoffsPending round={round} />
                    </div>
                ) : (
                    id && (
                        <StepperContext.Provider value={register}>
                            <div className="slide-frame" key={id}>
                                <Slide id={id} number={index + 1} total={steps.length} />
                            </div>
                        </StepperContext.Provider>
                    )
                )}
                <nav className="deck-nav" aria-label="Walkthrough">
                    <button type="button" className="button-secondary" disabled={index === 0} onClick={() => go(index - 1)}>
                        Previous
                    </button>
                    <span className="mono small muted">
                        {index + 1} / {steps.length}
                    </span>
                    {last && !pending && current && !done && !readOnly ? (
                        <button type="button" className="button-primary" disabled={busy} onClick={finish}>
                            Finish walkthrough
                        </button>
                    ) : (
                        <button type="button" className="button-secondary" disabled={last} onClick={() => go(index + 1)}>
                            Next
                        </button>
                    )}
                </nav>
                {current && !readOnly && (
                    <div className="deck-foot">
                        {done ? (
                            <>
                                <span className="small muted">
                                    <CheckIcon /> Walkthrough {done.how}.
                                </span>
                                <button type="button" className="button-link" onClick={() => setTab('findings')}>
                                    See the findings
                                </button>
                            </>
                        ) : (
                            <button type="button" className="button-link" disabled={busy} onClick={skip}>
                                Skip to findings
                            </button>
                        )}
                    </div>
                )}
            </div>
            {printing && <PrintedDeck slides={slides} />}
        </>
    );
}

/** The rail: the deck's chapters and slides, the one on show marked, and Trade-offs' place while it is written. */
function DeckContents({ round }: { round: RoundRecord }) {
    const entries = useSelector(
        (view) => shownSlides(view, round).map((slide) => ({ id: slide.id, chapter: slide.chapter, title: slide.title })),
        deepEqual
    );
    const { slide } = useUiState();
    const { setSlide } = useActions();
    const shown = slide ?? entries[0]?.id;
    if (!round.publishedAt)
        return (
            <nav className="rail" aria-label="Deck">
                <div className="nav-heading">WALKTHROUGH</div>
                <p className="small muted">The slides show here once the deck is published.</p>
            </nav>
        );
    return (
        <nav className="rail" aria-label="Deck">
            {CHAPTERS.map((chapter) => (
                <div key={chapter} className="nav-group">
                    <div className="nav-heading">{CHAPTER_TITLES[chapter].toUpperCase()}</div>
                    <ol className="contents">
                        {entries
                            .filter((entry) => entry.chapter === chapter)
                            .map((entry) => (
                                <li key={entry.id}>
                                    <button
                                        type="button"
                                        className="nav-item"
                                        aria-current={entry.id === shown ? 'step' : undefined}
                                        onClick={() => setSlide(entry.id)}
                                    >
                                        <span className="mono muted contents-number">
                                            {entries.findIndex((other) => other.id === entry.id) + 1}
                                        </span>
                                        <span className="nav-name">{entry.title}</span>
                                    </button>
                                </li>
                            ))}
                        {chapter === 'tradeoffs' && !round.tradeoffsAt && (
                            <li className="small muted">Written once you send your concerns on the impact map</li>
                        )}
                    </ol>
                </div>
            ))}
        </nav>
    );
}

/** The Walkthrough tab: the building view until the agent publishes the round's deck, then the deck. */
export function Walkthrough() {
    const round = useShownRound();
    const slides = useSelector((view) => shownSlides(view, round).length);
    return (
        <>
            <Rail
                strip={
                    <span className="mono small" title={`${slides} slides`}>
                        {slides}
                    </span>
                }
            >
                <DeckContents round={round} />
            </Rail>
            <main className="main" id="main">
                <div className="main-inner deck-inner">
                    {round.publishedAt ? <Deck round={round} /> : <Building round={round} />}
                </div>
            </main>
        </>
    );
}
