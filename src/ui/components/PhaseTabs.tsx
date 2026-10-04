import {
    directionsQuestion,
    directionTabs,
    groupProgress,
    openComments,
    type Phase1Stage,
    phase1Stage,
    tabs
} from '../../shared/derive';
import { deepEqual, useSelector } from '../store';
import { type Tab, useActions, useUiState } from '../ui';
import { CheckIcon, LockIcon } from './icons';

interface TabInfo {
    id: Tab;
    number: number;
    title: string;
    subtitle: string;
    unlocked: boolean;
    /** Shows a lock: the tab opens later. A skipped tab never opens, so it has no lock. */
    locked: boolean;
    done: boolean;
}

const STAGE_NAMES: Record<Phase1Stage, string> = { align: 'Align', explore: 'Explore', 'deep-dive': 'Deep dive', done: 'Done' };

/** `n` and the word, plural unless `n` is 1. */
function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * The four phase tabs, in the top row: a locked tab says what unlocks it, a skipped one says why, and a finished
 * phase shows a tick and stays readable. Interrogate names its stage until directions are picked.
 */
export function PhaseTabs() {
    const info = useSelector((view): TabInfo[] => {
        const state = tabs(view);
        const { phases } = view;
        const shared = groupProgress(view, null);
        const resolved = `${shared.resolved} of ${shared.total} resolved`;
        const stage = phase1Stage(view);
        const directions = directionTabs(view);
        const picked = directions.filter((tab) => tab.investigated).length;
        const chosen = directions.find((tab) => tab.chosen);
        const offered = directionsQuestion(view)?.options?.length ?? 0;
        const directionsResolved = directions.reduce((sum, tab) => sum + tab.resolved, 0);
        const directionsTotal = directions.reduce((sum, tab) => sum + tab.total, 0);
        const writeupComments = openComments(view, ['writeup']).length;
        const writeupSubtitle = phases.submission
            ? `Submitted v${phases.submission.revision}`
            : view.revision === 0
              ? 'Agent is drafting'
              : `v${view.revision}${writeupComments ? ` · ${plural(writeupComments, 'comment')} open` : ''}`;
        return [
            {
                id: 'interrogate',
                number: 1,
                title: 'Interrogate',
                subtitle: picked
                    ? `${plural(picked, 'direction')} picked`
                    : stage === 'done'
                      ? resolved
                      : `${STAGE_NAMES[stage]} · ${resolved}`,
                unlocked: true,
                locked: false,
                done: state.directions.unlocked || phases.phase1.completed
            },
            {
                id: 'directions',
                number: 2,
                title: 'Directions',
                subtitle: !state.directions.unlocked
                    ? (state.directions.skipped ?? state.directions.lockedLabel ?? '')
                    : chosen
                      ? `Chose ${chosen.label}`
                      : picked
                        ? `Investigating ${picked} of ${offered}`
                        : `${directionsResolved} of ${directionsTotal} resolved`,
                unlocked: state.directions.unlocked,
                locked: Boolean(state.directions.lockedLabel),
                done: state.directions.unlocked && phases.phase1.completed
            },
            {
                id: 'writeup',
                number: 3,
                title: 'Write-up',
                subtitle: state.writeup.unlocked ? writeupSubtitle : (state.writeup.lockedLabel ?? ''),
                unlocked: state.writeup.unlocked,
                locked: !state.writeup.unlocked,
                done: phases.submission !== null
            },
            {
                id: 'proposal',
                number: 4,
                title: 'Proposal',
                subtitle: !state.proposal.unlocked
                    ? (state.proposal.lockedLabel ?? '')
                    : phases.acceptedAt
                      ? 'Accepted'
                      : phases.proposalUnlocked
                        ? 'Awaiting your review'
                        : 'Agent is proposing',
                unlocked: state.proposal.unlocked,
                locked: !state.proposal.unlocked,
                done: Boolean(phases.acceptedAt)
            }
        ];
    }, deepEqual);
    const { tab } = useUiState();
    const { setTab, setPanelTab } = useActions();

    return (
        <nav className="phase-tabs" aria-label="Planning phases">
            {info.map((item) => (
                <button
                    key={item.id}
                    type="button"
                    className="phase-tab"
                    aria-current={tab === item.id ? 'page' : undefined}
                    disabled={!item.unlocked}
                    onClick={() => {
                        setTab(item.id);
                        if (item.id === 'proposal') setPanelTab('review');
                    }}
                >
                    <span
                        className={`phase-number${item.done ? ' is-done' : ''}${tab === item.id ? ' is-current' : ''}`}
                        aria-hidden="true"
                    >
                        {item.done && tab !== item.id ? <CheckIcon size={12} /> : item.number}
                    </span>
                    <span className="phase-text">
                        <span className="phase-title">{item.title}</span>
                        <span className="phase-subtitle" title={item.subtitle}>
                            {item.locked && <LockIcon />}
                            <span className="truncate">{item.subtitle}</span>
                        </span>
                    </span>
                </button>
            ))}
        </nav>
    );
}
