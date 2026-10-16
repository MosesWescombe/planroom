import { diffArrays } from 'diff';
import clamp from 'lodash/clamp';
import groupBy from 'lodash/groupBy';
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { describeAnchor } from '../../shared/anchors';
import type { ContextBlock } from '../../shared/questions';
import {
    describePlace,
    HOUSEKEEPING_PAGE,
    HOUSEKEEPING_TITLES,
    housekeepingEntries,
    housekeepingRead,
    type LineSpan,
    type PageAddition,
    type PageRecord,
    type PieceSpec,
    type PieceView,
    pagesOfFile,
    parseRange,
    pieceRead,
    type RelatedCode,
    readProgress,
    repeatOf,
    roundPages,
    tickKey
} from '../../shared/readthrough';
import {
    DEFAULT_PREFERENCES,
    findingsUnlocked,
    hasReadthrough,
    type NoteRecord,
    type RoundRecord,
    roundItems,
    TEST_VIEW_TITLES,
    TEST_VIEWS,
    type TestView
} from '../../shared/review';
import { fetchDiff, fetchExcerpt, fetchSearch, type SearchResult } from '../api';
import { BlockView } from '../blocks/Block';
import { type CodeRow, CodeViewer, type LineSelection, parsePatch } from '../code/CodeViewer';
import { blockLength } from '../code/folding';
import { resolveLanguage } from '../code/highlight';
import { commentOnWhole, openComposer } from '../comments/composer';
import { MAX_QUOTE, place, type SelectionBox } from '../comments/selection';
import { CheckIcon, ChevronIcon, CommentIcon } from '../components/icons';
import { Markdown, plainTitle, TitleMarkdown } from '../components/Markdown';
import { Modal } from '../components/Modal';
import { Rail } from '../components/Rail';
import { AgentNow } from '../components/SidePanel';
import { ThreadDialog, ThreadRow } from '../components/Thread';
import { plural } from '../format';
import { useReducedMotion } from '../hooks';
import { useReadOnly } from '../readOnly';
import { deepEqual, useSelector } from '../store';
import { quietly, useActions, useBusy, useUiState } from '../ui';
import { CommentEditor } from './BitbucketComment';
import { buildTree, commonRoot, compactFolders, type Folder } from './FileTreeSelect';
import { FindingCards, findingsOnRow, underRow } from './Findings';
import { useIsCurrentRound, useShownRound } from './hooks';

/**
 * The read-through: the change line by line, one concept to a page in the agent's reading order, then the test pages,
 * then Housekeeping. Each piece of code shows as it is now or as a diff; the reviewer ticks what they have read, by
 * hand or by auto-tick, selects code to comment on its lines, and asks the agent about the code or the words selected
 * in the page's thread.
 */

/** How long a piece stays on screen before auto-tick ticks it. */
export const AUTO_TICK_MS = 10_000;

/**
 * The rows of a piece from its file's whole diff: the lines in its new-side `lines` or old-side `oldLines`, everything
 * between them, and the lines removed right before or after them, as the server counts what a piece covers.
 */
export function pieceRows(rows: readonly CodeRow[], lines?: LineSpan, oldLines?: LineSpan): CodeRow[] {
    const body = rows.filter((row) => row.kind !== 'hunk');
    const within = (number: number | undefined, span: LineSpan | undefined) =>
        span !== undefined && number !== undefined && number >= span[0] && number <= span[1];
    const hit = (row: CodeRow) =>
        (row.kind !== 'remove' && within(row.number, lines)) || (row.kind !== 'add' && within(row.oldNumber, oldLines));
    let first = body.findIndex(hit);
    if (first === -1) return [];
    let last = body.findLastIndex(hit);
    while (first > 0 && body[first - 1]?.kind === 'remove') first -= 1;
    while (last < body.length - 1 && body[last + 1]?.kind === 'remove') last += 1;
    return body.slice(first, last + 1);
}

/**
 * Diff rows for a block moved from `from` to `to`: the new place's lines, with only what changed on the way marked as
 * changed, and what those lines were in the old place.
 */
export function movedRows(from: readonly string[], fromStart: number, to: readonly string[], toStart: number): CodeRow[] {
    const rows: CodeRow[] = [];
    let [old, next] = [fromStart, toStart];
    for (const part of diffArrays([...from], [...to]))
        for (const text of part.value) {
            if (part.removed) rows.push({ kind: 'remove', text, oldNumber: old++ });
            else if (part.added) rows.push({ kind: 'add', text, number: next++ });
            else rows.push({ kind: 'context', text, number: next++, oldNumber: old++ });
        }
    return rows;
}

/** A file's whole diff in this round as rows, fetched once per file; an error in words when it could not be read. */
function useFileRows(round: number, file: string): { rows?: CodeRow[]; error?: string } {
    const [state, setState] = useState<{ rows?: CodeRow[]; error?: string }>({});
    useEffect(() => {
        let live = true;
        setState({});
        fetchDiff(round, file, true).then(
            (patch) => live && setState({ rows: parsePatch(patch) }),
            (caught: unknown) =>
                live && setState({ error: caught instanceof Error ? caught.message : 'The diff could not be read' })
        );
        return () => {
            live = false;
        };
    }, [round, file]);
    return state;
}

/**
 * Call `onTick` once `ref`'s element has been on screen for `AUTO_TICK_MS` while `active`: at least half of it, or
 * half the screen for one taller than that. Scrolling it away restarts the count.
 */
function useAutoTick(ref: React.RefObject<HTMLElement | null>, active: boolean, onTick: () => void): void {
    const latest = useRef(onTick);
    latest.current = onTick;
    useEffect(() => {
        const element = ref.current;
        if (!active || !element || typeof IntersectionObserver === 'undefined') return undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const observer = new IntersectionObserver(
            (entries) => {
                const entry = entries[entries.length - 1];
                if (!entry) return;
                const screen = entry.rootBounds?.height ?? window.innerHeight;
                const onScreen =
                    entry.isIntersecting &&
                    entry.intersectionRect.height >= 0.5 * Math.min(entry.boundingClientRect.height, screen);
                if (onScreen && !timer) timer = setTimeout(() => latest.current(), AUTO_TICK_MS);
                if (!onScreen && timer) {
                    clearTimeout(timer);
                    timer = undefined;
                }
            },
            // Small steps too, so a piece many screens tall still reports reaching half the screen.
            { threshold: [0, 0.01, 0.02, 0.05, 0.1, 0.15, 0.2, 0.25, 0.5, 0.75, 1] }
        );
        observer.observe(element);
        return () => {
            observer.disconnect();
            clearTimeout(timer);
        };
    }, [ref, active]);
}

/** What the read-through needs to act on a page: the round, whether it takes changes, and the reviewer's settings. */
interface Reading {
    round: RoundRecord;
    editable: boolean;
    autoTick: boolean;
    view: 'auto' | PieceView;
    tests: TestView;
    /** Look up a name clicked in the code: where it is defined, or with `uses` every place it appears. */
    onName: (name: string, uses: boolean) => void;
}

/** The read-through's settings and whether the round on show takes changes. */
function useReading(round: RoundRecord, onName: Reading['onName']): Reading {
    const current = useIsCurrentRound(round);
    const readOnly = useReadOnly();
    const settings = useSelector((view) => view.preferences?.readthrough ?? DEFAULT_PREFERENCES.readthrough, deepEqual);
    return { round, editable: current && !readOnly, onName, ...settings };
}

/**
 * The ticks the reviewer took off by hand on this page load, which auto-tick then leaves alone.
 * ponytail: forgotten on reload, so auto-tick can tick such a piece again; keep the untick in state if that bites.
 */
const untickedByHand = new Set<string>();

