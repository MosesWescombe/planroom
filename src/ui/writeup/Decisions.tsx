import { memo } from 'react';
import type { BlockConfigs } from '../../shared/blocks';
import { type DecisionRow, decisionRows } from '../../shared/derive';
import { TableBlock } from '../blocks/basic';
import { deepEqual, useSelector } from '../store';

/** The section id the contents rail and links use for the Decisions section. A record id never starts with `_`. */
export const DECISIONS_ID = '_decisions';

const UNSETTLED: Record<NonNullable<DecisionRow['unsettled']>, string> = {
    'needs-review': 'Needs review',
    conflict: 'In conflict'
};

type Cell = BlockConfigs['table']['rows'][number][number];

/** A row's status cell: a badge while its answer is in doubt, else empty. */
function statusCell(row: DecisionRow): Cell {
    return row.unsettled ? { text: UNSETTLED[row.unsettled], tone: 'attention' } : null;
}

/** The decisions as a table: what was decided, the choice, a status column only while one is in doubt, and the question. */
export function decisionsTable(rows: readonly DecisionRow[]): BlockConfigs['table'] {
    const flagged = rows.some((row) => row.unsettled);
    return {
        columns: ['Decision', 'Choice', ...(flagged ? ['Status'] : []), 'From'],
        rows: rows.map((row) => [
            row.decision,
            row.note ? `${row.choice} (${row.note})` : row.choice,
            ...(flagged ? [statusCell(row)] : []),
            row.questionId
        ]),
        refColumn: flagged ? 3 : 2
    };
}

/**
 * The Decisions section the write-up ends with: one row per answered question, built by the page from the answers
 * rather than written by the agent, so it always says what the user chose. It is not reviewed: it is the user's own.
 */
export const Decisions = memo(function Decisions({ number }: { number: number }) {
    const rows = useSelector((view) => decisionRows(view), deepEqual);
    if (rows.length === 0) return null;
    return (
        <section
            id={`section-${DECISIONS_ID}`}
            className="doc-section"
            aria-labelledby={`section-title-${DECISIONS_ID}`}
            data-scroll-anchor
        >
            <div className="section-head">
                <h2 id={`section-title-${DECISIONS_ID}`}>
                    <span className="section-number">{number}</span>
                    <span>Decisions</span>
                </h2>
                <span className="section-note">From your answers</span>
            </div>
            <div className="section-block">
                <TableBlock id={DECISIONS_ID} config={decisionsTable(rows)} placement="writeup" />
            </div>
        </section>
    );
});
