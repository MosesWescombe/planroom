import { symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { changedLines, housekeepingEntries, lineCount, uncovered } from '../shared/readthrough.js';
import { defined, gitRepo } from '../test/serverHelpers.js';
import { buildLineIndex, isTestPath } from './lineIndex.js';

const lines = (count: number, make: (n: number) => string) =>
    `${Array.from({ length: count }, (_, at) => make(at + 1)).join('\n')}\n`;

/** A ten-line function, with `limit` in its sixth line. */
const fn = (name: string, limit = 3) =>
    [
        `export function ${name}(job: Job) {`,
        '    const started = Date.now();',
        '    for (let attempt = 1; ; attempt += 1) {',
        '        try {',
        '            return deliver(job);',
        `        } catch (error) { if (attempt >= ${limit}) throw error; }`,
        "        log.warn('retrying', job.id);",
        '        sleep(backoff(attempt));',
        '    }',
        '}'
    ].join('\n');

describe('the line index', () => {
    it('follows a rename, and holds what Bitbucket shows with three lines of context', async () => {
        const repo = await gitRepo();
        const base = await repo.commit({ 'src/old.ts': lines(30, (n) => `export const line${n} = ${n};`) });
        await repo.run(['mv', 'src/old.ts', 'src/new.ts']);
        const head = await repo.commit({
            'src/new.ts': lines(30, (n) => `export const line${n} = ${n === 15 ? 'fifteen' : n};`)
        });
        const index = await buildLineIndex(repo.dir, base, head);
        const file = defined(index.files.find((entry) => entry.path === 'src/new.ts'));
        expect(file).toMatchObject({ from: 'src/old.ts', hunks: [{ oldStart: 15, oldCount: 1, newStart: 15, newCount: 1 }] });
        expect(file.shown).toEqual([{ oldStart: 12, oldCount: 7, newStart: 12, newCount: 7 }]);
        expect(lineCount(changedLines(index))).toBe(2);
    });

    it('groups a ten-place rename as one repeat, and flags the place that also changes an argument', async () => {
        const repo = await gitRepo();
        const file = (n: number, call: string) =>
            `import { send } from './send';\n\nexport function job${n}() {\n    return ${call};\n}\n`;
        const names = Array.from({ length: 10 }, (_, at) => `src/jobs/job${at + 1}.ts`);
        const base = await repo.commit(Object.fromEntries(names.map((name, at) => [name, file(at, 'send(job, retries: 3, 5)')])));
        const head = await repo.commit(
            Object.fromEntries(
                names.map((name, at) => [name, file(at, at === 6 ? 'send(job, policy, 10)' : 'send(job, policy, 5)')])
            )
        );
        const index = await buildLineIndex(repo.dir, base, head);
        expect(index.repeats).toHaveLength(1);
        const [group] = index.repeats;
        expect(group).toMatchObject({ key: 'R1', change: '`retries: 3` to `policy`' });
        expect(group!.places).toHaveLength(10);
        expect(group!.places.filter((place) => place.differs)).toEqual([
            { file: 'src/jobs/job7.ts', new: [4, 4], old: [4, 4], differs: 'also changes `5` to `10`' }
        ]);
    });

    it('finds a block moved to another file with one line changed on the way', async () => {
        const repo = await gitRepo();
        const base = await repo.commit({
            'src/a.ts': `import { deliver } from './deliver';\n\n${fn('send')}\n`,
            'src/b.ts': 'export const b = 1;\n'
        });
        const head = await repo.commit({
            'src/a.ts': "import { deliver } from './deliver';\n",
            'src/b.ts': `export const b = 1;\n\n${fn('send', 5)}\n`
        });
        const index = await buildLineIndex(repo.dir, base, head);
        expect(index.moves).toEqual([{ from: { file: 'src/a.ts', lines: [3, 12] }, to: { file: 'src/b.ts', lines: [3, 12] } }]);
    });

    it('puts lock, binary and generated files and spacing-only hunks on Housekeeping, and marks test files', async () => {
        const repo = await gitRepo();
        const base = await repo.commit({
            '.gitattributes': 'src/gen/** linguist-generated\n',
            'pnpm-lock.yaml': 'lockfileVersion: 9\n',
            'logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1, 2]).toString('latin1'),
            'src/gen/api.ts': 'export const api = 1;\n',
            'src/retry.ts': 'export function retry() {\n  return 3;\n}\n\nexport const limit = 3;\n',
            'src/retry.test.ts': "it('retries', () => {});\n"
        });
        const head = await repo.commit({
            'pnpm-lock.yaml': 'lockfileVersion: 10\n',
            'logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 3, 4]).toString('latin1'),
            'src/gen/api.ts': 'export const api = 2;\n',
            'src/retry.ts': 'export function retry() {\n    return 3;\n}\n\nexport const limit = 2;\n',
            'src/retry.test.ts': "it('retries twice', () => {});\n"
        });
        const index = await buildLineIndex(repo.dir, base, head);
        const of = (path: string) => defined(index.files.find((entry) => entry.path === path));
        expect(of('pnpm-lock.yaml').housekeeping).toBe('lock');
        expect(of('logo.png').housekeeping).toBe('binary');
        expect(of('src/gen/api.ts').housekeeping).toBe('generated');
        expect(of('src/retry.ts').spacing).toEqual([0]);
        expect(of('src/retry.test.ts').test).toBe(true);
        expect(housekeepingEntries(index).map((entry) => [entry.file, entry.why])).toEqual([
            ['logo.png', 'binary'],
            ['pnpm-lock.yaml', 'lock'],
            ['src/gen/api.ts', 'generated'],
            ['src/retry.ts', 'spacing']
        ]);
        // Only the real change to retry.ts and the test need a page.
        expect(uncovered(index, [])).toEqual([
            { file: 'src/retry.test.ts', side: 'new', spans: [[1, 1]] },
            { file: 'src/retry.test.ts', side: 'old', spans: [[1, 1]] },
            { file: 'src/retry.ts', side: 'new', spans: [[5, 5]] },
            { file: 'src/retry.ts', side: 'old', spans: [[5, 5]] }
        ]);
    });

    it('counts spacing that joins or splits two words as a real change', async () => {
        const repo = await gitRepo();
        const base = await repo.commit({ 'q.ts': 'const q = "SELECT a FROM t";\n// keep\ncall(a, b);\nreturn x\n  + y;\n' });
        const head = await repo.commit({ 'q.ts': 'const q = "SELECT aFROM t";\n// keep\ncall(a,b);\nreturn x + y;\n' });
        const index = await buildLineIndex(repo.dir, base, head);
        expect(defined(index.files.find((entry) => entry.path === 'q.ts')).spacing).toEqual([1]);
    });

    it('keeps the files after a type change on their own hunks', async () => {
        const repo = await gitRepo();
        const base = await repo.commit({ 'a.ts': 'one\ntwo\n', 'b.ts': lines(10, (n) => `const b${n} = ${n};`) });
        await repo.run(['rm', '--quiet', 'a.ts']);
        await symlink('b.ts', join(repo.dir, 'a.ts'));
        const head = await repo.commit({ 'b.ts': lines(10, (n) => `const b${n} = ${n === 4 ? 'four' : n};`) });
        const index = await buildLineIndex(repo.dir, base, head);
        expect(defined(index.files.find((entry) => entry.path === 'b.ts')).hunks).toEqual([
            { oldStart: 4, oldCount: 1, newStart: 4, newCount: 1 }
        ]);
        expect(defined(index.files.find((entry) => entry.path === 'a.ts')).hunks).toHaveLength(2);
    });

    it('tells test files by name and folder', () => {
        for (const path of ['src/a.test.ts', 'src/a.spec.tsx', 'test/a.ts', 'pkg/tests/a.py', 'src/__tests__/a.js'])
            expect(isTestPath(path)).toBe(true);
        for (const path of ['src/testing.ts', 'src/latest/a.ts', 'src/contest.ts']) expect(isTestPath(path)).toBe(false);
    });
});
