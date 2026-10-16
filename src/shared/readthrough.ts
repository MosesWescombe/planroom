import { z } from 'zod';
import { recordId, repoPath } from './blocks.js';
import { contextBlock } from './questions.js';
import type { Anchor } from './records.js';

/**
 * The read-through: the change split into pages the reviewer reads line by line. The server builds a line index of the
 * round's diff and holds the agent's layout of pages to it, so no added or removed line is left off every page. The
 * page and the server both run these derivations, so the progress the page shows is the one the server would count.
 */

// ---------------------------------------------------------------- the line index

/** An inclusive run of line numbers, first to last. */
export const lineSpan = z.tuple([z.number().int().min(1), z.number().int().min(1)]);
export type LineSpan = z.infer<typeof lineSpan>;

const count = z.number().int().min(0);

/**
 * One hunk as git's header names it: where it starts on each side and how many lines it has there. A side with no
 * lines names the line before the change.
 */
export const diffHunk = z.object({ oldStart: count, oldCount: count, newStart: count, newCount: count });
export type DiffHunk = z.infer<typeof diffHunk>;

/** Why a file goes on the Housekeeping page whole: a known lock file, generated per `.gitattributes`, or binary. */
export const HOUSEKEEPING = ['lock', 'generated', 'binary'] as const;
export type Housekeeping = (typeof HOUSEKEEPING)[number];
export const HOUSEKEEPING_TITLES: Record<Housekeeping | 'spacing', string> = {
    lock: 'Lock file',
    generated: 'Generated',
    binary: 'Binary file',
    spacing: 'Spacing only'
};

/** One changed file of the index: its changed hunks, the hunks Bitbucket shows, and what reads it without a code page. */
export const indexFile = z.object({
    path: z.string(),
    /** A renamed file's old path. */
    from: z.string().optional(),
    /** The hunks with no context (`git diff -U0`): every added and removed line. */
    hunks: z.array(diffHunk),
    /** The hunks with three lines of context, which is what Bitbucket's diff shows. */
    shown: z.array(diffHunk),
    housekeeping: z.enum(HOUSEKEEPING).optional(),
    /** The indexes of `hunks` that change only spacing, listed on the Housekeeping page. */
    spacing: z.array(z.number().int().min(0)).optional(),
    /** A test file by its name or folder. The agent may still move it on or off the test pages. */
    test: z.literal(true).optional()
});
export type IndexFile = z.infer<typeof indexFile>;

/** One place of a repeated edit: its lines on each side, and what it changes beyond the repeated edit, if anything. */
export const repeatPlace = z.object({
    file: z.string(),
    new: lineSpan.optional(),
    old: lineSpan.optional(),
    differs: z.string().optional()
});
export type RepeatPlace = z.infer<typeof repeatPlace>;

/** The same edit made in several places, matched on normalised text, the places in diff order. */
export const repeatGroup = z.object({
    key: z.string(),
    /** The edit in words, e.g. "`retries: 3` to `policy`". */
    change: z.string(),
    places: z.array(repeatPlace).min(2)
});
export type RepeatGroup = z.infer<typeof repeatGroup>;

/** Code moved: a removed block and an added block of three or more lines that match. */
export const movedBlock = z.object({
    from: z.object({ file: z.string(), lines: lineSpan }),
    to: z.object({ file: z.string(), lines: lineSpan })
});
export type MovedBlock = z.infer<typeof movedBlock>;

/** What the server knows of a round's diff, built from `git diff -M -U0` plus a `-U3` pass for what Bitbucket shows. */
export const lineIndex = z.object({
    files: z.array(indexFile),
    repeats: z.array(repeatGroup),
    moves: z.array(movedBlock)
});
export type LineIndex = z.infer<typeof lineIndex>;

/** The new lines a hunk adds, or none. */
export function addedSpan(hunk: DiffHunk): LineSpan | undefined {
    return hunk.newCount > 0 ? [hunk.newStart, hunk.newStart + hunk.newCount - 1] : undefined;
}

/** The old lines a hunk removes, or none. */
export function removedSpan(hunk: DiffHunk): LineSpan | undefined {
    return hunk.oldCount > 0 ? [hunk.oldStart, hunk.oldStart + hunk.oldCount - 1] : undefined;
}

