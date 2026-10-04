import { memo } from 'react';
import { orderedSections } from '../../shared/derive';
import { BlockView } from '../blocks/Block';
import { relativeTime } from '../format';
import { useNow } from '../hooks';
import { useReadOnly } from '../readOnly';
import { deepEqual, useRecord, useSelector } from '../store';
import { quietly, useActions, useBusy } from '../ui';
import { latestTouching, undoReason } from './revisions';

/** One write-up block, re-rendered only when its own version changes. */
const SectionBlock = memo(function SectionBlock({ id }: { id: string }) {
    const block = useRecord('blocks', id);
    if (!block) return null;
    return (
        <div id={`block-${id}`} className="section-block" data-scroll-anchor>
            <BlockView block={block} placement="writeup" />
        </div>
    );
});

/** The reviewed tick, and when the agent's change cleared it, saying so. */
function ReviewTick({ sectionId, number }: { sectionId: string; number: number }) {
    const section = useRecord('sections', sectionId);
    const { send } = useActions();
    const readOnly = useReadOnly();
    const now = useNow();
    if (!section) return null;
    const changed = !section.reviewed && section.unreviewedBy !== undefined;
    return (
        <label className={`review-tick${changed ? ' is-changed' : section.reviewed ? ' is-reviewed' : ''}`}>
            <input
                type="checkbox"
                checked={section.reviewed}
                disabled={readOnly}
                onChange={(event) => quietly(send({ type: 'review.mark', sectionId, reviewed: event.target.checked }))}
                aria-label={`§${number} reviewed`}
            />
            <span className="review-text">
                <span>Reviewed</span>
                {changed && (
                    <span className="review-reason">
                        Unticked · {section.unreviewedBy === 'agent' ? 'changed by agent' : 'undone'}{' '}
                        {relativeTime(section.unreviewedAt, now)}
                    </span>
                )}
            </span>
        </label>
    );
}

/**
 * "Undo edit" beside the "changed by agent" marker, for the agent's latest change to
 * this section, disabled with the reason when it cannot be undone. Every edit, the
 * first draft included, can also be undone from the history.
 */
function UndoEdit({ sectionId }: { sectionId: string }) {
    const info = useSelector((view) => {
        const section = view.sections[sectionId];
        if (!section || section.reviewed || section.unreviewedBy !== 'agent') return undefined;
        const latest = latestTouching(view.revisions, section);
        if (!latest || latest.undone || latest.undoOf !== undefined) return undefined;
        return { n: latest.n, summary: latest.summary, reason: undoReason(view.revisions, latest.n, view.sections) };
    }, deepEqual);
    const { send } = useActions();
    const readOnly = useReadOnly();
    const [busy, track] = useBusy();
    if (!info || readOnly) return null;
    return (
        <button
            type="button"
            className="button-link small"
            disabled={busy || info.reason !== undefined}
            title={info.reason ?? `Undo v${info.n}: ${info.summary}`}
            onClick={() => quietly(track(send({ type: 'edit.undo', revision: info.n })))}
        >
            Undo edit{info.reason ? ` (${info.reason})` : ''}
        </button>
    );
}

/** One write-up section: its number and commentable title, its undo and review controls, then its blocks, a row of columns where it lists one. */
export const Section = memo(function Section({ id }: { id: string }) {
    const section = useRecord('sections', id);
    const number = useSelector((view) => orderedSections(view).find((entry) => entry.section.id === id)?.number ?? 0);
    if (!section) return null;
    return (
        <section id={`section-${id}`} className="doc-section" aria-labelledby={`section-title-${id}`} data-scroll-anchor>
            <div className="section-head">
                <h2 id={`section-title-${id}`}>
                    <span className="section-number">{number}</span>
                    <span data-anchor-target={`section:${id}`}>{section.title}</span>
                </h2>
                <div className="section-tools">
                    <UndoEdit sectionId={id} />
                    <ReviewTick sectionId={id} number={number} />
                </div>
            </div>
            {section.blocks.map((item) =>
                typeof item === 'string' ? (
                    <SectionBlock key={item} id={item} />
                ) : (
                    <div key={item.join(' ')} className="section-row">
                        {item.map((blockId) => (
                            <SectionBlock key={blockId} id={blockId} />
                        ))}
                    </div>
                )
            )}
        </section>
    );
});
