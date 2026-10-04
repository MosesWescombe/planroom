import { describe, expect, it, vi } from 'vitest';
import type { LoggedEvent } from '../shared/events.js';
import type { Patch } from '../shared/view.js';
import { defined, harness, rejection, upsert } from '../test/serverHelpers.js';

const suggest = (text: string) => ({ type: 'question.suggest', text });

describe('agent writes are typed batches', () => {
    it('valid batch: two questions and the summary apply together in one update', async () => {
        const { session } = await harness();
        const updates: Patch[][] = [];
        session.subscribe((patches) => updates.push(patches));
        const result = await session.emit({
            events: [upsert('Q-12'), upsert('Q-13'), { type: 'understanding.update', text: 'Rate limits for the public API.' }]
        });
        expect(result.applied.map((entry) => [entry.ref, entry.version, entry.changed])).toEqual([
            ['Q-12', 1, true],
            ['Q-13', 1, true],
            ['understanding', 1, true]
        ]);
        const fields = defined(updates.find((patches) => patches.some((patch) => patch.field === 'questions')));
        expect(fields.map((patch) => ('id' in patch ? patch.id : patch.field))).toEqual(
            expect.arrayContaining(['Q-12', 'Q-13', 'understanding'])
        );
    });

    it('malformed batch: an unknown event type rejects the whole batch, naming it and its index', async () => {
        const { session } = await harness();
        const error = await rejection(session.emit({ events: [upsert('Q-12'), { type: 'question.delete', id: 'Q-12' }] }));
        expect(error.issues).toEqual([
            { path: 'events[1].type', message: expect.stringContaining('unknown event type "question.delete"') }
        ]);
        expect(session.current.questions).toEqual({});
    });

    it('rejects an event missing its target, with the field path, and applies nothing', async () => {
        const { session } = await harness();
        const error = await rejection(session.emit({ events: [upsert('Q-1'), { type: 'question.close', reason: 'x' }] }));
        expect(error.issues.map((issue) => issue.path)).toEqual(['events[1].id']);
        const missing = await rejection(
            session.emit({ events: [upsert('Q-1'), { type: 'question.close', id: 'Q-99', reason: 'x' }] })
        );
        expect(missing.issues).toEqual([{ path: 'events[1].id', message: 'question Q-99 does not exist' }]);
        expect(session.current.questions).toEqual({});
    });

    it('rejects a section that lists a block nobody sent', async () => {
        const { session } = await harness();
        const error = await rejection(
            session.emit({
                events: [{ type: 'doc.section.upsert', section: { id: 's1', title: 'One', order: 1, blocks: ['ghost'] } }]
            })
        );
        expect(error.issues[0]?.path).toBe('events[0].section.blocks[0]');
    });
});

describe('invalid block configs are stored and reported', () => {
    it('flow block with an edge to a missing node: reported with its path and stored for the error card', async () => {
        const { session } = await harness();
        const config = { nodes: [{ id: 'a', label: 'A' }], edges: [{ from: 'a', to: 'x' }] };
        const result = await session.emit({
            events: [{ type: 'doc.block.upsert', block: { id: 'wu-flow', type: 'flow', config } }]
        });
        expect(result.blockProblems).toEqual([
            { block: 'wu-flow', reason: 'invalid', issues: [{ path: 'edges[0].to', message: 'node "x" is not defined' }] }
        ]);
        expect(session.current.blocks['wu-flow']).toMatchObject({ config, problem: { reason: 'invalid' } });
    });

    it('stores an unknown block type with its raw config', async () => {
        const { session } = await harness();
        const result = await session.emit({
            events: [{ type: 'doc.block.upsert', block: { id: 'b1', type: 'sparkline', config: { points: [1, 2] } } }]
        });
        expect(result.blockProblems[0]).toMatchObject({ block: 'b1', reason: 'unknown-type' });
        expect(session.current.blocks.b1).toMatchObject({
            type: 'sparkline',
            config: { points: [1, 2] },
            problem: { reason: 'unknown-type' }
        });
    });

    it('reports a bad block inside a question context', async () => {
        const { session } = await harness();
        const result = await session.emit({
            events: [upsert('Q-12', { context: { blocks: [{ type: 'bar', config: { series: [] } }] } })]
        });
        expect(result.blockProblems[0]?.block).toBe('Q-12 context.blocks[0]');
    });
});

