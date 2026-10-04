import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    CHANGE,
    defined,
    fakeCli,
    harness,
    onCleanup,
    rejection,
    section,
    tempRepo,
    textBlock,
    upsert
} from '../test/serverHelpers.js';
import { RejectedError } from './draft.js';
import { ChangeLockedError } from './lock.js';
import { findOpenSpecRoot } from './openspec.js';
import { Session } from './session.js';
import { SessionStore } from './store.js';

/** A process id that is running for the rest of the test. */
function livePid(): number {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    onCleanup(async () => void child.kill());
    return defined(child.pid, 'the child pid');
}

/** A process id that has exited. */
async function deadPid(): Promise<number> {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await new Promise((resolve) => child.once('exit', resolve));
    return defined(child.pid, 'the child pid');
}

describe('a Markdown plan', () => {
    it('new Markdown plan: lives in agent-plans/<id>/ with no OpenSpec change, and resumes there without naming the format', async () => {
        const h = await harness({ format: 'markdown' });
        expect(h.cli.created).toEqual([]);
        expect(existsSync(join(h.repo, 'agent-plans', CHANGE, '.planroom', 'state.json'))).toBe(true);
        expect(existsSync(join(h.repo, 'openspec', 'changes', CHANGE))).toBe(false);
        expect(h.session.view().format).toBe('markdown');
        await h.session.close();
        const { session, resumed } = await Session.open({ repoRoot: h.repo, changeId: CHANGE, cli: h.cli });
        onCleanup(() => session.close());
        expect(resumed).toBe(true);
        expect(session.current.format).toBe('markdown');
    });

    it('format fixed once created: refuses opening an existing plan in the other format, creating nothing', async () => {
        const h = await harness({ format: 'markdown' });
        await h.session.close();
        const error = await rejection(Session.open({ repoRoot: h.repo, changeId: CHANGE, cli: h.cli, format: 'openspec' }));
        expect(error.issues[0]?.message).toMatch(`already planned as a Markdown plan in agent-plans/${CHANGE}/`);
        expect(h.cli.created).toEqual([]);
    });

    it('refuses an id with a plan in both folders', async () => {
        const h = await harness({ format: 'markdown' });
        await h.session.close();
        await mkdir(join(h.repo, 'openspec', 'changes', CHANGE, '.planroom'), { recursive: true });
        await writeFile(
            join(h.repo, 'openspec', 'changes', CHANGE, '.planroom', 'state.json'),
            JSON.stringify(h.session.current)
        );
        const error = await rejection(Session.open({ repoRoot: h.repo, changeId: CHANGE, cli: h.cli }));
        expect(error.issues[0]?.message).toMatch(/has a plan in both/);
    });
});

describe('opening a session', () => {
    it('new change: creates the change folder and starts in Phase 1 with no questions', async () => {
        const { repo, cli, session } = await harness();
        expect(cli.created).toEqual([CHANGE]);
        expect(existsSync(join(repo, 'openspec', 'changes', CHANGE, '.planroom', 'state.json'))).toBe(true);
        expect(session.current.questions).toEqual({});
        expect(session.current.phases.phase1.completed).toBe(false);
    });

    it('invalid change id: rejects before writing anything', async () => {
        const repo = await tempRepo();
        const cli = fakeCli(repo);
        const opening = Session.open({ repoRoot: repo, changeId: 'Add Rate Limiting', cli });
        await expect(opening).rejects.toThrow(RejectedError);
        await expect(opening).rejects.toThrow(/kebab-case/);
        expect(cli.created).toEqual([]);
        expect(existsSync(join(repo, 'openspec', 'changes', 'Add Rate Limiting'))).toBe(false);
    });

    it('no openspec/ directory: rejects without scaffolding one', async () => {
        const repo = await tempRepo();
        await rm(join(repo, 'openspec'), { recursive: true });
        const cli = fakeCli(repo);
        await expect(Session.open({ repoRoot: repo, changeId: CHANGE, cli })).rejects.toThrow(/openspec init/);
        expect(cli.created).toEqual([]);
    });

    it('finds the repo from any directory under the nearest openspec/', async () => {
        const repo = await tempRepo();
        const nested = join(repo, 'apps', 'api');
        await mkdir(nested, { recursive: true });
        expect(findOpenSpecRoot(nested)).toBe(repo);
        expect(findOpenSpecRoot(repo)).toBe(repo);
        expect(findOpenSpecRoot(tmpdir())).toBeUndefined();
    });

    it('resume in a new agent session: restores questions, answers, blocks, comments, ticks and the phase', async () => {
        const h = await harness();
        const questions = Array.from({ length: 22 }, (_, n) => upsert(`Q-${n + 1}`));
        await h.session.emit({ events: questions });
        for (let n = 1; n <= 22; n += 1)
            await h.session.handlePage({ type: 'answer.submit', questionId: `Q-${n}`, version: 1, answer: { choice: 'a' } });
        await h.session.handlePage({ type: 'phase.complete', path: 'finished' });
        await h.session.emit({ events: [textBlock('b1', 'Summary text'), section('s1', 1, ['b1'])] });
        await h.session.handlePage({ type: 'review.mark', sectionId: 's1', reviewed: true });
        await h.session.handlePage({
            type: 'comment.create',
            anchor: {
                target: 'block:b1',
                position: { start: 0, end: 7 },
                quote: { exact: 'Summary', prefix: '', suffix: ' text' }
            },
            intent: 'question',
            text: 'Why?'
        });
        const before = h.session.current;

        const resumed = await h.reopen();
        expect(resumed.current).toEqual(before);
        expect(Object.keys(resumed.current.questions)).toHaveLength(22);
        expect(resumed.current.sections.s1?.reviewed).toBe(true);
        expect(resumed.current.threads['C-1']?.messages[0]?.text).toBe('Why?');
        expect(resumed.view().revisions).toHaveLength(1);
    });

    it('resumes with the agent cursor where the last agent session left it', async () => {
        const h = await harness();
        await h.session.emit({ events: [upsert('Q-1')] });
        await h.session.handlePage({ type: 'answer.submit', questionId: 'Q-1', version: 1, answer: { choice: 'a' } });
        await h.session.wait(1, 0.01);
        expect((await h.reopen()).current.agentCursor).toBe(1);
    });
});

