import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { PlanFormat } from '../shared/state.js';
import type { Patch } from '../shared/view.js';
import { commentThread } from '../test/fixtures.js';
import {
    CHANGE,
    defined,
    eventually,
    harness,
    type Outcome,
    onCleanup,
    section,
    tempRepo,
    textBlock,
    upsert
} from '../test/serverHelpers.js';
import { RejectedError } from './draft.js';
import { openSpecCli } from './openspec.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

const spec = (scenarioHashes = '####') =>
    [
        '## ADDED Requirements',
        '',
        '### Requirement: Fail open when the limit store is unavailable',
        '',
        'The API SHALL serve requests when Redis is unreachable.',
        '',
        `${scenarioHashes} Scenario: Redis down`,
        '',
        '- **WHEN** Redis times out',
        '- **THEN** the request is served',
        ''
    ].join('\n');

/** A session with a submitted write-up, ready for the agent to propose. */
async function submitted(outcome?: Outcome, validate = true, format?: PlanFormat) {
    const h = await harness({ outcome, ...(format ? { format } : {}) });
    await h.session.emit({ events: [upsert('Q-12')] });
    await h.session.handlePage({ type: 'answer.submit', questionId: 'Q-12', version: 1, answer: { choice: 'a' } });
    await h.session.handlePage({ type: 'phase.complete', path: 'finished' });
    await h.session.emit({ events: [textBlock('b1', 'Summary'), section('s1', 1, ['b1'])] });
    await h.session.handlePage({ type: 'review.mark', sectionId: 's1', reviewed: true });
    await h.session.handlePage({ type: 'phase.submit', changeId: CHANGE, revision: 1, validate });
    return h;
}

describe('a Markdown plan', () => {
    it('plan file missing, then plan written: checks <id>.md in place of openspec validate, and accepts once it is written', async () => {
        const { session, cli, repo } = await submitted(undefined, true, 'markdown');
        const plan = join(repo, 'agent-plans', CHANGE, `${CHANGE}.md`);
        await session.emit({ events: [{ type: 'proposal.ready' }] });
        await session.settled();
        expect(session.current.validation).toMatchObject({
            passed: false,
            issues: [{ path: `${CHANGE}.md`, message: `${CHANGE}.md does not exist in the plan folder` }]
        });
        expect(session.view().activity[0]).toMatchObject({ title: 'Validation failed', detail: `check ${CHANGE}.md` });

        await writeFile(plan, '  \n');
        await session.handlePage({ type: 'validation.rerun' });
        await session.settled();
        expect(session.current.validation?.issues[0]?.message).toBe(`${CHANGE}.md is empty`);

        await writeFile(plan, '# Rate limits - plan\n\n**Goal:** callers cannot overload the API.\n');
        await session.handlePage({ type: 'validation.rerun' });
        await session.settled();
        expect(cli.validations).toEqual([]);
        expect(session.current.phases.proposalUnlocked).toBe(true);
        await eventually(() => expect(session.view().proposal.files.map((file) => file.path)).toEqual([`${CHANGE}.md`]));
        await session.handlePage({ type: 'proposal.accept' });
        expect(session.current.phases.acceptedAt).not.toBeNull();
    });
});