/** Whether auto-tick may tick `piece` now: it is on, the round takes changes, and the piece is unticked but not by hand. */
function useAutoTickable(reading: Reading, piece: string): boolean {
    const key = tickKey(reading.round.n, piece);
    const ticked = useSelector((view) => Boolean(view.ticks[key]));
    return reading.autoTick && reading.editable && !ticked && !untickedByHand.has(key);
}

/** Tick `piece` read or not, or a place of it opened, in the current round. */
function useTick() {
    const { send } = useActions();
    return useCallback(
        (piece: string, read: boolean, how: 'manual' | 'auto', place?: number) =>
            quietly(send({ type: 'read.tick', piece, read, how, ...(place !== undefined ? { place } : {}) })),
        [send]
    );
}

/** A piece's Read checkbox. */
function ReadTick({ reading, piece, label }: { reading: Reading; piece: string; label: string }) {
    const ticked = useSelector((view) => Boolean(view.ticks[tickKey(reading.round.n, piece)]));
    const tick = useTick();
    return (
        <label className="toggle-inline read-tick">
            <input
                type="checkbox"
                checked={ticked}
                disabled={!reading.editable}
                aria-label={`${label} read`}
                onChange={(event) => {
                    const key = tickKey(reading.round.n, piece);
                    if (event.target.checked) untickedByHand.delete(key);
                    else untickedByHand.add(key);
                    tick(piece, event.target.checked, 'manual');
                }}
            />
            <span>Read</span>
        </label>
    );
}

/** The mark of something read: a tick in a filled circle. */
function ReadMark() {
    return (
        <span className="state-mark state-answered read-mark" role="img" aria-label="read">
            <CheckIcon size={9} />
        </span>
    );
}

/** A piece's button that folds it down to its header, say once read, or opens it again. */
function FoldButton({ folded, label, onFold }: { folded: boolean; label: string; onFold: (folded: boolean) => void }) {
    return (
        <button
            type="button"
            className="icon-button tiny piece-fold"
            aria-expanded={!folded}
            aria-label={`Collapse ${label}`}
            title={folded ? 'Expand' : 'Collapse'}
            onClick={() => onFold(!folded)}
        >
            <ChevronIcon />
        </button>
    );
}

/** Whether `piece` counts as read in the round: ticked, and any repeat place that differs opened. */
function usePieceRead(reading: Reading, piece: PieceSpec): boolean {
    return useSelector((view) => pieceRead(view, reading.round.index, reading.round.n, piece));
}

/** The reviewer's own comments on `file` whose last line is `row`. */
function notesOnRow(notes: readonly NoteRecord[], file: string, row: CodeRow): NoteRecord[] {
    return notes.filter((note) => note.anchor?.file === file && underRow(note.anchor, row));
}

/** A comment on the selected lines, in the plan page's composer box under them, with "only here" on a repeat's example. */
function NoteForm({
    selection,
    at,
    repeat,
    onSave,
    onCancel
}: {
    selection: LineSelection;
    at: SelectionBox;
    repeat: boolean;
    onSave: (text: string, onlyHere: boolean) => Promise<unknown>;
    onCancel: () => void;
}) {
    const [text, setText] = useState('');
    const [onlyHere, setOnlyHere] = useState(false);
    const [busy, track] = useBusy();
    const box = useRef<HTMLDivElement>(null);
    // Focus moves into the box as it opens, as it does into the plan page's composer.
    useEffect(() => box.current?.querySelector<HTMLElement>('[role="textbox"]')?.focus(), []);
    const lines = selection.start === selection.end ? `line ${selection.start}` : `lines ${selection.start}-${selection.end}`;
    return (
        <div
            ref={box}
            className="composer"
            role="dialog"
            aria-label={`Comment on ${lines}`}
            style={place(at, 360, true)}
            onKeyDown={(event) => event.key === 'Escape' && onCancel()}
        >
            <form
                className="reaction-form"
                onSubmit={(event) => {
                    event.preventDefault();
                    if (text.trim()) quietly(track(onSave(text, onlyHere)));
                }}
            >
                <CommentEditor
                    id={`note-${selection.start}`}
                    label={`Your comment on ${lines}`}
                    value={text}
                    signed={false}
                    onChange={setText}
                />
                {repeat && (
                    <label className="toggle-inline">
                        <input type="checkbox" checked={onlyHere} onChange={(event) => setOnlyHere(event.target.checked)} />
                        <span>Only here, not every place of the repeat</span>
                    </label>
                )}
                <div className="row">
                    <button type="submit" className="button-primary button-small" disabled={busy || !text.trim()}>
                        Add comment
                    </button>
                    <button type="button" className="button-text" onClick={onCancel}>
                        Cancel
                    </button>
                </div>
            </form>
        </div>
    );
}

/**
 * What can be done with selected code, in the plan page's toolbar over the selection: comment on its whole lines, or
 * ask the agent about exactly what is selected.
 */
function SelectionBar({
    selection,
    at,
    onComment,
    onAsk
}: {
    selection: LineSelection;
    at: SelectionBox;
    onComment: () => void;
    onAsk: () => void;
}) {
    const lines = selection.start === selection.end ? `Line ${selection.start}` : `Lines ${selection.start}-${selection.end}`;
    // Keep the selection: a mousedown on a button would otherwise clear it.
    const keep = (event: React.MouseEvent) => event.preventDefault();
    return (
        <div className="selection-toolbar" role="toolbar" aria-label={`${lines} selected`} style={place(at, 220, false)}>
            <button type="button" className="is-first" onMouseDown={keep} onClick={onComment}>
                <CommentIcon size={13} />
                Comment
            </button>
            <button type="button" onMouseDown={keep} onClick={onAsk}>
                Ask the agent
            </button>
        </div>
    );
}

/** One of the reviewer's comments, under the line it is on. */
function NoteCard({ note }: { note: NoteRecord }) {
    return (
        <div className="piece-note">
            <span className="small strong">Your comment{note.repeat && !note.repeat.onlyHere ? ', on every place' : ''}</span>
            <div className="prose">
                <Markdown source={note.text} />
            </div>
        </div>
    );
}

/**
 * A question to the agent about some lines, folded to a row under the last of them: the ask and where it stands, an
 * agent reply marked new until opened. Clicking it opens the thread over the page, to read the answer and reply.
 */
function LineThread({ id }: { id: string }) {
    const [open, setOpen] = useState(false);
    const title = useSelector((view) => {
        const anchor = view.threads[id]?.anchor;
        return `Question on ${anchor ? describeAnchor(anchor) : 'these lines'}`;
    });
    return (
        <div className="line-thread">
            <ThreadRow id={id} onOpen={() => setOpen(true)} />
            {open && <ThreadDialog id={id} title={title} onClose={() => setOpen(false)} />}
        </div>
    );
}

/**
 * A piece's code from its file's diff, as it is now or as a diff, with the findings and the reviewer's comments under
 * their lines once the findings may show, and the questions asked about its lines under them. Selecting code picks the
 * lines it touches: a comment is on those whole lines, a question on just the code selected. Clicking a name searches
 * for it.
 */
