/** Columns a tab counts for when measuring indentation. */
const TAB_WIDTH = 4;

/** A line's indentation in columns, or undefined for a blank line, which never opens or closes a fold. */
export function indentLevel(text: string): number | undefined {
    if (!text.trim()) return undefined;
    let level = 0;
    for (const char of text) {
        if (char === ' ') level += 1;
        else if (char === '\t') level += TAB_WIDTH - (level % TAB_WIDTH);
        else break;
    }
    return level;
}

/**
 * How many of `lines`, a header first, make up its block by indentation: the lines indented deeper than the header, and
 * any closing line at its level, such as `}` or `): void {`, which carries on when it opens another bracket.
 */
export function blockLength(lines: readonly string[]): number {
    const head = indentLevel(lines[0] ?? '') ?? 0;
    let length = 1;
    for (let at = 1; at < lines.length; at += 1) {
        const text = lines[at]!;
        const level = indentLevel(text);
        if (level === undefined) continue;
        if (level <= head && !/^\s*[)\]}]/.test(text)) break;
        length = at + 1;
        if (level <= head && !/[([{]\s*$/.test(text)) break;
    }
    return length;
}

/**
 * Indentation folding, the way editors fold code with no grammar to hand: a line opens a fold over
 * the lines after it that are indented deeper, so a function, a block or an object folds under its
 * header while the closing bracket stays in view. Blank lines inside a fold go with it; blank lines
 * at its end do not. Returns each fold's first line index mapped to its last.
 */
export function foldRanges(levels: readonly (number | undefined)[]): Map<number, number> {
    const folds = new Map<number, number>();
    const open: { line: number; level: number }[] = [];
    let last = -1;
    const close = (level: number) => {
        while (open.length && open[open.length - 1]!.level >= level) {
            const { line } = open.pop()!;
            if (last > line) folds.set(line, last);
        }
    };
    levels.forEach((level, line) => {
        if (level === undefined) return;
        close(level);
        open.push({ line, level });
        last = line;
    });
    close(-Infinity);
    return folds;
}
