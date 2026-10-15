import { basename } from 'node:path';
import { diffWords } from 'diff';
import {
    addedSpan,
    type DiffHunk,
    type Housekeeping,
    type IndexFile,
    type LineIndex,
    type LineSpan,
    type MovedBlock,
    type RepeatGroup,
    type RepeatPlace,
    removedSpan
} from '../shared/readthrough.js';
import { git, type NamedFile, nameStatus } from './worktree.js';

/**
 * The read-through's line index of a round: every added and removed line from `git diff -M -U0`, what Bitbucket's diff
 * shows from a `-U3` pass, the files and hunks Housekeeping holds, and the repeats and moves the agent gets as hints.
 */

/** A hunk with its removed and added lines' text. */
interface ParsedHunk extends DiffHunk {
    removed: string[];
    added: string[];
}

/** One file's part of a patch. */
interface ParsedFile {
    binary: boolean;
    hunks: ParsedHunk[];
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** A multi-file patch as one entry per `diff --git` header, in order, each with its hunks. */
export function parseFilePatches(patch: string): ParsedFile[] {
    const files: ParsedFile[] = [];
    let file: ParsedFile | undefined;
    let hunk: ParsedHunk | undefined;
    for (const line of patch.split('\n')) {
        if (line.startsWith('diff --git ')) {
            file = { binary: false, hunks: [] };
            files.push(file);
            hunk = undefined;
            continue;
        }
        if (!file) continue;
        const header = HUNK.exec(line);
        if (header) {
            hunk = {
                oldStart: Number(header[1]),
                oldCount: header[2] === undefined ? 1 : Number(header[2]),
                newStart: Number(header[3]),
                newCount: header[4] === undefined ? 1 : Number(header[4]),
                removed: [],
                added: []
            };
            file.hunks.push(hunk);
        } else if (!hunk) {
            if (line.startsWith('Binary files ') || line === 'GIT binary patch') file.binary = true;
        } else if (line.startsWith('-')) hunk.removed.push(line.slice(1));
        else if (line.startsWith('+')) hunk.added.push(line.slice(1));
    }
    return files;
}

/** `patches` matched to `names` in order, a type change's two patches merged into one file. */
function byName(patches: readonly ParsedFile[], names: readonly NamedFile[]): ParsedFile[] {
    let at = 0;
    return names.map((name) => {
        const own = patches[at++] ?? { binary: false, hunks: [] };
        if (!name.typechange) return own;
        const added = patches[at++];
        return added ? { binary: own.binary || added.binary, hunks: [...own.hunks, ...added.hunks] } : own;
    });
}

/** Lock files package managers write, which no one reads line by line. */
const LOCK_FILES = new Set([
    'pnpm-lock.yaml',
    'package-lock.json',
    'npm-shrinkwrap.json',
    'yarn.lock',
    'bun.lockb',
    'bun.lock',
    'Cargo.lock',
    'Gemfile.lock',
    'poetry.lock',
    'Pipfile.lock',
    'uv.lock',
    'composer.lock',
    'go.sum',
    'mix.lock',
    'Podfile.lock',
    'pubspec.lock',
    'flake.lock',
    'packages.lock.json',
    'gradle.lockfile'
]);

/** Whether a path names a test file by its name or folder. */
export function isTestPath(path: string): boolean {
    return /(^|\/)(tests?|__tests__)\//.test(path) || /\.(test|spec)\.[^/]+$/.test(path);
}

/**
 * Whether a hunk changes only spacing: the same text on both sides once whitespace is gone, except one space kept
 * between two word characters, so `a FROM` and `aFROM` still differ.
 * ponytail: spacing beside punctuation inside a string still counts as spacing; tokenise per language if that hides a
 * real change.
 */
function spacingOnly(hunk: ParsedHunk): boolean {
    const squash = (lines: string[]) =>
        lines
            .join('\n')
            .replace(/\s+/g, ' ')
            .replace(/(?<![\p{L}\p{N}_$]) | (?![\p{L}\p{N}_$])/gu, '');
    return squash(hunk.removed) === squash(hunk.added);
}

/** The files `.gitattributes` at `commit` marks generated (`linguist-generated` or `generated`), of `paths`. */
async function generatedPaths(repoRoot: string, commit: string, paths: readonly string[]): Promise<Set<string>> {
    const generated = new Set<string>();
    for (let start = 0; start < paths.length; start += 200) {
        let out: string;
        try {
            out = await git(repoRoot, [
                'check-attr',
                `--source=${commit}`,
                '-z',
                'linguist-generated',
                'generated',
                '--',
                ...paths.slice(start, start + 200)
            ]);
        } catch {
            // A git before 2.40 has no --source: nothing counts as generated.
            return generated;
        }
        const fields = out.split('\0');
        for (let at = 0; at + 2 < fields.length; at += 3)
            if (fields[at + 2] === 'set' || fields[at + 2] === 'true') generated.add(fields[at]!);
    }
    return generated;
}

/** Whitespace squashed to single spaces, trimmed. */
function normal(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

/** One edit inside a hunk: the text it took out and the text it put in, normalised. */
interface Edit {
    from: string;
    to: string;
}

/** The edits a hunk makes, word by word: each run of removed and added words between unchanged ones. */
function editsOf(hunk: ParsedHunk): Edit[] {
    if (!hunk.removed.length) return [{ from: '', to: normal(hunk.added.join('\n')) }];
    if (!hunk.added.length) return [{ from: normal(hunk.removed.join('\n')), to: '' }];
    const edits: Edit[] = [];
    let from = '';
    let to = '';
    const flush = () => {
        const edit = { from: normal(from), to: normal(to) };
        if (edit.from !== edit.to) edits.push(edit);
        from = '';
        to = '';
    };
    for (const part of diffWords(hunk.removed.join('\n'), hunk.added.join('\n'))) {
        if (part.removed) from += part.value;
        else if (part.added) to += part.value;
        else if (part.value.trim()) flush();
    }
    flush();
    return edits;
}

/** An edit as a key, to find the same edit in other hunks. */
function editKey(edit: Edit): string {
    return `${edit.from}\0${edit.to}`;
}

/** Text cut to `max` characters for a hint. */
function clip(text: string, max = 80): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** An edit in words, e.g. "`retries: 3` to `policy`". */
function describeEdit(edit: Edit): string {
    if (!edit.from) return `adds \`${clip(edit.to)}\``;
    if (!edit.to) return `removes \`${clip(edit.from)}\``;
    return `\`${clip(edit.from)}\` to \`${clip(edit.to)}\``;
}

/** A hunk of the index, with the file it is in and its parsed lines, for the repeat and move passes. */
interface Located {
    file: IndexFile;
    hunk: ParsedHunk;
    id: string;
}

/** Hunks longer than this on either side are not offered as repeats: the same big block twice is more likely a move. */
const MAX_REPEAT_LINES = 12;

/**
 * Repeated edits: hunks that make the same word-level edit, grouped by the edit most of them share. A place that makes
 * other edits as well is still in the group, flagged with what else it changes, since a near-identical repeat can hide
 * a bug.
 */
function findRepeats(hunks: readonly Located[]): RepeatGroup[] {
    const candidates = hunks.filter(
        ({ hunk }) => hunk.removed.length <= MAX_REPEAT_LINES && hunk.added.length <= MAX_REPEAT_LINES
    );
    const edits = new Map(candidates.map((located) => [located.id, editsOf(located.hunk)]));
    const counts = new Map<string, number>();
    for (const list of edits.values()) for (const key of new Set(list.map(editKey))) counts.set(key, (counts.get(key) ?? 0) + 1);
    const groups = new Map<string, Located[]>();
    for (const located of candidates) {
        const meaningful = (edits.get(located.id) ?? []).filter((edit) => /[\p{L}\p{N}_]/u.test(edit.from + edit.to));
        let best: string | undefined;
        for (const edit of meaningful) {
            const key = editKey(edit);
            if ((counts.get(key) ?? 0) >= 2 && (!best || (counts.get(key) ?? 0) > (counts.get(best) ?? 0))) best = key;
        }
        if (best) groups.set(best, [...(groups.get(best) ?? []), located]);
    }
    const repeats: RepeatGroup[] = [];
    for (const [key, members] of groups) {
        if (members.length < 2) continue;
        const [from = '', to = ''] = key.split('\0');
        const places = members.map(({ file, hunk, id }): RepeatPlace => {
            const others = (edits.get(id) ?? []).filter((edit) => editKey(edit) !== key);
            const added = addedSpan(hunk);
            const removed = removedSpan(hunk);
            return {
                file: file.path,
                ...(added ? { new: added } : {}),
                ...(removed ? { old: removed } : {}),
                ...(others.length ? { differs: `also changes ${others.map(describeEdit).join('; ')}` } : {})
            };
        });
        repeats.push({ key: `R${repeats.length + 1}`, change: describeEdit({ from, to }), places });
    }
    return repeats;
}

/** A line worth matching for a move: one with at least two letters or digits once trimmed. */
function significant(line: string): boolean {
    return normal(line).replace(/[^\p{L}\p{N}]/gu, '').length >= 2;
}

/** A run of removed or added lines of a hunk, by number, with the significant ones' text. */
interface Run {
    located: Located;
    file: string;
    /** Where the run starts, and every line of it, normalised. */
    start: number;
    all: string[];
    lines: { number: number; text: string }[];
    set: Set<string>;
}

/** `span` widened over the closing braces and brackets either side of it in `run`, which a moved block takes along. */
function widen(run: Run, span: LineSpan): LineSpan {
    const brace = (number: number) => {
        const text = run.all[number - run.start];
        return text !== undefined && text !== '' && !significant(text);
    };
    let [first, last] = span;
    while (brace(first - 1)) first -= 1;
    while (brace(last + 1)) last += 1;
    return [first, last];
}

/** The smallest a moved block is, in lines. */
const MIN_MOVE = 3;

/** The span from the first to the last of `numbers`. */
function spanOf(numbers: number[]): LineSpan {
    return [Math.min(...numbers), Math.max(...numbers)];
}

/**
 * Moved code: a removed block and an added block, in different hunks, that share three or more significant lines and
 * at least 60% of the significant lines between their first and last shared line on each side. Each block moves once.
 * ponytail: matches sets of distinct lines, ignoring their order; compare the blocks line by line if reordered code
 * shows as moved.
 */
function findMoves(hunks: readonly Located[]): MovedBlock[] {
    const run = (located: Located, side: 'removed' | 'added'): Run | undefined => {
        const start = side === 'removed' ? located.hunk.oldStart : located.hunk.newStart;
        const all = located.hunk[side].map(normal);
        const lines = all.map((text, at) => ({ number: start + at, text })).filter((line) => significant(line.text));
        if (lines.length < MIN_MOVE) return undefined;
        const file = side === 'removed' ? (located.file.from ?? located.file.path) : located.file.path;
        return { located, file, start, all, lines, set: new Set(lines.map((line) => line.text)) };
    };
    const removed = hunks.flatMap((located) => run(located, 'removed') ?? []);
    const added = hunks.flatMap((located) => run(located, 'added') ?? []);
    const byLine = new Map<string, Run[]>();
    for (const target of added) for (const text of target.set) byLine.set(text, [...(byLine.get(text) ?? []), target]);
    const candidates: { shared: number; move: MovedBlock }[] = [];
    for (const source of removed) {
        const shared = new Map<Run, number>();
        for (const text of source.set)
            for (const target of byLine.get(text) ?? []) shared.set(target, (shared.get(target) ?? 0) + 1);
        for (const [target, count] of shared) {
            if (count < MIN_MOVE || target.located.id === source.located.id) continue;
            const fromLines = source.lines.filter((line) => target.set.has(line.text)).map((line) => line.number);
            const toLines = target.lines.filter((line) => source.set.has(line.text)).map((line) => line.number);
            const from = spanOf(fromLines);
            const to = spanOf(toLines);
            const within = (lines: Run['lines'], span: LineSpan) =>
                lines.filter((line) => line.number >= span[0] && line.number <= span[1]).length;
            if (count < 0.6 * within(source.lines, from) || count < 0.6 * within(target.lines, to)) continue;
            candidates.push({
                shared: count,
                move: {
                    from: { file: source.file, lines: widen(source, from) },
                    to: { file: target.file, lines: widen(target, to) }
                }
            });
        }
    }
    const moves: MovedBlock[] = [];
    const clashes = (a: { file: string; lines: LineSpan }, b: { file: string; lines: LineSpan }) =>
        a.file === b.file && a.lines[0] <= b.lines[1] && b.lines[0] <= a.lines[1];
    for (const { move } of candidates.sort((a, b) => b.shared - a.shared))
        if (!moves.some((taken) => clashes(taken.from, move.from) || clashes(taken.to, move.to))) moves.push(move);
    return moves;
}

/**
 * The line index from `base` to `head`: per file, its changed hunks and the hunks Bitbucket shows, whether it is a
 * lock, generated or binary file, which hunks change only spacing and whether it is a test; then the repeated edits
 * and moved blocks across files. Files are by path.
 */
export async function buildLineIndex(repoRoot: string, base: string, head: string): Promise<LineIndex> {
    const patch = (context: number) =>
        git(repoRoot, ['diff', '-M', `-U${context}`, '--no-color', '--no-ext-diff', '--no-textconv', base, head]);
    const [names, zero, three] = await Promise.all([nameStatus(repoRoot, base, head), patch(0), patch(3)]);
    const parsed = byName(parseFilePatches(zero), names);
    const shown = byName(parseFilePatches(three), names);
    const generated = await generatedPaths(
        repoRoot,
        head,
        names.map((file) => file.path)
    );
    const located: Located[] = [];
    const files = names.map((name, at): IndexFile => {
        const own = parsed[at] ?? { binary: false, hunks: [] };
        const housekeeping: Housekeeping | undefined = own.binary
            ? 'binary'
            : LOCK_FILES.has(basename(name.path))
              ? 'lock'
              : generated.has(name.path)
                ? 'generated'
                : undefined;
        const spacing = housekeeping ? [] : own.hunks.flatMap((hunk, index) => (spacingOnly(hunk) ? [index] : []));
        const file: IndexFile = {
            path: name.path,
            ...(name.from ? { from: name.from } : {}),
            hunks: own.hunks.map(({ oldStart, oldCount, newStart, newCount }) => ({ oldStart, oldCount, newStart, newCount })),
            shown: (shown[at]?.hunks ?? []).map(({ oldStart, oldCount, newStart, newCount }) => ({
                oldStart,
                oldCount,
                newStart,
                newCount
            })),
            ...(housekeeping ? { housekeeping } : {}),
            ...(spacing.length ? { spacing } : {}),
            ...(isTestPath(name.path) ? { test: true as const } : {})
        };
        if (!housekeeping)
            own.hunks.forEach((hunk, index) => {
                if (!spacing.includes(index)) located.push({ file, hunk, id: `${at}:${index}` });
            });
        return file;
    });
    return {
        files: files.sort((a, b) => a.path.localeCompare(b.path)),
        repeats: findRepeats(located),
        moves: findMoves(located)
    };
}