function PieceCode({
    reading,
    page,
    piece,
    file,
    lines,
    oldLines,
    view,
    rows: given,
    onCommented
}: {
    reading: Reading;
    page: string;
    piece?: PieceSpec;
    file: string;
    lines?: LineSpan;
    oldLines?: LineSpan;
    view: PieceView;
    /** Rows to show instead of the file's diff, for a moved block. */
    rows?: CodeRow[];
    onCommented?: () => void;
}) {
    const { round } = reading;
    const fetched = useFileRows(round.n, file);
    const rows = useMemo(
        () => given ?? (fetched.rows ? pieceRows(fetched.rows, lines, oldLines) : undefined),
        [given, fetched.rows, lines, oldLines]
    );
    const items = useSelector((view) => (findingsUnlocked(round) ? roundItems(view, round.n) : []), deepEqual);
    const notes = useSelector((view) => Object.values(view.notes).filter((note) => note.round === round.n), deepEqual);
    const asked = useSelector(
        (view) =>
            Object.values(view.threads).flatMap(({ id, anchor }) =>
                anchor?.target === `page:${page}` && anchor.lines?.file === file ? [{ id, ...anchor.lines }] : []
            ),
        deepEqual
    );
    const { send } = useActions();
    const [picked, setPicked] = useState<{ selection: LineSelection; at: SelectionBox }>();
    const selection = picked?.selection;
    const [writing, setWriting] = useState(false);
    // As on the plan page, the toolbar over selected code goes once the selection does.
    useEffect(() => {
        if (!picked || writing) return undefined;
        const drop = () => {
            if (window.getSelection()?.isCollapsed !== false) setPicked(undefined);
        };
        document.addEventListener('selectionchange', drop);
        return () => document.removeEventListener('selectionchange', drop);
    }, [picked, writing]);
    const repeat = piece?.repeat;
    if (fetched.error && !given) return <p className="block-note">{fetched.error}</p>;
    if (!rows) return <p className="block-note">Reading {file}…</p>;
    if (rows.length === 0) return <p className="block-note">No lines of {file} here: a rename or a binary file.</p>;
    const anchor = selection && {
        file,
        side: selection.side,
        start: selection.start,
        ...(selection.end !== selection.start ? { end: selection.end } : {})
    };
    const save = (text: string, onlyHere: boolean) =>
        send({
            type: 'note.save',
            anchor: anchor!,
            text,
            page,
            ...(repeat ? { repeat: { key: repeat, onlyHere } } : {})
        }).then(() => {
            setWriting(false);
            setPicked(undefined);
            onCommented?.();
        });
    const ask = () => {
        if (!picked) return;
        const { text, ...span } = picked.selection;
        openComposer({
            anchor: { target: `page:${page}`, lines: { file, ...span, ...(text ? { text: text.slice(0, MAX_QUOTE) } : {}) } },
            intent: 'question',
            at: picked.at
        });
        setPicked(undefined);
        onCommented?.();
    };
    return (
        <>
            <CodeViewer
                rows={rows}
                format={view === 'now' ? 'now' : 'diff'}
                language={resolveLanguage('', undefined, file)}
                label={`${file}${lines ? ` lines ${lines[0]} to ${lines[1]}` : ''}`}
                {...(selection ? { selection } : {})}
                {...(reading.editable
                    ? {
                          onSelect: (lines: LineSelection, at: SelectionBox) => {
                              setPicked({ selection: lines, at });
                              setWriting(false);
                          }
                      }
                    : {})}
                onName={reading.onName}
                notes={(row) => {
                    const findings = findingsOnRow(items, file, row);
                    const own = notesOnRow(notes, file, row);
                    const questions = asked.filter((thread) => underRow(thread, row));
                    if (!findings.length && !own.length && !questions.length) return null;
                    return (
                        <>
                            {findings.length > 0 && <FindingCards items={findings} inPlace />}
                            {own.map((note) => (
                                <NoteCard key={note.id} note={note} />
                            ))}
                            {questions.map((thread) => (
                                <LineThread key={thread.id} id={thread.id} />
                            ))}
                        </>
                    );
                }}
            />
            {picked &&
                (writing ? (
                    <NoteForm
                        selection={picked.selection}
                        at={picked.at}
                        repeat={Boolean(repeat)}
                        onSave={save}
                        onCancel={() => {
                            setWriting(false);
                            setPicked(undefined);
                        }}
                    />
                ) : (
                    <SelectionBar selection={picked.selection} at={picked.at} onComment={() => setWriting(true)} onAsk={ask} />
                ))}
        </>
    );
}

/** The as-it-is-now and as-a-diff switch on one piece. */
function ViewSwitch({ view, onChange, label }: { view: PieceView; onChange: (view: PieceView) => void; label: string }) {
    return (
        <span role="tablist" aria-label={`How ${label} shows`} className="segmented">
            {(
                [
                    ['now', 'As it is now'],
                    ['diff', 'As a diff']
                ] as const
            ).map(([id, name]) => (
                <button key={id} type="button" role="tab" aria-selected={view === id} onClick={() => onChange(id)}>
                    {name}
                </button>
            ))}
        </span>
    );
}

/** A moved block: the code at its new place, only what changed on the way marked, from where to where. */
function MovedCode({
    reading,
    page,
    piece,
    view
}: {
    reading: Reading;
    page: string;
    piece: PieceSpec & { from: NonNullable<PieceSpec['from']> };
    view: PieceView;
}) {
    const fromSpan = parseRange(piece.from.oldLines);
    const toSpan = piece.lines ? parseRange(piece.lines) : undefined;
    const before = useFileRows(reading.round.n, piece.from.file);
    const after = useFileRows(reading.round.n, piece.file);
    const rows = useMemo(() => {
        if (!before.rows || !after.rows || !toSpan) return undefined;
        const old = before.rows.filter(
            (row) =>
                row.kind !== 'add' &&
                row.kind !== 'hunk' &&
                row.oldNumber !== undefined &&
                row.oldNumber >= fromSpan[0] &&
                row.oldNumber <= fromSpan[1]
        );
        const fresh = after.rows.filter(
            (row) =>
                row.kind !== 'remove' &&
                row.kind !== 'hunk' &&
                row.number !== undefined &&
                row.number >= toSpan[0] &&
                row.number <= toSpan[1]
        );
        return movedRows(
            old.map((row) => row.text),
            fromSpan[0],
            fresh.map((row) => row.text),
            toSpan[0]
        );
    }, [before.rows, after.rows, fromSpan[0], fromSpan[1], toSpan?.[0], toSpan?.[1]]);
    return (
        <>
            <p className="small moved-from">
                Moved from <code>{describePlace({ file: piece.from.file, old: fromSpan })}</code> to{' '}
                <code>{describePlace({ file: piece.file, ...(toSpan ? { new: toSpan } : {}) })}</code>; only what changed on the
                way is marked.
            </p>
            {rows ? (
                <PieceCode reading={reading} page={page} piece={piece} file={piece.file} view={view} rows={rows} />
            ) : (
                <p className="block-note">{before.error ?? after.error ?? `Reading ${piece.file}…`}</p>
            )}
        </>
    );
}

/** The other places of a repeat, one line each; a place that differs is flagged and opened to count as read. */
function RepeatPlaces({ reading, page, piece }: { reading: Reading; page: string; piece: PieceSpec }) {
    const index = reading.round.index;
    const repeat = repeatOf(index, piece);
    const opened = useSelector(
        (view) => (repeat?.group.places ?? []).map((_, at) => Boolean(view.ticks[tickKey(reading.round.n, piece.id, at)])),
        deepEqual
    );
    const tick = useTick();
    const [shown, setShown] = useState<ReadonlySet<number>>(() => new Set());
    if (!repeat) return null;
    const open = (at: number) => {
        setShown((current) => new Set(current).add(at));
        if (repeat.group.places[at]?.differs && !opened[at] && reading.editable) tick(piece.id, true, 'manual', at);
    };
    return (
        <div className="repeat-places">
            <p className="small">
                The same edit, {repeat.group.change}, in {plural(repeat.group.places.length, 'place')}. The others:
            </p>
            <ul>
                {repeat.group.places.map((place, at) =>
                    at === repeat.example ? null : (
                        <li key={at} className={place.differs ? 'is-differs' : undefined}>
                            <code>{describePlace(place)}</code>
                            {place.differs ? (
                                <span className="chip chip-attention">Differs: {place.differs}</span>
                            ) : (
                                <span className="small muted">identical</span>
                            )}
                            {opened[at] && <CheckIcon size={12} />}
                            {!shown.has(at) && (
                                <button type="button" className="button-link small" onClick={() => open(at)}>
                                    Open
                                </button>
                            )}
                            {shown.has(at) && (
                                <PieceCode
                                    reading={reading}
                                    page={page}
                                    file={place.file}
                                    {...(place.new ? { lines: place.new } : {})}
                                    {...(place.old && !place.new ? { oldLines: place.old } : {})}
                                    view="diff"
                                />
                            )}
                        </li>
                    )
                )}
            </ul>
        </div>
    );
}