describe('durability', () => {
    it('crash after an acknowledged answer: the answer is on disk before the acknowledgement', async () => {
        const { session } = await harness();
        await session.emit({ events: [upsert('Q-14')] });
        const ack = await session.handlePage({
            type: 'answer.submit',
            questionId: 'Q-14',
            version: 1,
            answer: { choice: 'b', note: 'with expiry' }
        });
        // Read what a restarted process would read, without closing the session.
        const loaded = await new SessionStore(session.store.dir).load();
        expect(loaded?.state.questions['Q-14']?.answer).toMatchObject({ choice: 'b', note: 'with expiry' });
        expect(loaded?.events.map((event) => event.seq)).toEqual([ack.seq]);
    });

    it('completes the log from the snapshot after a crash between the two writes', async () => {
        const { session } = await harness();
        await session.emit({ events: [upsert('Q-1')] });
        await session.handlePage({ type: 'question.suggest', text: 'First' });
        await session.handlePage({ type: 'question.suggest', text: 'Second' });
        const lines = (await readFile(session.store.eventsFile, 'utf8')).trim().split('\n');
        await writeFile(session.store.eventsFile, `${lines[0]}\n`);
        const loaded = await new SessionStore(session.store.dir).load();
        expect(loaded?.events.map((event) => event.seq)).toEqual([1, 2]);
        expect((await readFile(session.store.eventsFile, 'utf8')).trim().split('\n')).toHaveLength(2);
    });

    it('state.json gone but the log left: the fresh session starts its own log at seq 1 and keeps the old one aside', async () => {
        const h = await harness();
        await h.session.handlePage({ type: 'question.suggest', text: 'Old one' });
        await h.session.handlePage({ type: 'question.suggest', text: 'Old two' });
        const old = await readFile(h.session.store.eventsFile, 'utf8');
        await h.session.close();
        await rm(h.session.store.stateFile);
        const fresh = await h.reopen();
        expect((await fresh.handlePage({ type: 'question.suggest', text: 'New one' })).seq).toBe(1);
        const restarted = await h.reopen();
        expect((await restarted.wait(0, 0.01)).events.map((event) => event.seq)).toEqual([1]);
        expect(await restarted.wait(1, 0.01)).toMatchObject({ events: [], more: false });
        const aside = (await readdir(restarted.store.dir)).filter((name) => name.startsWith('events.jsonl.orphaned-'));
        expect(aside).toHaveLength(1);
        expect(await readFile(join(restarted.store.dir, defined(aside[0])), 'utf8')).toBe(old);
    });

    it('an older state.json checked out over a newer log: the log is moved aside and seqs continue from the snapshot', async () => {
        const h = await harness();
        await h.session.handlePage({ type: 'question.suggest', text: 'Kept' });
        await h.session.settled();
        const older = await readFile(h.session.store.stateFile, 'utf8');
        await h.session.handlePage({ type: 'question.suggest', text: 'Lost two' });
        await h.session.handlePage({ type: 'question.suggest', text: 'Lost three' });
        await h.session.close();
        await writeFile(h.session.store.stateFile, older);
        const resumed = await h.reopen();
        expect((await resumed.handlePage({ type: 'question.suggest', text: 'New two' })).seq).toBe(2);
        const loaded = await new SessionStore(resumed.store.dir).load();
        expect(loaded?.events.map((event) => event.seq)).toEqual([1, 2]);
        const aside = (await readdir(resumed.store.dir)).filter((name) => name.startsWith('events.jsonl.orphaned-'));
        expect(aside).toHaveLength(1);
    });

    it('repairs a torn final log line on a line of its own, so the next restart still loads', async () => {
        const h = await harness();
        await h.session.handlePage({ type: 'question.suggest', text: 'One' });
        await h.session.handlePage({ type: 'question.suggest', text: 'Two' });
        await h.session.close();
        const [first] = (await readFile(h.session.store.eventsFile, 'utf8')).split('\n');
        await writeFile(h.session.store.eventsFile, `${first}\n{"seq":2,"ty`);
        const resumed = await h.reopen();
        expect((await resumed.handlePage({ type: 'question.suggest', text: 'Three' })).seq).toBe(3);
        const loaded = await new SessionStore(resumed.store.dir).load();
        expect(loaded?.events.map((event) => event.seq)).toEqual([1, 2, 3]);
    });

    it('keeps a complete final log line that only lost its newline, so the next append leaves no gap', async () => {
        const h = await harness();
        await h.session.handlePage({ type: 'question.suggest', text: 'One' });
        await h.session.handlePage({ type: 'question.suggest', text: 'Two' });
        await h.session.close();
        await writeFile(h.session.store.eventsFile, (await readFile(h.session.store.eventsFile, 'utf8')).trimEnd());
        const resumed = await h.reopen();
        expect((await resumed.handlePage({ type: 'question.suggest', text: 'Three' })).seq).toBe(3);
        const loaded = await new SessionStore(resumed.store.dir).load();
        expect(loaded?.events.map((event) => event.seq)).toEqual([1, 2, 3]);
    });

    it('drops a torn final log line', async () => {
        const { session } = await harness();
        await session.handlePage({ type: 'question.suggest', text: 'One' });
        await writeFile(session.store.eventsFile, `${await readFile(session.store.eventsFile, 'utf8')}{"seq":2,"ty`);
        expect((await new SessionStore(session.store.dir).loadEvents()).map((event) => event.seq)).toEqual([1]);
    });
});

