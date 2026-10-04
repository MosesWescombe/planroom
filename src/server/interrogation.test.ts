import { describe, expect, it } from 'vitest';
import { defined, harness, rejection, upsert } from '../test/serverHelpers.js';
import { RejectedError } from './draft.js';

const answer = (questionId: string, choice = 'a', extra: Record<string, unknown> = {}) => ({
    type: 'answer.submit',
    questionId,
    version: 1,
    answer: { choice, ...extra }
});

describe('saved answers go to the agent', () => {
    it('save: marks the question answered and sends the answer with its note', async () => {
        const { session } = await harness();
        await session.emit({
            events: [
                upsert('Q-14', {
                    options: [
                        { id: 'a', label: 'Plans table + per-key override', recommended: true },
                        { id: 'b', label: 'Plans table only' }
                    ]
                })
            ]
        });
        await session.handlePage(answer('Q-14', 'a', { note: 'Overrides expire after 30 days' }));
        expect(session.current.questions['Q-14']).toMatchObject({
            status: 'answered',
            version: 2,
            answer: { choice: 'a', note: 'Overrides expire after 30 days' }
        });
        const { events } = await session.wait(0, 1);
        expect(events[0]).toMatchObject({
            type: 'answer.submit',
            questionId: 'Q-14',
            version: 1,
            summary: 'Plans table + per-key override',
            answer: { note: 'Overrides expire after 30 days' },
            stale: false
        });
    });

    it('rejects an answer that does not fit the question, recording nothing', async () => {
        const { session } = await harness();
        await session.emit({ events: [upsert('Q-1')] });
        await expect(session.handlePage(answer('Q-1', 'zz'))).rejects.toThrow(/option "zz" does not exist/);
        expect(session.delivery.lastSeq).toBe(0);
    });

    it('marks an answer to an older wording as stale', async () => {
        const { session } = await harness();
        await session.emit({ events: [upsert('Q-1')] });
        await session.emit({ events: [upsert('Q-1', { title: 'Reworded' })] });
        await session.handlePage(answer('Q-1'));
        expect((await session.wait(0, 1)).events[0]).toMatchObject({ stale: true });
    });
});

describe('the activity feed', () => {
    it('logs a new question as one to answer, and an info card as a plain change', async () => {
        const { session } = await harness();
        await session.emit({ events: [upsert('Q-1'), upsert('Q-2', { input: 'info', options: undefined })] });
        const [info, question] = session.view().activity;
        expect(question).toMatchObject({ title: 'Added Q-1', ref: 'Q-1', kind: 'question' });
        expect(info).toMatchObject({ title: 'Added Q-2', ref: 'Q-2' });
        expect(info?.kind).toBeUndefined();
    });
});

describe('an agent change to an answered question needs review', () => {
    it('reworded question: needs review with the previous answer kept, and re-saving it answers again', async () => {
        const { session } = await harness();
        await session.emit({ events: [upsert('Q-13')] });
        await session.handlePage(answer('Q-13', 'b'));
        const result = await session.emit({ events: [upsert('Q-13', { title: 'Reworded by agent' })] });
        expect(result.applied[0]?.changed).toBe(true);
        expect(session.current.questions['Q-13']).toMatchObject({ status: 'needs-review', answer: { choice: 'b' } });
        expect(session.view().activity[0]).toMatchObject({ title: 'Reworded Q-13', detail: 'back to needs review' });
        await session.handlePage({ ...answer('Q-13', 'b'), version: defined(session.current.questions['Q-13']).contentVersion });
        expect(session.current.questions['Q-13']?.status).toBe('answered');
    });
});

describe('conflicting answers are surfaced', () => {
    it('availability conflict: choosing "Change Q-3" reopens Q-3 and tells the agent', async () => {
        const { session } = await harness();
        await session.emit({ events: [upsert('Q-3'), upsert('Q-12')] });
        await session.handlePage(answer('Q-3'));
        await session.handlePage(answer('Q-12', 'b'));
        await session.emit({
            events: [upsert('Q-12', { status: 'conflict', conflict: { with: 'Q-3', reason: 'Q-03 put availability first' } })]
        });
        expect(session.current.questions['Q-12']?.status).toBe('conflict');
        await session.handlePage({ type: 'conflict.resolve', questionId: 'Q-12', choice: 'change-other' });
        expect(session.current.questions['Q-3']?.status).toBe('open');
        expect(session.current.questions['Q-12']?.status).toBe('answered');
        const { events } = await session.wait(2, 1);
        expect(events[0]).toMatchObject({ type: 'conflict.resolve', questionId: 'Q-12', choice: 'change-other', other: 'Q-3' });
    });

    it('keeping this answer leaves the other question alone', async () => {
        const { session } = await harness();
        await session.emit({
            events: [upsert('Q-3'), upsert('Q-12', { status: 'conflict', conflict: { with: 'Q-3', reason: 'r' } })]
        });
        await session.handlePage(answer('Q-3'));
        await session.handlePage({ type: 'conflict.resolve', questionId: 'Q-12', choice: 'keep' });
        expect(session.current.questions['Q-3']?.status).toBe('answered');
        expect(session.current.questions['Q-12']?.status).toBe('open');
    });
});

