import { describe, expect, it } from 'vitest';
import {
    describeLeftover,
    type LineIndex,
    type PageRecord,
    pieceLines,
    readPieces,
    readProgress,
    roundPages,
    sharedTicks,
    type TickRecord,
    tickKey,
    uncovered
} from './readthrough.js';

const NOW = '2026-10-15T00:00:00.000Z';

/** One modified file with a replaced line, a pure insertion and a pure removal, a moved block and a three-place repeat. */
const INDEX: LineIndex = {
    files: [
        {
            path: 'src/a.ts',
            hunks: [
                { oldStart: 10, oldCount: 1, newStart: 10, newCount: 1 },
                { oldStart: 20, oldCount: 0, newStart: 21, newCount: 2 },
                { oldStart: 30, oldCount: 3, newStart: 31, newCount: 0 }
            ],
            shown: []
        },
        { path: 'src/b.ts', from: 'src/old-b.ts', hunks: [{ oldStart: 5, oldCount: 4, newStart: 4, newCount: 0 }], shown: [] },
        { path: 'src/c.ts', hunks: [{ oldStart: 1, oldCount: 0, newStart: 1, newCount: 4 }], shown: [] },
        ...['x', 'y', 'z'].map((name) => ({
            path: `src/${name}.ts`,
            hunks: [{ oldStart: 4, oldCount: 1, newStart: 4, newCount: 1 }],
            shown: []
        }))
    ],
    repeats: [
        {
            key: 'R1',
            change: '`a` to `b`',
            places: [
                { file: 'src/x.ts', new: [4, 4], old: [4, 4] },
                { file: 'src/y.ts', new: [4, 4], old: [4, 4], differs: 'also changes `1` to `2`' },
                { file: 'src/z.ts', new: [4, 4], old: [4, 4] }
            ]
        }
    ],
    moves: [{ from: { file: 'src/old-b.ts', lines: [5, 8] }, to: { file: 'src/c.ts', lines: [1, 4] } }]
};

describe('coverage', () => {
    it('covers a hunk’s removed lines with its added ones, and a pure removal with the lines either side of it', () => {
        const lines = pieceLines(INDEX, { id: 'p', file: 'src/a.ts', lines: '9-31' });
        expect(lines.get('src/a.ts')).toEqual({ added: new Set([10, 21, 22]), removed: new Set([10, 30, 31, 32]) });
    });

    it('covers a moved block in both places, and every place of a repeat from its example', () => {
        const moved = pieceLines(INDEX, {
            id: 'm',
            file: 'src/c.ts',
            lines: '1-4',
            from: { file: 'src/old-b.ts', oldLines: '5-8' }
        });
        expect(moved.get('src/c.ts')?.added.size).toBe(4);
        expect(moved.get('src/b.ts')?.removed).toEqual(new Set([5, 6, 7, 8]));
        const repeat = pieceLines(INDEX, { id: 'r', file: 'src/x.ts', lines: '4', repeat: 'R1' });
        expect([...repeat.keys()]).toEqual(['src/x.ts', 'src/y.ts', 'src/z.ts']);
    });

    it('names the lines no piece holds, by file and side', () => {
        const left = uncovered(INDEX, [{ id: 'p', file: 'src/a.ts', lines: '10' }]);
        expect(left.map(describeLeftover)).toEqual([
            'src/a.ts lines 21 to 22',
            'src/a.ts removed lines 30 to 32',
            'src/b.ts removed lines 5 to 8',
            'src/c.ts lines 1 to 4',
            'src/x.ts line 4',
            'src/x.ts removed line 4',
            'src/y.ts line 4',
            'src/y.ts removed line 4',
            'src/z.ts line 4',
            'src/z.ts removed line 4'
        ]);
    });
});

describe('reading', () => {
    const example = { id: 'r', file: 'src/x.ts', lines: '4', repeat: 'R1' };
    const page = {
        id: 'renames',
        kind: 'concept' as const,
        title: 'Renames',
        order: 1,
        pieces: [example],
        round: 1,
        added: [],
        version: 1,
        updatedAt: NOW
    };
    const tick: TickRecord = { how: 'manual', at: NOW };

    it('reads a repeat only once its example is ticked and the place that differs opened', () => {
        const read = (ticks: Record<string, TickRecord>) => readPieces({ pages: { '1:renames': page }, ticks }, INDEX, 1);
        expect(read({}).has('r')).toBe(false);
        const ticked = { [tickKey(1, 'r')]: tick };
        expect(read(ticked).has('r')).toBe(false);
        expect(read({ ...ticked, [tickKey(1, 'r', 1)]: tick }).has('r')).toBe(true);
    });

    it('reads code on several pages the same on each, and unticks it everywhere at once', () => {
        const whole = { id: 'whole', file: 'src/a.ts', lines: '9-31' };
        const part = { id: 'part', file: 'src/a.ts', lines: '10' };
        const other = { id: 'other', file: 'src/c.ts', lines: '1-4' };
        const pages = {
            '1:first': { ...page, id: 'first', pieces: [whole] },
            '1:second': { ...page, id: 'second', order: 2, pieces: [part, other] }
        };
        // Ticking the whole hunk reads the part of it on the other page, and nothing else there.
        const wholeRead = { pages, ticks: { [tickKey(1, 'whole')]: tick } };
        expect([...readPieces(wholeRead, INDEX, 1)].sort()).toEqual(['part', 'whole']);
        expect(readProgress(wholeRead, INDEX, 1).pages).toEqual({
            first: { read: 1, total: 1 },
            second: { read: 1, total: 2 }
        });
        // Ticking the part leaves the rest of the whole hunk unread.
        expect([...readPieces({ pages, ticks: { [tickKey(1, 'part')]: tick } }, INDEX, 1)]).toEqual(['part']);
        expect(sharedTicks({ pages }, INDEX, 1, [part]).sort()).toEqual([tickKey(1, 'part'), tickKey(1, 'whole')]);
        expect(sharedTicks({ pages }, INDEX, 1, [other])).toEqual([tickKey(1, 'other')]);
    });

    it('counts the lines of the whole change read, and ticks of another round not at all', () => {
        const ticks = { [tickKey(1, 'r')]: tick, [tickKey(1, 'r', 1)]: tick };
        expect(readProgress({ pages: { '1:renames': page }, ticks }, INDEX, 1)).toEqual({
            pages: { renames: { read: 1, total: 1 } },
            lines: { read: 6, total: 21 }
        });
        expect(readProgress({ pages: { '1:renames': page }, ticks }, INDEX, 2).lines.read).toBe(0);
    });
});

describe('reading order', () => {
    const page = (id: string, fields: Partial<PageRecord>): PageRecord => ({
        id,
        kind: 'concept',
        title: id,
        order: 1,
        pieces: [{ id: `${id}-piece`, file: 'src/x.ts', lines: '4' }],
        round: 1,
        added: [],
        version: 1,
        updatedAt: NOW,
        ...fields
    });

    it('keeps each group together where its first page falls, then the test pages, and only the round asked for', () => {
        const pages = [
            page('edges', { group: 'Edges', order: 2 }),
            page('tests', { kind: 'tests', order: 0 }),
            page('core-later', { group: 'Core', order: 3 }),
            page('core', { group: 'Core', order: 1 }),
            page('next-round', { group: 'Core', order: 0, round: 2 })
        ];
        const parts = { pages: Object.fromEntries(pages.map((entry) => [`${entry.round}:${entry.id}`, entry])) };
        expect(roundPages(parts, 1).map((entry) => entry.id)).toEqual(['core', 'core-later', 'edges', 'tests']);
    });
});