/** The index's entry for `file`, by its path or, for a renamed file, its old path. */
export function indexFileOf(index: LineIndex, file: string): IndexFile | undefined {
    return index.files.find((entry) => entry.path === file) ?? index.files.find((entry) => entry.from === file);
}

/** Whether Bitbucket's diff shows `line` on `side` of `file`: inside a hunk with its three lines of context. */
export function shownOnDiff(index: LineIndex, file: string, side: 'new' | 'old', line: number): boolean {
    const entry = indexFileOf(index, file);
    if (!entry) return true;
    return entry.shown.some((hunk) => {
        const [start, lines] = side === 'new' ? [hunk.newStart, hunk.newCount] : [hunk.oldStart, hunk.oldCount];
        return line >= start && line < start + lines;
    });
}

// ---------------------------------------------------------------- the agent's layout

/** A line range as the agent writes it: `"40"` or `"40-72"`. */
export const lineRange = z
    .string()
    .regex(/^\d+(-\d+)?$/, 'must be a line number or a range such as "40-72"')
    .refine((range) => {
        const [start, end] = parseRange(range);
        return start >= 1 && end >= start;
    }, 'must start at line 1 or later and end at or after its start');

/** A line range's first and last line. */
export function parseRange(range: string): LineSpan {
    const [start = 0, end = start] = range.split('-').map(Number);
    return [start, end];
}

/** How a piece of code shows: as it is now, or as a diff. */
export const PIECE_VIEWS = ['now', 'diff'] as const;
export type PieceView = (typeof PIECE_VIEWS)[number];

/**
 * One piece of code on a page: a file and its lines on the new side, the old side, or both. A repeat's piece is its
 * example and covers every place of the repeat; a moved block names where it came `from`. On a test page each piece is
 * one test case, named by `title`.
 */
export const pieceSpec = z
    .object({
        id: recordId,
        file: repoPath,
        lines: lineRange.optional(),
        oldLines: lineRange.optional(),
        /** The view that reads best: a rewrite as it is now, a small tweak as a diff. The reviewer's setting can fix it. */
        view: z.enum(PIECE_VIEWS).optional(),
        /** The key of the repeat group this piece is the example of. */
        repeat: z.string().min(1).max(40).optional(),
        /** Where moved code came from. */
        from: z.object({ file: repoPath, oldLines: lineRange }).optional(),
        title: z.string().trim().min(1).max(300).optional()
    })
    .refine((piece) => piece.lines !== undefined || piece.oldLines !== undefined, {
        message: 'name its `lines`, its `oldLines`, or both',
        path: ['lines']
    });
export type PieceSpec = z.infer<typeof pieceSpec>;

/** Concept pages come first in the agent's order, then the test pages. The server adds Housekeeping last. */
export const PAGE_KINDS = ['concept', 'tests'] as const;
export type PageKind = (typeof PAGE_KINDS)[number];

/**
 * A page as the agent lays it out: its kind, title, group, place and pieces. Its words come later, in
 * `read.page.upsert`.
 */
export const outlinePage = z.object({
    id: recordId,
    kind: z.enum(PAGE_KINDS),
    title: z.string().trim().min(1).max(200),
    /** The area of the change a concept page belongs to, by its title; the pages of a group read together. */
    group: z.string().trim().min(1).max(120).optional(),
    order: z.number(),
    pieces: z.array(pieceSpec).min(1).max(40)
});
export type OutlinePage = z.infer<typeof outlinePage>;

/** Code a piece reaches, shown folded under it: a caller, a definition, a config. */
export const relatedCode = z.object({
    file: repoPath,
    lines: lineRange,
    note: z.string().trim().min(1).max(1000).optional()
});
export type RelatedCode = z.infer<typeof relatedCode>;

/**
 * A page's words, written once its pieces are laid out: the plain summary it opens with, any blocks that explain the
 * concept, what each piece is for with any blocks that explain it before its code, the code it reaches, and on a test
 * page each case's title and pseudo code.
 */
