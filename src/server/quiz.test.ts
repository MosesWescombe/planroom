import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../shared/events.js';
import type { QuizQuestion } from '../shared/quiz.js';
import { connect, defined, harness, rejection, section, textBlock, upsert } from '../test/serverHelpers.js';

/** A plan in its write-up: How it works and Risks, a text block each. */
async function writeup() {
    const h = await harness();
    await h.session.emit({ events: [upsert('Q-1')] });
    await h.session.handlePage({ type: 'answer.submit', questionId: 'Q-1', version: 1, answer: { choice: 'a' } });
    await h.session.handlePage({ type: 'phase.complete', path: 'finished' });
    await h.session.emit({
        events: [
            textBlock('how-text', 'Requests pass the limiter first.'),
            textBlock('risk-text', 'Redis can be down.'),
            section('how', 1, ['how-text'], 'How it works'),
            section('risks', 2, ['risk-text'], 'Risks')
        ]
    });
    return h;
}

function question(about: string, overrides: Partial<QuizQuestion> = {}): QuizQuestion {
    return {
        about,
        question: 'What does a request meet first?',
        choices: ['The limiter', 'The handler'],
        answer: 0,
        explanation: 'Every request passes the limiter first.',
        ...overrides
    };
}

const add = (questions: QuizQuestion[], note?: string): AgentEvent => ({
    type: 'quiz.add',
    questions,
    ...(note ? { note } : {})
});

describe('quiz me', () => {
    it('asks the agent about what the reader has seen, in words, leaving out refs that name nothing', async () => {
        const { session } = await writeup();
        const ack = await session.handlePage({ type: 'quiz.request', seen: ['block:how-text', 'block:gone', 'item:I-9'] });
        const { events } = await session.wait(defined(ack.seq) - 1, 1);
        expect(events[0]).toMatchObject({
            type: 'quiz.request',
            seen: [{ ref: 'block:how-text', what: 'text block in §1 "How it works"' }],
            asked: []
        });
        expect(session.current.quiz).toMatchObject({ seen: ['block:how-text'], requestedAt: expect.any(String) });
    });

    it('refuses a request with nothing read, and another while the agent writes the last', async () => {
        const { session } = await writeup();
        expect((await rejection(session.handlePage({ type: 'quiz.request', seen: ['block:gone'] }))).message).toBe(
            'seen: There is nothing you have read yet to quiz you on'
        );
        await session.handlePage({ type: 'quiz.request', seen: ['block:how-text'] });
        expect((await rejection(session.handlePage({ type: 'quiz.request', seen: ['block:how-text'] }))).message).toBe(
            'The agent is still writing your last questions'
        );
    });

    it('takes questions only on what was seen, numbers them, and settles the request', async () => {
        const { session } = await writeup();
        await session.handlePage({ type: 'quiz.request', seen: ['block:how-text'] });
        const unseen = await rejection(session.emit({ events: [add([question('block:risk-text')])] }));
        expect(unseen.issues[0]).toMatchObject({
            path: 'events[0].questions[0].about',
            message: expect.stringMatching(/^the reader has not seen "block:risk-text"/)
        });
        const beyond = await rejection(session.emit({ events: [add([question('block:how-text', { answer: 2 })])] }));
        expect(beyond.issues[0]).toMatchObject({ path: 'events[0].questions[0].answer' });
        expect(session.current.quiz.questions).toEqual([]);

        const second = question('block:how-text', { question: 'Where do counts live?', answer: 1 });
        const { applied } = await session.emit({
            events: [add([question('block:how-text'), second], 'Read Risks for more.')]
        });
        expect(applied[0]).toMatchObject({ ref: 'Z-1, Z-2' });
        expect(session.current.quiz).toEqual({
            seen: ['block:how-text'],
            questions: [
                { ...question('block:how-text'), id: 'Z-1', at: expect.any(String) },
                { ...second, id: 'Z-2', at: expect.any(String) }
            ],
            note: 'Read Risks for more.'
        });

        // More: what was seen before still counts, and the agent hears what it already asked.
        const ack = await session.handlePage({ type: 'quiz.request', seen: ['block:risk-text'] });
        const { events } = await session.wait(defined(ack.seq) - 1, 1);
        expect(events[0]).toMatchObject({
            seen: [{ ref: 'block:how-text' }, { ref: 'block:risk-text', what: 'text block in §2 "Risks"' }],
            asked: ['What does a request meet first?', 'Where do counts live?']
        });
        expect(session.current.quiz.note).toBeUndefined();
    });

    it('is not part of an ask', async () => {
        const { call } = await connect({ kind: 'ask' });
        await call('planroom_ask', { askId: 'q' });
        const { body } = await call('planroom_emit', { events: [add([question('block:x')])] });
        expect(body.issues[0].message).toMatch(/^an ask takes only .*quiz.add belongs to a plan/);
    });
});