/** Lines of a tracked file, fetched the first time `open` is true; an error in words when they could not be read. */
function useExcerpt(file: string, lines: string, open: boolean): { lines?: string[]; start?: number; error?: string } {
    const [state, setState] = useState<{ lines?: string[]; start?: number; error?: string }>({});
    useEffect(() => {
        if (!open || state.lines || state.error) return;
        fetchExcerpt(file, lines).then(
            (excerpt) => setState({ lines: excerpt.lines, start: excerpt.start }),
            (caught: unknown) => setState({ error: caught instanceof Error ? caught.message : 'It could not be read' })
        );
    }, [open, file, lines, state.lines, state.error]);
    return state;
}

/** Code a piece reaches, folded until opened. */
function Related({ code }: { code: RelatedCode }) {
    const [open, setOpen] = useState(false);
    const state = useExcerpt(code.file, code.lines, open);
    return (
        <details className="related" onToggle={(event) => setOpen(event.currentTarget.open)}>
            <summary>
                <code>
                    {code.file}:{code.lines}
                </code>
                {code.note && <span className="small muted"> {code.note}</span>}
            </summary>
            {state.error && <p className="block-note">{state.error}</p>}
            {state.lines && (
                <CodeViewer
                    source={state.lines.join('\n')}
                    {...(state.start !== undefined ? { start: state.start } : {})}
                    language={resolveLanguage('', undefined, code.file)}
                    label={`${code.file} lines ${code.lines}`}
                />
            )}
        </details>
    );
}

/** What the agent added because the reviewer asked, marked as such, its words selectable to ask about. */
function Additions({ page, additions }: { page: string; additions: PageAddition[] }) {
    if (!additions.length) return null;
    return (
        <>
            {additions.map((addition, at) => (
                <aside key={at} className="page-addition" aria-label="Added at your request">
                    <span className="chip">Added at your request</span>
                    {addition.text && (
                        <div className="prose" data-anchor-target={`page:${page}`}>
                            <Markdown source={addition.text} />
                        </div>
                    )}
                    {addition.blocks?.map((block, index) => (
                        <BlockView
                            key={index}
                            block={{ ...block, id: `${addition.thread}-added-${at}-${index}` }}
                            placement="question"
                        />
                    ))}
                </aside>
            ))}
        </>
    );
}

/** A `vscode://` link that opens `file`, under the folder `dir`, in VS Code at `line`. */
export function editorLink(dir: string, file: string, line: number): string {
    const path = `${dir.replace(/\\/g, '/')}/${file}`.replace(/^\/?/, '/');
    return `vscode://file${encodeURI(path).replace(/[?#]/g, encodeURIComponent)}:${line}:1`;
}

/**
 * Opens a piece's file from the review's worktree in VS Code at the piece's first line. Only while the worktree holds
 * the round on show, the current one of a live review, and only for a piece with lines in the new code.
 */
function OpenInEditor({ reading, file, lines }: { reading: Reading; file: string; lines?: string }) {
    const dir = useSelector((view) => view.worktreeDir);
    if (!dir || !lines || !reading.editable) return null;
    return (
        <a
            className="button-link small"
            href={editorLink(dir, file, parseRange(lines)[0])}
            aria-label={`Open in VS Code: ${file}`}
        >
            Open in VS Code
        </a>
    );
}

/** The view a piece starts in: the reviewer's fixed setting, else the agent's pick, else as it is now. */
function startingView(reading: Reading, piece: PieceSpec): PieceView {
    if (!piece.lines) return 'diff';
    return reading.view === 'auto' ? (piece.view ?? 'now') : reading.view;
}

/** Where a piece is, in words. */
function pieceWhere(piece: PieceSpec): string {
    if (piece.lines) return `${piece.file}:${piece.lines}`;
    return `${piece.file} (removed):${piece.oldLines}`;
}

/**
 * One piece of a concept page: what it is for, its words selectable to ask about, and any blocks that explain it, then
 * its code, the repeat's other places, the code it reaches, additions.
 */
const PieceCard = memo(function PieceCard({
    reading,
    page,
    piece,
    note,
    blocks,
    related,
    additions
}: {
    reading: Reading;
    page: string;
    piece: PieceSpec;
    note?: string;
    blocks?: ContextBlock[];
    related?: RelatedCode[];
    additions: PageAddition[];
}) {
    const ref = useRef<HTMLElement>(null);
    const [override, setOverride] = useState<PieceView>();
    const [folded, setFolded] = useState(false);
    const tickable = useAutoTickable(reading, piece.id);
    const tick = useTick();
    const autoTick = () => {
        if (tickable) tick(piece.id, true, 'auto');
    };
    // A folded piece shows no code, so its header on screen reads nothing.
    useAutoTick(ref, tickable && !folded, autoTick);
    const read = usePieceRead(reading, piece);
    const view = override ?? startingView(reading, piece);
    const where = pieceWhere(piece);
    return (
        <article ref={ref} id={`piece-${piece.id}`} className={`piece${read ? ' is-read' : ''}`} aria-label={where}>
            <header className="piece-head">
                <span className="piece-name">
                    <FoldButton folded={folded} label={where} onFold={setFolded} />
                    {read && <ReadMark />}
                    <code className="piece-where truncate" title={where}>
                        {where}
                    </code>
                </span>
                {piece.repeat && <span className="chip">Repeated edit</span>}
                {piece.from && <span className="chip">Moved</span>}
                <span className="grow" />
                <OpenInEditor reading={reading} file={piece.file} {...(piece.lines ? { lines: piece.lines } : {})} />
                {piece.lines && <ViewSwitch view={view} onChange={setOverride} label={where} />}
                <ReadTick reading={reading} piece={piece.id} label={where} />
            </header>
            <div className="piece-body" hidden={folded}>
                {note && (
                    <div className="prose piece-note-text" data-anchor-target={`page:${page}`}>
                        <Markdown source={note} />
                    </div>
                )}
                {blocks?.map((block, index) => (
                    <BlockView key={index} block={{ ...block, id: `${piece.id}-block-${index}` }} placement="question" />
                ))}
                {piece.from ? (
                    <MovedCode reading={reading} page={page} piece={{ ...piece, from: piece.from }} view={view} />
                ) : (
                    <PieceCode
                        reading={reading}
                        page={page}
                        piece={piece}
                        file={piece.file}
                        {...(piece.lines ? { lines: parseRange(piece.lines) } : {})}
                        {...(piece.oldLines ? { oldLines: parseRange(piece.oldLines) } : {})}
                        view={view}
                        onCommented={autoTick}
                    />
                )}
                {piece.repeat && <RepeatPlaces reading={reading} page={page} piece={piece} />}
                {related?.map((code, at) => (
                    <Related key={at} code={code} />
                ))}
                <Additions page={page} additions={additions} />
            </div>
        </article>
    );
});

