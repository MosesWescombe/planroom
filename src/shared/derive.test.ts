import { describe, expect, it } from 'vitest';
import {
    blockRecord,
    commentThread,
    NOW,
    phasesWith,
    questionContent,
    questionRecord,
    sectionRecord,
    stateWith
} from '../test/fixtures.js';
import type { QuestionRecord } from './questions.js';
import {
    acceptGate,
    canRequestChanges,
    currentPhase,
    decisionRows,
    describeCounts,
    directionTabs,
    groupProgress,
    investigatedDirections,
    listingProblems,
    outstandingItems,
    pagePhase,
    phase1Gate,
    phase1Stage,
    submitCounts,
    tabs,
    threadScope,
    tracedAnswers,
    traceFor,
    unreview,
    upsertQuestion
} from './derive.js';

const LATER = '2026-09-29T01:00:00.000Z';
const passed = { passed: true, issues: [], trigger: 'proposal.ready' as const, at: NOW };

describe('upsertQuestion', () => {
    it('creates a new question at version 1, open', () => {
        const { record, changed } = upsertQuestion(undefined, questionContent('Q-1'), NOW);
        expect(changed).toBe(true);
        expect(record).toMatchObject({ id: 'Q-1', status: 'open', version: 1, contentVersion: 1, answer: null });
    });

    it('no-op upsert: identical content keeps the version and reports no change', () => {
        const existing = questionRecord('Q-13', 'open', { version: 3, contentVersion: 3 });
        const { record, changed } = upsertQuestion(existing, questionContent('Q-13'), LATER);
        expect(changed).toBe(false);
        expect(record).toBe(existing);
    });

    it('content change: bumps the version by one', () => {
        const existing = questionRecord('Q-13', 'open', { version: 2, contentVersion: 2 });
        const { record } = upsertQuestion(existing, questionContent('Q-13', { title: 'Reworded' }), LATER);
        expect(record).toMatchObject({ version: 3, contentVersion: 3, status: 'open', title: 'Reworded' });
    });

    it('reworded question: an answered question drops to needs-review and keeps its answer', () => {
        const existing = questionRecord('Q-13', 'answered');
        const { record } = upsertQuestion(existing, questionContent('Q-13', { title: 'Reworded' }), LATER);
        expect(record.status).toBe('needs-review');
        expect(record.answer).toEqual(existing.answer);
        expect(record.changedByAgentAt).toBe(LATER);
    });

    it('re-sending status open never wipes an answer', () => {
        const existing = questionRecord('Q-13', 'answered');
        expect(upsertQuestion(existing, questionContent('Q-13', { status: 'open' }), LATER).changed).toBe(false);
    });

    it('raises a conflict, and clears it when the agent drops it', () => {
        const answered = questionRecord('Q-12', 'answered');
        const conflict = { with: 'Q-3', reason: 'Q-03 said availability first' };
        const raised = upsertQuestion(answered, questionContent('Q-12', { status: 'conflict', conflict }), LATER).record;
        expect(raised).toMatchObject({ status: 'conflict', conflict });
        expect(upsertQuestion(raised, questionContent('Q-12'), LATER).record.status).toBe('answered');
    });

    it('an agent change to an answered question needs review even when it arrives with the conflict cleared', () => {
        const answered = questionRecord('Q-12', 'answered');
        const conflict = { with: 'Q-3', reason: 'Q-03 said availability first' };
        const raised = upsertQuestion(answered, questionContent('Q-12', { status: 'conflict', conflict }), LATER).record;
        const reworded = upsertQuestion(raised, questionContent('Q-12', { title: 'Reworded' }), LATER).record;
        expect(reworded).toMatchObject({ status: 'needs-review', answer: answered.answer });
    });

    it('a rewording sent with the conflict still needs review once the conflict clears', () => {
        const answered = questionRecord('Q-12', 'answered');
        const conflict = { with: 'Q-3', reason: 'Q-03 said availability first' };
        const raised = upsertQuestion(answered, questionContent('Q-12', { title: 'Reworded', conflict }), LATER).record;
        expect(raised.status).toBe('conflict');
        expect(upsertQuestion(raised, questionContent('Q-12', { title: 'Reworded' }), LATER).record.status).toBe('needs-review');
    });

    it('a content update to a merged question keeps its merge target and reason', () => {
        const merged = questionRecord('Q-9', 'merged', { mergedInto: 'Q-2', closedReason: 'same as Q-2' });
        expect(upsertQuestion(merged, questionContent('Q-9', { title: 'New' }), LATER).record).toMatchObject({
            status: 'merged',
            mergedInto: 'Q-2',
            closedReason: 'same as Q-2'
        });
    });

    it('a topic names the decision without asking again: an answered question stays answered when only its topic changes', () => {
        const answered = questionRecord('Q-1', 'answered');
        const { record, changed } = upsertQuestion(answered, questionContent('Q-1', { topic: 'Redis outage' }), LATER);
        expect(changed).toBe(true);
        expect(record).toMatchObject({ status: 'answered', topic: 'Redis outage', version: 2, contentVersion: 1 });
        expect(record.changedByAgentAt).toBeUndefined();
        expect(upsertQuestion(record, questionContent('Q-1', { topic: 'Redis outage' }), LATER).changed).toBe(false);
    });

    it('keeps a closed question closed unless the agent reopens it', () => {
        const closed = questionRecord('Q-9', 'closed', { closedReason: 'ruled out' });
        expect(upsertQuestion(closed, questionContent('Q-9', { title: 'New' }), LATER).record).toMatchObject({
            status: 'closed',
            closedReason: 'ruled out'
        });
        expect(upsertQuestion(closed, questionContent('Q-9', { status: 'open' }), LATER).record.status).toBe('open');
    });
});

