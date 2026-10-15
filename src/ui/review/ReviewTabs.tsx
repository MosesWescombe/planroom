import { useEffect } from 'react';
import { readProgress } from '../../shared/readthrough';
import {
    currentRound,
    deckSlides,
    findingsUnlocked,
    hasDeck,
    hasReadthrough,
    type ReviewStage,
    reviewStage,
    roundItems,
    type Technique
} from '../../shared/review';
import { CheckIcon, LockIcon } from '../components/icons';
import { plural } from '../format';
import { deepEqual, useSelector } from '../store';
import { type Tab, useActions, useUiState } from '../ui';
import { useShownRound } from './hooks';

/**
 * The tab a review stage opens on, by the round's technique: the read-through for a round read through alone, and
 * after the deck for both.
 */
export function tabForStage(stage: ReviewStage, technique?: Technique): Tab {
    if (stage === 'preview' || stage === 'posted') return 'comments';
    if (technique === 'readthrough') return 'readthrough';
    if (stage === 'triage') return technique === 'both' ? 'readthrough' : 'findings';
    return 'walkthrough';
}

interface TabInfo {
    id: Tab;
    number: number;
    title: string;
    subtitle: string;
    unlocked: boolean;
    done: boolean;
}

/** Switch between rounds once there is more than one; an earlier round shows as it was. */
function RoundSwitcher() {
    const rounds = useSelector((view) => view.review?.rounds.map((round) => round.n) ?? [], deepEqual);
    const { round } = useUiState();
    const { setRound, setSlide } = useActions();
    if (rounds.length < 2) return null;
    const last = rounds[rounds.length - 1];
    return (
        <select
            className="field-select round-switcher"
            aria-label="Round"
            value={round ?? last}
            onChange={(event) => {
                const picked = Number(event.target.value);
                setRound(picked === last ? undefined : picked);
                setSlide(undefined);
            }}
        >
            {rounds.map((n) => (
                <option key={n} value={n}>
                    Round {n}
                    {n === last ? ' (current)' : ''}
                </option>
            ))}
        </select>
    );
}

/**
 * A review's tabs in the top row, by the round's technique: the Walkthrough, the Read-through or both, then the Review,
 * locked until the walkthrough is finished or skipped, then the Comments to post. With no deck, Review and Comments
 * are open at once. Each says where it stands.
 */
export function ReviewTabs() {
    const round = useShownRound();
    const info = useSelector((view): TabInfo[] => {
        const stage = view.review && currentRound(view.review).n === round.n ? reviewStage(view) : 'posted';
        const items = roundItems(view, round.n);
        const reacted = items.filter((item) => view.reactions[item.id]).length;
        const unlocked = findingsUnlocked(round);
        const drafted = deckSlides(view, round.n).length;
        const posted = Boolean(round.postedAt);
        const none = round.reviewers?.strength === 'none';
        const read = readProgress(view, round.index, round.n).lines;
        const tabs: Omit<TabInfo, 'number'>[] = [
            {
                id: 'walkthrough',
                title: 'Walkthrough',
                subtitle:
                    stage === 'next-round'
                        ? `Round ${round.n} is starting`
                        : !round.publishedAt
                          ? `Agent is building · ${plural(drafted, 'slide')}`
                          : !round.tradeoffsAt && round.impact?.sentAt
                            ? 'Agent is writing Trade-offs'
                            : round.walkthrough
                              ? `${round.walkthrough.how === 'finished' ? 'Finished' : 'Skipped'} · ${plural(drafted, 'slide')}`
                              : plural(drafted, 'slide'),
                unlocked: true,
                done: Boolean(round.walkthrough)
            },
            {
                id: 'readthrough',
                title: 'Read-through',
                subtitle: !round.readthrough
                    ? round.technique === 'both' && !round.publishedAt
                        ? 'After the walkthrough'
                        : 'Agent is laying out the pages'
                    : `${read.read} of ${plural(read.total, 'line')} read`,
                unlocked: true,
                done: Boolean(round.readthrough) && read.total > 0 && read.read === read.total
            },
            {
                id: 'findings',
                title: 'Review',
                subtitle: unlocked
                    ? items.length
                        ? `${reacted} of ${plural(items.length, 'finding')} reacted to`
                        : none
                          ? 'No AI review'
                          : round.progress?.reviewedAt
                            ? 'No findings'
                            : 'Agent is reviewing'
                    : 'After the walkthrough',
                unlocked,
                done: unlocked && (items.length > 0 ? reacted === items.length : none || Boolean(round.progress?.reviewedAt))
            },
            {
                id: 'comments',
                title: 'Comments',
                subtitle: posted
                    ? 'Posted'
                    : round.posting?.state === 'partial'
                      ? 'Partly posted'
                      : unlocked
                        ? 'Preview and post'
                        : 'After the review',
                unlocked,
                done: posted
            }
        ];
        return tabs
            .filter(
                (tab) =>
                    (tab.id !== 'walkthrough' || hasDeck(round.technique)) &&
                    (tab.id !== 'readthrough' || hasReadthrough(round.technique))
            )
            .map((tab, index) => ({ ...tab, number: index + 1 }));
    }, deepEqual);
    const { tab } = useUiState();
    const { setTab } = useActions();
    // A technique chosen elsewhere can take the tab on show away: move to the one that replaces it.
    const technique = round.technique;
    useEffect(() => {
        if (tab === 'walkthrough' && !hasDeck(technique)) setTab('readthrough');
        if (tab === 'readthrough' && !hasReadthrough(technique)) setTab('walkthrough');
    }, [tab, technique, setTab]);
    return (
        <nav className="phase-tabs" aria-label="Review">
            {info.map((item) => (
                <button
                    key={item.id}
                    type="button"
                    className="phase-tab"
                    aria-current={tab === item.id ? 'page' : undefined}
                    disabled={!item.unlocked}
                    onClick={() => setTab(item.id)}
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
                            {!item.unlocked && <LockIcon />}
                            <span className="truncate">{item.subtitle}</span>
                        </span>
                    </span>
                </button>
            ))}
            <RoundSwitcher />
        </nav>
    );
}
