import { describe, expect, it } from 'vitest';
import {
    agentEvent,
    type AgentEventType,
    agentEventTypes,
    emitBatch,
    loggedEvent,
    type LoggedEventType,
    pageRequest,
    type PageRequestType
} from './events.js';

const anchor = { target: 'block:b1', position: { start: 0, end: 5 }, quote: { exact: 'hello', prefix: '', suffix: ' world' } };
const question = { id: 'Q-1', group: 'scope', title: 'T', input: 'single', options: [{ id: 'a', label: 'A' }] };

const agentSamples: Record<AgentEventType, unknown> = {
    'question.upsert': { type: 'question.upsert', question },
    'question.close': { type: 'question.close', id: 'Q-9', reason: 'You ruled out penalties in Q-04' },
    'question.merge': { type: 'question.merge', id: 'Q-9', into: 'Q-4' },
    'understanding.update': { type: 'understanding.update', text: 'We are adding rate limits.' },
    'stage.advance': { type: 'stage.advance', to: 'deep-dive', reason: 'Only the gateway can see every request' },
    'doc.section.upsert': { type: 'doc.section.upsert', section: { id: 's1', title: 'Summary', order: 1, blocks: ['b1'] } },
    'doc.block.upsert': { type: 'doc.block.upsert', block: { id: 'b1', type: 'text', config: { body: 'Hi' } } },
    'comment.reply': {
        type: 'comment.reply',
        threadId: 'C-1',
        text: 'Done',
        touched: [{ ref: 'section:s1', note: '§1 edited' }]
    },
    'comment.edit': { type: 'comment.edit', messageId: 'C-1.2', text: 'Done, with an expiry' },
    'suggestion.decline': { type: 'suggestion.decline', id: 'S-1', reason: 'Covered by Q-3' },
    'proposal.trace': { type: 'proposal.trace', spec: 'rate-limits', requirement: 'Fail open', questions: ['Q-12'] },
    'proposal.ready': { type: 'proposal.ready' }
};

const pageSamples: Record<PageRequestType, unknown> = {
    'answer.submit': { type: 'answer.submit', questionId: 'Q-1', version: 2, answer: { choice: 'a', note: 'n' } },
    'question.reopen': { type: 'question.reopen', questionId: 'Q-1' },
    'conflict.resolve': { type: 'conflict.resolve', questionId: 'Q-1', choice: 'change-other' },
    'question.suggest': { type: 'question.suggest', text: 'Should internal keys skip limits?' },
    'comment.create': { type: 'comment.create', anchor, intent: 'change', text: 'Needs an owner' },
    'thread.reply': { type: 'thread.reply', threadId: 'C-1', text: 'Thanks' },
    'comment.resolve': { type: 'comment.resolve', threadId: 'C-1' },
    'message.send': { type: 'message.send', text: 'Keep the EU edge in mind' },
    'review.mark': { type: 'review.mark', sectionId: 's1', reviewed: true },
    'checklist.tick': { type: 'checklist.tick', blockId: 'b1', item: '0', done: true },
    'assumption.confirm': { type: 'assumption.confirm', blockId: 'b1' },
    'block.fix': { type: 'block.fix', blockId: 'b1' },
    'edit.undo': { type: 'edit.undo', revision: 3 },
    'stage.advance': { type: 'stage.advance', to: 'explore' },
    'phase.complete': { type: 'phase.complete', path: 'assumptions', direction: 'redis' },
    'phase.submit': { type: 'phase.submit', changeId: 'add-x', revision: 4, validate: true, anyway: false },
    'validation.rerun': { type: 'validation.rerun' },
    'proposal.accept': { type: 'proposal.accept' },
    'proposal.requestChanges': { type: 'proposal.requestChanges', text: 'Split the spec' },
    'session.end': { type: 'session.end' },
    'session.reopen': { type: 'session.reopen' }
};

