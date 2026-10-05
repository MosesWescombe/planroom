import { memo, useState } from 'react';
import {
    directionsQuestion,
    directionTabs,
    groupProgress,
    orderedQuestions,
    phase1Gate,
    phase1Stage,
    type QuestionScope,
    RESOLVED
} from '../../shared/derive';
import { isInfo } from '../../shared/questions';
import type { View } from '../../shared/view';
import { CheckIcon, PlusIcon } from '../components/icons';
import { Markdown } from '../components/Markdown';
import { Rail } from '../components/Rail';
import { useReadOnly } from '../readOnly';
import { deepEqual, useSelector } from '../store';
import { quietly, useActions, useBusy, useUiState } from '../ui';
import { QuestionCard } from './QuestionCard';

/** The element id of a group's header, safe for any group path. */
function groupAnchor(path: string): string {
    return `group-${path.replace(/[^\w-]/g, '_')}`;
}

/** Scrolls the page to a group's header. */
function jumpToGroup(path: string) {
    document.getElementById(groupAnchor(path))?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
}

/** Resolved-over-total ring: full when done, a pie while partly done, empty before. */
function ProgressRing({ resolved, total }: { resolved: number; total: number }) {
    if (total > 0 && resolved === total) {
        return (
            <span className="ring ring-done" aria-hidden="true">
                <CheckIcon />
            </span>
        );
    }
    if (resolved === 0) return <span className="ring ring-empty" aria-hidden="true" />;
    return (
        <span
            className="ring ring-part"
            style={{ ['--part' as string]: `${Math.round((resolved / total) * 100)}%` }}
            aria-hidden="true"
        />
    );
}

/** The questions the user suggested that the agent has not added, each pending or declined with its reason. */
function Suggestions() {
    const suggestions = useSelector(
        (view) => Object.values(view.suggestions).filter((suggestion) => suggestion.status !== 'added'),
        deepEqual
    );
    if (suggestions.length === 0) return null;
    return (
        <div className="nav-group">
            <div className="nav-heading">YOUR SUGGESTIONS</div>
            {suggestions.map((suggestion) => (
                <div key={suggestion.id} className="suggestion">
                    <span>{suggestion.text}</span>
                    <span className="suggestion-status">
                        {suggestion.status === 'pending'
                            ? 'Pending · waiting for the agent'
                            : `Declined: ${suggestion.reason ?? ''}`}
                    </span>
                </div>
            ))}
        </div>
    );
}

/** "Add a question": suggest one to the agent, which adds it or declines it. Hidden while the session is read-only. */
function AddQuestion() {
    const { send } = useActions();
    const readOnly = useReadOnly();
    const [open, setOpen] = useState(false);
    const [text, setText] = useState('');
    const [busy, track] = useBusy();
    if (readOnly) return null;
    if (!open) {
        return (
            <button type="button" className="button-link add-question" onClick={() => setOpen(true)}>
                <PlusIcon />
                Add a question
            </button>
        );
    }
    return (
        <form
            className="add-question-form"
            onSubmit={(event) => {
                event.preventDefault();
                const question = text.trim();
                if (!question) return;
                quietly(
                    track(send({ type: 'question.suggest', text: question })).then(() => {
                        setText('');
                        setOpen(false);
                    })
                );
            }}
        >
            <label htmlFor="suggest-question">Suggest a question for the agent</label>
            <textarea id="suggest-question" rows={2} value={text} autoFocus onChange={(event) => setText(event.target.value)} />
            <div className="row-end">
                <button type="button" className="button-text" onClick={() => setOpen(false)}>
                    Cancel
                </button>
                <button type="submit" className="button-primary button-small" disabled={busy || !text.trim()}>
                    Send
                </button>
            </div>
        </form>
    );
}