describe('questions can be closed, merged, reopened and suggested', () => {
    it('closed by agent: collapses with the reason, and Reopen returns it to open and tells the agent', async () => {
        const { session } = await harness();
        await session.emit({ events: [upsert('Q-4'), upsert('Q-9')] });
        await session.emit({ events: [{ type: 'question.close', id: 'Q-9', reason: 'you ruled out penalties in Q-04' }] });
        expect(session.current.questions['Q-9']).toMatchObject({
            status: 'closed',
            closedReason: 'you ruled out penalties in Q-04'
        });
        await session.handlePage({ type: 'question.reopen', questionId: 'Q-9' });
        expect(session.current.questions['Q-9']?.status).toBe('open');
        expect(session.current.questions['Q-9']?.closedReason).toBeUndefined();
        expect((await session.wait(0, 1)).events[0]).toMatchObject({ type: 'question.reopen', questionId: 'Q-9' });
    });

    it('merges into another question, and refuses a merge into itself or a missing one', async () => {
        const { session } = await harness();
        await session.emit({ events: [upsert('Q-4'), upsert('Q-9')] });
        await session.emit({ events: [{ type: 'question.merge', id: 'Q-9', into: 'Q-4' }] });
        expect(session.current.questions['Q-9']).toMatchObject({ status: 'merged', mergedInto: 'Q-4' });
        await expect(session.emit({ events: [{ type: 'question.merge', id: 'Q-4', into: 'Q-4' }] })).rejects.toBeInstanceOf(
            RejectedError
        );
        await expect(session.emit({ events: [{ type: 'question.merge', id: 'Q-4', into: 'Q-77' }] })).rejects.toThrow(
            /Q-77 does not exist/
        );
    });

    it('user suggests a question: pending until the agent adds it', async () => {
        const { session } = await harness();
        await session.handlePage({ type: 'question.suggest', text: 'Should internal service keys skip limits?' });
        expect(session.current.suggestions['S-1']).toMatchObject({
            status: 'pending',
            text: 'Should internal service keys skip limits?'
        });
        expect((await session.wait(0, 1)).events[0]).toMatchObject({ type: 'question.suggest', suggestionId: 'S-1' });
        await session.emit({
            events: [{ ...upsert('Q-20', { title: 'Should internal service keys skip limits?' }), fromSuggestion: 'S-1' }]
        });
        expect(session.current.suggestions['S-1']).toMatchObject({ status: 'added', questionId: 'Q-20' });
    });

    it('the agent can decline a suggestion with a reason', async () => {
        const { session } = await harness();
        await session.handlePage({ type: 'question.suggest', text: 'Dup?' });
        await session.emit({ events: [{ type: 'suggestion.decline', id: 'S-1', reason: 'Q-3 already covers this' }] });
        expect(session.current.suggestions['S-1']).toMatchObject({ status: 'declined', reason: 'Q-3 already covers this' });
    });
});

