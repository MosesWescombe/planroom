import { memo, useState } from 'react';
import {
    decisionRows,
    describeCounts,
    isAssumption,
    isConfirmed,
    orderedSections,
    outstandingItems,
    submitCounts
} from '../../shared/derive';
import { blockIdsOf } from '../../shared/records';
import { CheckIcon } from '../components/icons';
import { Markdown } from '../components/Markdown';
import { Rail } from '../components/Rail';
import { plural } from '../format';
import { deepEqual, useSelector } from '../store';
import { useActions } from '../ui';
import { Decisions, DECISIONS_ID } from './Decisions';
import { History } from './History';
import { Section } from './Section';
import { SubmitDialog } from './SubmitDialog';

/**
 * Every section in order, with what the contents rail and its collapsed strip mark it by, then the Decisions section
 * the page adds once there are answers, which is never reviewed (`derived`).
 */
function useContentsEntries() {
    return useSelector((view) => {
        const sections = orderedSections(view).map(({ section, number }) => ({
            id: section.id,
            number,
            title: section.title,
            reviewed: section.reviewed,
            changed: !section.reviewed && section.unreviewedBy !== undefined,
            assumptions: blockIdsOf(section).filter((blockId) => {
                const block = view.blocks[blockId];
                return block !== undefined && isAssumption(block) && !isConfirmed(view, block);
            }).length,
            derived: false
        }));
        if (decisionRows(view).length === 0) return sections;
        const decisions = {
            id: DECISIONS_ID,
            number: sections.length + 1,
            title: 'Decisions',
            reviewed: false,
            changed: false,
            assumptions: 0,
            derived: true
        };
        return [...sections, decisions];
    }, deepEqual);
}

/** The contents rail: every section, marked when reviewed, when the agent changed it, or when assumptions wait in it. */
const Contents = memo(function Contents({ onHistory }: { onHistory: () => void }) {
    const entries = useContentsEntries();
    const revisions = useSelector((view) => view.revisions.length);
    const { goTo } = useActions();
    return (
        <nav className="rail" aria-label="Contents">
            <div className="nav-heading">CONTENTS</div>
            <ol className="contents">
                {entries.map((entry) => (
                    <li key={entry.id}>
                        <a
                            href={`#section-${entry.id}`}
                            className="nav-item"
                            onClick={(event) => {
                                event.preventDefault();
                                goTo(`section:${entry.id}`);
                            }}
                        >
                            <span className="mono muted contents-number">{entry.number}</span>
                            <span className="nav-name">{entry.title}</span>
                            {entry.changed && (
                                <span className="dot dot-agent" role="img" aria-label="changed by agent, needs review" />
                            )}
                            {entry.assumptions > 0 && (
                                <span className="count" aria-label={`${entry.assumptions} assumptions to confirm`}>
                                    {entry.assumptions}
                                </span>
                            )}
                            {entry.reviewed && (
                                <span className="state-mark state-answered" role="img" aria-label="reviewed">
                                    <CheckIcon size={9} />
                                </span>
                            )}
                        </a>
                    </li>
                ))}
            </ol>
            {revisions > 0 && (
                <button type="button" className="button-link" onClick={onHistory}>
                    History ({revisions} revision{revisions === 1 ? '' : 's'})
                </button>
            )}
        </nav>
    );
});

/** The collapsed contents: reviewed over total, then one numbered mark per section, ticked or flagged as in the rail. */
const ContentsStrip = memo(function ContentsStrip() {
    const entries = useContentsEntries();
    const { goTo } = useActions();
    const reviewed = entries.filter((entry) => entry.reviewed).length;
    const reviewable = entries.filter((entry) => !entry.derived).length;
    return (
        <nav className="rail-strip" aria-label="Review progress">
            <span className="mono small" title={`${reviewed} of ${reviewable} sections reviewed`}>
                {reviewed}/{reviewable}
            </span>
            <div className="rail-strip-group">
                {entries.map((entry) => {
                    const state = entry.reviewed ? 'reviewed' : entry.changed || entry.assumptions > 0 ? 'attention' : 'open';
                    const label = [
                        `§${entry.number} ${entry.title}`,
                        entry.derived && 'from your answers',
                        entry.reviewed && 'reviewed',
                        entry.changed && 'changed by agent, needs review',
                        entry.assumptions > 0 && plural(entry.assumptions, 'assumption') + ' to confirm'
                    ]
                        .filter(Boolean)
                        .join(', ');
                    return (
                        <a
                            key={entry.id}
                            className="rail-strip-item"
                            href={`#section-${entry.id}`}
                            aria-label={label}
                            title={label}
                            onClick={(event) => {
                                event.preventDefault();
                                goTo(`section:${entry.id}`);
                            }}
                        >
                            <span className={`strip-section is-${state}`} aria-hidden="true">
                                {entry.reviewed ? <CheckIcon size={9} /> : entry.number}
                            </span>
                        </a>
                    );
                })}
            </div>
        </nav>
    );
});

