import { describe, expect, it } from 'vitest';
import {
    ASSUMPTION_HOLDS,
    answerProblem,
    describeAnswer,
    type QuestionContent,
    questionContent,
    questionRecord
} from './questions.js';

/** The question record from HANDOFF.md, as the agent would send it. */
const handoffRecord = {
    id: 'Q-12',
    version: 3,
    group: 'deep-dive/failure-modes',
    title: 'When Redis is unreachable, should the API fail open or fail closed?',
    impact: 'high',
    context: {
        why: 'Redis is the only limit store.',
        findings: ['No fallback today'],
        refs: ['src/lib/redis.ts'],
        blocks: [{ type: 'flow', config: {} }]
    },
    input: 'single',
    options: [
        { id: 'a', label: 'Fail open', detail: 'Serve the call', tradeoff: 'Unlimited while Redis is down', recommended: true },
        { id: 'b', label: 'Fail closed', detail: 'Return 503' }
    ],
    allowOther: true,
    status: 'open',
    reviewed: false,
    answer: null,
    links: { dependsOn: ['Q-03'], unblocks: ['Q-14'], spec: 'rate-limits' }
};

const base = { group: 'scope', title: 'T', options: [{ id: 'a', label: 'A' }] };

describe('question records', () => {
    it('parses the handoff sample', () => {
        expect(questionContent.safeParse(handoffRecord).success).toBe(true);
    });

    it.each([
        { input: 'single', ...base },
        { input: 'multi', ...base },
        { input: 'chips', ...base },
        { input: 'freeform', group: 'scope', title: 'Anything else?' }
    ])('parses a $input question', (question) => {
        expect(questionContent.safeParse({ id: 'Q-1', ...question }).success).toBe(true);
    });

    it.each(['streaming', 'open', 'answered', 'needs-review', 'conflict', 'closed', 'merged'])('stores status %s', (status) => {
        const record = {
            id: 'Q-1',
            ...base,
            input: 'single',
            status,
            version: 1,
            contentVersion: 1,
            answer: null,
            createdAt: 'now',
            updatedAt: 'now'
        };
        expect(questionRecord.safeParse(record).success).toBe(true);
    });

    it('allows at most one recommended option', () => {
        const parsed = questionContent.safeParse({
            id: 'Q-1',
            group: 'scope',
            title: 'T',
            input: 'single',
            options: [
                { id: 'a', label: 'A', recommended: true },
                { id: 'b', label: 'B', recommended: true }
            ]
        });
        expect(parsed.success).toBe(false);
        expect(parsed.error?.issues[0]?.path).toEqual(['options', 1, 'recommended']);
    });

    it('needs options except for freeform, and a reason for a conflict', () => {
        expect(questionContent.safeParse({ id: 'Q-1', group: 'g', title: 'T', input: 'chips' }).success).toBe(false);
        expect(
            questionContent.safeParse({ id: 'Q-1', group: 'g', title: 'T', input: 'chips', status: 'streaming' }).success
        ).toBe(true);
        expect(questionContent.safeParse({ id: 'Q-1', ...base, input: 'single', status: 'conflict' }).success).toBe(false);
        expect(
            questionContent.safeParse({ id: 'Q-1', ...base, input: 'single', conflict: { with: 'Q-1', reason: 'x' } }).success
        ).toBe(false);
    });

    it('rejects ids that are not Q-<n>', () => {
        expect(questionContent.safeParse({ ...handoffRecord, id: 'twelve' }).success).toBe(false);
    });
});

describe('answers', () => {
    const single: QuestionContent = {
        id: 'Q-1',
        group: 'g',
        title: 'T',
        input: 'single',
        options: [{ id: 'a', label: 'Plans table' }]
    };

    it('checks an answer against its question', () => {
        expect(answerProblem(single, { choice: 'a' })).toBeNull();
        expect(answerProblem(single, { choice: 'z' })).toBe('option "z" does not exist');
        expect(answerProblem(single, { text: 'mine' })).toBe('this question does not take a written answer');
        expect(answerProblem({ ...single, allowOther: true }, { text: 'mine' })).toBeNull();
        expect(answerProblem({ ...single, input: 'chips' }, { text: 'mine' })).toBeNull();
        expect(answerProblem({ ...single, input: 'multi' }, { choices: [] })).toBe('pick at least one option');
        expect(answerProblem({ input: 'freeform' }, { text: '  ' })).toBe('a freeform answer needs text');
    });

    it('describes an answer in words', () => {
        expect(describeAnswer(single, { choice: 'a', note: 'n' })).toBe('Plans table');
        expect(describeAnswer(single, { choices: ['a'], text: ' own ' })).toBe('Plans table, own');
    });
});