describe('completing Phase 1', () => {
    it('all resolved: Finish is accepted and tells the agent', async () => {
        const { session } = await harness();
        await session.emit({ events: [upsert('Q-1'), upsert('Q-2')] });
        await expect(session.handlePage({ type: 'phase.complete', path: 'finished' })).rejects.toThrow(/cannot finish yet/);
        await session.handlePage(answer('Q-1'));
        await session.emit({ events: [{ type: 'question.close', id: 'Q-2', reason: 'not needed' }] });
        await session.handlePage({ type: 'phase.complete', path: 'finished' });
        expect(session.current.phases.phase1).toMatchObject({ completed: true, path: 'finished' });
        const { events } = await session.wait(1, 1);
        expect(events[0]).toMatchObject({ type: 'phase.complete', path: 'finished', assumptions: [] });
    });

    it('draft early: completes with the 8 open questions sent as assumptions', async () => {
        const { session } = await harness();
        await session.emit({ events: Array.from({ length: 10 }, (_, n) => upsert(`Q-${n + 1}`)) });
        await session.handlePage(answer('Q-1'));
        await session.handlePage(answer('Q-2'));
        await session.handlePage({ type: 'phase.complete', path: 'assumptions' });
        const { events } = await session.wait(2, 1);
        expect(events[0]).toMatchObject({ type: 'phase.complete', path: 'assumptions' });
        expect(events[0]?.type === 'phase.complete' && events[0].assumptions.map((item) => item.questionId)).toEqual([
            'Q-3',
            'Q-4',
            'Q-5',
            'Q-6',
            'Q-7',
            'Q-8',
            'Q-9',
            'Q-10'
        ]);
    });

    it('interrupt the agent: the question being written and the open one go as assumptions, then a batch adding a question is rejected and one updating a question applies', async () => {
        const { session } = await harness();
        await session.emit({ events: [upsert('Q-1'), upsert('Q-2', { status: 'streaming' })] });
        await session.handlePage({ type: 'phase.complete', path: 'assumptions' });
        expect((await session.wait(0, 1)).events[0]).toMatchObject({
            type: 'phase.complete',
            assumptions: [{ questionId: 'Q-1' }, { questionId: 'Q-2', status: 'streaming' }]
        });
        await expect(session.emit({ events: [upsert('Q-2'), upsert('Q-3')] })).rejects.toThrow(
            /finished Phase 1 early, so Q-3 cannot be added.*planroom_wait/
        );
        expect(session.current.questions['Q-3']).toBeUndefined();
        await session.emit({ events: [upsert('Q-2')] });
        expect(session.current.questions['Q-2']?.status).toBe('open');
    });
});