/** The overview's links to each direction's tab, with its progress. */
function DirectionLinks() {
    const tabs = useSelector((view) => directionTabs(view), deepEqual);
    const { setDirection, setDrawer } = useActions();
    if (tabs.length === 0) return null;
    return (
        <div className="nav-group">
            <div className="nav-heading">DIRECTIONS</div>
            {tabs.map((tab) => (
                <button
                    key={tab.id}
                    type="button"
                    className="nav-item"
                    onClick={() => {
                        setDrawer(undefined);
                        setDirection(tab.id);
                    }}
                >
                    <ProgressRing resolved={tab.resolved} total={tab.total} />
                    <span className="nav-name">{tab.label}</span>
                    <span className="mono muted">
                        {tab.resolved}/{tab.total}
                    </span>
                </button>
            ))}
        </div>
    );
}

/** The question navigator for one Phase 1 tab: its progress, then resolved over total per group. */
export const Navigator = memo(function Navigator({ scope = null }: { scope?: QuestionScope }) {
    const progress = useSelector((view) => groupProgress(view, scope), deepEqual);
    const { setDrawer } = useActions();
    const headings = [...new Set(progress.groups.map((group) => group.heading))];
    const percent = progress.total ? Math.round((progress.resolved / progress.total) * 100) : 0;
    return (
        <nav className="rail" aria-label="Question navigator">
            <div className="progress">
                <div className="progress-line">
                    <span className="strong">Progress</span>
                    <span className="mono">
                        {progress.resolved} / {progress.total}
                    </span>
                </div>
                <div
                    className="progress-bar"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={progress.total}
                    aria-valuenow={progress.resolved}
                    aria-label="Questions resolved"
                >
                    <span style={{ width: `${percent}%` }} />
                </div>
            </div>
            {headings.map((heading) => (
                <div key={heading} className="nav-group">
                    <div className="nav-heading">{heading}</div>
                    {progress.groups
                        .filter((group) => group.heading === heading)
                        .map((group) => (
                            <a
                                key={group.path}
                                className="nav-item"
                                href={`#${groupAnchor(group.path)}`}
                                onClick={(event) => {
                                    event.preventDefault();
                                    setDrawer(undefined);
                                    jumpToGroup(group.path);
                                }}
                            >
                                <ProgressRing resolved={group.resolved} total={group.total} />
                                <span className="nav-name">{group.name}</span>
                                <span className="mono muted">
                                    {group.resolved}/{group.total}
                                </span>
                            </a>
                        ))}
                </div>
            ))}
            <Suggestions />
            <AddQuestion />
        </nav>
    );
});

/** The collapsed navigator: overall resolved over total, then one ring per group, a gap between headings. */
const NavigatorStrip = memo(function NavigatorStrip({ scope }: { scope: QuestionScope }) {
    const progress = useSelector((view) => groupProgress(view, scope), deepEqual);
    const headings = [...new Set(progress.groups.map((group) => group.heading))];
    return (
        <nav className="rail-strip" aria-label="Question progress">
            <span className="mono small" title={`${progress.resolved} of ${progress.total} questions resolved`}>
                {progress.resolved}/{progress.total}
            </span>
            {headings.map((heading) => (
                <div key={heading} className="rail-strip-group">
                    {progress.groups
                        .filter((group) => group.heading === heading)
                        .map((group) => {
                            const label = `${group.name}, ${group.resolved} of ${group.total} resolved`;
                            return (
                                <a
                                    key={group.path}
                                    className="rail-strip-item"
                                    href={`#${groupAnchor(group.path)}`}
                                    aria-label={label}
                                    title={label}
                                    onClick={(event) => {
                                        event.preventDefault();
                                        jumpToGroup(group.path);
                                    }}
                                >
                                    <ProgressRing resolved={group.resolved} total={group.total} />
                                </a>
                            );
                        })}
                </div>
            ))}
        </nav>
    );
});