export const pageContent = z.object({
    id: recordId,
    summary: z.string().trim().min(1).max(8000),
    blocks: z.array(contextBlock).max(40).optional(),
    pieces: z
        .array(
            z.object({
                id: recordId,
                note: z.string().trim().min(1).max(4000),
                /** Diagrams or tables that explain the piece, shown between its note and its code. */
                blocks: z.array(contextBlock).max(4).optional(),
                related: z.array(relatedCode).max(6).optional()
            })
        )
        .max(40)
        .default([]),
    tests: z
        .array(
            z.object({
                piece: recordId,
                title: z.string().trim().min(1).max(300),
                pseudo: z.string().trim().min(1).max(4000)
            })
        )
        .max(40)
        .optional()
});
export type PageContent = z.infer<typeof pageContent>;

/** What the agent added to a page because the reviewer asked, in a page thread. It never changes what was there. */
export const pageAddition = z.object({
    thread: z.string(),
    /** The piece it sits under; unset, it sits at the end of the page. */
    piece: recordId.optional(),
    text: z.string().optional(),
    blocks: z.array(contextBlock).optional(),
    at: z.string()
});
export type PageAddition = z.infer<typeof pageAddition>;

/** A stored page: its layout, its round, its words once written, the additions asked for, and its version. */
export const pageRecord = outlinePage.extend({
    round: z.number().int().min(1),
    content: pageContent.omit({ id: true }).optional(),
    added: z.array(pageAddition).default([]),
    version: z.number().int().min(1),
    updatedAt: z.string()
});
export type PageRecord = z.infer<typeof pageRecord>;

/** A read tick: when, and whether the reviewer ticked it or auto-tick did. */
export const tickRecord = z.object({ how: z.enum(['manual', 'auto']), at: z.string() });
export type TickRecord = z.infer<typeof tickRecord>;

/** The Housekeeping page's own id, which counts as read once it is opened. */
export const HOUSEKEEPING_PAGE = 'housekeeping';

/** Where a round's page is stored: page ids are the agent's own, so each round can reuse them. */
export function pageKey(round: number, page: string): string {
    return `${round}:${page}`;
}

/** Where a tick is stored: a piece, a differing place of a repeat by its index, or the Housekeeping page. */
export function tickKey(round: number, piece: string, place?: number): string {
    return `${round}:${piece}${place === undefined ? '' : `#${place}`}`;
}

/** What the read-through derivations read. */
export interface ReadParts {
    pages: Record<string, PageRecord>;
    ticks: Record<string, TickRecord>;
}

/**
 * A round's pages in reading order: concept pages in the agent's order, each group together where its first page
 * falls, then the test pages.
 */
export function roundPages(parts: Pick<ReadParts, 'pages'>, round: number): PageRecord[] {
    const pages = Object.values(parts.pages).filter((page) => page.round === round);
    const groupAt = new Map<string, number>();
    for (const page of pages)
        if (page.group !== undefined) groupAt.set(page.group, Math.min(groupAt.get(page.group) ?? page.order, page.order));
    const at = (page: PageRecord) => (page.group === undefined ? page.order : (groupAt.get(page.group) ?? page.order));
    return pages.sort(
        (a, b) =>
            PAGE_KINDS.indexOf(a.kind) - PAGE_KINDS.indexOf(b.kind) ||
            at(a) - at(b) ||
            (a.group ?? '').localeCompare(b.group ?? '') ||
            a.order - b.order ||
            a.id.localeCompare(b.id)
    );
}

// ---------------------------------------------------------------- coverage

/** Changed line numbers of one file, by side: added lines on the new side, removed lines on the old. */
export interface FileLines {
    added: Set<number>;
    removed: Set<number>;
}

/** Changed lines by the index's file path. */
export type Lines = Map<string, FileLines>;

/** The entry for `path` in `lines`, created empty when missing. */
function linesOf(lines: Lines, path: string): FileLines {
    let entry = lines.get(path);
    if (!entry) {
        entry = { added: new Set(), removed: new Set() };
        lines.set(path, entry);
    }
    return entry;
}

/** Add `span`'s lines to `into`. */
function addSpan(into: Set<number>, span: LineSpan | undefined): void {
    if (span) for (let line = span[0]; line <= span[1]; line += 1) into.add(line);
}