describe('Phase 1 progress and gate', () => {
    const failureModes = [
        questionRecord('Q-1', 'answered', { group: 'deep-dive/failure-modes' }),
        questionRecord('Q-2', 'answered', { group: 'deep-dive/failure-modes' }),
        questionRecord('Q-3', 'closed', { group: 'deep-dive/failure-modes' }),
        questionRecord('Q-4', 'open', { group: 'deep-dive/failure-modes' })
    ];

    it('group counts: 2 answered, 1 closed, 1 open shows 3/4', () => {
        const progress = groupProgress(stateWith({ questions: [...failureModes, questionRecord('Q-5', 'answered')] }));
        expect(progress.groups[0]).toMatchObject({ heading: 'DEEP DIVE', name: 'Failure modes', resolved: 3, total: 4 });
        expect(progress).toMatchObject({ resolved: 4, total: 5 });
    });

    it('all resolved: Finish phase 1 is enabled', () => {
        const questions = Array.from({ length: 22 }, (_, n) => questionRecord(`Q-${n + 1}`, n % 5 === 0 ? 'closed' : 'answered'));
        expect(phase1Gate(stateWith({ questions })).canFinish).toBe(true);
    });

    it.each(['needs-review', 'conflict', 'streaming', 'open'] as const)('a %s question keeps Finish disabled', (status) => {
        expect(
            phase1Gate(stateWith({ questions: [questionRecord('Q-1', 'answered'), questionRecord('Q-2', status)] })).canFinish
        ).toBe(false);
    });

    it('draft early: the unresolved questions are what the write-up carries as assumptions', () => {
        const questions = [
            ...Array.from({ length: 8 }, (_, n) => questionRecord(`Q-${n + 1}`, 'open')),
            questionRecord('Q-9', 'answered')
        ];
        expect(phase1Gate(stateWith({ questions })).unresolved.map((q) => q.id)).toHaveLength(8);
    });

    it('an empty session cannot finish', () => {
        expect(phase1Gate(stateWith({})).canFinish).toBe(false);
    });

    it('context before the questions: an open info card shows in its group but counts toward neither progress nor the gate', () => {
        const info = questionRecord('Q-6', 'open', { group: 'deep-dive/failure-modes', input: 'info', options: undefined });
        const state = stateWith({ questions: [...failureModes.slice(0, 3), info] });
        expect(groupProgress(state).groups[0]).toMatchObject({
            resolved: 3,
            total: 3,
            questionIds: ['Q-1', 'Q-2', 'Q-3', 'Q-6']
        });
        expect(phase1Gate(state)).toMatchObject({ canFinish: true, total: 3, unresolved: [] });
        expect(phase1Gate(stateWith({ questions: [info] })).canFinish).toBe(false);
    });
});