/** A group's heading, name and counts of its open, answered and closed questions, leaving info cards out. */
function GroupHeader({ path, heading, name, ids }: { path: string; heading: string; name: string; ids: string[] }) {
    const counts = useSelector((view) => {
        const statuses = ids.flatMap((id) => {
            const question = view.questions[id];
            return question && !isInfo(question) ? [question.status] : [];
        });
        return {
            open: statuses.filter((status) => status && !RESOLVED.has(status)).length,
            answered: statuses.filter((status) => status === 'answered').length,
            closed: statuses.filter((status) => status === 'closed' || status === 'merged').length
        };
    }, deepEqual);
    const parts = [
        counts.open && `${counts.open} open`,
        counts.answered && `${counts.answered} answered`,
        counts.closed && `${counts.closed} closed`
    ].filter(Boolean);
    return (
        <div id={groupAnchor(path)} className="group-header" data-scroll-anchor>
            <div className="group-title">
                <span className="eyebrow">{heading}</span>
                <h2>{name}</h2>
            </div>
            <span className="muted small">{parts.join(' · ')}</span>
        </div>
    );
}

/** The agent's summary of the change so far, commentable as `understanding`. */
const Understanding = memo(function Understanding() {
    const understanding = useSelector((view) => view.understanding);
    return (
        <section id="understanding" className="understanding" aria-label="The agent's current understanding" data-scroll-anchor>
            <span className="eyebrow">WHAT THE AGENT UNDERSTANDS SO FAR</span>
            {understanding.text ? (
                <div className="understanding-text" data-anchor-target="understanding">
                    <Markdown source={understanding.text} />
                </div>
            ) : (
                <p className="muted">The agent is reading the codebase. Its summary of the change appears here.</p>
            )}
        </section>
    );
});

/** What the agent is doing to Phase 1 right now, or undefined when it is not working on it. */
function agentActivity(view: View): string | undefined {
    const writing = orderedQuestions(view).find((question) => question.status === 'streaming');
    if (writing) return `Agent writing ${writing.id}`;
    if (!view.agent.working) return undefined;
    return view.agent.editing ? `Agent editing ${view.agent.editing}` : `Agent ${view.agent.doing ?? 'working'}`;
}

interface GoAhead {
    id: string;
    label: string;
    canFinish: boolean;
    open: number;
}

/**
 * The one control of Phases 1 and 2, floating at the bottom right, doing what the stage needs next. While aligning it
 * agrees the goals. Once directions are investigated it shows only on a direction's tab in Directions, going ahead
 * with that one. Otherwise it is "Finish phase 1". Finishing with questions unresolved asks first, then carries them into the
 * write-up as assumptions. While the agent is working it shows what the agent is doing and interrupts it.
 */
