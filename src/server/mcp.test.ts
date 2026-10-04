import { existsSync } from 'node:fs';
import { mkdir, readdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { emptyState } from '../shared/state.js';
import { openInput, stateInput, waitInput } from '../shared/tools.js';
import { CHANGE, connect, defined, eventually, section, tempRepo, textBlock, upsert } from '../test/serverHelpers.js';
import { openerCommand, openInBrowser } from './opener.js';
import { rememberRepo } from './registry.js';

describe('MCP tools', () => {
    it('lists the four tools with generated schemas, the channel capability and instructions', async () => {
        const { client } = await connect();
        const { tools } = await client.listTools();
        expect(tools.map((tool) => tool.name)).toEqual(['planroom_open', 'planroom_emit', 'planroom_wait', 'planroom_state']);
        const emit = defined(tools.find((tool) => tool.name === 'planroom_emit'));
        expect(JSON.stringify(emit.inputSchema)).toContain('question.upsert');
        expect(client.getServerCapabilities()?.experimental).toEqual({ 'claude/channel': {} });
        expect(client.getInstructions()).toMatch(/skip any seq you have already handled/);
    });

    it('generates the open, wait and state schemas from src/shared', async () => {
        const { client } = await connect();
        const { tools } = await client.listTools();
        const properties = (name: string) => tools.find((tool) => tool.name === name)?.inputSchema.properties;
        expect(properties('planroom_open')).toEqual(z.toJSONSchema(openInput, { io: 'input' }).properties);
        expect(properties('planroom_wait')).toEqual(z.toJSONSchema(waitInput, { io: 'input' }).properties);
        expect(properties('planroom_state')).toEqual(z.toJSONSchema(stateInput, { io: 'input' }).properties);
    });

    it('opens a session, returns its URL, and opens the browser', async () => {
        const { call, openBrowser, planroom, repo } = await connect();
        const { body } = await call('planroom_open', { changeId: CHANGE, title: 'API rate limiting' });
        expect(body).toMatchObject({ resumed: false, phase: 'interrogate', cursor: 0, repoRoot: repo, browserOpened: true });
        expect(body.url).toBe(planroom.url);
        expect(openBrowser).toHaveBeenCalledWith(body.url);
        const page = await fetch(body.url);
        expect(page.status).toBe(200);
    });

    it('no browser available: still succeeds and returns the URL', async () => {
        const { call } = await connect({ opened: false });
        const { isError, body } = await call('planroom_open', { changeId: CHANGE });
        expect(isError).toBe(false);
        expect(body).toMatchObject({ browserOpened: false, url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:/) });
    });

    it('re-opening the same change keeps its URL; another change gets a new one', async () => {
        const { call } = await connect();
        const first = (await call('planroom_open', { changeId: CHANGE })).body;
        expect((await call('planroom_open', { changeId: CHANGE })).body).toMatchObject({ url: first.url, resumed: true });
        const other = (await call('planroom_open', { changeId: 'add-audit-log' })).body;
        expect(other.url).not.toBe(first.url);
        expect((await fetch(first.url)).status).toBe(404);
    });

    it('opens a Markdown plan in agent-plans/, and refuses re-opening it as the other format', async () => {
        const { call, repo } = await connect();
        const { body } = await call('planroom_open', { changeId: CHANGE, format: 'markdown' });
        expect(body).toMatchObject({ resumed: false, format: 'markdown' });
        expect(existsSync(join(repo, 'agent-plans', CHANGE, '.planroom', 'state.json'))).toBe(true);
        expect(existsSync(join(repo, 'openspec', 'changes', CHANGE))).toBe(false);
        expect((await call('planroom_open', { changeId: CHANGE })).body).toMatchObject({ resumed: true, format: 'markdown' });
        expect(await call('planroom_open', { changeId: CHANGE, format: 'openspec' })).toMatchObject({
            isError: true,
            body: { issues: [{ path: 'format' }] }
        });
    });

    it('reports an invalid change id and every tool before open as errors', async () => {
        const { call } = await connect();
        expect(await call('planroom_emit', { events: [upsert('Q-1')] })).toMatchObject({
            isError: true,
            body: { issues: [{ message: expect.stringMatching(/planroom_open first/) }] }
        });
        expect((await call('planroom_open', { changeId: 'Add Rate Limiting' })).body.issues[0].message).toMatch(/kebab-case/);
    });

    it('emits, waits and returns state', async () => {
        const { call, planroom, repo } = await connect();
        await call('planroom_open', { changeId: CHANGE });
        expect((await call('planroom_emit', { events: [upsert('Q-1')], summary: 'First questions' })).body).toMatchObject({
            applied: [{ ref: 'Q-1', version: 1 }]
        });
        const bad = await call('planroom_emit', { events: [upsert('Q-2'), { type: 'question.delete' }] });
        expect(bad).toMatchObject({ isError: true, body: { issues: [{ path: 'events[1].type' }] } });

        await defined(planroom.session).handlePage({
            type: 'answer.submit',
            questionId: 'Q-1',
            version: 1,
            answer: { choice: 'a' }
        });
        expect((await call('planroom_wait', { after: 0 })).body).toMatchObject({
            events: [{ seq: 1, type: 'answer.submit' }],
            cursor: 1,
            timedOut: false
        });
        expect((await call('planroom_wait', { after: 1, timeoutSec: 1 })).body).toEqual({
            events: [],
            timedOut: true,
            more: false,
            cursor: 1
        });

        const state = (await call('planroom_state')).body;
        expect(state).toMatchObject({
            phase: 'interrogate',
            cursor: 1,
            latestSeq: 1,
            repoRoot: repo,
            phase1: { resolved: 1, total: 1, canFinish: true },
            decisions: [{ questionId: 'Q-1', choice: 'Option A' }]
        });
        expect(state.state.questions['Q-1'].status).toBe('answered');
        expect(state.state.lastEvent).toBeUndefined();
    });

    it('Shut down after accepting: the lock is released and the page stops answering', async () => {
        const { call, planroom, repo } = await connect();
        const { url } = (await call('planroom_open', { changeId: CHANGE })).body;
        const session = defined(planroom.session);
        await session.emit({ events: [upsert('Q-12')] });
        await session.handlePage({ type: 'answer.submit', questionId: 'Q-12', version: 1, answer: { choice: 'a' } });
        await session.handlePage({ type: 'phase.complete', path: 'finished' });
        await session.emit({ events: [textBlock('b1', 'Summary'), section('s1', 1, ['b1'])] });
        await session.handlePage({ type: 'review.mark', sectionId: 's1', reviewed: true });
        await session.handlePage({ type: 'phase.submit', changeId: CHANGE, revision: 1, validate: true });
        await session.emit({ events: [{ type: 'proposal.ready' }] });
        await session.settled();
        const { seq } = await session.handlePage({ type: 'proposal.accept' });
        expect((await call('planroom_wait', { after: defined(seq) - 1 })).body).toMatchObject({
            events: [{ type: 'proposal.accept' }]
        });
        await eventually(() => expect(planroom.session).toBeUndefined());
        expect(existsSync(join(repo, 'openspec', 'changes', CHANGE, '.planroom', 'lock'))).toBe(false);
        await expect(fetch(url)).rejects.toThrow();
        expect((await call('planroom_wait', { after: defined(seq) })).body.issues[0].message).toMatch(/planroom_open first/);
    });

    it('Resuming an ended session keeps it served: its end is from an earlier run', async () => {
        const { call, planroom } = await connect();
        await call('planroom_open', { changeId: CHANGE });
        await defined(planroom.session).handlePage({ type: 'session.end' });
        await call('planroom_wait', { after: 0 });
        await eventually(() => expect(planroom.session).toBeUndefined());
        const { url } = (await call('planroom_open', { changeId: CHANGE })).body;
        expect((await call('planroom_wait', { after: 0 })).body).toMatchObject({ events: [{ type: 'session.end' }] });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(planroom.session?.changeId).toBe(CHANGE);
        expect((await fetch(url)).status).toBe(200);
    });

    it('pushes page events as channel notifications when no wait is pending', async () => {
        const { call, planroom, notifications } = await connect();
        await call('planroom_open', { changeId: CHANGE });
        await defined(planroom.session).handlePage({ type: 'message.send', text: 'Keep the EU edge in mind' });
        await vi.waitFor(() => expect(notifications).toHaveLength(1));
        expect(notifications[0]).toMatchObject({
            method: 'notifications/claude/channel',
            params: {
                meta: { seq: '1', kind: 'message.send', change_id: CHANGE },
                content: expect.stringContaining('"text":"Keep the EU edge in mind"')
            }
        });
    });

    it('a failed open keeps the session that was open: an invalid id, or a change another session holds', async () => {
        const { call, repo, planroom } = await connect();
        const first = (await call('planroom_open', { changeId: CHANGE })).body;
        expect((await call('planroom_open', { changeId: 'Add Foo' })).isError).toBe(true);
        const held = join(repo, 'openspec', 'changes', 'add-other', '.planroom');
        await mkdir(held, { recursive: true });
        await writeFile(
            join(held, 'lock'),
            JSON.stringify({ pid: process.ppid, url: 'http://127.0.0.1:4000/held/', startedAt: 'x' })
        );
        expect((await call('planroom_open', { changeId: 'add-other' })).isError).toBe(true);
        expect(planroom.url).toBe(first.url);
        expect(planroom.session?.changeId).toBe(CHANGE);
        expect((await call('planroom_emit', { events: [upsert('Q-1')] })).isError).toBe(false);
        expect((await fetch(first.url)).status).toBe(200);
    });

    it('names the live page when another running session holds the change', async () => {
        const { call, repo } = await connect();
        await call('planroom_open', { changeId: CHANGE });
        await call('planroom_open', { changeId: 'add-other' });
        const holder = { pid: process.ppid, url: 'http://127.0.0.1:4000/held/', startedAt: 'x' };
        await writeFile(join(repo, 'openspec', 'changes', CHANGE, '.planroom', 'lock'), JSON.stringify(holder));
        const { isError, body } = await call('planroom_open', { changeId: CHANGE });
        expect(isError).toBe(true);
        expect(body).toMatchObject({ url: holder.url, error: expect.stringContaining(holder.url) });
    });
});