const at = { seq: 1, at: '2026-09-29T00:00:00.000Z' };
const loggedSamples: Record<LoggedEventType, unknown> = {
    'answer.submit': {
        ...at,
        type: 'answer.submit',
        questionId: 'Q-1',
        version: 1,
        answer: { choice: 'a' },
        summary: 'A',
        stale: false
    },
    'question.reopen': { ...at, type: 'question.reopen', questionId: 'Q-1' },
    'conflict.resolve': { ...at, type: 'conflict.resolve', questionId: 'Q-1', choice: 'keep', other: 'Q-3' },
    'question.suggest': { ...at, type: 'question.suggest', suggestionId: 'S-1', text: 'Q?' },
    'comment.create': { ...at, type: 'comment.create', threadId: 'C-1', anchor, intent: 'wrong', text: 'No' },
    'thread.reply': { ...at, type: 'thread.reply', threadId: 'C-1', text: 'Also' },
    'comment.resolve': { ...at, type: 'comment.resolve', threadId: 'C-1' },
    'message.send': { ...at, type: 'message.send', threadId: 'M-1', text: 'Hi' },
    'checklist.tick': { ...at, type: 'checklist.tick', blockId: 'b1', item: '0', done: false },
    'assumption.confirm': { ...at, type: 'assumption.confirm', blockId: 'b1', title: 'Per region' },
    'block.fix': { ...at, type: 'block.fix', blockId: 'b1', blockType: 'bar', issues: [{ path: 'data[0]', message: 'bad' }] },
    'stage.advance': { ...at, type: 'stage.advance', to: 'explore', open: [{ questionId: 'Q-2', title: 'T', status: 'open' }] },
    'phase.complete': {
        ...at,
        type: 'phase.complete',
        path: 'assumptions',
        direction: { id: 'redis', label: 'Redis token bucket' },
        assumptions: [{ questionId: 'Q-2', title: 'T', status: 'open' }]
    },
    'phase.submit': { ...at, type: 'phase.submit', changeId: 'add-x', revision: 4, validate: true, outstanding: [] },
    'proposal.accept': { ...at, type: 'proposal.accept', changeId: 'add-x' },
    'proposal.requestChanges': { ...at, type: 'proposal.requestChanges', openComments: ['C-2'] },
    'session.end': { ...at, type: 'session.end', how: 'finished' },
    'session.reopen': { ...at, type: 'session.reopen', from: 'accepted' },
    'validation.result': {
        ...at,
        type: 'validation.result',
        passed: false,
        issues: [{ level: 'ERROR', path: 'specs', message: 'x' }],
        trigger: 'rerun'
    },
    'edit.undone': { ...at, type: 'edit.undone', revision: 3, newRevision: 5, blocks: ['b1'], sections: [] }
};

describe('agent events', () => {
    it('covers every agent event type with a sample', () => {
        expect(Object.keys(agentSamples).sort()).toEqual([...agentEventTypes].sort());
    });

    it.each(Object.entries(agentSamples))('%s round-trips', (_type, sample) => {
        const parsed = agentEvent.parse(sample);
        expect(agentEvent.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    });

    it('batches up to 100 events, or none with a doing', () => {
        expect(emitBatch.safeParse({ events: [] }).success).toBe(false);
        expect(emitBatch.safeParse({ events: [], doing: 'researching the callers' }).success).toBe(true);
        expect(emitBatch.safeParse({ events: [], subagents: [] }).success).toBe(true);
        expect(emitBatch.safeParse({ events: [agentSamples['proposal.ready']], summary: 'Done' }).success).toBe(true);
    });

    it('has no event that carries HTML for the page', () => {
        expect(agentEventTypes.some((type) => /html/i.test(type))).toBe(false);
    });
});

describe('page requests and logged events', () => {
    it.each(Object.entries(pageSamples))('page request %s round-trips', (_type, sample) => {
        const parsed = pageRequest.parse(sample);
        expect(pageRequest.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    });

    it.each(Object.entries(loggedSamples))('logged event %s round-trips', (_type, sample) => {
        const parsed = loggedEvent.parse(sample);
        expect(loggedEvent.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    });

    it('trims page text and refuses blank text', () => {
        expect(pageRequest.parse({ type: 'message.send', text: '  hi  ' })).toEqual({ type: 'message.send', text: 'hi' });
        expect(pageRequest.safeParse({ type: 'message.send', text: '   ' }).success).toBe(false);
    });
});