const PhaseGate = memo(function PhaseGate({ scope }: { scope: string | null }) {
    const gate = useSelector((view) => {
        const tabs = directionTabs(view);
        const scoped = (direction?: string) => {
            const { canFinish, unresolved } = phase1Gate(view, direction);
            return { canFinish, open: unresolved.length };
        };
        const tab = tabs.find((candidate) => candidate.id === scope);
        return {
            stage: phase1Stage(view),
            total: Object.values(view.questions).filter((question) => !isInfo(question)).length,
            plain: scoped(),
            hasDirections: tabs.length > 0,
            direction: tab && { id: tab.id, label: tab.label, ...scoped(tab.id) },
            activity: agentActivity(view)
        };
    }, deepEqual);
    const readOnly = useReadOnly();
    const { send, setTab } = useActions();
    const [confirming, setConfirming] = useState<{ direction?: GoAhead } | undefined>();
    const [busy, track] = useBusy();

    if (gate.stage === 'done') {
        return (
            <div className="phase-gate">
                <button type="button" className="button-secondary" onClick={() => setTab('writeup')}>
                    Go to the write-up
                </button>
            </div>
        );
    }
    // Once directions are investigated, you go ahead from a direction's own tab, not the overview.
    if (readOnly || (gate.hasDirections && !gate.direction)) return null;
    const nothingAsked = gate.total === 0;
    const complete = (path: 'finished' | 'assumptions', direction?: GoAhead) =>
        quietly(
            track(send({ type: 'phase.complete', path, ...(direction ? { direction: direction.id } : {}) })).then(() =>
                setConfirming(undefined)
            )
        );
    const goAhead = (direction: GoAhead) =>
        direction.canFinish ? complete('finished', direction) : setConfirming({ direction });

    if (gate.stage === 'align') {
        return (
            <div className="phase-gate">
                <button
                    type="button"
                    className="button-primary"
                    disabled={nothingAsked || busy}
                    title={nothingAsked ? 'The agent has not asked anything yet' : undefined}
                    onClick={() => quietly(track(send({ type: 'stage.advance', to: 'explore' })))}
                >
                    Goals agreed - explore approaches
                </button>
            </div>
        );
    }
    if (confirming) {
        const open = confirming.direction?.open ?? gate.plain.open;
        const lead = confirming.direction ? `go ahead with ${confirming.direction.label} and carry` : 'carry';
        return (
            <div className="phase-gate is-confirming">
                <span className="small">
                    {gate.activity ? `Interrupt the agent and ${lead}` : lead.charAt(0).toUpperCase() + lead.slice(1)} {open}{' '}
                    unresolved question{open === 1 ? '' : 's'} into the write-up as assumptions?
                </span>
                <div className="row">
                    <button type="button" className="button-text" onClick={() => setConfirming(undefined)}>
                        Cancel
                    </button>
                    <button
                        type="button"
                        className="button-primary"
                        disabled={busy}
                        onClick={() => complete('assumptions', confirming.direction)}
                    >
                        {confirming.direction ? 'Go ahead with assumptions' : 'Finish with assumptions'}
                    </button>
                </div>
            </div>
        );
    }
    const { direction } = gate;
    const label = direction
        ? `${gate.activity ? 'Interrupt and go' : 'Go'} ahead with ${direction.label}`
        : gate.activity
          ? 'Interrupt and finish'
          : 'Finish phase 1';
    const onClick = () => {
        if (direction) goAhead(direction);
        else if (gate.plain.canFinish) complete('finished');
        else setConfirming({});
    };
    return (
        <div className="phase-gate">
            <button
                type="button"
                className={gate.activity ? 'button-primary finish-interrupt' : 'button-primary'}
                disabled={nothingAsked || busy}
                title={nothingAsked ? 'The agent has not asked anything yet' : direction?.label}
                onClick={onClick}
            >
                {gate.activity && (
                    <span className="finish-activity">
                        <span className="finish-activity-dot" aria-hidden="true" />
                        <span className="truncate">{gate.activity}</span>
                    </span>
                )}
                {/* The flex button never renders this space; it keeps the activity and the label apart in the accessible name. */}{' '}
                {/* A direction's label can be long, so it is cut short and shown whole on hover. */}
                <span className="truncate">{label}</span>
            </button>
        </div>
    );
});

/** The direction whose Directions tab is showing, or null for the overview; a direction without a tab shows the overview. */
function useDirectionScope(): string | null {
    const { direction } = useUiState();
    const known = useSelector((view) => directionTabs(view).some((tab) => tab.id === direction));
    return known && direction !== undefined ? direction : null;
}

/** The Directions tabs, in the bar under the top row: the overview, then one per direction with its progress. */
export function DirectionSwitcher() {
    const tabs = useSelector((view) => directionTabs(view), deepEqual);
    const current = useDirectionScope();
    const { setDirection } = useActions();
    if (tabs.length === 0) return null;
    return (
        <nav className="direction-switch" aria-label="Directions">
            <button
                type="button"
                className="direction-switch-tab"
                aria-current={current === null ? 'page' : undefined}
                onClick={() => setDirection(undefined)}
            >
                Overview
            </button>
            {tabs.map((tab) => (
                <button
                    key={tab.id}
                    type="button"
                    className="direction-switch-tab"
                    aria-current={current === tab.id ? 'page' : undefined}
                    title={tab.label}
                    onClick={() => setDirection(tab.id)}
                >
                    <ProgressRing resolved={tab.resolved} total={tab.total} />
                    <span className="truncate">{tab.label}</span>
                    <span className="mono muted small">
                        {tab.resolved}/{tab.total}
                    </span>
                    {tab.chosen && <span className="badge badge-accent">Chosen</span>}
                    {!tab.investigated && !tab.chosen && <span className="badge badge-neutral">Dropped</span>}
                </button>
            ))}
        </nav>
    );
}