describe('write-up gates', () => {
    const assumption = (id: string, title: string) => blockRecord(id, 'callout', { tone: 'assumption', title });

    it('blocked submit: an unreviewed section and two unconfirmed assumptions are listed', () => {
        const state = stateWith({
            sections: [
                sectionRecord('s1', 1, ['a1', 'a2'], { reviewed: true }),
                sectionRecord('s4', 4, ['chart'], { reviewed: false, unreviewedBy: 'agent', title: 'Limits' })
            ],
            blocks: [
                assumption('a1', 'Limits are per region'),
                assumption('a2', 'Keys are per org'),
                blockRecord('chart', 'bar', {})
            ]
        });
        const items = outstandingItems(state);
        expect(items.map((item) => [item.kind, item.ref])).toEqual([
            ['section', 's4'],
            ['assumption', 'a1'],
            ['assumption', 'a2']
        ]);
        expect(items[0]?.label).toBe('§2 Limits - changed by agent, not re-reviewed');
        expect(describeCounts(submitCounts(items))).toBe('1 section and 2 assumptions still need you.');
    });

    it('ready submit: nothing outstanding once reviewed and confirmed', () => {
        const state = stateWith({
            sections: [sectionRecord('s1', 1, ['a1'], { reviewed: true })],
            blocks: [assumption('a1', 'Per region')],
            patch: { confirmedAssumptions: { a1: 1 } }
        });
        expect(outstandingItems(state)).toEqual([]);
        expect(describeCounts(submitCounts([]))).toBe('Nothing is outstanding.');
    });

    it('a confirmation is for one version: an edited assumption needs confirming again', () => {
        const state = stateWith({
            sections: [sectionRecord('s1', 1, ['a1'], { reviewed: true })],
            blocks: [assumption('a1', 'Per region')],
            patch: { confirmedAssumptions: { a1: 1 } }
        });
        state.blocks.a1 = { ...assumption('a1', 'Per region'), version: 2 };
        expect(outstandingItems(state).map((item) => item.kind)).toEqual(['assumption']);
    });

    it('counts open comments on questions and the write-up, not on the proposal or messages', () => {
        const state = stateWith({
            threads: [
                commentThread('C-1', 'block:b1'),
                commentThread('C-2', 'question:Q-1'),
                commentThread('C-3', 'file:proposal.md'),
                commentThread('C-4', 'block:b1', { status: 'resolved' }),
                { ...commentThread('M-1', 'x'), kind: 'message' }
            ]
        });
        expect(outstandingItems(state).map((item) => item.ref)).toEqual(['C-1', 'C-2']);
    });

    it('unreview clears the tick and records who changed it', () => {
        expect(unreview(sectionRecord('s4', 4, [], { reviewed: true }), 'agent', LATER)).toMatchObject({
            reviewed: false,
            unreviewedBy: 'agent',
            unreviewedAt: LATER
        });
    });
});

describe('proposal gates', () => {
    const unlocked = { ...stateWith({}).phases, proposalUnlocked: true };

    it('accept: needs a passing validation and no open proposal comment', () => {
        expect(acceptGate(stateWith({})).canAccept).toBe(false);
        expect(acceptGate(stateWith({ patch: { validation: passed, phases: unlocked } })).canAccept).toBe(true);
    });

    it('accept after a new submission: the last passing validation was of the previous change', () => {
        expect(acceptGate(stateWith({ patch: { validation: passed } }))).toEqual({
            canAccept: false,
            reason: 'The agent is still writing the proposal'
        });
    });

    it('accept blocked by a comment: says the comment needs resolving', () => {
        const state = stateWith({
            threads: [commentThread('C-1', 'file:specs/x/spec.md')],
            patch: { validation: passed, phases: unlocked }
        });
        expect(acceptGate(state)).toEqual({ canAccept: false, reason: '1 comment on the proposal needs resolving' });
    });

    it('request changes needs an open proposal comment or a message', () => {
        expect(canRequestChanges(stateWith({}), '  ')).toBe(false);
        expect(canRequestChanges(stateWith({}), 'Split it')).toBe(true);
        expect(canRequestChanges(stateWith({ threads: [commentThread('C-1', 'file:tasks.md')] }), undefined)).toBe(true);
    });

    it('traced requirement: counts answered questions a requirement points back to', () => {
        const state = stateWith({
            questions: [questionRecord('Q-12', 'answered'), questionRecord('Q-13', 'answered'), questionRecord('Q-14', 'closed')],
            patch: {
                traces: [
                    {
                        spec: 'rate-limits',
                        requirement: 'Fail open when the limit store is unavailable',
                        questions: ['Q-12', 'Q-14']
                    }
                ]
            }
        });
        expect(tracedAnswers(state)).toEqual({ traced: 1, answered: 2 });
        expect(traceFor(state, 'Fail open when the limit store is unavailable', 'rate-limits')).toEqual(['Q-12', 'Q-14']);
        expect(traceFor(state, 'Untraced requirement')).toBeUndefined();
    });
});