/** Add one hunk's added and removed lines to `lines` under `path`. */
function addHunk(lines: Lines, path: string, hunk: DiffHunk): void {
    const entry = linesOf(lines, path);
    addSpan(entry.added, addedSpan(hunk));
    addSpan(entry.removed, removedSpan(hunk));
}

/** Every added and removed line of the change. A binary file has none. */
export function changedLines(index: LineIndex): Lines {
    const lines: Lines = new Map();
    for (const file of index.files) for (const hunk of file.hunks) addHunk(lines, file.path, hunk);
    return lines;
}

/** The lines the Housekeeping page holds: whole lock, generated and binary files, and hunks that change only spacing. */
export function housekeepingLines(index: LineIndex): Lines {
    const lines: Lines = new Map();
    for (const file of index.files)
        file.hunks.forEach((hunk, at) => {
            if (file.housekeeping || file.spacing?.includes(at)) addHunk(lines, file.path, hunk);
        });
    return lines;
}

/** Whether two spans share a line. */
function overlaps(a: LineSpan, b: LineSpan): boolean {
    return a[0] <= b[1] && b[0] <= a[1];
}

/**
 * The changed lines a piece covers. Its new-side `lines` cover the lines added in them and the lines removed beside
 * them: a hunk's removed lines go with its added lines, and a pure removal goes with the lines either side of it. Its
 * `oldLines` do the same from the old side. A repeat's example covers every place of the repeat, and a moved block
 * covers where it came from too.
 */
export function pieceLines(index: LineIndex, piece: PieceSpec): Lines {
    const lines: Lines = new Map();
    const cover = (file: string, newSpan: LineSpan | undefined, oldSpan: LineSpan | undefined) => {
        const entry = indexFileOf(index, file);
        if (!entry) return;
        const into = linesOf(lines, entry.path);
        for (const hunk of entry.hunks) {
            const added = addedSpan(hunk);
            const removed = removedSpan(hunk);
            const byNew =
                newSpan && (added ? overlaps(added, newSpan) : hunk.newStart >= newSpan[0] - 1 && hunk.newStart <= newSpan[1]);
            const byOld =
                oldSpan &&
                (removed ? overlaps(removed, oldSpan) : hunk.oldStart >= oldSpan[0] - 1 && hunk.oldStart <= oldSpan[1]);
            if (!byNew && !byOld) continue;
            for (const line of spanLines(added)) if (!newSpan || byOld || inSpan(line, newSpan)) into.added.add(line);
            for (const line of spanLines(removed)) if (!oldSpan || byNew || inSpan(line, oldSpan)) into.removed.add(line);
        }
    };
    cover(piece.file, piece.lines ? parseRange(piece.lines) : undefined, piece.oldLines ? parseRange(piece.oldLines) : undefined);
    if (piece.from) cover(piece.from.file, undefined, parseRange(piece.from.oldLines));
    const group = piece.repeat ? index.repeats.find((candidate) => candidate.key === piece.repeat) : undefined;
    for (const place of group?.places ?? []) cover(place.file, place.new, place.old);
    return lines;
}

/** Every line of `span`, or none. */
function spanLines(span: LineSpan | undefined): number[] {
    if (!span) return [];
    return Array.from({ length: span[1] - span[0] + 1 }, (_, index) => span[0] + index);
}

/** Whether `line` is in `span`. */
function inSpan(line: number, span: LineSpan): boolean {
    return line >= span[0] && line <= span[1];
}

/** Add every line of `from` to `into`. */
export function mergeLines(into: Lines, from: Lines): Lines {
    for (const [path, entry] of from) {
        const target = linesOf(into, path);
        for (const line of entry.added) target.added.add(line);
        for (const line of entry.removed) target.removed.add(line);
    }
    return into;
}

/** How many lines `lines` holds, both sides together. */
export function lineCount(lines: Lines): number {
    let total = 0;
    for (const entry of lines.values()) total += entry.added.size + entry.removed.size;
    return total;
}

/** Sorted line numbers as runs of consecutive lines. */
export function spansOf(numbers: Iterable<number>): LineSpan[] {
    const spans: LineSpan[] = [];
    for (const line of [...numbers].sort((a, b) => a - b)) {
        const last = spans[spans.length - 1];
        if (last && line === last[1] + 1) last[1] = line;
        else spans.push([line, line]);
    }
    return spans;
}