describe('phase 1 stages', () => {
    const agree = { type: 'stage.advance', to: 'explore' } as const;
    const offer = (options = ['redis', 'gateway'], id = 'Q-3') =>
        upsert(id, {
            group: 'explore/approach',
            title: 'Which ways should we investigate?',
            input: 'directions',
            options: options.map((id) => ({ id, label: `Direction ${id}` }))
        });
    const investigate = (choices: string[]) => ({
        type: 'answer.submit',
        questionId: 'Q-3',
        version: 1,
        answer: { choices }
    });

    it('the user agrees the goals: the agent gets the questions still open, and they stay open', async () => {
        const { session } = await harness();
        await session.emit({
            events: [
                upsert('Q-1', { group: 'align/goals' }),
                upsert('Q-2', { group: 'align/goals', input: 'assumption', options: [] })
            ]
        });
        await session.handlePage(answer('Q-1'));
        await session.handlePage(agree);
        expect(session.current.phases.phase1.aligned).toMatchObject({ by: 'user' });
        expect(session.current.questions['Q-2']?.status).toBe('open');
        const { events } = await session.wait(1, 1);
        expect(events[0]).toMatchObject({ type: 'stage.advance', to: 'explore', open: [{ questionId: 'Q-2' }] });
        await expect(session.handlePage(agree)).rejects.toThrow(/already agreed/);
    });

    it('directions before the goals are agreed: rejected, telling the agent to agree the goals, and accepted with stage.advance in the same batch', async () => {
        const { session } = await harness();
        const early = await rejection(session.emit({ events: [offer()] }));
        expect(early.issues[0]).toMatchObject({
            path: 'events[0].question.input',
            message: expect.stringMatching(/agree the goals/)
        });
        await session.emit({ events: [{ type: 'stage.advance', to: 'explore' }, offer()] });
        expect(session.current.phases.phase1.aligned).toMatchObject({ by: 'agent' });
        expect(session.current.questions['Q-3']?.input).toBe('directions');
    });

    it('pick directions: the agent receives both direction ids as the choices of the answer', async () => {
        const { session } = await harness();
        await session.emit({ events: [{ type: 'stage.advance', to: 'explore' }, offer()] });
        await session.handlePage(investigate(['redis', 'gateway']));
        expect((await session.wait(0, 1)).events[0]).toMatchObject({
            type: 'answer.submit',
            questionId: 'Q-3',
            answer: { choices: ['redis', 'gateway'] }
        });
    });

    it('there is one directions question', async () => {
        const { session } = await harness();
        await session.emit({ events: [{ type: 'stage.advance', to: 'explore' }, offer()] });
        const second = await rejection(session.emit({ events: [offer(['redis'], 'Q-4')] }));
        expect(second.issues[0]?.message).toMatch(/Q-3 already offers the directions/);
    });

    it('direction the user did not pick: a question joining it is rejected, and a question must name a real direction', async () => {
        const { session } = await harness();
        await session.emit({ events: [{ type: 'stage.advance', to: 'explore' }, offer()] });
        const unpicked = await rejection(session.emit({ events: [upsert('Q-4', { direction: 'redis' })] }));
        expect(unpicked.issues[0]).toMatchObject({ path: 'events[0].question.direction' });
        expect(unpicked.issues[0]?.message).toMatch(/did not choose to investigate "redis"/);
        await session.handlePage(investigate(['redis']));
        await session.emit({ events: [upsert('Q-4', { direction: 'redis' }), upsert('Q-5')] });
        expect(session.current.questions['Q-4']?.direction).toBe('redis');
        const unknown = await rejection(session.emit({ events: [upsert('Q-6', { direction: 'edge' })] }));
        expect(unknown.issues[0]?.message).toMatch(/Q-3 has no direction "edge"/);
        const dropped = await rejection(session.emit({ events: [offer(['gateway'])] }));
        expect(dropped.issues[0]).toMatchObject({ path: 'question Q-4', message: 'Q-3 has no direction "redis"' });
    });

    it('deep dive without a reason: rejected; with a reason the agent can skip exploring, but not once directions are offered', async () => {
        const { session } = await harness();
        const bare = await rejection(session.emit({ events: [{ type: 'stage.advance', to: 'deep-dive' }] }));
        expect(bare.issues[0]).toMatchObject({ path: 'events[0].reason' });
        await session.emit({ events: [{ type: 'stage.advance', to: 'deep-dive', reason: 'Only the gateway sees every call' }] });
        expect(session.current.phases.phase1).toMatchObject({
            aligned: { by: 'agent' },
            exploreSkipped: 'Only the gateway sees every call'
        });
        const other = await harness({ changeId: 'add-other' });
        await other.session.emit({ events: [{ type: 'stage.advance', to: 'explore' }, offer()] });
        const late = await rejection(other.session.emit({ events: [{ type: 'stage.advance', to: 'deep-dive', reason: 'x' }] }));
        expect(late.issues[0]?.message).toMatch(/already offered in Q-3/);
    });

    it('one clear way: explore is skipped with the reason, and Finish completes the phase as before', async () => {
        const { session } = await harness();
        await session.emit({
            events: [upsert('Q-1'), { type: 'stage.advance', to: 'deep-dive', reason: 'Only the gateway sees every request' }]
        });
        expect(session.current.phases.phase1.exploreSkipped).toBe('Only the gateway sees every request');
        await session.handlePage(answer('Q-1'));
        await session.handlePage({ type: 'phase.complete', path: 'finished' });
        expect(session.current.phases.phase1).toMatchObject({ completed: true, path: 'finished' });
    });

    it('going ahead with a direction: required once investigating, scoped to it, and named to the agent', async () => {
        const { session } = await harness();
        await session.emit({ events: [{ type: 'stage.advance', to: 'explore' }, offer()] });
        await session.handlePage(investigate(['redis', 'gateway']));
        await session.emit({
            events: [upsert('Q-4', { direction: 'redis' }), upsert('Q-5', { direction: 'gateway' }), upsert('Q-6')]
        });
        await session.handlePage(answer('Q-4'));
        await expect(session.handlePage({ type: 'phase.complete', path: 'finished' })).rejects.toThrow(/Choose the direction/);
        await expect(session.handlePage({ type: 'phase.complete', path: 'finished', direction: 'edge' })).rejects.toThrow(
            /not a direction you are investigating/
        );
        await expect(session.handlePage({ type: 'phase.complete', path: 'finished', direction: 'redis' })).rejects.toThrow(
            /1 of 3 questions/
        );
        await session.handlePage({ type: 'phase.complete', path: 'assumptions', direction: 'redis' });
        expect(session.current.phases.phase1).toMatchObject({ completed: true, direction: 'redis' });
        const { events } = await session.wait(2, 1);
        expect(events[0]).toMatchObject({
            type: 'phase.complete',
            direction: { id: 'redis', label: 'Direction redis' },
            assumptions: [{ questionId: 'Q-6' }]
        });
        const after = await rejection(session.emit({ events: [{ type: 'stage.advance', to: 'explore' }] }));
        expect(after.issues[0]?.message).toMatch(/finished Phase 1/);
    });
});
