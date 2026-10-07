import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitRepo } from '../test/serverHelpers.js';
import { changedFiles, changedLines, defaultBranch, ensureWorktree, filePatch, mergeBase, removeWorktree } from './worktree.js';

const retry = (attempts: number) => `export function retry() {\n    return ${attempts};\n}\n`;

describe('the review worktree', () => {
    it('checks out the reviewed commit beside the working copy, leaving the working copy and its edits alone', async () => {
        const repo = await gitRepo();
        await repo.commit({ 'src/retry.ts': retry(3) }, 'base');
        await repo.run(['checkout', '--quiet', '-b', 'feature/retry']);
        const head = await repo.commit({ 'src/retry.ts': retry(2) }, 'cap retries');
        await repo.run(['checkout', '--quiet', 'main']);
        await writeFile(join(repo.dir, 'src/retry.ts'), 'uncommitted edit\n');

        const dir = join(repo.dir, '.planroom', 'reviews', 'branch-feature-retry', 'worktree');
        await ensureWorktree(repo.dir, dir, head);

        expect(await readFile(join(dir, 'src/retry.ts'), 'utf8')).toBe(retry(2));
        expect((await repo.run(['rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe('main');
        expect(await readFile(join(repo.dir, 'src/retry.ts'), 'utf8')).toBe('uncommitted edit\n');
        expect(await repo.run(['worktree', 'list'])).toContain(dir);

        await removeWorktree(repo.dir, dir);
        expect(existsSync(dir)).toBe(false);
        expect(await repo.run(['worktree', 'list'])).not.toContain(dir);
    });

    it('moves the worktree to a new head, and replaces a plain folder without touching the working copy', async () => {
        const repo = await gitRepo();
        const first = await repo.commit({ 'a.txt': 'one\n' });
        const second = await repo.commit({ 'a.txt': 'two\n' });
        const dir = join(repo.dir, '.planroom', 'reviews', 'pr-1', 'worktree');
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'stray.txt'), 'left by a crash\n');

        await ensureWorktree(repo.dir, dir, first);
        expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('one\n');
        expect((await repo.run(['rev-parse', 'HEAD'])).trim()).toBe(second);

        await ensureWorktree(repo.dir, dir, second);
        expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('two\n');
        expect(existsSync(join(dir, 'stray.txt'))).toBe(false);
    });
});

describe('reading the change', () => {
    it('finds a branch against its merge base with the default branch, and lists its files with line counts', async () => {
        const repo = await gitRepo();
        await repo.commit({ 'src/retry.ts': retry(3), 'src/old.ts': 'x\n', 'src/move.ts': 'a\nb\nc\nd\ne\n' }, 'base');
        await repo.run(['checkout', '--quiet', '-b', 'feature']);
        await repo.run(['mv', 'src/move.ts', 'src/moved.ts']);
        const head = await repo.commit({ 'src/retry.ts': retry(2), 'src/old.ts': null, 'src/new.ts': 'y\nz\n' });
        await repo.run(['checkout', '--quiet', 'main']);
        await repo.commit({ 'other.txt': 'main moved on\n' });

        expect(await defaultBranch(repo.dir)).toBe('main');
        const base = await mergeBase(repo.dir, 'main', head);
        expect(await changedFiles(repo.dir, base, head)).toEqual([
            { path: 'src/moved.ts', status: 'renamed', from: 'src/move.ts', additions: 0, deletions: 0 },
            { path: 'src/new.ts', status: 'added', additions: 2, deletions: 0 },
            { path: 'src/old.ts', status: 'removed', additions: 0, deletions: 1 },
            { path: 'src/retry.ts', status: 'modified', additions: 1, deletions: 1 }
        ]);
        expect(await filePatch(repo.dir, base, head, 'src/retry.ts')).toContain('+    return 2;');
    });

    it('names the lines a later commit changed, by their numbers before it, and the ones it deleted outright', async () => {
        const repo = await gitRepo();
        const before = await repo.commit({ 'f.txt': 'a\nb\nc\nd\ne\n' });
        const after = await repo.commit({ 'f.txt': 'a\nB\nc\nnew\nd\n' });
        const lines = await changedLines(repo.dir, before, after, 'f.txt');
        expect([...lines.removed]).toEqual([5]);
        expect([...lines.touched].sort()).toEqual([2, 4, 5]);
    });
});