describe('the proposal opens for review on strict validation', () => {
    it('refuses proposal.ready before the page has submitted', async () => {
        const { session } = await harness();
        await expect(session.emit({ events: [{ type: 'proposal.ready' }] })).rejects.toThrow(/needs a submission/);
    });

    it('validation passes: the review unlocks and the agent gets the result', async () => {
        const { session, cli } = await submitted();
        const result = await session.emit({ events: [{ type: 'proposal.ready' }] });
        expect(result.validating).toBe(true);
        await session.settled();
        expect(cli.validations).toEqual([CHANGE]);
        expect(cli.strict).toEqual([true]);
        expect(session.view().activity[0]).toMatchObject({ detail: `openspec validate ${CHANGE} --strict` });
        expect(session.current.phases.proposalUnlocked).toBe(true);
        expect(session.current.validation).toMatchObject({ passed: true, trigger: 'proposal.ready' });
        const last = (await session.wait(0, 1)).events.at(-1);
        expect(last).toMatchObject({ type: 'validation.result', passed: true });
    });

    it('validation fails: the review stays locked, and the page and the agent get the errors', async () => {
        const issues = [
            { level: 'ERROR', path: 'specs/rate-limits/spec.md', message: 'Requirement must have at least one scenario' }
        ];
        const { session } = await submitted({ passed: false, issues });
        await session.emit({ events: [{ type: 'proposal.ready' }] });
        await session.settled();
        expect(session.current.phases.proposalUnlocked).toBe(false);
        expect(session.current.validation?.issues).toEqual(issues);
        expect((await session.wait(0, 1)).events.at(-1)).toMatchObject({ type: 'validation.result', passed: false, issues });
    });

    it('re-run after a hand edit: the latest result replaces the shown status', async () => {
        const { session, cli } = await submitted({
            passed: false,
            issues: [{ level: 'ERROR', path: 'tasks.md', message: 'bad' }]
        });
        await session.emit({ events: [{ type: 'proposal.ready' }] });
        await session.settled();
        cli.outcome = { passed: true, issues: [] };
        await session.handlePage({ type: 'validation.rerun' });
        await session.settled();
        expect(session.current.validation).toMatchObject({ passed: true, trigger: 'rerun' });
        expect(session.current.phases.proposalUnlocked).toBe(true);
    });

    it('submitted without strict validation: runs plain openspec validate, on proposal.ready and on re-run', async () => {
        const { session, cli } = await submitted(undefined, false);
        await session.emit({ events: [{ type: 'proposal.ready' }] });
        await session.settled();
        await session.handlePage({ type: 'validation.rerun' });
        await session.settled();
        expect(cli.strict).toEqual([false, false]);
        expect(session.view().activity[0]).toMatchObject({ title: 'Validation passed', detail: `openspec validate ${CHANGE}` });
    });

    it('a validation that started before the user submitted again does not unlock the new submission', async () => {
        const { session, cli } = await submitted();
        const release = cli.hold();
        await session.emit({ events: [{ type: 'proposal.ready' }] });
        await session.handlePage({ type: 'phase.submit', changeId: CHANGE, revision: 1, validate: true });
        release();
        await session.settled();
        expect(session.current.phases.proposalUnlocked).toBe(false);
        expect(session.current.validation).toBeNull();
        expect((await session.wait(0, 0.01)).events.map((event) => event.type)).not.toContain('validation.result');
    });

    it('reports validating until the last of two overlapping validations finishes', async () => {
        const { session, cli } = await submitted();
        const releaseFirst = cli.hold();
        await session.emit({ events: [{ type: 'proposal.ready' }] });
        const releaseSecond = cli.hold();
        await session.handlePage({ type: 'validation.rerun' });
        releaseFirst();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(session.view().validating).toBe(true);
        releaseSecond();
        await session.settled();
        expect(session.view().validating).toBe(false);
    });

    it('a validation result that cannot be stored is logged, not left to crash the server', async () => {
        const { session, cli } = await submitted();
        const release = cli.hold();
        await session.emit({ events: [{ type: 'proposal.ready' }] });
        const unhandled = vi.fn();
        process.on('unhandledRejection', unhandled);
        const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const save = vi.spyOn(session.store, 'saveState').mockRejectedValueOnce(new Error('ENOSPC: no space left on device'));
        onCleanup(async () => {
            process.off('unhandledRejection', unhandled);
            logged.mockRestore();
            save.mockRestore();
        });
        release();
        await session.settled();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(unhandled).not.toHaveBeenCalled();
        expect(logged).toHaveBeenCalledWith(expect.stringContaining('validation result'), expect.any(Error));
        expect(session.view().validating).toBe(false);
    });

    it('a validation still running when the session closes writes nothing and notifies no one', async () => {
        const { session, cli } = await submitted();
        const notify = vi.fn(async () => undefined);
        session.setNotifier(notify);
        const release = cli.hold();
        await session.emit({ events: [{ type: 'proposal.ready' }] });
        await session.close();
        const onDisk = await readFile(session.store.stateFile, 'utf8');
        release();
        await session.settled();
        expect(await readFile(session.store.stateFile, 'utf8')).toBe(onDisk);
        expect(notify).not.toHaveBeenCalled();
    });

    it('reports validating while the CLI runs', async () => {
        const { session } = await submitted();
        const seen: boolean[] = [];
        session.subscribe((patches: Patch[]) =>
            patches.forEach((patch) => patch.field === 'validating' && seen.push(patch.value))
        );
        await session.emit({ events: [{ type: 'proposal.ready' }] });
        await session.settled();
        expect(seen).toEqual([true, false]);
    });
});

