import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { outstandingItems } from '../shared/derive.js';
import type { AgentEvent } from '../shared/events.js';
import { documentAt } from '../shared/revisions.js';
import { CHANGE, defined, harness, rejection, section, textBlock, upsert } from '../test/serverHelpers.js';

const limits = (enterprise: number): AgentEvent => ({
    type: 'doc.block.upsert',
    block: {
        id: 's4-bar',
        type: 'bar',
        config: {
            series: ['Sustained'],
            data: [
                ['Team', 600],
                ['Enterprise', enterprise]
            ]
        },
        refs: ['Q-1']
    }
});

const assumption = (id: string, title: string): AgentEvent => ({
    type: 'doc.block.upsert',
    block: { id, type: 'callout', config: { tone: 'assumption', title } }
});

/** A session past Phase 1 with a six-section write-up at revision 1. */
async function writeup() {
    const h = await harness();
    await h.session.emit({ events: [upsert('Q-1')] });
    await h.session.handlePage({ type: 'answer.submit', questionId: 'Q-1', version: 1, answer: { choice: 'a' } });
    await h.session.handlePage({ type: 'phase.complete', path: 'finished' });
    await h.session.emit({
        summary: 'First draft',
        events: [
            textBlock('s1-text', 'We add per-key rate limits.'),
            textBlock('s2-text', 'Requests pass the limiter first.'),
            textBlock('s3-text', 'Token bucket in Redis.'),
            limits(6000),
            assumption('a1', 'Limits are per region, not global'),
            assumption('a2', 'Keys belong to one org'),
            {
                type: 'doc.block.upsert',
                block: {
                    id: 'c1',
                    type: 'checklist',
                    config: { interactive: true, items: [{ text: '429 has Retry-After' }, { text: 'Fail-open metric' }] }
                }
            },
            {
                type: 'doc.block.upsert',
                block: { id: 'bad-bar', type: 'bar', config: { series: ['S'], data: [['Free', 'lots']] } }
            },
            section('s1', 1, ['s1-text'], 'Summary'),
            section('s2', 2, ['s2-text'], 'Flow'),
            section('s3', 3, ['s3-text', 'bad-bar'], 'Decisions'),
            section('s4', 4, ['s4-bar'], 'Limits'),
            section('s5', 5, ['a1', 'a2'], 'Assumptions'),
            section('s6', 6, ['c1'], 'Acceptance')
        ]
    });
    return h;
}

describe('the write-up', () => {
    it('records a revision per batch with the agent summary', async () => {
        const { session } = await writeup();
        expect(session.view().revisions).toMatchObject([{ n: 1, summary: 'First draft' }]);
        expect(session.current.revision).toBe(1);
    });

    it('ask agent to fix: sends the block id and its validation errors', async () => {
        const { session } = await writeup();
        const ack = await session.handlePage({ type: 'block.fix', blockId: 'bad-bar' });
        const { events } = await session.wait(defined(ack.seq) - 1, 1);
        expect(events[0]).toMatchObject({
            type: 'block.fix',
            blockId: 'bad-bar',
            blockType: 'bar',
            issues: [{ path: 'data[0][1]' }]
        });
        await expect(session.handlePage({ type: 'block.fix', blockId: 's4-bar' })).rejects.toThrow(/renders fine/);
    });

    it('ask agent to fix a block stored before a rule tightened: sends the errors the page now shows', async () => {
        const h = await writeup();
        await h.session.close();
        const saved = JSON.parse(await readFile(h.session.store.stateFile, 'utf8'));
        saved.blocks['s4-bar'].config = { series: ['A'], data: [['Free']] };
        await writeFile(h.session.store.stateFile, JSON.stringify(saved));
        const resumed = await h.reopen();
        const ack = await resumed.handlePage({ type: 'block.fix', blockId: 's4-bar' });
        const { events } = await resumed.wait(defined(ack.seq) - 1, 1);
        expect(events[0]).toMatchObject({ type: 'block.fix', blockId: 's4-bar', issues: [{ path: 'data[0]' }] });
    });

    it('ask agent to fix a block that validated but threw while drawing: sends the error the page caught', async () => {
        const { session } = await writeup();
        const ack = await session.handlePage({ type: 'block.fix', blockId: 's4-bar', thrown: 'layout failed' });
        const { events } = await session.wait(defined(ack.seq) - 1, 1);
        expect(events[0]).toMatchObject({
            type: 'block.fix',
            blockId: 's4-bar',
            issues: [{ path: '', message: 'threw while drawing: layout failed' }]
        });
    });

    it('edited after review: an agent change to a reviewed section unticks it as changed by agent', async () => {
        const { session } = await writeup();
        await session.handlePage({ type: 'review.mark', sectionId: 's4', reviewed: true });
        expect(session.current.sections.s4?.reviewed).toBe(true);
        await session.emit({ summary: 'Raised Enterprise', events: [limits(9000)] });
        expect(session.current.sections.s4).toMatchObject({ reviewed: false, unreviewedBy: 'agent' });
        expect(outstandingItems(session.current).find((item) => item.ref === 's4')?.label).toBe(
            '§4 Limits - changed by agent, not re-reviewed'
        );
    });

    it('an identical re-send does not untick or record a revision', async () => {
        const { session } = await writeup();
        await session.handlePage({ type: 'review.mark', sectionId: 's4', reviewed: true });
        const result = await session.emit({ events: [limits(6000)] });
        expect(result.revision).toBeUndefined();
        expect(session.current.sections.s4?.reviewed).toBe(true);
    });

    it('ticks and unticks are stored but never reach the agent', async () => {
        const { session } = await writeup();
        await expect(session.handlePage({ type: 'review.mark', sectionId: 's1', reviewed: true })).resolves.toEqual({});
        expect(session.current.sections.s1?.reviewed).toBe(true);
        await session.handlePage({ type: 'review.mark', sectionId: 's1', reviewed: false });
        expect(session.current.sections.s1?.reviewed).toBe(false);
        expect(session.current.lastEvent?.type).toBe('phase.complete');
    });
});