describe('the server owns record versions', () => {
    it('content change: Q-13 goes from version 2 to 3 and only its record is patched', async () => {
        const { session } = await harness();
        await session.emit({ events: [upsert('Q-12'), upsert('Q-13')] });
        await session.emit({ events: [upsert('Q-13', { title: 'Second wording' })] });
        const updates: Patch[][] = [];
        session.subscribe((patches) => updates.push(patches));
        const result = await session.emit({ events: [upsert('Q-12'), upsert('Q-13', { title: 'Third wording' })] });
        expect(result.applied.map((entry) => [entry.ref, entry.version, entry.changed])).toEqual([
            ['Q-12', 1, false],
            ['Q-13', 3, true]
        ]);
        const recordPatches = updates.flat().filter((patch) => patch.field === 'questions');
        expect(recordPatches.map((patch) => ('id' in patch ? patch.id : ''))).toEqual(['Q-13']);
    });

    it('no-op upsert: identical content keeps the version and patches nothing', async () => {
        const { session } = await harness();
        await session.emit({ events: [upsert('Q-13')] });
        const updates: Patch[][] = [];
        session.subscribe((patches) => updates.push(patches));
        const result = await session.emit({ events: [upsert('Q-13')] });
        expect(result.applied[0]).toMatchObject({ version: 1, changed: false });
        expect(updates.flat().filter((patch) => patch.field === 'questions')).toEqual([]);
    });

    it('ignores a version the agent tries to set', async () => {
        const { session } = await harness();
        await session.emit({
            events: [{ type: 'question.upsert', question: { id: 'Q-1', group: 'g', title: 'T', input: 'freeform', version: 40 } }]
        });
        expect(session.current.questions['Q-1']?.version).toBe(1);
    });
});

describe('page events form an ordered, replayable log', () => {
    it('read after a cursor: returns events 4 and 5 in order, each with its seq', async () => {
        const { session } = await harness();
        for (const n of [1, 2, 3, 4, 5]) await session.handlePage(suggest(`Suggestion ${n}`));
        const first = await session.wait(3, 1);
        expect(first.events.map((event) => event.seq)).toEqual([4, 5]);
        expect((await session.wait(3, 1)).events).toEqual(first.events);
    });

    it('resume after an agent restart: events recorded while no agent was connected are returned', async () => {
        const h = await harness();
        for (const n of [1, 2, 3, 4, 5, 6, 7]) await h.session.handlePage(suggest(`Before ${n}`));
        await h.session.wait(7, 0.01);
        await h.session.handlePage(suggest('While away 1'));
        await h.session.handlePage(suggest('While away 2'));
        const resumed = await h.reopen();
        expect(resumed.current.agentCursor).toBe(7);
        expect((await resumed.wait(7, 1)).events.map((event) => event.seq)).toEqual([8, 9]);
    });
});

describe('the agent can wait for events', () => {
    it('wait with nothing pending: returns the answer as soon as it is recorded', async () => {
        const { session } = await harness();
        await session.emit({ events: [upsert('Q-14')] });
        const waiting = session.wait(0, 30);
        expect(session.agentStatus().mode).toBe('waiting');
        const ack = await session.handlePage({ type: 'answer.submit', questionId: 'Q-14', version: 1, answer: { choice: 'a' } });
        const result = await waiting;
        expect(result).toMatchObject({ timedOut: false, events: [{ seq: ack.seq, type: 'answer.submit', questionId: 'Q-14' }] });
    });

    it('timeout: returns an empty list marked as timed out', async () => {
        const { session } = await harness();
        expect(await session.wait(0, 0.02)).toEqual({ events: [], timedOut: true, more: false });
    });

    it('an aborted wait returns at once', async () => {
        const { session } = await harness();
        const controller = new AbortController();
        const waiting = session.wait(0, 30, controller.signal);
        controller.abort();
        expect((await waiting).events).toEqual([]);
    });
});