describe('switching plans from the page', () => {
    /** Two plans, the agent on CHANGE, and how the page posts a switch. */
    async function twoPlans() {
        const connected = await connect();
        const { call, repo } = connected;
        await call('planroom_open', { changeId: 'add-audit-log', title: 'Audit log' });
        const first = (await call('planroom_open', { changeId: CHANGE, title: 'API rate limiting' })).body;
        await mkdir(join(repo, 'openspec', 'changes', 'archive'));
        await mkdir(join(repo, 'openspec', 'changes', 'add-no-plan'));
        const switchTo = (changeId: string) =>
            fetch(`${first.url}api/plans/open`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ changeId })
            });
        return { ...connected, first, switchTo };
    }

    it('lists every plan in the repo, most recently changed first, with where each stands', async () => {
        const { first, repo } = await twoPlans();
        const older = join(repo, 'openspec', 'changes', 'add-audit-log', '.planroom', 'state.json');
        await utimes(older, new Date('2026-01-01'), new Date('2026-01-01'));
        const { plans } = await (await fetch(`${first.url}api/plans`)).json();
        expect(plans).toEqual([
            {
                changeId: CHANGE,
                title: 'API rate limiting',
                format: 'openspec',
                status: 'interrogate',
                updatedAt: expect.any(String)
            },
            {
                changeId: 'add-audit-log',
                title: 'Audit log',
                format: 'openspec',
                status: 'interrogate',
                updatedAt: '2026-01-01T00:00:00.000Z'
            }
        ]);
    });

    it("also lists other repos' plans when given the repo registry", async () => {
        const other = await tempRepo();
        const registryFile = join(other, 'repos.json');
        await rememberRepo(registryFile, other);
        await mkdir(join(other, 'openspec', 'changes', 'add-elsewhere', '.planroom'), { recursive: true });
        await writeFile(
            join(other, 'openspec', 'changes', 'add-elsewhere', '.planroom', 'state.json'),
            JSON.stringify(emptyState('add-elsewhere', 'Elsewhere', '2026-10-02T00:00:00.000Z'))
        );
        const { call } = await connect({ registryFile });
        const { url } = (await call('planroom_open', { changeId: CHANGE })).body;
        const listing = await (await fetch(`${url}api/plans`)).json();
        expect(listing.plans.map((plan: { changeId: string }) => plan.changeId)).toEqual([CHANGE]);
        expect(listing.elsewhere).toEqual([
            { repoRoot: other, plans: [expect.objectContaining({ changeId: 'add-elsewhere', status: 'interrogate' })] }
        ]);
    });

    it('serves the chosen plan under a new URL and makes the agent load it before it emits or waits again', async () => {
        const { call, planroom, first, switchTo, openBrowser } = await twoPlans();
        const parked = call('planroom_wait', { after: 0, timeoutSec: 30 });
        const response = await switchTo('add-audit-log');
        expect(response.status).toBe(200);
        const { url } = await response.json();
        expect(url).toBe(planroom.url);
        expect(url).not.toBe(first.url);
        expect(planroom.session?.changeId).toBe('add-audit-log');
        expect((await fetch(first.url)).status).toBe(404);
        expect(openBrowser).toHaveBeenCalledTimes(2);

        expect((await parked).body).toMatchObject({ events: [], timedOut: true });
        for (const [name, args] of [
            ['planroom_emit', { events: [upsert('Q-1')] }],
            ['planroom_wait', { after: 0, timeoutSec: 1 }]
        ] as const) {
            expect(await call(name, args)).toMatchObject({
                isError: true,
                body: {
                    issues: [
                        { message: expect.stringMatching(/switched the page to the plan for add-audit-log.*planroom_state/) }
                    ]
                }
            });
        }
        expect((await call('planroom_state')).body).toMatchObject({ url, state: { changeId: 'add-audit-log' } });
        expect((await call('planroom_emit', { events: [upsert('Q-1')] })).isError).toBe(false);
    });

    it('opens only a change that has a plan, and creates nothing', async () => {
        const { call, repo, switchTo, first } = await twoPlans();
        for (const changeId of ['add-no-plan', 'add-unknown', '../add-audit-log', 'archive', '']) {
            const response = await switchTo(changeId);
            expect(response.status).toBe(404);
        }
        expect((await readdir(join(repo, 'openspec', 'changes'))).sort()).toEqual([
            'add-api-rate-limiting',
            'add-audit-log',
            'add-no-plan',
            'archive'
        ]);
        expect(await readdir(join(repo, 'openspec', 'changes', 'add-no-plan'))).toEqual([]);
        const same = await switchTo(CHANGE);
        expect(await same.json()).toEqual({ url: first.url });
        expect((await call('planroom_emit', { events: [upsert('Q-1')] })).isError).toBe(false);
    });

    it('names the live page when another running session holds the chosen plan', async () => {
        const { repo, switchTo } = await twoPlans();
        const holder = { pid: process.ppid, url: 'http://127.0.0.1:4000/held/', startedAt: 'x' };
        await writeFile(join(repo, 'openspec', 'changes', 'add-audit-log', '.planroom', 'lock'), JSON.stringify(holder));
        const response = await switchTo('add-audit-log');
        expect(response.status).toBe(409);
        expect((await response.json()).issues[0].message).toContain(holder.url);
    });
});