describe('checklists and assumptions', () => {
    it('ticking an interactive checklist item persists it and notifies the agent', async () => {
        const { session } = await writeup();
        await session.handlePage({ type: 'checklist.tick', blockId: 'c1', item: '1', done: true });
        expect(session.current.checklistTicks.c1).toEqual({ '1': true });
        expect((await session.wait(2, 1)).events[0]).toMatchObject({
            type: 'checklist.tick',
            blockId: 'c1',
            item: '1',
            done: true
        });
        await expect(session.handlePage({ type: 'checklist.tick', blockId: 'c1', item: '9', done: true })).rejects.toThrow(
            /no item "9"/
        );
    });

    it('confirm an assumption: shows as confirmed and notifies the agent', async () => {
        const { session } = await writeup();
        await session.handlePage({ type: 'assumption.confirm', blockId: 'a1' });
        expect(session.current.confirmedAssumptions.a1).toBe(1);
        expect((await session.wait(2, 1)).events[0]).toMatchObject({
            type: 'assumption.confirm',
            blockId: 'a1',
            title: 'Limits are per region, not global'
        });
        await expect(session.handlePage({ type: 'assumption.confirm', blockId: 's1-text' })).rejects.toThrow(/not an assumption/);
    });

    it('tick while waiting: ticks and confirmations do not end the wait; the next event brings them along', async () => {
        const { session } = await writeup();
        const waiting = session.wait(2, 30);
        await session.handlePage({ type: 'checklist.tick', blockId: 'c1', item: '1', done: true });
        await session.handlePage({ type: 'assumption.confirm', blockId: 'a1' });
        expect(session.delivery.waiting).toBe(true);
        expect((await session.wait(2, 0.01)).events.map((event) => event.type)).toEqual(['checklist.tick', 'assumption.confirm']);
        await session.handlePage({ type: 'message.send', text: 'Looks good' });
        expect((await waiting).events.map((event) => event.type)).toEqual([
            'checklist.tick',
            'assumption.confirm',
            'message.send'
        ]);
    });

    it('tick while idle with channels: the held tick is pushed just ahead of the next event', async () => {
        const { session } = await writeup();
        const pushed: string[] = [];
        session.setNotifier(async (event) => void pushed.push(event.type));
        await session.handlePage({ type: 'checklist.tick', blockId: 'c1', item: '1', done: true });
        expect(pushed).toEqual([]);
        await session.handlePage({ type: 'message.send', text: 'Looks good' });
        expect(pushed).toEqual(['checklist.tick', 'message.send']);
    });
});

describe('agent edits can be undone', () => {
    it('undo: restores the block as a new revision and tells the agent what was reverted', async () => {
        const { session } = await writeup();
        await session.emit({ summary: 'Raised Enterprise', events: [limits(9000)] });
        await session.handlePage({ type: 'edit.undo', revision: 2 });
        expect(session.current.blocks['s4-bar']?.config.data).toEqual([
            ['Team', 600],
            ['Enterprise', 6000]
        ]);
        expect(session.view().revisions.map((rev) => [rev.n, rev.undoOf, rev.undone])).toEqual([
            [1, undefined, false],
            [2, undefined, true],
            [3, 2, false]
        ]);
        const { events } = await session.wait(2, 1);
        expect(events[0]).toMatchObject({ type: 'edit.undone', revision: 2, newRevision: 3, blocks: ['s4-bar'] });
    });

    it('undo removes a section the edit added, and the blocks with it', async () => {
        const { session } = await writeup();
        await session.emit({ events: [textBlock('s7-text', 'Later'), section('s7', 7, ['s7-text'], 'Later')] });
        await session.handlePage({ type: 'edit.undo', revision: 2 });
        expect(session.current.sections.s7).toBeUndefined();
        expect(session.current.blocks['s7-text']).toBeUndefined();
    });

    it('superseded edit: undoing the first of two edits to §4 is refused with the reason', async () => {
        const { session } = await writeup();
        await session.emit({ events: [limits(9000)] });
        await session.emit({ events: [limits(12000)] });
        const refused = await rejection(session.handlePage({ type: 'edit.undo', revision: 2 }));
        expect(refused.message).toContain('§4 changed again since');
        await session.handlePage({ type: 'edit.undo', revision: 3 });
        await expect(session.handlePage({ type: 'edit.undo', revision: 3 })).rejects.toThrow(/already undone/);
    });
});

