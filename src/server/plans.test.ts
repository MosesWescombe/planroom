import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyState, type PlanFormat, planDir } from '../shared/state.js';
import { defined, tempRepo } from '../test/serverHelpers.js';
import { hasPlan, listPlans, listPlansElsewhere } from './plans.js';
import { knownRepos, registryFile, rememberRepo } from './registry.js';

/** Write a plan's state file, and a lock held by `pid` when given. */
async function plan(
    repo: string,
    changeId: string,
    lock?: { pid: number; url: string },
    format: PlanFormat = 'openspec'
): Promise<void> {
    const dir = join(repo, planDir(format, changeId), '.planroom');
    await mkdir(dir, { recursive: true });
    await writeFile(
        join(dir, 'state.json'),
        JSON.stringify(emptyState(changeId, `Plan ${changeId}`, '2026-10-02T00:00:00.000Z', format))
    );
    if (lock) await writeFile(join(dir, 'lock'), JSON.stringify({ ...lock, startedAt: 'x' }));
}

describe('the repo registry', () => {
    it('lives under XDG_STATE_HOME, else ~/.local/state', () => {
        expect(registryFile({ XDG_STATE_HOME: '/state' })).toBe('/state/planroom/repos.json');
        expect(registryFile({})).toMatch(/\.local\/state\/planroom\/repos\.json$/);
    });

    it('remembers each repo once, and reads a missing or broken file as empty', async () => {
        const file = join(await tempRepo(), 'state', 'repos.json');
        expect(await knownRepos(file)).toEqual([]);
        await rememberRepo(file, '/repos/b');
        await rememberRepo(file, '/repos/a/');
        await rememberRepo(file, '/repos/b');
        expect(await knownRepos(file)).toEqual(['/repos/a', '/repos/b']);
        await writeFile(file, 'not json');
        expect(await knownRepos(file)).toEqual([]);
    });
});

describe('plans in this repo', () => {
    it('lists OpenSpec and Markdown plans with their format, and leaves out folders with no plan', async () => {
        const repo = await tempRepo();
        await plan(repo, 'add-spec');
        await plan(repo, 'add-notes', undefined, 'markdown');
        await mkdir(join(repo, 'agent-plans', 'IOT-1-old-plan'), { recursive: true });
        const plans = await listPlans(repo);
        expect(
            plans.map(({ changeId, format }) => ({ changeId, format })).sort((a, b) => a.changeId.localeCompare(b.changeId))
        ).toEqual([
            { changeId: 'add-notes', format: 'markdown' },
            { changeId: 'add-spec', format: 'openspec' }
        ]);
        expect(await hasPlan(repo, 'add-notes')).toBe(true);
        expect(await hasPlan(repo, 'IOT-1-old-plan')).toBe(false);
    });
});

describe('plans in other repos', () => {
    it('lists the plans of every other known repo with any, and the live page of one another session holds', async () => {
        const [here, other, empty] = await Promise.all([tempRepo(), tempRepo(), tempRepo()]);
        const file = join(here, 'repos.json');
        for (const repo of [here, other, empty, '/repos/gone']) await rememberRepo(file, repo);
        await plan(here, 'add-here');
        await plan(other, 'add-live', { pid: process.ppid, url: 'http://127.0.0.1:4000/live/' });
        await plan(other, 'add-idle', { pid: 2 ** 22 + 1, url: 'http://127.0.0.1:4001/dead/' });
        await plan(other, 'add-own', { pid: process.pid, url: 'http://127.0.0.1:4002/mine/' });

        const elsewhere = await listPlansElsewhere(file, here);
        expect(elsewhere.map((repo) => repo.repoRoot)).toEqual([other]);
        const byId = Object.fromEntries(defined(elsewhere[0]).plans.map((summary) => [summary.changeId, summary]));
        expect(byId['add-live']?.liveUrl).toBe('http://127.0.0.1:4000/live/');
        expect(byId['add-idle']).not.toHaveProperty('liveUrl');
        expect(byId['add-own']).not.toHaveProperty('liveUrl');
        expect((await listPlans(here)).map((summary) => summary.changeId)).toEqual(['add-here']);
        expect(JSON.parse(await readFile(file, 'utf8')).repos).toHaveLength(4);
    });
});