/** Lines left over: changed, and on no page and not on Housekeeping. */
export interface Leftover {
    file: string;
    side: 'new' | 'old';
    spans: LineSpan[];
}

/** The changed lines no page holds, by file and side, in the index's file order. */
export function uncovered(index: LineIndex, pieces: readonly PieceSpec[]): Leftover[] {
    const covered = housekeepingLines(index);
    for (const piece of pieces) mergeLines(covered, pieceLines(index, piece));
    const left: Leftover[] = [];
    for (const [file, entry] of changedLines(index)) {
        const done = covered.get(file);
        const added = [...entry.added].filter((line) => !done?.added.has(line));
        const removed = [...entry.removed].filter((line) => !done?.removed.has(line));
        if (added.length) left.push({ file, side: 'new', spans: spansOf(added) });
        if (removed.length) left.push({ file, side: 'old', spans: spansOf(removed) });
    }
    return left;
}

/** A span in words: "line 40" or "lines 40 to 44". */
export function describeSpan(span: LineSpan): string {
    return span[0] === span[1] ? `line ${span[0]}` : `lines ${span[0]} to ${span[1]}`;
}

/** Leftover lines in words, e.g. "src/retry.ts lines 40 to 44" or "src/old.ts removed line 3". */
export function describeLeftover(left: Leftover): string {
    const spans = left.spans.map((span) => describeSpan(span).replace(/^lines? /, ''));
    const noun = left.spans.length === 1 && left.spans[0]![0] === left.spans[0]![1] ? 'line' : 'lines';
    return `${left.file} ${left.side === 'old' ? `removed ${noun}` : noun} ${spans.join(', ')}`;
}

// ---------------------------------------------------------------- the Housekeeping page

/** One file the Housekeeping page lists: why it needs no line-by-line read, and for spacing, which hunks. */
export interface HousekeepingEntry {
    file: string;
    why: Housekeeping | 'spacing';
    /** For spacing-only hunks, their new-side lines, or old-side ones where nothing was added. */
    spans: { side: 'new' | 'old'; span: LineSpan }[];
}

/** What the Housekeeping page lists, by file in diff order. */
export function housekeepingEntries(index: LineIndex): HousekeepingEntry[] {
    return index.files.flatMap((file): HousekeepingEntry[] => {
        if (file.housekeeping) return [{ file: file.path, why: file.housekeeping, spans: [] }];
        const spacing = (file.spacing ?? []).flatMap((at): HousekeepingEntry['spans'] => {
            const hunk = file.hunks[at];
            const added = hunk && addedSpan(hunk);
            const removed = hunk && removedSpan(hunk);
            if (added) return [{ side: 'new', span: added }];
            return removed ? [{ side: 'old', span: removed }] : [];
        });
        return spacing.length ? [{ file: file.path, why: 'spacing', spans: spacing }] : [];
    });
}

// ---------------------------------------------------------------- reading

/** A repeat piece's group and the place its example is: the place its lines overlap, else the first. */
export function repeatOf(
    index: LineIndex | undefined,
    piece: Pick<PieceSpec, 'repeat' | 'file' | 'lines' | 'oldLines'>
): { group: RepeatGroup; example: number } | undefined {
    const group = piece.repeat ? index?.repeats.find((candidate) => candidate.key === piece.repeat) : undefined;
    if (!group) return undefined;
    const newSpan = piece.lines ? parseRange(piece.lines) : undefined;
    const oldSpan = piece.oldLines ? parseRange(piece.oldLines) : undefined;
    const example = group.places.findIndex(
        (place) =>
            (place.file === piece.file || indexFileOf(index!, piece.file)?.path === place.file) &&
            ((newSpan && place.new && overlaps(place.new, newSpan)) || (oldSpan && place.old && overlaps(place.old, oldSpan)))
    );
    return { group, example: Math.max(0, example) };
}

/**
 * Whether a piece counts as read: ticked, and for a repeat's example, every place that differs from it opened too.
 * Identical places count with the example.
 */