describe('the plan browser from a Claude session', () => {
    it('opens with no change id, parks a wait until the user picks a plan, then makes the agent load it', async () => {
        const { call, planroom, repo, openBrowser } = await connect();
        const dir = join(repo, 'openspec', 'changes', 'add-audit-log', '.planroom');
        await mkdir(dir, { recursive: true });
        await writeFile(
            join(dir, 'state.json'),
            JSON.stringify(emptyState('add-audit-log', 'Audit log', '2026-10-05T00:00:00.000Z'))
        );

        const opened = (await call('planroom_open', {})).body;
        expect(opened).toMatchObject({ browsing: true, browserOpened: true, repoRoot: repo });
        expect(openBrowser).toHaveBeenLastCalledWith(opened.url);
        expect(planroom.session).toBeUndefined();
        const reader = defined((await fetch(`${opened.url}api/stream`)).body).getReader();
        let received = '';
        while (!received.includes('"type":"browse"')) received += new TextDecoder().decode((await reader.read()).value);
        expect(received).toContain('{"type":"browse","readOnly":false}');
        await reader.cancel();
        expect((await fetch(`${opened.url}api/events`, { method: 'POST' })).status).toBe(404);

        expect((await call('planroom_wait', { after: 0, timeoutSec: 1 })).body).toMatchObject({ events: [], timedOut: true });
        const parked = call('planroom_wait', { after: 0, timeoutSec: 30 });
        const picked = await fetch(`${opened.url}api/plans/open`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ changeId: 'add-audit-log' })
        });
        expect(picked.status).toBe(200);
        expect(await parked).toMatchObject({
            isError: true,
            body: { issues: [{ message: expect.stringMatching(/switched the page to the plan for add-audit-log/) }] }
        });
        expect((await call('planroom_state')).body).toMatchObject({ state: { changeId: 'add-audit-log' } });
    });
});

describe('the browser opener', () => {
    it('uses the platform opener', () => {
        expect(openerCommand('http://x/', 'linux')).toEqual({ command: 'xdg-open', args: ['http://x/'] });
        expect(openerCommand('http://x/', 'darwin')).toEqual({ command: 'open', args: ['http://x/'] });
        expect(openerCommand('http://x/', 'win32').command).toBe('cmd');
    });

    it.runIf(process.platform === 'linux')('resolves false when no opener can run', async () => {
        const path = process.env.PATH;
        process.env.PATH = '';
        try {
            expect(await openInBrowser('http://127.0.0.1:1/')).toBe(false);
        } finally {
            process.env.PATH = path;
        }
    });
});