/** "Ready to propose?" with what still needs the user, and the way into the submit dialog. */
const SubmitBar = memo(function SubmitBar({ onOpen }: { onOpen: () => void }) {
    const summary = useSelector((view) => {
        const counts = submitCounts(outstandingItems(view));
        return {
            text: describeCounts(counts),
            submitted: view.phases.submission,
            markdown: view.format === 'markdown',
            accepted: Boolean(view.phases.acceptedAt),
            unlocked: view.phases.proposalUnlocked,
            revision: view.revision,
            empty: view.revision === 0
        };
    }, deepEqual);
    const { setTab, setPanelTab } = useActions();
    if (summary.empty || summary.accepted) return null;
    const output = summary.markdown ? 'a Markdown plan' : 'an OpenSpec change';
    if (summary.submitted) {
        // Submitting again waits for the current proposal and needs a write-up revision it has not seen.
        const again = summary.unlocked && summary.submitted.revision !== summary.revision;
        return (
            <footer className="submit-bar">
                <div className="submit-text">
                    <span className="submit-title">{summary.unlocked ? 'Proposed' : 'Submitted'}</span>
                    <span className="submit-detail">
                        {summary.unlocked
                            ? `Write-up v${summary.submitted.revision} became ${output}. Review it in the Proposal tab.`
                            : `The agent is turning write-up v${summary.submitted.revision} into ${output}.`}
                    </span>
                </div>
                <button
                    type="button"
                    className="button-inverse"
                    onClick={() => {
                        if (again) {
                            onOpen();
                        } else {
                            setTab('proposal');
                            setPanelTab('review');
                        }
                    }}
                >
                    {again ? 'Submit again' : summary.unlocked ? 'Open proposal' : 'Show progress'}
                </button>
            </footer>
        );
    }
    return (
        <footer className="submit-bar">
            <div className="submit-text">
                <span className="submit-title">Ready to propose?</span>
                <span className="submit-detail">{summary.text}</span>
            </div>
            <button type="button" className="button-inverse" onClick={onOpen}>
                {summary.markdown ? 'Submit & write Markdown plan' : 'Submit & propose OpenSpec change'}
            </button>
        </footer>
    );
});

/** Phase 2: the write-up document built from the agent's sections and blocks. */
export function Writeup() {
    const head = useSelector(
        (view) => ({
            title: view.title,
            revision: view.revision,
            answered: Object.values(view.questions).filter((question) => question.status === 'answered').length,
            lede: view.understanding.text.split(/\n{2,}/)[0] ?? ''
        }),
        deepEqual
    );
    const sectionIds = useSelector((view) => orderedSections(view).map(({ section }) => section.id), deepEqual);
    const [dialog, setDialog] = useState(false);
    const [history, setHistory] = useState(false);
    return (
        <>
            <Rail strip={<ContentsStrip />}>
                <Contents onHistory={() => setHistory(true)} />
            </Rail>
            <main className="main" id="main">
                <div className="main-inner doc-inner">
                    <article className="doc">
                        <header className="doc-head">
                            <div className="eyebrow">
                                PHASE 2 · WRITE-UP
                                {head.revision > 0 && (
                                    <span className="mono">
                                        {' '}
                                        · v{head.revision} · from {head.answered} answer{head.answered === 1 ? '' : 's'}
                                    </span>
                                )}
                            </div>
                            <h1>{head.title}</h1>
                            {head.lede && (
                                <div className="doc-lede">
                                    <Markdown source={head.lede} />
                                </div>
                            )}
                        </header>
                        {sectionIds.length === 0 ? (
                            <p className="muted">
                                The agent is drafting the write-up from your answers. Sections appear here as it writes them.
                            </p>
                        ) : (
                            sectionIds.map((id) => <Section key={id} id={id} />)
                        )}
                        <Decisions number={sectionIds.length + 1} />
                        <SubmitBar onOpen={() => setDialog(true)} />
                    </article>
                </div>
            </main>
            {dialog && <SubmitDialog onClose={() => setDialog(false)} />}
            {history && <History onClose={() => setHistory(false)} />}
        </>
    );
}
