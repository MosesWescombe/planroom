import isEqual from 'lodash/isEqual';
import { Fragment, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { boxOf, type SelectionBox, textOffset } from '../comments/selection';
import { ChevronIcon } from '../components/icons';
import { plural } from '../format';
import { foldRanges, indentLevel } from './folding';
import { highlightLines, type Token } from './highlight';

/**
 * One line of the viewer: a diff line's kind (plain code is all context), its number in the new file
 * (or the plain code) and, for a diff, its number in the original. In the as-it-is-now view the first line of a change
 * carries the lines the change replaced, and a `gone` row marks where lines were removed, carrying them.
 */
export interface CodeRow {
    kind: 'context' | 'add' | 'remove' | 'hunk' | 'gone';
    text: string;
    number?: number;
    oldNumber?: number;
    /** On the first line of a change, the old lines the whole change replaced; none on a line that was only added. */
    was?: string[];
    /** The lines removed at a `gone` marker. */
    gone?: string[];
}

/** Lines picked in the viewer, on one side of the diff, with the code highlighted in them. */
export interface LineSelection {
    side: 'new' | 'old';
    start: number;
    end: number;
    /** The code highlighted, which can start and end partway through a line; none when it is only whitespace. */
    text?: string;
}

/**
 * Diff rows as the code reads now: removed lines drop out, the first line of each change keeps the lines the change
 * replaced, and a removal with nothing in its place leaves a `gone` marker holding the removed lines.
 */
export function nowRows(rows: readonly CodeRow[]): CodeRow[] {
    const out: CodeRow[] = [];
    let removed: CodeRow[] = [];
    let replacing = false;
    const flush = () => {
        if (removed.length && !replacing)
            out.push({
                kind: 'gone',
                text: `${removed.length} ${removed.length === 1 ? 'line' : 'lines'} removed`,
                gone: removed.map((row) => row.text),
                ...(removed[0]?.oldNumber !== undefined ? { oldNumber: removed[0].oldNumber } : {})
            });
        removed = [];
        replacing = false;
    };
    for (const row of rows) {
        if (row.kind === 'hunk') continue;
        if (row.kind === 'remove') {
            if (replacing) flush();
            removed.push(row);
        } else if (row.kind === 'add') {
            out.push(replacing || !removed.length ? row : { ...row, was: removed.map((line) => line.text) });
            replacing = true;
        } else {
            flush();
            out.push(row);
        }
    }
    flush();
    return out;
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

/** Highlight scopes whose words are not names to search for. */
const NOT_NAMES = new Set(['hljs-string', 'hljs-comment', 'hljs-keyword', 'hljs-number', 'hljs-literal', 'hljs-regexp']);

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
                .filter((row) => row.kind !== other && row.kind !== 'hunk' && row.kind !== 'gone')
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

/** A token's text with each name in it a `code-name` span, which a click searches for. */
function withNames(text: string): ReactNode {
    return text.split(/([A-Za-z_$][\w$]*)/).map((part, index) =>
        index % 2 === 1 ? (
            <span key={index} className="code-name">
                {part}
            </span>
        ) : (
            part
        )
    );
}

/** A token as nested spans, one per highlight scope, outermost first; with `names`, its names clickable. */
function renderToken(token: Token, key: number, names = false): ReactNode {
    const text = names && !token.scopes.some((scope) => NOT_NAMES.has(scope)) ? withNames(token.text) : token.text;
    return (
        <Fragment key={key}>
            {token.scopes.reduceRight<ReactNode>(
                (child, scope) => (
                    // biome-ignore lint/correctness/useJsxKeyInIterable: each span wraps the last, so there are no siblings to key.
                    <span className={scope}>{child}</span>
                ),
                text
            )}
        </Fragment>
    );
}

const MARKERS: Partial<Record<CodeRow['kind'], string>> = { add: '+', remove: '−', hunk: '', gone: '' };

/** The lines `rows` hold, as a selection: their new-side numbers, or their old-side ones when all were removed. */
function selectionOf(rows: readonly CodeRow[]): LineSelection | undefined {
    const fresh = rows.flatMap((row) => (row.kind !== 'remove' && row.number !== undefined ? [row.number] : []));
    const old = rows.flatMap((row) => (row.oldNumber !== undefined ? [row.oldNumber] : []));
    const [side, numbers] = fresh.length ? (['new', fresh] as const) : (['old', old] as const);
    if (!numbers.length) return undefined;
    return { side, start: Math.min(...numbers), end: Math.max(...numbers) };
}

/** A viewer's own selectable lines of code, leaving out those of any code shown in a note under a line. */
const OWN_ROWS = ':scope > .code-line [data-row]';

/**
 * The whole lines the page's text selection touches in `root`, a viewer's rows, with the code highlighted in them, and
 * where the selection sits in the window; nothing when the selection is collapsed, reaches outside `root` or holds no
 * code.
 */
function pickedLines(root: HTMLElement, shown: readonly ViewLine[]): { picked: LineSelection; at: SelectionBox } | undefined {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return undefined;
    // Firefox splits a selection around unselectable text into several ranges, so span the first to the last.
    const range = selection.getRangeAt(0).cloneRange();
    const last = selection.getRangeAt(selection.rangeCount - 1);
    range.setEnd(last.endContainer, last.endOffset);
    if (!root.contains(range.commonAncestorContainer)) return undefined;
    const parts = [...root.querySelectorAll<HTMLElement>(OWN_ROWS)]
        .filter((code) => range.intersectsNode(code))
        .map((code) => {
            const text = code.textContent ?? '';
            const from = code.contains(range.startContainer) ? textOffset(code, range.startContainer, range.startOffset) : 0;
            const to = code.contains(range.endContainer) ? textOffset(code, range.endContainer, range.endOffset) : text.length;
            return { row: shown[Number(code.dataset.row)]!.row, text: text.slice(from, to) };
        });
    // A drag that ends at the start of a line, or starts at the end of one, touches it without taking any of its code.
    while (parts[0]?.text === '') parts.shift();
    while (parts.at(-1)?.text === '') parts.pop();
    const lines = selectionOf(parts.map(({ row }) => row));
    if (!lines) return undefined;
    const text = parts.map((part) => part.text).join('\n');
    return { picked: text.trim() ? { ...lines, text } : lines, at: boxOf(range, root) };
}

/** How far an arrow key, Home or End moves the selection's end, as `Selection.modify` takes it; nothing for other keys. */
function selectionStep(event: React.KeyboardEvent): [direction: 'backward' | 'forward', granularity: string] | undefined {
    const direction = ['ArrowLeft', 'ArrowUp', 'Home'].includes(event.key) ? 'backward' : 'forward';
    switch (event.key) {
        case 'ArrowLeft':
        case 'ArrowRight':
            if (event.metaKey) return [direction, 'lineboundary'];
            return [direction, event.ctrlKey || event.altKey ? 'word' : 'character'];
        case 'ArrowUp':
        case 'ArrowDown':
            return [direction, 'line'];
        case 'Home':
        case 'End':
            return [direction, 'lineboundary'];
        default:
            return undefined;
    }
}

/** The line of code in `root`, a viewer's rows, that `node` sits in; nothing when it sits outside the code. */
function codeOf(root: HTMLElement, node: Node | null): HTMLElement | undefined {
    const code = (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>('.line-code');
    return code?.closest('.code-rows') === root ? code : undefined;
}

/**
 * Draw `caret` in `root`, a viewer's rows, at the moving end of the selection while `lines` has focus and that end is in
 * the code, and hide it otherwise: read-only text shows no caret of its own.
 */
function placeCaret(caret: HTMLElement, lines: HTMLElement, root: HTMLElement): void {
    const selection = window.getSelection();
    const focus = selection?.focusNode ?? null;
    const code = document.activeElement === lines ? codeOf(root, focus) : undefined;
    caret.hidden = !code;
    if (!code || !selection || !focus) return;
    const point = document.createRange();
    point.setStart(focus, selection.focusOffset);
    // A point between elements, or on an empty line, has no box of its own: the line's code stands in.
    const box = point.getClientRects()[0] ?? code.getBoundingClientRect();
    const origin = root.getBoundingClientRect();
    caret.style.left = `${box.left - origin.left}px`;
    caret.style.top = `${box.top - origin.top}px`;
    caret.style.height = `${box.height}px`;
}

/** Whether `row` is one of the lines `selection` names. */
export function inSelection(row: CodeRow, selection: LineSelection | undefined): boolean {
    if (!selection) return false;
    const number = selection.side === 'new' ? (row.kind === 'remove' ? undefined : row.number) : row.oldNumber;
    return number !== undefined && number >= selection.start && number <= selection.end && row.kind !== 'gone';
}

/** The old lines a change replaced, shown over the code below its first line. */
function WasPopover({ row }: { row: CodeRow }) {
    return (
        <span className="was-popover" role="note" aria-label={`Before the change at line ${row.number}`}>
            <span className="small strong">Before</span>
            {row.was?.map((line, index) => (
                <span key={index} className="was-line">
                    {line || ' '}
                </span>
            ))}
        </span>
    );
}

type CopyState = 'idle' | 'copied' | 'failed';
const COPY_LABELS: Record<CopyState, string> = { idle: 'Copy', copied: 'Copied', failed: 'Copy failed' };

/**
 * Read-only code, highlighted and foldable: plain code numbered from `start`, a unified diff shown inline or as either
 * side alone, or a diff as the code reads now, its added lines marked as in the diff, what a change replaced in a popover
 * from a dot on its first line, and a marker where lines were removed that opens to show them. Folding follows
 * indentation, so functions, blocks, objects and diff hunks collapse under their first line. The page renders every
 * line as text, so comments anchor in it like any other block. With `onSelect`, selecting code with the mouse, or with
 * Shift and the arrow keys, Home or End once the code has focus, picks the lines it touches and the code highlighted;
 * without Shift those keys move a drawn caret. With `onName`, clicking a name in the code reports it, and whether Ctrl
 * or Cmd was held.
 */
export function CodeViewer({
    source = '',
    rows: given,
    format = 'code',
    start,
    language,
    title,
    label,
    notes,
    selection,
    onSelect,
    onName,
    tools
}: {
    source?: string;
    /** Diff rows to show instead of parsing `source`, e.g. a piece of a file's diff. */
    rows?: readonly CodeRow[];
    format?: 'code' | 'diff' | 'now';
    start?: number;
    /** A highlight.js language name or alias; undefined shows plain text. */
    language?: string;
    title?: string;
    /** Names the lines for assistive technology. */
    label: string;
    /** What to show under a line, such as the review findings on it; nothing when it returns nothing. */
    notes?: (row: CodeRow) => ReactNode;
    /** The lines picked, marked in the gutter. */
    selection?: LineSelection;
    /** Lines picked, with where the selection sits in the window, to float a popover by it. */
    onSelect?: (selection: LineSelection, at: SelectionBox) => void;
    /** A name clicked, with `modified` when Ctrl or Cmd was held. */
    onName?: (name: string, modified: boolean) => void;
    /** More controls for the head, before Copy. */
    tools?: ReactNode;
}) {
    const rows = useMemo(() => {
        const parsed = given ?? (format === 'code' ? plainRows(source, start) : parsePatch(source));
        return format === 'now' ? nowRows(parsed) : parsed;
    }, [given, source, format, start]);
    const tokens = useMemo(() => highlightRows(rows, language), [rows, language]);
    const [view, setView] = useState<DiffView>('inline');
    const shown = useMemo(() => viewLines(rows, tokens, format === 'diff' ? view : 'inline'), [rows, tokens, view, format]);
    const folds = useMemo(
        () => foldRanges(shown.map(({ row }) => (row.kind === 'hunk' || row.kind === 'gone' ? -1 : indentLevel(row.text)))),
        [shown]
    );
    const [folded, setFolded] = useState<ReadonlySet<number>>(() => new Set());
    const [copy, setCopy] = useState<CopyState>('idle');
    const [opened, setOpened] = useState<ReadonlySet<number>>(() => new Set());
    const [was, setWas] = useState<number>();
    const linesRef = useRef<HTMLDivElement>(null);
    const rowsRef = useRef<HTMLDivElement>(null);
    const caretRef = useRef<HTMLSpanElement>(null);
    const drawCaret = useCallback(() => {
        const [caret, lines, root] = [caretRef.current, linesRef.current, rowsRef.current];
        if (caret && lines && root) placeCaret(caret, lines, root);
    }, []);
    // After every render too, so the caret keeps to its line when a note opens or a fold closes above it.
    useLayoutEffect(() => drawCaret());
    const pick = () => {
        const found = rowsRef.current ? pickedLines(rowsRef.current, shown) : undefined;
        if (found && !isEqual(found.picked, selection)) onSelect?.(found.picked, found.at);
    };
    const latestPick = useRef(pick);
    latestPick.current = pick;
    const selectable = Boolean(onSelect);
    // A drag can end anywhere, and picking only once it does keeps the lines under the pointer from moving mid-drag.
    useEffect(() => {
        if (!selectable) return undefined;
        const finish = () => latestPick.current();
        window.addEventListener('mouseup', finish);
        document.addEventListener('selectionchange', drawCaret);
        return () => {
            window.removeEventListener('mouseup', finish);
            document.removeEventListener('selectionchange', drawCaret);
        };
    }, [selectable, drawCaret]);
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
    // One side alone, or the code as it is now, copies as that file's code; inline copies the patch.
    const copyText =
        format === 'diff' && view === 'inline' && !given
            ? source
            : shown
                  .filter(({ row }) => row.kind !== 'hunk' && row.kind !== 'gone')
                  .map(({ row }) => row.text)
                  .join('\n');
    const lineLabel = (row: CodeRow) => (format === 'now' || view !== 'inline' ? row.number : (MARKERS[row.kind] ?? row.number));
    // Read-only text has no caret to move, so the arrow keys, Home and End move the drawn one with `Selection.modify`,
    // and with Shift extend the selection. Keys pressed in a note's fields stay theirs.
    const moveCaret = (event: React.KeyboardEvent<HTMLDivElement>) => {
        const step = selectionStep(event);
        const native = window.getSelection();
        const root = rowsRef.current;
        if (!step || event.target !== event.currentTarget || !native || !root) return;
        event.preventDefault();
        const alter = event.shiftKey ? 'extend' : 'move';
        if (!native.focusNode || !root.contains(native.focusNode)) {
            // The first key in this code puts the caret at its start; with Shift it extends from there.
            const first = root.querySelector(OWN_ROWS);
            if (!first) return;
            native.collapse(document.createTreeWalker(first, NodeFilter.SHOW_TEXT).nextNode() ?? first, 0);
            if (alter === 'extend') native.modify(alter, ...step);
        } else {
            const { anchorNode, anchorOffset, focusNode, focusOffset } = native;
            // Step over the notes between lines, and stay put rather than leave the code past its first or last line.
            for (let tries = 0; tries < 50; tries += 1) {
                native.modify(alter, ...step);
                if (codeOf(root, native.focusNode) || !root.contains(native.focusNode)) break;
            }
            if (!codeOf(root, native.focusNode) && anchorNode && focusNode)
                native.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset);
        }
        if (alter === 'extend') pick();
        drawCaret();
        caretRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    };
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
        const marked = inSelection(row, selection);
        const showWas = was === index;
        lines.push(
            <span key={index} className={`code-line is-${row.kind}${marked ? ' is-selected' : ''}`}>
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
                    <span className="line-number">{lineLabel(row)}</span>
                    {format === 'now' && row.was?.length ? (
                        <button
                            type="button"
                            className="was-toggle"
                            aria-label={`What the change at line ${row.number} replaced`}
                            aria-expanded={showWas}
                            onClick={() => setWas(showWas ? undefined : index)}
                        />
                    ) : null}
                </span>
                <span className="line-text">
                    {row.kind === 'add' && <span className="visually-hidden">Added: </span>}
                    {row.kind === 'remove' && <span className="visually-hidden">Removed: </span>}
                    {row.kind === 'gone' ? (
                        <button
                            type="button"
                            className="gone-toggle"
                            aria-expanded={opened.has(index)}
                            onClick={() =>
                                setOpened((current) => {
                                    const next = new Set(current);
                                    if (!next.delete(index)) next.add(index);
                                    return next;
                                })
                            }
                        >
                            − {row.text}
                        </button>
                    ) : (
                        // Only the code is selectable, so a selection never takes the gutter or the screen-reader words. An
                        // empty line holds a break, as in an editor, so the caret can stop on it.
                        <span className="line-code" {...(row.kind === 'hunk' ? {} : { 'data-row': index })}>
                            {row.text ? rowTokens.map((token, at) => renderToken(token, at, Boolean(onName))) : <br />}
                        </span>
                    )}
                    {showWas && <WasPopover row={row} />}
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
        if (row.kind === 'gone' && opened.has(index))
            row.gone?.forEach((text, at) =>
                lines.push(
                    <span key={`gone-${index}-${at}`} className="code-line is-remove">
                        <span className="code-gutter">
                            <span className="fold-slot" />
                            <span className="line-number">{row.oldNumber === undefined ? '' : row.oldNumber + at}</span>
                        </span>
                        <span className="line-text">
                            <span className="visually-hidden">Removed: </span>
                            <span className="line-code">{text}</span>
                        </span>
                    </span>
                )
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
        <div className={`code-viewer${format === 'now' ? ' is-now' : ''}`}>
            <div className="code-head">
                {title && <span className="code-title">{title}</span>}
                <span className="code-tools">
                    {language && <span className="code-language">{language}</span>}
                    {tools}
                    {format === 'diff' && !given && (
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
            <div
                ref={linesRef}
                className="code-lines"
                role="group"
                aria-label={label}
                {...(onSelect ? { tabIndex: 0, onKeyDown: moveCaret, onFocus: drawCaret, onBlur: drawCaret } : {})}
            >
                {/* Names are a mouse shortcut: the read-through's search box finds any name from the keyboard. */}
                {/* biome-ignore lint/a11y/useKeyWithClickEvents: the click only searches for the name clicked. */}
                <div
                    ref={rowsRef}
                    className="code-rows"
                    onClick={
                        onName
                            ? (event) => {
                                  // A click that ends a drag selected code rather than a name.
                                  if (window.getSelection()?.isCollapsed === false) return;
                                  const name = (event.target as HTMLElement).closest('.code-name')?.textContent;
                                  if (name) onName(name, event.ctrlKey || event.metaKey);
                              }
                            : undefined
                    }
                >
                    {lines}
                    {onSelect && <span ref={caretRef} className="code-caret" aria-hidden="true" />}
                </div>
            </div>
        </div>
    );
}