/** A direction tab's heading: the direction and its description, from the directions question. */
function DirectionHead({ id }: { id: string }) {
    const option = useSelector((view) => directionsQuestion(view)?.options?.find((candidate) => candidate.id === id), deepEqual);
    return (
        <header className="page-head">
            <div className="eyebrow">PHASE 2 · DIRECTION</div>
            <h1>{option?.label ?? id}</h1>
            {option?.detail && (
                <div className="lede">
                    <Markdown source={option.detail} />
                </div>
            )}
        </header>
    );
}

/** The questions in `scope` by group, each under its header. */
function QuestionGroups({ scope }: { scope: QuestionScope }) {
    const groups = useSelector(
        (view) =>
            groupProgress(view, scope).groups.map(({ path, heading, name, questionIds }) => ({
                path,
                heading,
                name,
                ids: questionIds
            })),
        deepEqual
    );
    return (
        <>
            {groups.map((group) => (
                <section key={group.path} className="question-group" aria-label={group.name}>
                    <GroupHeader {...group} />
                    {group.ids.map((id) => (
                        <QuestionCard key={id} id={id} />
                    ))}
                </section>
            ))}
        </>
    );
}

/**
 * Phase 1: the navigator, then the page head, the agent's understanding and the shared questions by group, with the
 * phase gate floating over them. A direction's own questions live on its tab in Directions.
 */
export function Interrogate() {
    const title = useSelector((view) => view.title);
    const skipped = useSelector((view) => view.phases.phase1.exploreSkipped);
    return (
        <>
            <Rail strip={<NavigatorStrip scope={null} />}>
                <Navigator scope={null} />
            </Rail>
            <main className="main" id="main">
                <div className="main-inner">
                    <header className="page-head">
                        <div className="eyebrow">PHASE 1 · INTERROGATE</div>
                        <h1>{title}</h1>
                        <p className="lede">
                            The agent is stress-testing this change before anything is written. Answer, correct its assumptions,
                            or select any text to comment. Every edit syncs both ways, live.
                        </p>
                        {skipped && (
                            <p className="stage-note">
                                <span className="muted">The agent went straight to the deep dive:</span> {skipped}
                            </p>
                        )}
                    </header>
                    <Understanding />
                    <QuestionGroups scope={null} />
                </div>
                <PhaseGate scope={null} />
            </main>
        </>
    );
}

/** The collapsed Directions overview navigator: one ring per direction, opening its tab. */
const DirectionStrip = memo(function DirectionStrip() {
    const tabs = useSelector((view) => directionTabs(view), deepEqual);
    const { setDirection } = useActions();
    return (
        <nav className="rail-strip" aria-label="Direction progress">
            {tabs.map((tab) => {
                const label = `${tab.label}, ${tab.resolved} of ${tab.total} resolved`;
                return (
                    <button
                        key={tab.id}
                        type="button"
                        className="rail-strip-item"
                        aria-label={label}
                        title={label}
                        onClick={() => setDirection(tab.id)}
                    >
                        <ProgressRing resolved={tab.resolved} total={tab.total} />
                    </button>
                );
            })}
        </nav>
    );
});

/**
 * The Directions overview: each direction side by side with its progress, then the shared questions still open, which
 * going ahead needs resolved. Once Phase 1 completes they are the write-up's assumptions, so the list goes.
 */