describe('assumption and directions cards', () => {
    const assumption = { group: 'align/goals', title: 'Only the public API needs limits', input: 'assumption' };
    const directions = {
        group: 'explore/approach',
        title: 'Which ways should we investigate?',
        input: 'directions',
        options: [
            { id: 'redis', label: 'Redis token bucket', detail: 'Uses **Redis**', blocks: [{ type: 'flow', config: {} }] },
            { id: 'gateway', label: 'Gateway plugin' }
        ]
    };

    it('an assumption takes no options; a directions question carries blocks on its options', () => {
        expect(questionContent.safeParse({ id: 'Q-1', ...assumption }).success).toBe(true);
        expect(
            questionContent.safeParse({ id: 'Q-1', ...assumption, options: [{ id: 'a', label: 'A' }] }).error?.issues[0]
        ).toMatchObject({ message: 'an assumption has no options' });
        expect(questionContent.safeParse({ id: 'Q-2', ...directions }).success).toBe(true);
    });

    it('only a directions question has option blocks, and it belongs to no direction', () => {
        const blocks = { ...base, input: 'single', options: [{ id: 'a', label: 'A', blocks: [{ type: 'flow', config: {} }] }] };
        expect(questionContent.safeParse({ id: 'Q-3', ...blocks }).error?.issues[0]?.path).toEqual(['options', 0, 'blocks']);
        expect(questionContent.safeParse({ id: 'Q-2', ...directions, direction: 'redis' }).error?.issues[0]?.path).toEqual([
            'direction'
        ]);
        expect(questionContent.safeParse({ id: 'Q-4', ...base, input: 'single', direction: 'redis' }).success).toBe(true);
    });

    it('an assumption holds or is corrected, never both or neither', () => {
        const card = { input: 'assumption' as const };
        expect(answerProblem(card, { choice: ASSUMPTION_HOLDS })).toBeNull();
        expect(answerProblem(card, { text: 'Internal keys too' })).toBeNull();
        expect(answerProblem(card, { choice: ASSUMPTION_HOLDS, text: 'x' })).toBe(
            'an assumption either holds or is corrected, not both'
        );
        expect(answerProblem(card, {})).toBe('say whether it holds, or correct it');
        expect(answerProblem(card, { choice: 'a' })).toBe('an assumption holds or is corrected');
        expect(describeAnswer(card, { choice: ASSUMPTION_HOLDS })).toBe('Holds');
        expect(describeAnswer(card, { text: ' Internal keys too ' })).toBe('Not quite: Internal keys too');
    });

    it('an info card has no options, cannot conflict and takes no answer', () => {
        const info = { id: 'Q-5', group: 'deep-dive/limits', title: 'How requests reach the limiter', input: 'info' };
        expect(questionContent.safeParse({ ...info, context: { blocks: [{ type: 'flow', config: {} }] } }).success).toBe(true);
        expect(questionContent.safeParse({ ...info, options: [{ id: 'a', label: 'A' }] }).error?.issues[0]).toMatchObject({
            message: 'an info card has no options'
        });
        expect(questionContent.safeParse({ ...info, conflict: { with: 'Q-1', reason: 'x' } }).error?.issues[0]?.path).toEqual([
            'conflict'
        ]);
        expect(answerProblem({ input: 'info' }, { text: 'ok' })).toBe('an info card takes no answer');
    });

    it('a directions answer picks at least one direction to investigate', () => {
        const card = { input: 'directions' as const, options: directions.options };
        expect(answerProblem(card, { choices: ['redis', 'gateway'] })).toBeNull();
        expect(answerProblem(card, { choices: [] })).toBe('pick at least one direction to investigate');
        expect(answerProblem(card, { choices: ['edge'] })).toBe('option "edge" does not exist');
        expect(describeAnswer(card, { choices: ['redis', 'gateway'] })).toBe('Redis token bucket, Gateway plugin');
    });
});
