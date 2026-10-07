import { Fragment, type ReactNode, useEffect, useMemo, useState } from 'react';
import { ChevronIcon } from '../components/icons';
import { plural } from '../format';
import { foldRanges, indentLevel } from './folding';
import { highlightLines, type Token } from './highlight';

/**
 * One line of the viewer: a diff line's kind (plain code is all context), its number in the new file
 * (or the plain code) and, for a diff, its number in the original.
 */
export interface CodeRow {
    kind: 'context' | 'add' | 'remove' | 'hunk';
    text: string;
    number?: number;
    oldNumber?: number;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Parse a unified diff into lines numbered on both sides. File headers (`diff --git`, `index`, `---`, `+++`) are not
 * lines of the file, before the first hunk or before a later file's, nor is `\ No newline at end of file`, so both
 * are left out. A later header is recognised by its shape rather than by hunk line counts, which hand-written diffs
 * often get wrong.
 */
export function parsePatch(patch: string): CodeRow[] {
    const lines: CodeRow[] = [];
    let [old, next] = [0, 0];
    const all = patch.replace(/\n$/, '').split('\n');
    const isHunk = (index: number) => HUNK.test(all[index] ?? '');
    for (
        let index = Math.max(
            0,
            all.findIndex((line) => HUNK.test(line))
        );
        index < all.length;
        index += 1
    ) {
        const line = all[index] ?? '';
        if (line.startsWith('\\')) continue;
        const header =
            line.startsWith('diff --git ') ||
            (line.startsWith('--- ') && (all[index + 1] ?? '').startsWith('+++ ') && isHunk(index + 2));
        if (header) {
            while (index + 1 < all.length && !isHunk(index + 1)) index += 1;
            continue;
        }
        const hunk = HUNK.exec(line);
        if (hunk) {
            [old, next] = [Number(hunk[1]), Number(hunk[2])];
            lines.push({ kind: 'hunk', text: line });
        } else if (line.startsWith('+')) {
            lines.push({ kind: 'add', text: line.slice(1), number: next });
            next += 1;
        } else if (line.startsWith('-')) {
            lines.push({ kind: 'remove', text: line.slice(1), oldNumber: old });
            old += 1;
        } else {
            lines.push({ kind: 'context', text: line.startsWith(' ') ? line.slice(1) : line, number: next, oldNumber: old });
            [old, next] = [old + 1, next + 1];
        }
    }
    return lines;
}

/** How a diff shows: both sides interleaved, or one side alone as that file reads. */
type DiffView = 'inline' | 'original' | 'new';

const DIFF_VIEWS: readonly [DiffView, string][] = [
    ['inline', 'Inline'],
    ['original', 'Original'],
    ['new', 'New']
];

/** A row with its highlighted tokens. */
interface ViewLine {
    row: CodeRow;
    tokens: Token[];
}

/** The lines a view shows: every row inline, or one side without the other's lines, numbered as in that file. */
function viewLines(rows: readonly CodeRow[], tokens: readonly Token[][], view: DiffView): ViewLine[] {
    const lines = rows.map((row, index) => ({ row, tokens: tokens[index] ?? [] }));
    if (view === 'inline') return lines;
    const hidden = view === 'original' ? 'add' : 'remove';
    return lines
        .filter(({ row }) => row.kind !== hidden)
        .map((line) => (view === 'original' ? { ...line, row: { ...line.row, number: line.row.oldNumber } } : line));
}

/** Plain code as rows numbered from `start`. */
export function plainRows(code: string, start = 1): CodeRow[] {
    return code
        .replace(/\n$/, '')
        .split('\n')
        .map((text, index) => ({ kind: 'context', text, number: start + index }));
}

/**
 * Highlight every row. A diff's two sides are highlighted apart, each as continuous code, so a
 * comment or string that spans lines colours correctly on both. Hunk headers stay plain.
 */
function highlightRows(rows: readonly CodeRow[], language: string | undefined): Token[][] {
    const side = (other: CodeRow['kind']) =>
        highlightLines(
            rows
                .filter((row) => row.kind !== other && row.kind !== 'hunk')
                .map((row) => row.text)
                .join('\n'),
            language
        );
    const after = side('remove');
    const before = rows.some((row) => row.kind === 'remove') ? side('add') : [];
    let [a, b] = [0, 0];
    return rows.map((row) => {
        if (row.kind === 'hunk') return [{ text: row.text, scopes: [] }];
        if (row.kind === 'remove') return before[b++] ?? [];
        if (row.kind === 'context') b += 1;
        return after[a++] ?? [];
    });
}

/** A token as nested spans, one per highlight scope, outermost first. */
function renderToken(token: Token, key: number): ReactNode {
    return (
        <Fragment key={key}>
            {token.scopes.reduceRight<ReactNode>(
                (child, scope) => (
                    // biome-ignore lint/correctness/useJsxKeyInIterable: each span wraps the last, so there are no siblings to key.
                    <span className={scope}>{child}</span>
                ),
                token.text
            )}
        </Fragment>
    );
}

const MARKERS: Partial<Record<CodeRow['kind'], string>> = { add: '+', remove: '−', hunk: '' };

type CopyState = 'idle' | 'copied' | 'failed';
const COPY_LABELS: Record<CopyState, string> = { idle: 'Copy', copied: 'Copied', failed: 'Copy failed' };

/**
 * Read-only code, highlighted and foldable: plain code numbered from `start`, or a unified diff shown
 * inline or as either side alone. Folding follows indentation, so functions, blocks, objects and diff
 * hunks collapse under their first line. The page renders every line as text, so comments anchor in it
 * like any other block.
 */
export function CodeViewer({
    source,
    format = 'code',
    start,
    language,
    title,
    label,
    notes
}: {
    source: string;
    format?: 'code' | 'diff';
    start?: number;
    /** A highlight.js language name or alias; undefined shows plain text. */
    language?: string;
    title?: string;
    /** Names the lines for assistive technology. */
    label: string;
    /** What to show under a line, such as the review findings on it; nothing when it returns nothing. */
    notes?: (row: CodeRow) => ReactNode;
}) {
    const rows = useMemo(() => (format === 'diff' ? parsePatch(source) : plainRows(source, start)), [source, format, start]);
    const tokens = useMemo(() => highlightRows(rows, language), [rows, language]);
    const [view, setView] = useState<DiffView>('inline');
    const shown = useMemo(() => viewLines(rows, tokens, view), [rows, tokens, view]);
    const folds = useMemo(() => foldRanges(shown.map(({ row }) => (row.kind === 'hunk' ? -1 : indentLevel(row.text)))), [shown]);
    const [folded, setFolded] = useState<ReadonlySet<number>>(() => new Set());
    const [copy, setCopy] = useState<CopyState>('idle');
    useEffect(() => setFolded(new Set()), [shown]);
    useEffect(() => {
        if (copy === 'idle') return undefined;
        const timer = setTimeout(() => setCopy('idle'), 1500);
        return () => clearTimeout(timer);
    }, [copy]);

    const toggle = (line: number) =>
        setFolded((current) => {
            const next = new Set(current);
            if (!next.delete(line)) next.add(line);
            return next;
        });
    // One side alone copies as that file's code; inline copies the patch.
    const copyText =
        view === 'inline'
            ? source
            : shown
                  .filter(({ row }) => row.kind !== 'hunk')
                  .map(({ row }) => row.text)
                  .join('\n');
    // `navigator.clipboard` is missing outside a secure context, so reach it inside the promise.
    const copySource = () =>
        Promise.resolve()
            .then(() => navigator.clipboard.writeText(copyText))
            .then(
                () => setCopy('copied'),
                () => setCopy('failed')
            );

    const lines: ReactNode[] = [];
    let next = 0;
    while (next < shown.length) {
        const index = next;
        const { row, tokens: rowTokens } = shown[index]!;
        const end = folds.get(index);
        const closed = end !== undefined && folded.has(index);
        lines.push(
            <span key={index} className={`code-line is-${row.kind}`}>
                <span className="code-gutter">
                    <span className="fold-slot">
                        {end !== undefined && (
                            <button
                                type="button"
                                className="fold-toggle"
                                aria-expanded={!closed}
                                aria-label={`${closed ? 'Unfold' : 'Fold'} ${plural(end - index, 'line')}`}
                                onClick={() => toggle(index)}
                            >
                                <ChevronIcon />
                            </button>
                        )}
                    </span>
                    <span className="line-number">{view === 'inline' ? (MARKERS[row.kind] ?? row.number) : row.number}</span>
                </span>
                <span className="line-text">
                    {row.kind === 'add' && <span className="visually-hidden">Added: </span>}
                    {row.kind === 'remove' && <span className="visually-hidden">Removed: </span>}
                    {rowTokens.map(renderToken)}
                    {closed && (
                        // The gutter toggle is the accessible control; this is a wider mouse target beside the text.
                        <button
                            type="button"
                            className="fold-more"
                            tabIndex={-1}
                            aria-hidden="true"
                            onClick={() => toggle(index)}
                        >
                            ⋯
                        </button>
                    )}
                </span>
            </span>
        );
        const note = notes?.(row);
        if (note) {
            lines.push(
                <div key={`note-${index}`} className="code-note">
                    {note}
                </div>
            );
        }
        next = closed ? end + 1 : index + 1;
    }

    return (
        <div className="code-viewer">
            <div className="code-head">
                {title && <span className="code-title">{title}</span>}
                <span className="code-tools">
                    {language && <span className="code-language">{language}</span>}
                    {format === 'diff' && (
                        <span role="tablist" aria-label="Diff view" className="segmented">
                            {DIFF_VIEWS.map(([id, name]) => (
                                <button key={id} type="button" role="tab" aria-selected={view === id} onClick={() => setView(id)}>
                                    {name}
                                </button>
                            ))}
                        </span>
                    )}
                    {folds.size > 0 && (
                        <button
                            type="button"
                            className="button-text"
                            onClick={() => setFolded(folded.size ? new Set() : new Set(folds.keys()))}
                        >
                            {folded.size ? 'Unfold all' : 'Fold all'}
                        </button>
                    )}
                    <button type="button" className="button-text" onClick={copySource}>
                        {COPY_LABELS[copy]}
                    </button>
                </span>
            </div>
            <div className="code-lines" role="group" aria-label={label}>
                <div className="code-rows">{lines}</div>
            </div>
        </div>
    );
}