describe('events are pushed when no wait is pending', () => {
    it('agent idle with channels: a comment is pushed with its seq, and reading past it confirms push', async () => {
        const { session } = await harness();
        const pushed: LoggedEvent[] = [];
        session.setNotifier(async (event) => void pushed.push(event));
        const ack = await session.handlePage({ type: 'message.send', text: 'Keep the EU edge in mind' });
        expect(pushed.map((event) => [event.seq, event.type])).toEqual([[ack.seq, 'message.send']]);
        expect(session.agentStatus().mode).not.toBe('push');
        await session.wait(defined(ack.seq), 0.01);
        expect(session.agentStatus().mode).toBe('push');
    });

    it('agent waiting: the answer comes through the wait and is not also pushed', async () => {
        const { session } = await harness();
        await session.emit({ events: [upsert('Q-1')] });
        const notifier = vi.fn(async () => undefined);
        session.setNotifier(notifier);
        const waiting = session.wait(0, 30);
        await session.handlePage({ type: 'answer.submit', questionId: 'Q-1', version: 1, answer: { choice: 'a' } });
        expect((await waiting).events).toHaveLength(1);
        expect(notifier).not.toHaveBeenCalled();
    });

    it('never delivers an event twice while a wait is pending', async () => {
        const { session } = await harness();
        const notifier = vi.fn(async () => undefined);
        session.setNotifier(notifier);
        const seen: number[] = [];
        let cursor = 0;
        for (let round = 0; round < 3; round += 1) {
            const waiting = session.wait(cursor, 30);
            await session.handlePage(suggest(`S${round}`));
            const { events } = await waiting;
            seen.push(...events.map((event) => event.seq));
            cursor = defined(events.at(-1)).seq;
        }
        expect(seen).toEqual([1, 2, 3]);
        expect(notifier).not.toHaveBeenCalled();
    });

    it('a pushed event that a later wait returns does not count as proof the channel works', async () => {
        const { session } = await harness();
        session.setNotifier(async () => undefined);
        await session.handlePage(suggest('pushed into the void'));
        expect((await session.wait(0, 1)).events).toHaveLength(1);
        await session.wait(1, 0.01);
        expect(session.agentStatus().mode).not.toBe('push');
    });
});

describe('events queue while the agent is away', () => {
    it('answer while offline: both answers queue, the page shows 2 queued, the next read returns both', async () => {
        const { session, clock } = await harness();
        await session.emit({ events: [upsert('Q-1'), upsert('Q-2')] });
        clock.advance(120_000);
        await session.handlePage({ type: 'answer.submit', questionId: 'Q-1', version: 1, answer: { choice: 'a' } });
        await session.handlePage({ type: 'answer.submit', questionId: 'Q-2', version: 1, answer: { choice: 'b' } });
        expect(session.agentStatus()).toEqual({ mode: 'offline', queued: 2 });
        expect((await session.wait(0, 1)).events.map((event) => event.type)).toEqual(['answer.submit', 'answer.submit']);
        expect(session.agentStatus().queued).toBe(0);
    });

    it('shows the agent as working, not offline, right after a tool call', async () => {
        const { session } = await harness();
        await session.emit({ events: [upsert('Q-1')] });
        expect(session.agentStatus()).toMatchObject({ mode: 'waiting', editing: 'Q-1', working: true });
    });

    it('stops showing the agent as working once it parks a wait, or after two quiet minutes', async () => {
        const { session, clock } = await harness();
        await session.emit({ events: [upsert('Q-1')] });
        const controller = new AbortController();
        const waiting = session.wait(1, 30, controller.signal);
        expect(session.agentStatus().working).toBeUndefined();
        controller.abort();
        await waiting;
        expect(session.agentStatus().working).toBe(true);
        clock.advance(120_000);
        expect(session.agentStatus()).toEqual({ mode: 'offline', queued: 0 });
    });
});