describe('tabs and phases', () => {
    it('write-up locked: reads "After phase 2" until phase 1 completes, or "After phase 1" with explore skipped', () => {
        expect(tabs(stateWith({})).writeup).toEqual({ unlocked: false, lockedLabel: 'After phase 2' });
        const skipped = stateWith({ patch: { phases: phasesWith({ exploreSkipped: 'One clear way' }) } });
        expect(tabs(skipped).writeup).toEqual({ unlocked: false, lockedLabel: 'After phase 1' });
        const done = stateWith({ patch: { phases: { ...stateWith({}).phases, phase1: { completed: true, path: 'finished' } } } });
        expect(tabs(done).writeup.unlocked).toBe(true);
        expect(tabs(done).interrogate.unlocked).toBe(true);
    });

    it('proposal locked: reads "After submit", and unlocks on submit before validation', () => {
        const phases = stateWith({}).phases;
        expect(tabs(stateWith({})).proposal).toEqual({ unlocked: false, lockedLabel: 'After submit' });
        const submitted = { ...phases, submission: { revision: 1, validate: true, outstanding: [], at: NOW } };
        expect(tabs(stateWith({ patch: { phases: submitted } })).proposal.unlocked).toBe(true);
    });

    it('names the furthest phase reached', () => {
        const phases = stateWith({}).phases;
        expect(currentPhase(stateWith({}))).toBe('interrogate');
        const submitted = { ...phases, submission: { revision: 1, validate: true, outstanding: [], at: NOW } };
        expect(currentPhase(stateWith({ patch: { phases: submitted } }))).toBe('proposal');
        expect(currentPhase(stateWith({ patch: { phases: { ...phases, acceptedAt: NOW } } }))).toBe('accepted');
    });

    it('scopes threads by their anchor target', () => {
        expect(threadScope(commentThread('C-1', 'qblock:Q-1:0'))).toBe('interrogate');
        expect(threadScope(commentThread('C-1', 'section:s1'))).toBe('writeup');
        expect(threadScope(commentThread('C-1', 'file:design.md'))).toBe('proposal');
    });
});