/**
 * One test case: its title, pseudo code or real code, switchable, and its Read tick, which counts in any view. Its
 * pseudo code is selectable to ask about.
 */
function TestCard({
    reading,
    page,
    piece,
    title,
    pseudo
}: {
    reading: Reading;
    page: string;
    piece: PieceSpec;
    title: string;
    pseudo?: string;
}) {
    const ref = useRef<HTMLElement>(null);
    const [override, setOverride] = useState<TestView>();
    const [folded, setFolded] = useState(false);
    const tickable = useAutoTickable(reading, piece.id);
    const tick = useTick();
    useAutoTick(ref, tickable && !folded, () => tick(piece.id, true, 'auto'));
    const read = usePieceRead(reading, piece);
    const view = override ?? (reading.tests === 'pseudo' && !pseudo ? 'code' : reading.tests);
    return (
        <article
            ref={ref}
            id={`piece-${piece.id}`}
            className={`piece test-case${read ? ' is-read' : ''}`}
            aria-label={plainTitle(title)}
        >
            <header className="piece-head">
                <span className="piece-name strong">
                    <FoldButton folded={folded} label={plainTitle(title)} onFold={setFolded} />
                    {read && <ReadMark />}
                    <span className="truncate" title={plainTitle(title)}>
                        <TitleMarkdown source={title} />
                    </span>
                </span>
                <span className="grow" />
                <OpenInEditor reading={reading} file={piece.file} {...(piece.lines ? { lines: piece.lines } : {})} />
                <span role="tablist" aria-label={`How ${plainTitle(title)} shows`} className="segmented">
                    {TEST_VIEWS.map((id) => (
                        <button
                            key={id}
                            type="button"
                            role="tab"
                            aria-selected={view === id}
                            disabled={id === 'pseudo' && !pseudo}
                            onClick={() => setOverride(id)}
                        >
                            {TEST_VIEW_TITLES[id]}
                        </button>
                    ))}
                </span>
                <ReadTick reading={reading} piece={piece.id} label={plainTitle(title)} />
            </header>
            <div className="piece-body" hidden={folded}>
                {view === 'pseudo' && pseudo && (
                    <pre
                        className="pseudo-code"
                        aria-label={`Pseudo code of ${plainTitle(title)}`}
                        data-anchor-target={`page:${page}`}
                    >
                        {pseudo}
                    </pre>
                )}
                {view === 'code' && (
                    <PieceCode
                        reading={reading}
                        page={page}
                        piece={piece}
                        file={piece.file}
                        {...(piece.lines ? { lines: parseRange(piece.lines) } : {})}
                        {...(piece.oldLines ? { oldLines: parseRange(piece.oldLines) } : {})}
                        view={piece.lines ? 'now' : 'diff'}
                    />
                )}
            </div>
        </article>
    );
}

/** The page's threads with the agent, and the way to ask about the whole page. */
function PageThreads({ page, editable }: { page: PageRecord; editable: boolean }) {
    const threads = useSelector(
        (view) =>
            Object.values(view.threads)
                .filter((thread) => thread.anchor?.target === `page:${page.id}`)
                .map(({ id, anchor }) => ({
                    id,
                    heading: anchor?.lines || anchor?.quote ? describeAnchor(anchor) : undefined
                })),
        deepEqual
    );
    const [open, setOpen] = useState<string>();
    return (
        <section className="page-threads" aria-label="Questions on this page">
            <h2 className="eyebrow">Questions on this page</h2>
            {threads.length === 0 && (
                <p className="small muted">Select code or words and ask the agent, or ask about the whole page.</p>
            )}
            {threads.map((thread) => (
                <ThreadRow
                    key={thread.id}
                    id={thread.id}
                    {...(thread.heading ? { heading: thread.heading } : {})}
                    onOpen={() => setOpen(thread.id)}
                />
            ))}
            {open && (
                <ThreadDialog id={open} title={`Question on ${plainTitle(page.title)}`} onClose={() => setOpen(undefined)} />
            )}
            {editable && (
                <button type="button" className="button-link small" onClick={() => commentOnWhole(`page:${page.id}`, 'question')}>
                    Ask the agent about this page
                </button>
            )}
        </section>
    );
}

/** One page: its title, then its words and pieces once written, or that it is coming; then its threads. */
function PageView({ reading, page, number, total }: { reading: Reading; page: PageRecord; number: number; total: number }) {
    const tick = useTick();
    const unread = useSelector(
        (view) => page.pieces.filter((piece) => !view.ticks[tickKey(reading.round.n, piece.id)]).map((piece) => piece.id),
        deepEqual
    );
    const read = useSelector((view) =>
        page.pieces.every((piece) => pieceRead(view, reading.round.index, reading.round.n, piece))
    );
    const { content } = page;
    const notes = new Map(content?.pieces.map((piece) => [piece.id, piece]) ?? []);
    const tests = new Map(content?.tests?.map((test) => [test.piece, test]) ?? []);
    const added = (piece?: string) => page.added.filter((addition) => addition.piece === piece);
    return (
        <section className="read-page" aria-labelledby={`page-title-${page.id}`}>
            <header className="page-head">
                <div className="eyebrow">
                    {page.kind === 'tests' ? 'Tests' : (page.group ?? 'Concept')}
                    <span className="mono">
                        {' '}
                        · page {number} of {total}
                    </span>
                </div>
                <h1 id={`page-title-${page.id}`}>
                    <span data-anchor-target={`page:${page.id}`}>
                        <TitleMarkdown source={page.title} />
                    </span>
                </h1>
                {content && read && (
                    <span className="page-read small strong">
                        <ReadMark /> Page read
                    </span>
                )}
                {content && !read && reading.editable && unread.length > 0 && (
                    <button
                        type="button"
                        className="button-secondary button-small page-read-button"
                        onClick={() => {
                            for (const piece of unread) tick(piece, true, 'manual');
                        }}
                    >
                        Mark the page read
                    </button>
                )}
            </header>
            {!content ? (
                <div className="page-coming">
                    <div className="loading-bar" role="progressbar" aria-label="Writing this page" />
                    <p className="muted">This page is coming: the agent is writing it. Read the pages before it meanwhile.</p>
                </div>
            ) : (
                <>
                    <div className="prose page-summary" data-anchor-target={`page:${page.id}`}>
                        <Markdown source={content.summary} />
                    </div>
                    {content.blocks?.map((block, index) => (
                        <BlockView key={index} block={{ ...block, id: `${page.id}-block-${index}` }} placement="question" />
                    ))}
                    {page.kind === 'tests'
                        ? page.pieces.map((piece) => {
                              const test = tests.get(piece.id);
                              return (
                                  <TestCard
                                      key={piece.id}
                                      reading={reading}
                                      page={page.id}
                                      piece={piece}
                                      title={test?.title ?? piece.title ?? piece.id}
                                      {...(test?.pseudo ? { pseudo: test.pseudo } : {})}
                                  />
                              );
                          })
                        : page.pieces.map((piece) => {
                              const words = notes.get(piece.id);
                              return (
                                  <PieceCard
                                      key={piece.id}
                                      reading={reading}
                                      page={page.id}
                                      piece={piece}
                                      {...(words?.note ? { note: words.note } : {})}
                                      {...(words?.blocks ? { blocks: words.blocks } : {})}
                                      {...(words?.related ? { related: words.related } : {})}
                                      additions={added(piece.id)}
                                  />
                              );
                          })}
                    <Additions page={page.id} additions={added(undefined)} />
                </>
            )}
            <PageThreads page={page} editable={reading.editable} />
        </section>
    );
}