export function pieceRead(
    parts: Pick<ReadParts, 'ticks'>,
    index: LineIndex | undefined,
    round: number,
    piece: PieceSpec
): boolean {
    if (!parts.ticks[tickKey(round, piece.id)]) return false;
    const repeat = repeatOf(index, piece);
    if (!repeat) return true;
    return repeat.group.places.every(
        (place, at) => at === repeat.example || !place.differs || Boolean(parts.ticks[tickKey(round, piece.id, at)])
    );
}

/**
 * The pieces of a page a question on it is about: those whose lines hold the lines it asks about, or every piece when it
 * asks about the page's words, the whole page, or lines no piece holds.
 */
export function askedPieces(index: LineIndex | undefined, pieces: PieceSpec[], lines: Anchor['lines']): PieceSpec[] {
    if (!lines) return pieces;
    const asked: LineSpan = [lines.start, lines.end];
    const path = index && indexFileOf(index, lines.file)?.path;
    const held = pieces.filter((piece) => {
        const span = lines.side === 'new' ? piece.lines : piece.oldLines;
        if (piece.file === lines.file && span && overlaps(parseRange(span), asked)) return true;
        // A piece also shows the lines removed beside its own, and the places of its repeat.
        const changed = index && path ? pieceLines(index, piece).get(path) : undefined;
        const side = lines.side === 'new' ? changed?.added : changed?.removed;
        return spanLines(asked).some((line) => side?.has(line));
    });
    return held.length ? held : pieces;
}

/** Whether the round's Housekeeping page has been opened, which reads every file on it. */
export function housekeepingRead(parts: Pick<ReadParts, 'ticks'>, round: number): boolean {
    return Boolean(parts.ticks[tickKey(round, HOUSEKEEPING_PAGE)]);
}

/** How far the reviewer has read: pieces per page, and changed lines across the whole change. */
export interface ReadProgress {
    pages: Record<string, { read: number; total: number }>;
    lines: { read: number; total: number };
}

/** The reviewer's progress through a round's read-through. */
export function readProgress(parts: ReadParts, index: LineIndex | undefined, round: number): ReadProgress {
    const pages: ReadProgress['pages'] = {};
    if (!index) return { pages, lines: { read: 0, total: 0 } };
    const read: Lines = housekeepingRead(parts, round) ? housekeepingLines(index) : new Map();
    for (const page of roundPages(parts, round)) {
        let done = 0;
        for (const piece of page.pieces)
            if (pieceRead(parts, index, round, piece)) {
                done += 1;
                mergeLines(read, pieceLines(index, piece));
            }
        pages[page.id] = { read: done, total: page.pieces.length };
    }
    const changed = changedLines(index);
    let readCount = 0;
    for (const [file, entry] of changed) {
        const done = read.get(file);
        for (const line of entry.added) if (done?.added.has(line)) readCount += 1;
        for (const line of entry.removed) if (done?.removed.has(line)) readCount += 1;
    }
    return { pages, lines: { read: readCount, total: lineCount(changed) } };
}

/** The pages of a round that hold lines of `file`, in reading order, and whether Housekeeping lists it. */
export function pagesOfFile(
    parts: Pick<ReadParts, 'pages'>,
    index: LineIndex,
    round: number,
    file: string
): { pages: PageRecord[]; housekeeping: boolean } {
    const entry = indexFileOf(index, file);
    const path = entry?.path ?? file;
    const pages = roundPages(parts, round).filter((page) =>
        page.pieces.some((piece) => {
            const lines = pieceLines(index, piece).get(path);
            return (lines && lines.added.size + lines.removed.size > 0) || piece.file === path || piece.file === entry?.from;
        })
    );
    return { pages, housekeeping: housekeepingEntries(index).some((listed) => listed.file === path) };
}

/** Where a place is, in words: "src/b.ts line 22", or its removed lines when it only removed. */
export function describePlace(place: Pick<RepeatPlace, 'file' | 'new' | 'old'>): string {
    if (place.new) return `${place.file} ${describeSpan(place.new).replace(' to ', '-')}`;
    return place.old ? `${place.file} removed ${describeSpan(place.old).replace(' to ', '-')}` : place.file;
}