describe('the page says what the agent is on', () => {
    it('agent replying to a comment, then agent researching: names the comment a wait handed over, and what the agent says it is on until it waits again', async () => {
        const { session } = await harness();
        await session.emit({ events: [upsert('Q-1')] });
        await session.handlePage({
            type: 'comment.create',
            anchor: { target: 'question:Q-1' },
            intent: 'question',
            text: 'Which callers?'
        });
        await session.wait(0, 1);
        expect(session.agentStatus()).toMatchObject({ doing: 'replying to your comment on Q-1', thread: 'C-1' });

        await session.emit({ events: [], doing: 'Researching the callers' });
        expect(session.agentStatus()).toMatchObject({ doing: 'researching the callers', thread: 'C-1' });

        const controller = new AbortController();
        const waiting = session.wait(1, 30, controller.signal);
        controller.abort();
        await waiting;
        expect(session.agentStatus()).toMatchObject({ working: true, doing: 'drafting questions' });
        expect(session.agentStatus().thread).toBeUndefined();
    });

    it('counts several answers, and says the write-up once Phase 1 is complete', async () => {
        const { session } = await harness();
        await session.emit({ events: [upsert('Q-1'), upsert('Q-2')] });
        await session.handlePage({ type: 'answer.submit', questionId: 'Q-1', version: 1, answer: { choice: 'a' } });
        await session.handlePage({ type: 'answer.submit', questionId: 'Q-2', version: 1, answer: { choice: 'b' } });
        await session.wait(0, 1);
        expect(session.agentStatus().doing).toBe('following up on 2 answers');

        await session.handlePage({ type: 'phase.complete', path: 'finished' });
        await session.wait(2, 1);
        expect(session.agentStatus().doing).toBe('drafting the write-up');
    });

    it('agent waiting on its subagents: busy even with a wait parked, never offline for half an hour, until the list is cleared', async () => {
        const { session, clock } = await harness();
        await session.emit({ events: [], subagents: ['Reading the billing service', 'tracing alarm writes'] });
        clock.advance(10 * 60_000);
        expect(session.agentStatus()).toEqual({
            mode: 'waiting',
            queued: 0,
            working: true,
            doing: 'waiting on 2 subagents',
            subagents: ['reading the billing service', 'tracing alarm writes']
        });

        const controller = new AbortController();
        const waiting = session.wait(0, 30, controller.signal);
        expect(session.agentStatus()).toMatchObject({ mode: 'waiting', working: true, doing: 'waiting on 2 subagents' });
        controller.abort();
        await waiting;

        clock.advance(30 * 60_000);
        expect(session.agentStatus()).toEqual({
            mode: 'offline',
            queued: 0,
            subagents: ['reading the billing service', 'tracing alarm writes']
        });

        await session.emit({ events: [], subagents: [] });
        expect(session.agentStatus()).toMatchObject({ doing: 'drafting questions' });
        expect(session.agentStatus().subagents).toBeUndefined();
        clock.advance(120_000);
        expect(session.agentStatus()).toEqual({ mode: 'offline', queued: 0 });
    });

    it('rejects a batch with no events, doing or subagents', async () => {
        const { session } = await harness();
        const error = await rejection(session.emit({ events: [] }));
        expect(error.issues).toEqual([{ path: 'events', message: 'send at least one event, `doing` or `subagents`' }]);
    });
});