/** The Housekeeping page: what needs no line-by-line read, by file. Opening it reads all of it. */
function Housekeeping({ reading }: { reading: Reading }) {
    const index = reading.round.index;
    const entries = index ? housekeepingEntries(index) : [];
    const opened = useSelector((view) => housekeepingRead(view, reading.round.n));
    const tick = useTick();
    useEffect(() => {
        if (!opened && reading.editable) tick(HOUSEKEEPING_PAGE, true, 'auto');
    }, [opened, reading.editable, tick]);
    return (
        <section className="read-page" aria-labelledby="page-title-housekeeping">
            <header className="page-head">
                <div className="eyebrow">Housekeeping</div>
                <h1 id="page-title-housekeeping">What needs no line-by-line read</h1>
                <p className="lede">
                    Lock files, generated and binary files, and changes to spacing only. Opening this page counts them as read.
                </p>
            </header>
            <ul className="housekeeping">
                {entries.map((entry) => (
                    <li key={entry.file}>
                        <code>{entry.file}</code> <span className="chip">{HOUSEKEEPING_TITLES[entry.why]}</span>
                        {entry.spans.length > 0 && (
                            <span className="small muted">
                                {' '}
                                {entry.spans
                                    .map(
                                        ({ side, span }) =>
                                            `${side === 'old' ? 'removed ' : ''}${span[0] === span[1] ? span[0] : `${span[0]}-${span[1]}`}`
                                    )
                                    .join(', ')}
                            </span>
                        )}
                    </li>
                ))}
            </ul>
        </section>
    );
}

type SearchMatch = SearchResult['matches'][number];

/** Where a search matched and its line of code. */
function MatchLine({ match }: { match: SearchMatch }) {
    return (
        <>
            <code className="search-where">
                {match.file}:{match.line}
            </code>
            <code className="search-text">{match.text.trim()}</code>
        </>
    );
}

/** A whole-word match a search found, as a code block of its one line under its file. */
function Use({ match }: { match: SearchMatch }) {
    return (
        <CodeViewer
            source={match.text.trim()}
            start={match.line}
            language={resolveLanguage('', undefined, match.file)}
            title={match.file}
            label={`${match.file} line ${match.line}`}
        />
    );
}

/** The most lines a declaration shows: as many as one excerpt holds. */
const DECLARATION_LINES = 400;

/** A declaration a search found, opening to its code from the declaring line to the end of its block by indentation. */
function Declaration({ match }: { match: SearchMatch }) {
    const [open, setOpen] = useState(false);
    const state = useExcerpt(match.file, `${match.line}-${match.line + DECLARATION_LINES - 1}`, open);
    return (
        <details className="related" onToggle={(event) => setOpen(event.currentTarget.open)}>
            <summary>
                <MatchLine match={match} />
            </summary>
            {state.error && <p className="block-note">{state.error}</p>}
            {state.lines && (
                <CodeViewer
                    source={state.lines.slice(0, blockLength(state.lines)).join('\n')}
                    start={match.line}
                    language={resolveLanguage('', undefined, match.file)}
                    label={`${match.file} from line ${match.line}`}
                />
            )}
        </details>
    );
}

/**
 * The search for a name in the reviewed commit, each match with its line of code: the lines that declare it, each
 * opening to its code, or with `uses` every whole-word match. A button switches between the two.
 */
function SearchDialog({
    round,
    name,
    uses: usesFirst,
    onClose
}: {
    round: number;
    name: string;
    uses: boolean;
    onClose: () => void;
}) {
    const [uses, setUses] = useState(usesFirst);
    const [result, setResult] = useState<SearchResult>();
    const [error, setError] = useState<string>();
    useEffect(() => {
        let live = true;
        setResult(undefined);
        setError(undefined);
        fetchSearch(round, name, !uses).then(
            (found) => live && setResult(found),
            (caught: unknown) => live && setError(caught instanceof Error ? caught.message : 'The search failed')
        );
        return () => {
            live = false;
        };
    }, [round, name, uses]);
    const where = uses ? 'appears' : 'is defined';
    return (
        <Modal label={`Where ${name} ${where}`} onClose={onClose} className="dialog dialog-wide">
            <h2 className="dialog-title">
                Where <code>{name}</code> {where}
            </h2>
            <p className="small muted">
                {uses
                    ? 'A text search for the whole word in the files of the reviewed commit, not a go-to-definition.'
                    : 'The lines of the reviewed commit that read as declaring the name, matched by their shape rather than by a compiler. Ctrl-click a name to list every use.'}{' '}
                <button type="button" className="button-text" onClick={() => setUses(!uses)}>
                    {uses ? 'Show the definition' : 'Show every use'}
                </button>
            </p>
            {error && <p className="block-note">{error}</p>}
            {!result && !error && <p className="block-note">Searching…</p>}
            {result && (
                <>
                    <p className="small" role="status">
                        {result.truncated
                            ? `The first ${result.matches.length} matches; there are more, so the list was cut short.`
                            : plural(result.matches.length, uses ? 'match' : 'declaration', uses ? 'matches' : 'declarations')}
                    </p>
                    <ol className={uses ? 'search-matches search-uses' : 'search-matches'}>
                        {result.matches.map((match, at) => (
                            <li key={at}>{uses ? <Use match={match} /> : <Declaration match={match} />}</li>
                        ))}
                    </ol>
                </>
            )}
        </Modal>
    );
}

/** The rows a rail title slides in while hovered or focused; a title in none slides while it is hovered itself. */
const RAIL_ROW = '.nav-item, .rail-file, .rail-folder > summary';
/** How long a rail title waits once its row is hovered, then takes to slide from its start to its end. */
const SLIDE_DELAY_MS = 300;
const SLIDE_MS = 4000;

/**
 * A rail title kept to one line and cut with an ellipsis. While its row is hovered or focused the cut lifts and the
 * title slides sideways to show the rest, unless the reader asks for reduced motion; it scrolls by hand too, and a
 * sideways wheel, trackpad or touch scroll stops the slide where it is.
 */
function RailTitle({ className, children }: { className: string; children: ReactNode }) {
    const ref = useRef<HTMLSpanElement>(null);
    const still = useReducedMotion();
    useEffect(() => {
        const title = ref.current;
        const row = title?.closest<HTMLElement>(RAIL_ROW) ?? title;
        if (!title || !row) return undefined;
        let timer = 0;
        let frame = 0;
        const stop = () => {
            window.clearTimeout(timer);
            window.cancelAnimationFrame(frame);
        };
        // Slides on from wherever the title is at the full-length pace; the browser clamps the end, and the scroll
        // falls back to the start once the row is left and the cut returns.
        const slide = () => {
            stop();
            if (still) return;
            timer = window.setTimeout(() => {
                const from = { left: title.scrollLeft, at: performance.now() };
                const step = (now: number) => {
                    const end = title.scrollWidth - title.clientWidth;
                    const left = from.left + ((now - from.at) / SLIDE_MS) * end;
                    title.scrollLeft = left;
                    if (left < end) frame = window.requestAnimationFrame(step);
                };
                frame = window.requestAnimationFrame(step);
            }, SLIDE_DELAY_MS);
        };
        const byHand = (event: WheelEvent) => {
            if (event.deltaX || event.shiftKey) stop();
        };
        row.addEventListener('pointerenter', slide);
        row.addEventListener('focusin', slide);
        row.addEventListener('pointerleave', stop);
        row.addEventListener('focusout', stop);
        title.addEventListener('wheel', byHand, { passive: true });
        title.addEventListener('touchstart', stop, { passive: true });
        return () => {
            stop();
            row.removeEventListener('pointerenter', slide);
            row.removeEventListener('focusin', slide);
            row.removeEventListener('pointerleave', stop);
            row.removeEventListener('focusout', stop);
            title.removeEventListener('wheel', byHand);
            title.removeEventListener('touchstart', stop);
        };
    }, [still]);
    return (
        <span ref={ref} className={`${className} rail-title`}>
            <span className="rail-title-text">{children}</span>
        </span>
    );
}

