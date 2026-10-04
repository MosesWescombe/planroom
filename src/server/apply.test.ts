import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { CHANGE, harness, rejection, section, textBlock, upsert } from '../test/serverHelpers.js';

/** A session past Phase 1 whose write-up is `s1` listing `t1`, at revision 1. */
async function drafting() {
    const h = await harness();
    await h.session.emit({ events: [upsert('Q-1')] });
    await h.session.handlePage({ type: 'answer.submit', questionId: 'Q-1', version: 1, answer: { choice: 'a' } });
    await h.session.handlePage({ type: 'phase.complete', path: 'finished' });
    await h.session.emit({ events: [textBlock('t1', 'Summary'), section('s1', 1, ['t1'])] });
    return h;
}

/** A session whose reviewed write-up was submitted, with or without strict validation. */
async function submitted(validate = true) {
    const h = await drafting();
    await h.session.handlePage({ type: 'review.mark', sectionId: 's1', reviewed: true });
    await h.session.handlePage({ type: 'phase.submit', changeId: CHANGE, revision: 1, validate });
    return h;
}

describe('ids that name Object.prototype members', () => {
    it('a page request for section "constructor" is refused and the session keeps working', async () => {
        const { session } = await drafting();
        const refused = await rejection(session.handlePage({ type: 'review.mark', sectionId: 'constructor', reviewed: true }));
        expect(refused.status).toBe(400);
        expect(Object.keys(session.current.sections)).toEqual(['s1']);
        await expect(session.emit({ events: [textBlock('t1', 'Summary, revised')] })).resolves.toMatchObject({
            revision: 2
        });
    });

    it('a thread named after a prototype member does not exist', async () => {
        const { session } = await drafting();
        expect((await rejection(session.handlePage({ type: 'thread.reply', threadId: 'constructor', text: 'Hi' }))).status).toBe(
            404
        );
        expect((await rejection(session.handlePage({ type: 'comment.resolve', threadId: 'toString' }))).status).toBe(404);
        expect(session.current.threads).toEqual({});
    });

    it('the agent cannot create a block named "constructor", so the session stays resumable', async () => {
        const h = await drafting();
        await expect(h.session.emit({ events: [textBlock('constructor', 'Hi')] })).rejects.toThrow(/events\[0\]\.block\.id/);
        const reopened = await h.reopen();
        expect(reopened.current.blocks.t1).toBeDefined();
    });

    it('agent references to a prototype-named thread or suggestion are refused as missing', async () => {
        const { session } = await drafting();
        await expect(
            session.emit({ events: [{ type: 'comment.reply', threadId: 'constructor', text: 'Done' }] })
        ).rejects.toThrow(/thread constructor does not exist/);
        await expect(
            session.emit({ events: [{ type: 'suggestion.decline', id: 'valueOf', reason: 'Out of scope' }] })
        ).rejects.toThrow(/suggestion valueOf does not exist/);
        await expect(session.emit({ events: [{ ...upsert('Q-2'), fromSuggestion: 'toString' }] })).rejects.toThrow(
            /suggestion toString does not exist/
        );
        expect(session.current.suggestions).toEqual({});
    });
});

describe('section integrity', () => {
    it('refuses a section that lists the same block twice', async () => {
        const { session } = await drafting();
        const refused = await rejection(session.emit({ events: [section('s1', 1, ['t1', 't1'])] }));
        expect(refused.issues.map((issue) => issue.path)).toEqual(['events[0].section.blocks[1]']);
        expect(session.current.sections.s1?.blocks).toEqual(['t1']);
    });

    it('a section an older version saved with a block listed twice does not block writes to other sections', async () => {
        const h = await drafting();
        await h.session.close();
        const saved = JSON.parse(await readFile(h.session.store.stateFile, 'utf8'));
        saved.sections.s1.blocks = ['t1', 't1'];
        await writeFile(h.session.store.stateFile, JSON.stringify(saved));
        const resumed = await h.reopen();
        await resumed.emit({ events: [textBlock('t2', 'Rollout'), section('s2', 2, ['t2'])] });
        expect(resumed.current.sections.s2?.blocks).toEqual(['t2']);
        // Editing that section is a write to it, so the repeat has to go.
        const refused = await rejection(
            resumed.emit({ events: [textBlock('t3', 'Risks'), section('s1', 1, ['t1', 't3', 't1'])] })
        );
        expect(refused.issues.map((issue) => issue.path)).toEqual(['events[1].section.blocks[2]']);
    });
});

describe('conflicts', () => {
    it('keeping an answer through a conflict that came with a rewording still needs review', async () => {
        const { session } = await harness();
        await session.emit({ events: [upsert('Q-1'), upsert('Q-2')] });
        await session.handlePage({ type: 'answer.submit', questionId: 'Q-1', version: 1, answer: { choice: 'a' } });
        const conflict = { with: 'Q-2', reason: 'Q-2 said the opposite' };
        await session.emit({ events: [upsert('Q-1', { title: 'Reworded', conflict })] });
        expect(session.current.questions['Q-1']?.status).toBe('conflict');

        await session.handlePage({ type: 'conflict.resolve', questionId: 'Q-1', choice: 'keep' });
        expect(session.current.questions['Q-1']?.status).toBe('needs-review');
    });

    it('keeping an answer through a conflict with no rewording is answered', async () => {
        const { session } = await harness();
        await session.emit({ events: [upsert('Q-1'), upsert('Q-2')] });
        await session.handlePage({ type: 'answer.submit', questionId: 'Q-1', version: 1, answer: { choice: 'a' } });
        await session.emit({ events: [upsert('Q-1', { conflict: { with: 'Q-2', reason: 'Q-2 said the opposite' } })] });

        await session.handlePage({ type: 'conflict.resolve', questionId: 'Q-1', choice: 'keep' });
        expect(session.current.questions['Q-1']?.status).toBe('answered');
    });
});

describe('validation', () => {
    it('refuses a re-run until the agent has proposed the change', async () => {
        const { session, cli } = await submitted();
        const refused = await rejection(session.handlePage({ type: 'validation.rerun' }));
        expect(refused.message).toMatch(/not proposed/);
        expect(cli.validations).toEqual([]);

        await session.emit({ events: [{ type: 'proposal.ready' }] });
        await session.settled();
        await session.handlePage({ type: 'validation.rerun' });
        await session.settled();
        expect(cli.validations).toEqual([CHANGE, CHANGE]);
    });

    it.each([
        [true, 'running openspec validate --strict'],
        [false, 'running openspec validate']
    ])('with "Validate strictly" %s, proposal.ready notes "%s"', async (validate, detail) => {
        const { session } = await submitted(validate);
        await session.emit({ events: [{ type: 'proposal.ready' }] });
        await session.settled();
        expect(session.view().activity.find((entry) => entry.title === 'Proposed the change')?.detail).toBe(detail);
    });
});
