import { describe, expect, it } from 'vitest';
import {
    type AgentEventType,
    agentEvent,
    agentEventTypes,
    emitBatch,
    type LoggedEventType,
    loggedEvent,
    type PageRequestType,
    pageRequest
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
    'proposal.ready': { type: 'proposal.ready' },
    'slide.upsert': { type: 'slide.upsert', slide: { id: 'why-1', chapter: 'why', order: 1, title: 'Why', blocks: ['b1'] } },
    'deck.progress': { type: 'deck.progress', pictures: { drawn: 2, total: 4 }, review: '3 of 5 reviewers done' },
    'deck.publish': { type: 'deck.publish' },
    'item.upsert': {
        type: 'item.upsert',
        item: {
            id: 'I-1',
            kind: 'question',
            title: 'Why three retries?',
            body: 'Three retries at 100 ms can outlast the caller timeout.',
            confidence: 0.8,
            anchor: { file: 'src/retry.ts', side: 'new', start: 40, end: 44 },
            draft: 'Why three retries here?'
        }
    },
    'item.withdraw': { type: 'item.withdraw', id: 'I-2', reason: 'The caller handles it' },
    'summary.draft': { type: 'summary.draft', text: 'Looks good once the retry cap is fixed.' },
    'earlier.label': { type: 'earlier.label', key: '1/item:I-1', label: 'addressed', note: 'Capped at two' }
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
    'session.reopen': { type: 'session.reopen' },
    'ask.done': { type: 'ask.done' },
    'take.answer': { type: 'take.answer', blockId: 'take-1', answer: { kind: 'predict', guess: 'It fails open' } },
    'walkthrough.done': { type: 'walkthrough.done', how: 'skipped' },
    'impact.save': { type: 'impact.save', concerns: { billing: ['Does the export retry?'] }, added: [] },
    'impact.send': { type: 'impact.send' },
    'reviewers.start': { type: 'reviewers.start', reviewers: { strength: 'single', model: 'haiku', effort: 'low' } },
    'item.react': { type: 'item.react', itemId: 'I-1', verdict: 'reject', reason: 'Handled in the caller' },
    'comment.choose': { type: 'comment.choose', key: 'item:I-1', task: true },
    'note.save': { type: 'note.save', anchor: { file: 'src/retry.ts', side: 'new', start: 12 }, text: 'Nice' },
    'note.delete': { type: 'note.delete', id: 'N-1' },
    'summary.edit': { type: 'summary.edit', text: 'Ship it' },
    'comments.open': { type: 'comments.open' },
    'comments.post': { type: 'comments.post', choices: { 'item:I-1': 'reanchor' } },
    'earlier.confirm': { type: 'earlier.confirm', key: '1/item:I-1', confirmed: true },
    'preferences.set': {
        type: 'preferences.set',
        preferences: {
            takes: { predict: true, prosCons: true, risk: false, check: true },
            density: 'light',
            views: { pins: true, diff: true, charts: false, heatmap: true, matrix: true }
        }
    }
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
    'ask.done': { ...at, type: 'ask.done', context: '# Auth migration\n', file: 'docs/auth.md' },
    'validation.result': {
        ...at,
        type: 'validation.result',
        passed: false,
        issues: [{ level: 'ERROR', path: 'specs', message: 'x' }],
        trigger: 'rerun'
    },
    'edit.undone': { ...at, type: 'edit.undone', revision: 3, newRevision: 5, blocks: ['b1'], sections: [] },
    'take.answer': {
        ...at,
        type: 'take.answer',
        blockId: 'take-1',
        kind: 'risk',
        answer: { kind: 'risk', ratings: { security: 4, correctness: 2 } },
        summary: 'correctness 2, security 4'
    },
    'walkthrough.done': { ...at, type: 'walkthrough.done', how: 'finished', round: 1 },
    'impact.send': {
        ...at,
        type: 'impact.send',
        round: 1,
        areas: [
            { id: 'billing', title: 'Billing exports', concerns: ['Does the export retry?'] },
            { title: 'Search', concerns: [] }
        ]
    },
    'item.react': { ...at, type: 'item.react', itemId: 'I-1', title: 'Retry cap', verdict: 'reword', text: 'Cap it at two?' },
    'reviewers.start': {
        ...at,
        type: 'reviewers.start',
        round: 1,
        reviewers: { strength: 'thorough', model: 'opus', effort: 'medium' }
    },
    'preferences.change': {
        ...at,
        type: 'preferences.change',
        preferences: {
            takes: { predict: false, prosCons: true, risk: true, check: true },
            density: 'normal',
            views: { pins: true, diff: true, charts: true, heatmap: true, matrix: true }
        }
    },
    'review.posted': { ...at, type: 'review.posted', round: 1, posted: 6, total: 7, failed: ['item:I-5'], drafts: true }
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

    it('a rewording needs its text and a rejection its reason', () => {
        expect(pageRequest.safeParse({ type: 'item.react', itemId: 'I-1', verdict: 'reword' }).success).toBe(false);
        expect(pageRequest.safeParse({ type: 'item.react', itemId: 'I-1', verdict: 'reject' }).success).toBe(false);
        expect(pageRequest.safeParse({ type: 'item.react', itemId: 'I-1', verdict: 'agree' }).success).toBe(true);
    });

    it('trims page text and refuses blank text', () => {
        expect(pageRequest.parse({ type: 'message.send', text: '  hi  ' })).toEqual({ type: 'message.send', text: 'hi' });
        expect(pageRequest.safeParse({ type: 'message.send', text: '   ' }).success).toBe(false);
    });
});
