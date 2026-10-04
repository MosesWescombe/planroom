import { describe, expect, it } from 'vitest';
import { captureAnchor } from '../shared/anchors.js';
import type { AgentEvent } from '../shared/events.js';
import { defined, harness, section, textBlock, upsert } from '../test/serverHelpers.js';

const cellText = 'Overrides: support can raise one key';

async function withComment() {
    const h = await harness();
    await h.session.emit({ events: [upsert('Q-1')] });
    const start = cellText.indexOf('support can raise one key');
    const anchor = captureAnchor('block:s4-table', cellText, start, start + 'support can raise one key'.length);
    const ack = await h.session.handlePage({
        type: 'comment.create',
        anchor,
        intent: 'change',
        text: 'Overrides need an owner and an expiry'
    });
    return { ...h, anchor, ack };
}

describe('comments', () => {
    it('comment on a table cell: stored as an open thread and sent with its intent and anchor', async () => {
        const { session, anchor, ack } = await withComment();
        expect(session.current.threads['C-1']).toMatchObject({ kind: 'comment', status: 'open', intent: 'change', anchor });
        const { events } = await session.wait(defined(ack.seq) - 1, 1);
        expect(events[0]).toMatchObject({
            type: 'comment.create',
            threadId: 'C-1',
            intent: 'change',
            anchor,
            text: 'Overrides need an owner and an expiry'
        });
    });

    it('comment on an image: the agent receives the comment anchored to the whole block', async () => {
        const { session } = await harness();
        await session.handlePage({
            type: 'comment.create',
            anchor: { target: 'block:img' },
            intent: 'question',
            text: 'Pin 2 is on the wrong field'
        });
        const [event] = (await session.wait(0, 1)).events;
        expect(event).toMatchObject({ type: 'comment.create', threadId: 'C-1', text: 'Pin 2 is on the wrong field' });
        expect(event?.type === 'comment.create' && event.anchor).toEqual({ target: 'block:img' });
    });

    it('refuses an anchor that selects nothing', async () => {
        const { session, anchor } = await withComment();
        await expect(
            session.handlePage({
                type: 'comment.create',
                anchor: { ...anchor, position: { start: 4, end: 4 } },
                intent: 'question',
                text: 'x'
            })
        ).rejects.toThrow(/selects no text/);
    });

    it('reply with edits: lists each section it changed, and those sections need review again', async () => {
        const { session } = await withComment();
        const checklist = (items: string[]): AgentEvent => ({
            type: 'doc.block.upsert',
            block: { id: 's8-list', type: 'checklist', config: { items: items.map((text) => ({ text })) } }
        });
        const blocks = Array.from({ length: 8 }, (_, n) => textBlock(`t${n + 1}`, `Section ${n + 1}`));
        const sections = Array.from({ length: 8 }, (_, n) =>
            section(`s${n + 1}`, n + 1, n === 7 ? [`t${n + 1}`, 's8-list'] : [`t${n + 1}`])
        );
        await session.emit({ events: [...blocks, checklist(['Has an owner']), ...sections] });
        await session.handlePage({ type: 'review.mark', sectionId: 's4', reviewed: true });
        await session.handlePage({ type: 'review.mark', sectionId: 's8', reviewed: true });

        await session.emit({
            events: [
                textBlock('t4', 'Overrides need an owner and expire after 30 days.'),
                checklist(['Has an owner', 'Override expiry enforced']),
                { type: 'comment.reply', threadId: 'C-1', text: 'Added an owner and an expiry.' }
            ]
        });
        const reply = defined(defined(session.current.threads['C-1']).messages.at(-1));
        expect(reply).toMatchObject({ author: 'agent', text: 'Added an owner and an expiry.' });
        expect(reply.touched?.map((item) => item.note)).toEqual(['§4 edited', '§8 1 item added']);
        expect(session.current.sections.s4?.reviewed).toBe(false);
        expect(session.current.sections.s8?.reviewed).toBe(false);
    });

    it('the user replies and resolves; resolving tells the agent', async () => {
        const { session } = await withComment();
        await session.emit({ events: [{ type: 'comment.reply', threadId: 'C-1', text: 'Which owner?' }] });
        await session.handlePage({ type: 'thread.reply', threadId: 'C-1', text: 'The account manager' });
        const ack = await session.handlePage({ type: 'comment.resolve', threadId: 'C-1' });
        expect(session.current.threads['C-1']).toMatchObject({ status: 'resolved' });
        expect(session.current.threads['C-1']?.messages.map((message) => message.author)).toEqual(['user', 'agent', 'user']);
        expect((await session.wait(defined(ack.seq) - 1, 1)).events[0]).toMatchObject({
            type: 'comment.resolve',
            threadId: 'C-1'
        });
    });

    it('reply with a diagram: stored on the message, and a block that fails its schema is reported', async () => {
        const { session } = await withComment();
        const flow = { type: 'flow', config: { nodes: [{ id: 'a', label: 'Request' }], edges: [] } };
        const result = await session.emit({
            events: [
                {
                    type: 'comment.reply',
                    threadId: 'C-1',
                    text: 'Here is the path a request takes.',
                    blocks: [flow, { type: 'bar', config: {} }]
                }
            ]
        });
        expect(session.current.threads['C-1']?.messages.at(-1)?.blocks).toEqual([flow, { type: 'bar', config: {} }]);
        expect(result.blockProblems.map((problem) => problem.block)).toEqual(['C-1.2 blocks[1]']);
    });

    it('a reply whose block failed is fixed in place: the same message, no new one', async () => {
        const { session } = await withComment();
        const broken = { type: 'bar', config: {} };
        const first = await session.emit({
            events: [{ type: 'comment.reply', threadId: 'C-1', text: 'Here is the split.', blocks: [broken] }]
        });
        expect(first.applied[0]?.ref).toBe('C-1.2');
        const bar = { type: 'bar', config: { series: ['Keys'], data: [['Free', 3]] } };
        const fixed = await session.emit({ events: [{ type: 'comment.edit', messageId: 'C-1.2', blocks: [bar] }] });
        expect(fixed.blockProblems).toEqual([]);
        expect(fixed.applied[0]).toMatchObject({ ref: 'C-1.2', changed: true });
        expect(session.current.threads['C-1']?.messages).toHaveLength(2);
        expect(session.current.threads['C-1']?.messages.at(-1)).toMatchObject({ text: 'Here is the split.', blocks: [bar] });
    });

    it("comment.edit refuses the user's message and one that does not exist", async () => {
        const { session } = await withComment();
        await expect(session.emit({ events: [{ type: 'comment.edit', messageId: 'C-1.1', text: 'Rewritten' }] })).rejects.toThrow(
            /edit only your own replies/
        );
        await expect(session.emit({ events: [{ type: 'comment.edit', messageId: 'C-1.9', text: 'x' }] })).rejects.toThrow(
            /does not exist/
        );
        expect(session.current.threads['C-1']?.messages.map((message) => message.text)).toEqual([
            'Overrides need an owner and an expiry'
        ]);
    });

    it('the agent can reply and resolve in one step', async () => {
        const { session } = await withComment();
        await session.emit({ events: [{ type: 'comment.reply', threadId: 'C-1', text: 'Done.', resolve: true }] });
        expect(session.current.threads['C-1']?.status).toBe('resolved');
    });

    it('direct message: sent unanchored, and the agent reply lands in the same thread', async () => {
        const { session } = await harness();
        const ack = await session.handlePage({ type: 'message.send', text: 'Keep the EU edge in mind throughout' });
        expect((await session.wait(0, 1)).events[0]).toMatchObject({ seq: ack.seq, type: 'message.send', threadId: 'M-1' });
        await session.emit({
            events: [{ type: 'comment.reply', threadId: 'M-1', text: 'Noted: every region gets its own limit.' }]
        });
        expect(session.current.threads['M-1']).toMatchObject({
            kind: 'message',
            messages: [{ author: 'user' }, { author: 'agent' }]
        });
        expect(session.current.threads['M-1']?.anchor).toBeUndefined();
    });

    it('pasted stack trace and pasted screenshot: stored on the message, and the agent gets the snippet and each image with the path to open it at', async () => {
        const { session } = await harness();
        const attachments = [
            { kind: 'image', asset: 'paste-1.png' },
            { kind: 'text', text: 'Error: limit exceeded\n    at check (limits.ts:12)' }
        ] as const;
        await session.handlePage({ type: 'message.send', text: '', attachments });
        expect(session.current.threads['M-1']?.messages[0]).toMatchObject({ text: '', attachments });
        const [event] = (await session.wait(0, 1)).events;
        expect(event).toMatchObject({
            type: 'message.send',
            attachments: [
                {
                    kind: 'image',
                    asset: 'paste-1.png',
                    path: `openspec/changes/${session.current.changeId}/.planroom/assets/paste-1.png`
                },
                attachments[1]
            ]
        });
    });

    it("a Markdown plan's pasted image: the agent gets its path under agent-plans/", async () => {
        const { session } = await harness({ format: 'markdown' });
        await session.handlePage({ type: 'message.send', text: 'see', attachments: [{ kind: 'image', asset: 'paste-1.png' }] });
        const [event] = (await session.wait(0, 1)).events;
        expect(event).toMatchObject({
            attachments: [{ path: `agent-plans/${session.current.changeId}/.planroom/assets/paste-1.png` }]
        });
    });

    it('refuses a message with neither words nor pastes, and an attachment outside the assets folder', async () => {
        const { session } = await harness();
        await expect(session.handlePage({ type: 'message.send', text: '  ' })).rejects.toThrow(/write a message or paste/);
        await expect(
            session.handlePage({ type: 'message.send', text: 'x', attachments: [{ kind: 'image', asset: '../state.json' }] })
        ).rejects.toThrow(/image file name/);
    });

    it('rejects a reply to a thread that does not exist', async () => {
        const { session } = await harness();
        await expect(session.emit({ events: [{ type: 'comment.reply', threadId: 'C-9', text: 'x' }] })).rejects.toThrow(
            /thread C-9 does not exist/
        );
    });
});
