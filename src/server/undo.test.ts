import { describe, expect, it } from 'vitest';
import { isConfirmed, outstandingItems } from '../shared/derive.js';
import type { AgentEvent } from '../shared/events.js';
import { defined, harness, rejection, section, textBlock, upsert } from '../test/serverHelpers.js';

const assumption = (id: string, title: string): AgentEvent => ({
    type: 'doc.block.upsert',
    block: { id, type: 'callout', config: { tone: 'assumption', title } }
});

const checklist = (id: string, items: string[]): AgentEvent => ({
    type: 'doc.block.upsert',
    block: { id, type: 'checklist', config: { interactive: true, items: items.map((text) => ({ text })) } }
});

/** A session past Phase 1 whose write-up is `s1` listing `t1`, at revision 1. */
async function drafting() {
    const h = await harness();
    await h.session.emit({ events: [upsert('Q-1')] });
    await h.session.handlePage({ type: 'answer.submit', questionId: 'Q-1', version: 1, answer: { choice: 'a' } });
    await h.session.handlePage({ type: 'phase.complete', path: 'finished' });
    await h.session.emit({ events: [textBlock('t1', 'Summary'), section('s1', 1, ['t1'])] });
    return h;
}

describe('undoing the revision that created a block', () => {
    it('drops its confirmation, so a re-sent assumption with the same id is unconfirmed', async () => {
        const { session } = await drafting();
        await session.emit({ events: [assumption('a1', 'Limits are per region'), section('s1', 1, ['t1', 'a1'])] });
        await session.handlePage({ type: 'assumption.confirm', blockId: 'a1' });
        await session.handlePage({ type: 'edit.undo', revision: 2 });
        expect(session.current.blocks.a1).toBeUndefined();
        expect(session.current.confirmedAssumptions).not.toHaveProperty('a1');

        await session.emit({ events: [assumption('a1', 'Limits are global'), section('s1', 1, ['t1', 'a1'])] });
        const recreated = defined(session.current.blocks.a1);
        expect(recreated.version).toBe(1);
        expect(isConfirmed(session.current, recreated)).toBe(false);
        expect(outstandingItems(session.current).map((item) => item.ref)).toContain('a1');
    });

    it('drops its checklist ticks, so a re-sent checklist with the same id starts unticked', async () => {
        const { session } = await drafting();
        await session.emit({ events: [checklist('c1', ['429 has Retry-After']), section('s1', 1, ['t1', 'c1'])] });
        await session.handlePage({ type: 'checklist.tick', blockId: 'c1', item: '0', done: true });
        await session.handlePage({ type: 'edit.undo', revision: 2 });
        expect(session.current.checklistTicks).not.toHaveProperty('c1');

        await session.emit({ events: [checklist('c1', ['Fail-open metric']), section('s1', 1, ['t1', 'c1'])] });
        expect(Object.values(session.current.checklistTicks.c1 ?? {})).not.toContain(true);
    });
});

describe('undo keeps the write-up consistent', () => {
    it('refuses to remove a block that a later revision listed in a section', async () => {
        const { session } = await drafting();
        await session.emit({ events: [textBlock('b2', 'Orphan for now')] });
        await session.emit({ events: [section('s1', 1, ['t1', 'b2'])] });

        const refused = await rejection(session.handlePage({ type: 'edit.undo', revision: 2 }));
        expect(refused.message).toContain('§1 lists b2');
        expect(session.current.blocks.b2).toBeDefined();
        await expect(session.emit({ events: [textBlock('t1', 'Summary, revised')] })).resolves.toMatchObject({
            revision: 4
        });
    });

    it('refuses to put a block back in a section when a later revision moved it to another', async () => {
        const { session } = await drafting();
        await session.emit({ events: [section('s1', 1, [])] });
        await session.emit({ events: [section('s2', 2, ['t1'])] });

        const refused = await rejection(session.handlePage({ type: 'edit.undo', revision: 2 }));
        expect(refused.message).toContain('t1');
        expect(session.current.sections.s1?.blocks).toEqual([]);
    });

    it('re-derives the problem of a block restored to an invalid config', async () => {
        const { session } = await drafting();
        const bar = (value: unknown): AgentEvent => ({
            type: 'doc.block.upsert',
            block: { id: 'bar', type: 'bar', config: { series: ['S'], data: [['Free', value]] } }
        });
        await session.emit({ events: [bar('lots'), section('s1', 1, ['t1', 'bar'])] });
        await session.emit({ events: [bar(10)] });
        expect(session.current.blocks.bar?.problem).toBeUndefined();

        await session.handlePage({ type: 'edit.undo', revision: 3 });
        expect(session.current.blocks.bar?.problem).toMatchObject({ reason: 'invalid', issues: [{ path: 'data[0][1]' }] });
        await expect(session.handlePage({ type: 'block.fix', blockId: 'bar' })).resolves.toMatchObject({
            seq: expect.any(Number)
        });
    });
});