describe('one live session per change', () => {
    it('change already open: fails with the live page URL', async () => {
        const { repo, cli, session } = await harness();
        await session.close();
        await writeFile(
            join(repo, 'openspec', 'changes', CHANGE, '.planroom', 'lock'),
            JSON.stringify({ pid: livePid(), url: 'http://127.0.0.1:4000/t/', startedAt: 'x' })
        );
        const opening = Session.open({ repoRoot: repo, changeId: CHANGE, cli });
        await expect(opening).rejects.toThrow(ChangeLockedError);
        await expect(opening).rejects.toThrow(/http:\/\/127\.0\.0\.1:4000\/t\//);
    });

    it('stale hold: a lock left by a dead process is taken over', async () => {
        const { repo, cli, session } = await harness();
        await session.close();
        const lockFile = join(repo, 'openspec', 'changes', CHANGE, '.planroom', 'lock');
        await writeFile(lockFile, JSON.stringify({ pid: await deadPid(), url: 'http://127.0.0.1:4000/t/', startedAt: 'x' }));
        const { session: next, resumed } = await Session.open({ repoRoot: repo, changeId: CHANGE, cli });
        onCleanup(() => next.close());
        expect(resumed).toBe(true);
        expect(JSON.parse(await readFile(lockFile, 'utf8')).pid).toBe(process.pid);
    });

    it('releases the lock on close and records the page URL while open', async () => {
        const { session } = await harness();
        await session.publishUrl('http://127.0.0.1:5000/tok/');
        expect(JSON.parse(await readFile(session.store.lockFile, 'utf8')).url).toBe('http://127.0.0.1:5000/tok/');
        await session.close();
        expect(existsSync(session.store.lockFile)).toBe(false);
    });
});