/** The page a file is on: its number in the read-through, its id, its title and whether it is all read. */
interface FilePage {
    number: number;
    id: string;
    title: string;
    read: boolean;
}

/** A folder of changed files in the rail, its folders folding, each file with the numbers of the pages it is on. */
function FileFolder({
    folder,
    pagesOf,
    current,
    onPick
}: {
    folder: Folder;
    pagesOf: ReadonlyMap<string, FilePage[]>;
    current: string;
    onPick: (page: string) => void;
}) {
    return (
        <ul className="rail-files">
            {folder.folders.map(compactFolders).map((child) => (
                <li key={child.name}>
                    <details open className="rail-folder">
                        <summary title={child.name}>
                            <ChevronIcon />
                            <RailTitle className="rail-folder-name">{child.name}</RailTitle>
                        </summary>
                        <FileFolder folder={child} pagesOf={pagesOf} current={current} onPick={onPick} />
                    </details>
                </li>
            ))}
            {folder.files.map((file) => {
                const pages = pagesOf.get(file.path) ?? [];
                return (
                    <li key={file.path} className="rail-file" title={file.path}>
                        <RailTitle className={`rail-file-name${pages.length ? '' : ' muted'}`}>{file.name}</RailTitle>
                        {pages.map((page) => (
                            <button
                                key={page.id}
                                type="button"
                                className={`page-number${page.read ? ' is-read' : ''}`}
                                aria-current={page.id === current ? 'step' : undefined}
                                aria-label={`Page ${page.number}: ${page.title}${page.read ? ', read' : ''}`}
                                title={page.title}
                                onClick={() => onPick(page.id)}
                            >
                                {page.number}
                            </button>
                        ))}
                        {pages.length === 0 && (
                            <span className="small muted" title="On no page: no lines changed">
                                none
                            </span>
                        )}
                    </li>
                );
            })}
        </ul>
    );
}

/** The round's pages in order, each with its rail heading and how many of its pieces are read. */
function useRailPages(round: RoundRecord) {
    return useSelector((view) => {
        const progress = readProgress(view, round.index, round.n);
        return roundPages(view, round.n).map((page) => {
            const { read, total } = progress.pages[page.id] ?? { read: 0, total: page.pieces.length };
            return {
                id: page.id,
                kind: page.kind,
                heading: page.kind === 'tests' ? 'TESTS' : (page.group ?? 'CONCEPTS'),
                title: page.title,
                written: Boolean(page.content),
                read,
                total,
                done: Boolean(page.content) && read === total
            };
        });
    }, deepEqual);
}

/**
 * The rail: every page in order under its group, numbered, with how much of it is read, then Housekeeping, the concept
 * pages, the tests and Housekeeping each a list of its own; or the changed files as a tree, each with the numbers of the
 * pages it is on. The tests heading marks every written test page read at once.
 */
function ReadContents({
    round,
    current,
    editable,
    onPick
}: {
    round: RoundRecord;
    current: string;
    editable: boolean;
    onPick: (page: string) => void;
}) {
    const [byFile, setByFile] = useState(false);
    const pages = useRailPages(round);
    const tick = useTick();
    const unreadTests = useSelector(
        (view) =>
            roundPages(view, round.n)
                .filter((page) => page.kind === 'tests' && page.content)
                .flatMap((page) => page.pieces.filter((piece) => !view.ticks[tickKey(round.n, piece.id)]))
                .map((piece) => piece.id),
        deepEqual
    );
    const files = useSelector(
        (view) =>
            round.index
                ? round.index.files.map((file) => {
                      const found = pagesOfFile(view, round.index!, round.n, file.path);
                      return { path: file.path, pages: found.pages.map((page) => page.id), housekeeping: found.housekeeping };
                  })
                : [],
        deepEqual
    );
    const housekeeping = useSelector((view) => housekeepingRead(view, round.n));
    const hasHousekeeping = round.index ? housekeepingEntries(round.index).length > 0 : false;
    const byId = new Map(
        pages.map((page, at) => [page.id, { number: at + 1, id: page.id, title: plainTitle(page.title), read: page.done }])
    );
    const filePages = new Map(
        files.map((file) => [
            file.path,
            [
                ...file.pages.flatMap((id) => byId.get(id) ?? []),
                ...(file.housekeeping
                    ? [{ number: pages.length + 1, id: HOUSEKEEPING_PAGE, title: 'Housekeeping', read: housekeeping }]
                    : [])
            ]
        ])
    );
    const numbered = pages.map((page, at) => ({ ...page, number: at + 1 }));
    const paths = files.map((file) => file.path);
    const root = commonRoot(paths);
    return (
        <nav className="rail" aria-label="Read-through">
            <div className="row rail-switch" role="tablist" aria-label="List by">
                <button type="button" role="tab" className="button-text" aria-selected={!byFile} onClick={() => setByFile(false)}>
                    Pages
                </button>
                <button type="button" role="tab" className="button-text" aria-selected={byFile} onClick={() => setByFile(true)}>
                    By file
                </button>
            </div>
            {!byFile ? (
                <>
                    {Object.entries(groupBy(numbered, 'kind')).map(([kind, section]) => (
                        <ol key={kind} className="contents">
                            {section.map((page, at) => (
                                <li key={page.id}>
                                    {(at === 0 || section[at - 1]?.heading !== page.heading) && (
                                        <div className="nav-heading">
                                            {page.heading}
                                            {pages.every((other) => other.heading !== page.heading || other.done) && <ReadMark />}
                                            {kind === 'tests' && editable && unreadTests.length > 0 && (
                                                <button
                                                    type="button"
                                                    className="button-link small mark-all"
                                                    onClick={() => {
                                                        for (const piece of unreadTests) tick(piece, true, 'manual');
                                                    }}
                                                >
                                                    Mark all read
                                                </button>
                                            )}
                                        </div>
                                    )}
                                    <button
                                        type="button"
                                        className="nav-item"
                                        aria-current={page.id === current ? 'step' : undefined}
                                        title={plainTitle(page.title)}
                                        onClick={() => onPick(page.id)}
                                    >
                                        <span className="contents-number mono muted">{page.number}</span>
                                        <RailTitle className="nav-name">
                                            <TitleMarkdown source={page.title} />
                                        </RailTitle>
                                        {page.done ? (
                                            <ReadMark />
                                        ) : (
                                            <span className="mono small muted" aria-label={`${page.read} of ${page.total} read`}>
                                                {page.written ? `${page.read}/${page.total}` : 'coming'}
                                            </span>
                                        )}
                                    </button>
                                </li>
                            ))}
                        </ol>
                    ))}
                    {hasHousekeeping && (
                        <ol className="contents">
                            <li>
                                <button
                                    type="button"
                                    className="nav-item"
                                    aria-current={current === HOUSEKEEPING_PAGE ? 'step' : undefined}
                                    onClick={() => onPick(HOUSEKEEPING_PAGE)}
                                >
                                    <span className="contents-number mono muted">{pages.length + 1}</span>
                                    <span className="nav-name">Housekeeping</span>
                                    {housekeeping && <ReadMark />}
                                </button>
                            </li>
                        </ol>
                    )}
                </>
            ) : (
                <div className="by-file">
                    {root.length > 0 && (
                        <div className="rail-root" title={root.join('/')}>
                            <RailTitle className="mono small muted">{root.join('/')}/</RailTitle>
                        </div>
                    )}
                    <FileFolder folder={buildTree(paths, root)} pagesOf={filePages} current={current} onPick={onPick} />
                </div>
            )}
        </nav>
    );
}