describe('accepting or requesting changes', () => {
    async function validated() {
        const h = await submitted();
        await h.session.emit({ events: [{ type: 'proposal.ready' }] });
        await h.session.settled();
        return h;
    }

    it('accept: tells the agent, and the session becomes read-only', async () => {
        const { session } = await validated();
        const ack = await session.handlePage({ type: 'proposal.accept' });
        expect(session.current.phases.acceptedAt).not.toBeNull();
        expect((await session.wait(defined(ack.seq) - 1, 1)).events[0]).toMatchObject({
            type: 'proposal.accept',
            changeId: CHANGE
        });
        await expect(session.emit({ events: [upsert('Q-99')] })).rejects.toThrow(/accepted.*read-only/);
        await expect(session.handlePage({ type: 'message.send', text: 'hi' })).rejects.toThrow(/read-only/);
    });

    it('end before the proposal validates: cancelled, and the session becomes read-only', async () => {
        const { session } = await submitted();
        const ack = await session.handlePage({ type: 'session.end' });
        expect(session.current.phases.ended).toMatchObject({ how: 'cancelled' });
        expect((await session.wait(defined(ack.seq) - 1, 1)).events[0]).toMatchObject({ type: 'session.end', how: 'cancelled' });
        await expect(session.emit({ events: [upsert('Q-99')] })).rejects.toThrow(/cancelled this session.*Stop/);
        await expect(session.handlePage({ type: 'session.end' })).rejects.toThrow(/read-only/);
    });

    it('end once the proposal validates: finished', async () => {
        const { session } = await validated();
        await session.handlePage({ type: 'session.end' });
        expect(session.current.phases.ended).toMatchObject({ how: 'finished' });
    });

    it('reopen: an accepted or ended session takes edits again, and the agent learns how it had been read-only', async () => {
        const { session } = await validated();
        await expect(session.handlePage({ type: 'session.reopen' })).rejects.toThrow('This session is not read-only');

        await session.handlePage({ type: 'proposal.accept' });
        const reopened = await session.handlePage({ type: 'session.reopen' });
        expect(session.current.phases).toMatchObject({ acceptedAt: null, proposalUnlocked: true });
        expect((await session.wait(defined(reopened.seq) - 1, 1)).events[0]).toMatchObject({
            type: 'session.reopen',
            from: 'accepted'
        });
        await session.emit({ events: [textBlock('b2', 'Revised after reopening'), section('s2', 2, ['b2'])] });

        await session.handlePage({ type: 'session.end' });
        const again = await session.handlePage({ type: 'session.reopen' });
        expect(session.current.phases.ended).toBeUndefined();
        expect((await session.wait(defined(again.seq) - 1, 1)).events[0]).toMatchObject({ from: 'finished' });
        await session.handlePage({ type: 'proposal.accept' });
    });

    it('accept after submitting again: waits for the new change to validate', async () => {
        const { session } = await validated();
        await session.handlePage({ type: 'phase.submit', changeId: CHANGE, revision: 1, validate: true });
        await expect(session.handlePage({ type: 'proposal.accept' })).rejects.toThrow('The agent is still writing the proposal');
    });

    it('accept blocked by a comment on the proposal', async () => {
        const { session } = await validated();
        const { anchor } = commentThread('x', 'file:specs/rate-limits/spec.md');
        await session.handlePage({ type: 'comment.create', anchor: defined(anchor), intent: 'change', text: 'Split this' });
        await expect(session.handlePage({ type: 'proposal.accept' })).rejects.toThrow(
            '1 comment on the proposal needs resolving'
        );
    });

    it('request changes needs an open proposal comment or a message', async () => {
        const { session } = await validated();
        await expect(session.handlePage({ type: 'proposal.requestChanges' })).rejects.toBeInstanceOf(RejectedError);
        const ack = await session.handlePage({ type: 'proposal.requestChanges', text: 'Split the spec in two' });
        expect((await session.wait(defined(ack.seq) - 1, 1)).events[0]).toMatchObject({
            type: 'proposal.requestChanges',
            text: 'Split the spec in two',
            threadId: 'M-1'
        });
    });
});

describe('traceability', () => {
    it('traced requirement: stored against the question ids, which must exist', async () => {
        const { session } = await submitted();
        await session.emit({
            events: [
                {
                    type: 'proposal.trace',
                    spec: 'rate-limits',
                    requirement: 'Fail open when the limit store is unavailable',
                    questions: ['Q-12']
                }
            ]
        });
        expect(session.current.traces).toEqual([
            { spec: 'rate-limits', requirement: 'Fail open when the limit store is unavailable', questions: ['Q-12'] }
        ]);
        await expect(
            session.emit({ events: [{ type: 'proposal.trace', requirement: 'R', questions: ['Q-40'] }] })
        ).rejects.toThrow(/Q-40 does not exist/);
    });
});