describe('phase 1 stages and directions', () => {
    const aligned = { aligned: { by: 'user' as const, at: NOW } };
    const options = [
        { id: 'redis', label: 'Redis token bucket', recommended: true },
        { id: 'postgres', label: 'Postgres counters' },
        { id: 'gateway', label: 'Gateway plugin' }
    ];
    /** The directions question, answered with `picked` when given. */
    const offer = (picked?: string[]) =>
        questionRecord('Q-3', picked ? 'answered' : 'open', {
            group: 'explore/approach',
            input: 'directions',
            options,
            answer: picked ? { choices: picked, version: 1, at: NOW } : null
        });

    it('the Directions tab opens with the first direction tab, and says why when it is skipped', () => {
        const phases = phasesWith(aligned);
        expect(tabs(stateWith({ questions: [offer()], patch: { phases } })).directions).toEqual({
            unlocked: false,
            lockedLabel: 'After phase 1'
        });
        expect(tabs(stateWith({ questions: [offer(['redis'])], patch: { phases } })).directions).toEqual({ unlocked: true });
        const skipped = phasesWith({ ...aligned, exploreSkipped: 'Only the gateway sees every call' });
        expect(tabs(stateWith({ patch: { phases: skipped } })).directions).toEqual({
            unlocked: false,
            skipped: 'Skipped: one clear way'
        });
        const finished = phasesWith({ ...aligned, completed: true });
        expect(tabs(stateWith({ questions: [offer()], patch: { phases: finished } })).directions).toEqual({
            unlocked: false,
            skipped: 'Skipped'
        });
    });

    it('the page phase is Directions from picking directions until going ahead; the agent still sees interrogate', () => {
        const phases = phasesWith(aligned);
        expect(pagePhase(stateWith({ questions: [offer()], patch: { phases } }))).toBe('interrogate');
        const picked = stateWith({ questions: [offer(['redis'])], patch: { phases } });
        expect(pagePhase(picked)).toBe('directions');
        expect(currentPhase(picked)).toBe('interrogate');
        const ahead = phasesWith({ ...aligned, completed: true, direction: 'redis' });
        expect(pagePhase(stateWith({ questions: [offer(['redis'])], patch: { phases: ahead } }))).toBe('writeup');
    });

    it('moves from align to explore to the deep dive, and is done once Phase 1 completes', () => {
        expect(phase1Stage(stateWith({}))).toBe('align');
        expect(phase1Stage(stateWith({ patch: { phases: phasesWith(aligned) } }))).toBe('explore');
        expect(phase1Stage(stateWith({ questions: [offer()], patch: { phases: phasesWith(aligned) } }))).toBe('explore');
        expect(phase1Stage(stateWith({ questions: [offer(['redis'])], patch: { phases: phasesWith(aligned) } }))).toBe(
            'deep-dive'
        );
        expect(phase1Stage(stateWith({ patch: { phases: phasesWith({ ...aligned, exploreSkipped: 'One clear way' }) } }))).toBe(
            'deep-dive'
        );
        expect(phase1Stage(stateWith({ patch: { phases: phasesWith({ completed: true }) } }))).toBe('done');
    });

    it('investigates nothing while the directions question is open again', () => {
        const reopened = { ...offer(['redis']), status: 'open' as const };
        expect(investigatedDirections(stateWith({ questions: [offer(['redis', 'gateway'])] }))).toEqual(['redis', 'gateway']);
        expect(investigatedDirections(stateWith({ questions: [reopened] }))).toEqual([]);
    });

    it('shared and direction questions: a tab per investigated direction or one with questions, in option order, with its own progress; shared ones stay on the overview', () => {
        const state = stateWith({
            questions: [
                offer(['gateway', 'redis']),
                questionRecord('Q-4', 'answered', { direction: 'redis' }),
                questionRecord('Q-5', 'open', { direction: 'redis' }),
                questionRecord('Q-6', 'open', { direction: 'postgres' }),
                questionRecord('Q-7', 'open')
            ],
            patch: { phases: phasesWith({ ...aligned, completed: true, direction: 'redis' }) }
        });
        expect(directionTabs(state)).toEqual([
            {
                id: 'redis',
                label: 'Redis token bucket',
                recommended: true,
                investigated: true,
                chosen: true,
                resolved: 1,
                total: 2
            },
            {
                id: 'postgres',
                label: 'Postgres counters',
                recommended: false,
                investigated: false,
                chosen: false,
                resolved: 0,
                total: 1
            },
            {
                id: 'gateway',
                label: 'Gateway plugin',
                recommended: false,
                investigated: true,
                chosen: false,
                resolved: 0,
                total: 0
            }
        ]);
        expect(groupProgress(state, 'redis').total).toBe(2);
        expect(groupProgress(state, null).groups.flatMap((group) => group.questionIds)).toEqual(['Q-3', 'Q-7']);
    });

    it('going ahead with a direction scopes the gate and the outstanding questions to it and the shared ones', () => {
        const questions = [
            offer(['redis', 'gateway']),
            questionRecord('Q-4', 'answered', { direction: 'redis' }),
            questionRecord('Q-5', 'open', { direction: 'gateway' })
        ];
        expect(phase1Gate(stateWith({ questions }), 'redis').canFinish).toBe(true);
        expect(phase1Gate(stateWith({ questions }), 'gateway').unresolved.map((question) => question.id)).toEqual(['Q-5']);
        expect(phase1Gate(stateWith({ questions })).total).toBe(3);
        const chosen = stateWith({ questions, patch: { phases: phasesWith({ completed: true, direction: 'redis' }) } });
        expect(outstandingItems(chosen).filter((item) => item.kind === 'question')).toEqual([]);
    });
});