/**
 * The collapsed rail: pages read over total, then one numbered mark per page, ticked once read, a gap between the
 * concept pages, the tests and Housekeeping.
 */
function ReadStrip({ round, current, onPick }: { round: RoundRecord; current: string; onPick: (page: string) => void }) {
    const pages = useRailPages(round);
    const housekeeping = useSelector((view) => housekeepingRead(view, round.n));
    const marks = [
        ...pages.map((page, at) => ({
            id: page.id,
            number: at + 1,
            section: page.kind,
            title: plainTitle(page.title),
            done: page.done,
            state: page.done ? 'read' : page.written ? `${page.read} of ${page.total} read` : 'coming'
        })),
        ...(round.index && housekeepingEntries(round.index).length > 0
            ? [
                  {
                      id: HOUSEKEEPING_PAGE,
                      number: pages.length + 1,
                      section: 'housekeeping',
                      title: 'Housekeeping',
                      done: housekeeping,
                      state: housekeeping ? 'read' : 'not read'
                  }
              ]
            : [])
    ];
    const read = marks.filter((mark) => mark.done).length;
    return (
        <nav className="rail-strip" aria-label="Read-through progress">
            <span className="mono small" title={`${read} of ${plural(marks.length, 'page')} read`}>
                {read}/{marks.length}
            </span>
            {Object.entries(groupBy(marks, 'section')).map(([section, group]) => (
                <div key={section} className="rail-strip-group">
                    {group.map((mark) => {
                        const label = `Page ${mark.number}: ${mark.title}, ${mark.state}`;
                        return (
                            <button
                                key={mark.id}
                                type="button"
                                className="rail-strip-item"
                                aria-current={mark.id === current ? 'step' : undefined}
                                aria-label={label}
                                title={label}
                                onClick={() => onPick(mark.id)}
                            >
                                <span className={`strip-section is-${mark.done ? 'reviewed' : 'open'}`} aria-hidden="true">
                                    {mark.done ? <CheckIcon size={9} /> : mark.number}
                                </span>
                            </button>
                        );
                    })}
                </div>
            ))}
        </nav>
    );
}

/**
 * The number of the page on show, to type over: Enter goes to the page typed, held within the first and the last;
 * leaving the box puts the page on show back.
 */
function PageJump({ at, total, onGo }: { at: number; total: number; onGo: (index: number) => void }) {
    const [typed, setTyped] = useState<string>();
    const shown = typed ?? String(at + 1);
    return (
        <form
            className="page-jump mono small muted"
            onSubmit={(event) => {
                event.preventDefault();
                setTyped(undefined);
                const number = Number.parseInt(shown, 10);
                if (!Number.isNaN(number)) onGo(clamp(number, 1, total) - 1);
            }}
        >
            <input
                className="field-input"
                inputMode="numeric"
                value={shown}
                aria-label={`Page number, of ${total}`}
                onChange={(event) => setTyped(event.target.value)}
                onBlur={() => setTyped(undefined)}
            />
            <span aria-hidden="true">/ {total}</span>
        </form>
    );
}

/** While the agent lays out the read-through: what it is doing, or that the read-through follows the deck. */
function ReadBuilding({ round }: { round: RoundRecord }) {
    return (
        <div className="deck-building">
            <div className="loading-bar" role="progressbar" aria-label="Laying out the read-through" />
            <p className="muted">
                {round.technique === 'both' && !round.publishedAt
                    ? 'The read-through follows the deck: the agent lays it out once the walkthrough is published.'
                    : 'The agent is laying out the pages. The first one shows as soon as it is written.'}
            </p>
            <AgentNow />
        </div>
    );
}

/** A box to search the reviewed commit for any name, the keyboard's way to what clicking a name does. */
function NameSearch({ onSearch }: { onSearch: (name: string) => void }) {
    const [name, setName] = useState('');
    return (
        <form
            className="row name-search"
            role="search"
            onSubmit={(event) => {
                event.preventDefault();
                if (name.trim()) onSearch(name.trim());
            }}
        >
            <input
                className="field-input"
                aria-label="Find a name in the reviewed commit"
                placeholder="Find a name"
                value={name}
                onChange={(event) => setName(event.target.value)}
            />
            <button type="submit" className="button-secondary button-small" disabled={!name.trim()}>
                Find
            </button>
        </form>
    );
}

/**
 * The Read-through tab: the page list down the side, how much of the change is read at the top, then the page on
 * show and the way to the next.
 */
export function Readthrough() {
    const round = useShownRound();
    const { page: picked } = useUiState();
    const { setPage } = useActions();
    const [search, setSearch] = useState<{ name: string; uses: boolean }>();
    const reading = useReading(round, (name, uses) => setSearch({ name, uses }));
    const ids = useSelector((view) => roundPages(view, round.n).map((page) => page.id), deepEqual);
    const progress = useSelector((view) => readProgress(view, round.index, round.n).lines, deepEqual);
    const hasHousekeeping = round.index ? housekeepingEntries(round.index).length > 0 : false;
    const order = hasHousekeeping ? [...ids, HOUSEKEEPING_PAGE] : ids;
    const current = picked && order.includes(picked) ? picked : order[0];
    const page = useSelector((view) => (current ? view.pages[`${round.n}:${current}`] : undefined), deepEqual);
    const at = current ? order.indexOf(current) : -1;
    const go = (id: string | undefined) => {
        if (!id) return;
        setPage(id);
        document.getElementById('main')?.scrollTo?.({ top: 0 });
    };
    let body: ReactNode;
    if (!hasReadthrough(round.technique)) body = <p className="muted">This round is reviewed with the overview deck alone.</p>;
    else if (!round.readthrough) body = <ReadBuilding round={round} />;
    else
        body = (
            <>
                <div className="read-head">
                    <div className="read-progress">
                        <span className="small strong">
                            {progress.read} of {plural(progress.total, 'changed line')} read
                        </span>
                        <progress
                            max={Math.max(1, progress.total)}
                            value={progress.read}
                            aria-label="How much of the change is read"
                        />
                    </div>
                    <NameSearch onSearch={(name) => setSearch({ name, uses: false })} />
                </div>
                {current === HOUSEKEEPING_PAGE ? (
                    <Housekeeping reading={reading} />
                ) : (
                    page && <PageView reading={reading} page={page} number={at + 1} total={order.length} />
                )}
                <nav className="deck-nav" aria-label="Pages">
                    <button type="button" className="button-secondary" disabled={at <= 0} onClick={() => go(order[at - 1])}>
                        Previous page
                    </button>
                    <PageJump at={at} total={order.length} onGo={(index) => go(order[index])} />
                    <button
                        type="button"
                        className="button-secondary"
                        disabled={at >= order.length - 1}
                        onClick={() => go(order[at + 1])}
                    >
                        Next page
                    </button>
                </nav>
            </>
        );
    return (
        <>
            <Rail
                strip={
                    round.readthrough && current ? (
                        <ReadStrip round={round} current={current} onPick={go} />
                    ) : (
                        <span className="mono small">{order.length}</span>
                    )
                }
            >
                {round.readthrough && current ? (
                    <ReadContents round={round} current={current} editable={reading.editable} onPick={go} />
                ) : (
                    <nav className="rail" aria-label="Read-through">
                        <div className="nav-heading">READ-THROUGH</div>
                        <p className="small muted">The pages show here once the agent lays them out.</p>
                    </nav>
                )}
            </Rail>
            <main className="main" id="main">
                <div className="main-inner">{body}</div>
            </main>
            {search && <SearchDialog round={round.n} {...search} onClose={() => setSearch(undefined)} />}
        </>
    );
}