describe('the change renders as written on disk', () => {
    it('agent edits a spec from a comment: the proposal view updates without a reload', async () => {
        const { session, repo } = await harness();
        const dir = join(repo, 'openspec', 'changes', CHANGE);
        const proposals: string[][] = [];
        session.subscribe((patches) =>
            patches.forEach((patch) => patch.field === 'proposal' && proposals.push(patch.value.files.map((file) => file.path)))
        );
        await writeFile(join(dir, 'proposal.md'), '## Why\n\nLimits.\n');
        await mkdir(join(dir, 'specs', 'rate-limits'), { recursive: true });
        await writeFile(join(dir, 'specs', 'rate-limits', 'spec.md'), spec());
        await eventually(() => {
            const file = session.view().proposal.files.find((candidate) => candidate.path === 'specs/rate-limits/spec.md');
            expect(file?.spec?.sections[0]?.requirements[0]?.name).toBe('Fail open when the limit store is unavailable');
            expect(file?.marks).toEqual(['ADDED']);
        });
        expect(proposals.length).toBeGreaterThan(0);
        expect(session.view().proposal.files.some((file) => file.path.includes('.planroom'))).toBe(false);
    });
});

describe('the OpenSpec CLI runner', () => {
    const call = z.object({ args: z.array(z.string()), telemetry: z.string().nullable() });

    it.runIf(process.platform !== 'win32')('validates strictly only when asked, and never sends telemetry', async () => {
        const dir = await tempRepo();
        const calls = join(dir, 'calls.jsonl');
        const bin = join(dir, 'openspec.cjs');
        await writeFile(
            bin,
            [
                '#!/usr/bin/env node',
                `require('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args: process.argv.slice(2), telemetry: process.env.OPENSPEC_TELEMETRY ?? null }) + '\\n');`,
                `console.log(JSON.stringify({ items: [{ id: ${JSON.stringify(CHANGE)}, valid: true, issues: [] }] }));`
            ].join('\n'),
            { mode: 0o755 }
        );
        vi.stubEnv('OPENSPEC_TELEMETRY', '1');
        onCleanup(async () => void vi.unstubAllEnvs());
        const cli = openSpecCli(dir, bin);
        expect(await cli.validate(CHANGE, true)).toEqual({ passed: true, issues: [] });
        await cli.validate(CHANGE, false);
        const recorded = (await readFile(calls, 'utf8'))
            .trim()
            .split('\n')
            .map((line) => call.parse(JSON.parse(line)));
        expect(recorded).toEqual([
            { args: ['validate', CHANGE, '--strict', '--json', '--no-interactive'], telemetry: '0' },
            { args: ['validate', CHANGE, '--json', '--no-interactive'], telemetry: '0' }
        ]);
    });
});

describe('the real OpenSpec CLI', () => {
    async function repoWithChange(scenarioHashes: string) {
        const repo = await tempRepo();
        const cli = openSpecCli(repo, join(repoRoot, 'node_modules', '.bin', 'openspec'));
        await cli.newChange(CHANGE);
        const dir = join(repo, 'openspec', 'changes', CHANGE);
        await writeFile(
            join(dir, 'proposal.md'),
            '## Why\n\nLimits.\n\n## What Changes\n\n- Limits.\n\n## Impact\n\n- **api**: limits.\n'
        );
        await mkdir(join(dir, 'specs', 'rate-limits'), { recursive: true });
        await writeFile(join(dir, 'specs', 'rate-limits', 'spec.md'), spec(scenarioHashes));
        await mkdir(join(dir, '.planroom'), { recursive: true });
        await writeFile(join(dir, '.planroom', 'state.json'), '{}');
        return cli;
    }

    it('passes a valid change, ignoring its .planroom folder', async () => {
        const cli = await repoWithChange('####');
        expect(await cli.validate(CHANGE, true)).toEqual({ passed: true, issues: [] });
    });

    it('fails a scenario written with three hashes instead of four', async () => {
        const cli = await repoWithChange('###');
        const outcome = await cli.validate(CHANGE, true);
        expect(outcome.passed).toBe(false);
        expect(outcome.issues.length).toBeGreaterThan(0);
    });
});