describe('side-by-side columns', () => {
    it('missing block in a row: a section lists blocks as a row of columns, and one not yet sent is refused at its row and column', async () => {
        const { session } = await writeup();
        const refused = await rejection(
            session.emit({ events: [textBlock('s7-a', 'Before'), section('s7', 7, ['s7-a', ['s7-a', 'ghost']], 'Side by side')] })
        );
        expect(refused.issues).toEqual([
            { path: 'events[1].section.blocks[1][0]', message: 'block "s7-a" is already listed in this section' },
            {
                path: 'events[1].section.blocks[1][1]',
                message: 'block "ghost" has not been sent; send it with doc.block.upsert in this batch or an earlier one'
            }
        ]);
        await session.emit({
            events: [
                textBlock('s7-a', 'Before'),
                textBlock('s7-b', 'After'),
                section('s7', 7, [['s7-a', 's7-b']], 'Side by side')
            ]
        });
        expect(session.current.sections.s7?.blocks).toEqual([['s7-a', 's7-b']]);
    });

    it('an edit to a block in a row of columns unticks its section, and undo restores the row', async () => {
        const { session } = await writeup();
        await session.emit({
            events: [textBlock('s7-a', 'Before'), textBlock('s7-b', 'After'), section('s7', 7, [['s7-a', 's7-b']])]
        });
        await session.handlePage({ type: 'review.mark', sectionId: 's7', reviewed: true });
        await session.emit({ summary: 'Reworded', events: [textBlock('s7-b', 'After, reworded')] });
        expect(session.current.sections.s7).toMatchObject({ reviewed: false, unreviewedBy: 'agent' });
        await session.emit({ summary: 'Stacked', events: [section('s7', 7, ['s7-a', 's7-b'])] });
        await session.handlePage({ type: 'edit.undo', revision: 4 });
        expect(session.current.sections.s7?.blocks).toEqual([['s7-a', 's7-b']]);
    });
});

describe('write-up revisions are diffable', () => {
    it('diff two revisions: the bar chart changed, with the Enterprise value', async () => {
        const { session } = await writeup();
        await session.emit({ summary: 'Raised Enterprise', events: [limits(9000)] });
        const all = session.allRevisions;
        const before = documentAt(all, 1).blocks.get('s4-bar')?.config.data;
        const after = documentAt(all, 2).blocks.get('s4-bar')?.config.data;
        expect(before).toContainEqual(['Enterprise', 6000]);
        expect(after).toContainEqual(['Enterprise', 9000]);
        expect(session.revision(2)?.changes.map((change) => change.id)).toEqual(['s4-bar']);
    });
});

describe('the submit gate', () => {
    it('blocked submit: refused with every outstanding item until "Submit anyway"', async () => {
        const { session } = await writeup();
        for (const id of ['s1', 's2', 's3', 's5', 's6'])
            await session.handlePage({ type: 'review.mark', sectionId: id, reviewed: true });
        const submit = { type: 'phase.submit', changeId: CHANGE, revision: 1, validate: true };
        const refused = await rejection(session.handlePage(submit));
        expect(refused.status).toBe(409);
        expect(refused.issues.map((issue) => issue.path)).toEqual(['s4', 'a1', 'a2']);
        const seqBefore = session.delivery.lastSeq;

        await session.handlePage({ ...submit, anyway: true });
        expect(session.delivery.lastSeq).toBe(seqBefore + 1);
        expect(session.current.phases.submission?.outstanding.map((item) => item.ref)).toEqual(['s4', 'a1', 'a2']);
    });

    it('ready submit: goes through with the change id, revision and strict validation', async () => {
        const { session } = await writeup();
        for (const id of ['s1', 's2', 's3', 's4', 's5', 's6'])
            await session.handlePage({ type: 'review.mark', sectionId: id, reviewed: true });
        await session.handlePage({ type: 'assumption.confirm', blockId: 'a1' });
        await session.handlePage({ type: 'assumption.confirm', blockId: 'a2' });
        const ack = await session.handlePage({ type: 'phase.submit', changeId: CHANGE, revision: 1, validate: true });
        const { events } = await session.wait(defined(ack.seq) - 1, 1);
        expect(events[0]).toMatchObject({ type: 'phase.submit', changeId: CHANGE, revision: 1, validate: true, outstanding: [] });
    });

    it('refuses a submission of a write-up revision that is no longer current', async () => {
        const { session } = await writeup();
        await session.emit({ events: [limits(9000)] });
        await expect(
            session.handlePage({ type: 'phase.submit', changeId: CHANGE, revision: 1, validate: true, anyway: true })
        ).rejects.toThrow(/revision 2/);
    });
});
