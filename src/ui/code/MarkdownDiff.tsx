import { diffArrays } from 'diff';
import { Fragment, type ReactNode, useMemo } from 'react';
import { Markdown, markdownBlocks } from '../components/Markdown';
import type { CodeRow } from './CodeViewer';

/** Whether a file is Markdown, by its extension. */
export function isMarkdown(file: string): boolean {
    return /\.(md|markdown)$/i.test(file);
}

/** One block of a rendered Markdown diff: unchanged, added or removed, its source, and the diff rows it is made of. */
export interface MarkdownBlock {
    kind: 'context' | 'add' | 'remove';
    source: string;
    rows: CodeRow[];
}

/** The text of rows, one line each. */
function sourceOf(rows: readonly CodeRow[]): string {
    return rows.map((row) => row.text).join('\n');
}

/** One side's rows cut into the top-level Markdown blocks their text parses into. */
function blocksOf(rows: readonly CodeRow[]): CodeRow[][] {
    return markdownBlocks(sourceOf(rows)).map(([start, end]) => rows.slice(start - 1, end));
}

/**
 * Diff rows as Markdown blocks, as a rich diff shows prose: each side is parsed into its top-level blocks and the
 * blocks are diffed whole, so a block changed at all shows as the old block removed and the new one added. Each block
 * renders from its own source, so none is cut mid-list or mid-fence.
 */
export function markdownDiff(rows: readonly CodeRow[]): MarkdownBlock[] {
    const before = blocksOf(rows.filter((row) => row.kind === 'context' || row.kind === 'remove'));
    const after = blocksOf(rows.filter((row) => row.kind === 'context' || row.kind === 'add'));
    const blocks: MarkdownBlock[] = [];
    let [old, next] = [0, 0];
    for (const part of diffArrays(before.map(sourceOf), after.map(sourceOf))) {
        const kind: MarkdownBlock['kind'] = part.removed ? 'remove' : part.added ? 'add' : 'context';
        const taken = part.removed ? before.slice(old, old + part.count) : after.slice(next, next + part.count);
        if (!part.added) old += part.count;
        if (!part.removed) next += part.count;
        blocks.push(...taken.map((ofBlock) => ({ kind, source: sourceOf(ofBlock), rows: ofBlock })));
    }
    return blocks;
}

const MARKED = { add: 'Added', remove: 'Removed' } as const;

/**
 * Markdown diff rows rendered as the file reads: block by block, an added block marked as an added line is and a
 * removed one struck through, with what `notes` shows for a block's rows under it. A removed block shows the notes on
 * its removed lines only, since its unchanged lines show theirs in the new block.
 */
export function MarkdownDiff({
    rows,
    label,
    notes
}: {
    rows: readonly CodeRow[];
    /** Names the blocks for assistive technology. */
    label: string;
    /** What to show under a line, such as the review findings on it; nothing when it returns nothing. */
    notes?: (row: CodeRow) => ReactNode;
}) {
    const blocks = useMemo(() => markdownDiff(rows), [rows]);
    return (
        <div className="code-viewer markdown-diff" role="group" aria-label={label}>
            {blocks.map((block, index) => (
                <Fragment key={index}>
                    <div className={`markdown-block is-${block.kind}`}>
                        {block.kind !== 'context' && <span className="visually-hidden">{MARKED[block.kind]}: </span>}
                        <div className="prose document">
                            <Markdown document source={block.source} />
                        </div>
                    </div>
                    {block.rows
                        .filter((row) => block.kind !== 'remove' || row.kind === 'remove')
                        .map((row, at) => {
                            const note = notes?.(row);
                            return note ? (
                                <div key={at} className="code-note">
                                    {note}
                                </div>
                            ) : null;
                        })}
                </Fragment>
            ))}
        </div>
    );
}