function DirectionsOverview() {
    const title = useSelector((view) => view.title);
    const cards = useSelector((view) => {
        const options = directionsQuestion(view)?.options ?? [];
        return directionTabs(view).map((tab) => ({ ...tab, detail: options.find((option) => option.id === tab.id)?.detail }));
    }, deepEqual);
    const open = useSelector(
        (view) =>
            view.phases.phase1.completed
                ? []
                : orderedQuestions(view)
                      .filter((question) => !question.direction && !isInfo(question) && !RESOLVED.has(question.status))
                      .map((question) => question.id),
        deepEqual
    );
    const { setDirection } = useActions();
    const chosen = cards.find((card) => card.chosen);
    return (
        <>
            <header className="page-head">
                <div className="eyebrow">PHASE 2 · DIRECTIONS</div>
                <h1>{title}</h1>
                <p className="lede">
                    {chosen
                        ? `You went ahead with ${chosen.label}.`
                        : cards.length
                          ? 'Each direction you picked has its own tab of questions. Compare them here, then go ahead with one from its tab.'
                          : 'No directions are being investigated. Pick some in the directions question on Interrogate.'}
                </p>
            </header>
            {cards.length > 0 && (
                <div className="direction-cards">
                    {cards.map((card) => (
                        <section key={card.id} className="direction-card" aria-label={card.label}>
                            <div className="direction-card-head">
                                <h2>{card.label}</h2>
                                {card.recommended && <span className="badge badge-accent">Recommended</span>}
                                {card.chosen && <span className="badge badge-accent">Chosen</span>}
                                {!card.investigated && !card.chosen && <span className="badge badge-neutral">Dropped</span>}
                            </div>
                            {card.detail && (
                                <div className="direction-card-detail">
                                    <Markdown source={card.detail} />
                                </div>
                            )}
                            <div className="direction-card-foot">
                                <span className="row">
                                    <ProgressRing resolved={card.resolved} total={card.total} />
                                    <span className="muted small">
                                        {card.resolved} of {card.total} resolved
                                    </span>
                                </span>
                                <button
                                    type="button"
                                    className="button-secondary button-small"
                                    aria-label={`Open ${card.label}`}
                                    onClick={() => setDirection(card.id)}
                                >
                                    Open
                                </button>
                            </div>
                        </section>
                    ))}
                </div>
            )}
            {open.length > 0 && (
                <section className="question-group" aria-label="Still open from phase 1">
                    <div className="group-header">
                        <div className="group-title">
                            <span className="eyebrow">PHASE 1</span>
                            <h2>Still open</h2>
                        </div>
                        <span className="muted small">{open.length} open</span>
                    </div>
                    {open.map((id) => (
                        <QuestionCard key={id} id={id} />
                    ))}
                </section>
            )}
        </>
    );
}

/**
 * Phase 2: the overview comparing the directions, or one direction's own questions with the gate to go ahead with
 * it. The tabs between them sit in the bar under the top row.
 */
export function DirectionsPhase() {
    const scope = useDirectionScope();
    const empty = useSelector((view) => scope !== null && groupProgress(view, scope).groups.length === 0);
    if (scope === null) {
        return (
            <>
                <Rail strip={<DirectionStrip />}>
                    <nav className="rail" aria-label="Direction navigator">
                        <DirectionLinks />
                        <Suggestions />
                        <AddQuestion />
                    </nav>
                </Rail>
                <main className="main" id="main">
                    <div className="main-inner">
                        <DirectionsOverview />
                    </div>
                    <PhaseGate scope={null} />
                </main>
            </>
        );
    }
    return (
        <>
            <Rail strip={<NavigatorStrip scope={scope} />}>
                <Navigator scope={scope} />
            </Rail>
            <main className="main" id="main">
                <div className="main-inner">
                    <DirectionHead id={scope} />
                    <QuestionGroups scope={scope} />
                    {empty && <p className="muted">The agent is digging into this direction. Its questions appear here.</p>}
                </div>
                <PhaseGate scope={scope} />
            </main>
        </>
    );
}