describe('the decisions table', () => {
    const answered = (id: string, overrides: Parameters<typeof questionRecord>[2] = {}) =>
        questionRecord(id, 'answered', overrides);

    it('decisions from answers: one row per answered question in id order, named by its topic or else its title, with its question', () => {
        const state = stateWith({
            questions: [
                answered('Q-10', { topic: 'Store' }),
                answered('Q-2', { answer: { choice: 'b', note: 'only in prod', version: 1, at: NOW } }),
                questionRecord('Q-3', 'open'),
                questionRecord('Q-4', 'closed', { answer: { choice: 'a', version: 1, at: NOW } }),
                questionRecord('Q-5', 'answered', { input: 'info', options: [] })
            ]
        });
        expect(decisionRows(state)).toEqual([
            { questionId: 'Q-2', decision: 'Question Q-2', choice: 'Option B', note: 'only in prod' },
            { questionId: 'Q-10', decision: 'Store', choice: 'Option A' }
        ]);
    });

    it('an assumption that holds is confirmed; with a topic its statement is the choice; a correction is the choice', () => {
        const assumption: Partial<QuestionRecord> = {
            input: 'assumption',
            options: [],
            title: 'Redis is the only thing ingest needs'
        };
        const state = stateWith({
            questions: [
                answered('Q-1', { ...assumption, answer: { choice: 'holds', version: 1, at: NOW } }),
                answered('Q-2', { ...assumption, topic: 'Ingest needs', answer: { choice: 'holds', version: 1, at: NOW } }),
                answered('Q-3', { ...assumption, answer: { text: 'Postgres too, for tokens', version: 1, at: NOW } })
            ]
        });
        expect(decisionRows(state).map(({ decision, choice }) => [decision, choice])).toEqual([
            ['Redis is the only thing ingest needs', 'Confirmed'],
            ['Ingest needs', 'Redis is the only thing ingest needs'],
            ['Redis is the only thing ingest needs', 'Postgres too, for tokens']
        ]);
    });

    it("lists the direction gone ahead with, drops the other direction's questions, and flags answers in doubt", () => {
        const state = stateWith({
            questions: [
                answered('Q-1', {
                    input: 'directions',
                    options: [
                        { id: 'thin', label: 'Thin accept' },
                        { id: 'cache', label: 'Cache at the door' }
                    ],
                    answer: { choices: ['thin', 'cache'], version: 1, at: NOW }
                }),
                answered('Q-2', { direction: 'thin' }),
                answered('Q-3', { direction: 'cache' }),
                questionRecord('Q-4', 'needs-review'),
                questionRecord('Q-5', 'conflict', { answer: { choice: 'b', version: 1, at: NOW } })
            ],
            patch: { phases: phasesWith({ completed: true, direction: 'thin' }) }
        });
        expect(decisionRows(state)).toEqual([
            { questionId: 'Q-1', decision: 'Question Q-1', choice: 'Thin accept' },
            { questionId: 'Q-2', decision: 'Question Q-2', choice: 'Option A' },
            { questionId: 'Q-4', decision: 'Question Q-4', choice: 'Option A', unsettled: 'needs-review' },
            { questionId: 'Q-5', decision: 'Question Q-5', choice: 'Option B', unsettled: 'conflict' }
        ]);
    });
});

describe('section columns', () => {
    it('a block in a row of columns belongs to its section, and a missing one is reported at its row and column', () => {
        const state = stateWith({
            sections: [sectionRecord('s1', 1, ['intro', ['before', 'ghost']])],
            blocks: [blockRecord('intro', 'text', { body: 'x' }), blockRecord('before', 'text', { body: 'y' })]
        });
        expect(listingProblems(state)).toEqual([{ sectionId: 's1', position: [1, 1], blockId: 'ghost', kind: 'missing' }]);
        expect(outstandingItems(state).map((item) => item.ref)).toEqual(['s1']);
    });
});
