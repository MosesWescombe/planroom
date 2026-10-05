import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QuestionRecord, QuestionStatus } from '../../shared/questions';
import type { Attachment, ThreadMessage } from '../../shared/records';
import type { AgentStatus } from '../../shared/view';
import { commentThread, NOW, questionRecord } from '../../test/fixtures';
import { defined, instance, makeView, posted, renderWith, storeWith } from '../../test/harness';
import { SidePanel } from '../components/SidePanel';
import { Thread } from '../components/Thread';
import { QuestionCard } from '../interrogate/QuestionCard';
import { readSetting } from '../local';
import { setAnchorStates } from './anchorStatus';
import { CommentLayer } from './CommentLayer';
import { closeComposer, commentOnWhole } from './composer';
import { captureSelection, rangeFromOffsets } from './selection';

/** Make `range` the page's only selection. */
function selectRange(range: Range): void {
    const selection = defined(window.getSelection());
    selection.removeAllRanges();
    selection.addRange(range);
}

/** Select `quote` inside the first text node of `element` that contains it. */
function select(element: Element, quote: string): void {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const index = (node.textContent ?? '').indexOf(quote);
        if (index === -1) continue;
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + quote.length);
        selectRange(range);
        return;
    }
    throw new Error(`"${quote}" not found`);
}

function Table() {
    return (
        <div data-anchor-target="block:s4-table">
            <table>
                <tbody>
                    <tr>
                        <td>Overrides</td>
                        <td>support can raise one key</td>
                    </tr>
                </tbody>
            </table>
        </div>
    );
}

describe('commenting on any selected text', () => {
    // The composer is module state: a test that fails with it open must not leave it open for the next.
    afterEach(closeComposer);

    it('captures an anchor over a table cell, with offsets and quote context', () => {
        renderWith(storeWith(makeView()), <Table />);
        select(screen.getByText('support can raise one key'), 'support can raise one key');
        expect(captureSelection()?.anchor).toEqual({
            target: 'block:s4-table',
            position: { start: 9, end: 34 },
            quote: { exact: 'support can raise one key', prefix: 'Overrides', suffix: '' }
        });
        const range = rangeFromOffsets(instance(document.querySelector('[data-anchor-target]'), HTMLElement), 9, 34);
        expect(range?.toString()).toBe('support can raise one key');
    });

    it('ignores a selection that spans two commentable elements or sits in a field', () => {
        renderWith(
            storeWith(makeView()),
            <>
                <p data-anchor-target="a">first</p>
                <p data-anchor-target="b">second</p>
                <div data-anchor-target="c">
                    <textarea defaultValue="typed" />
                </div>
            </>
        );
        const range = document.createRange();
        range.setStart(instance(screen.getByText('first').firstChild, Text), 0);
        range.setEnd(instance(screen.getByText('second').firstChild, Text), 3);
        selectRange(range);
        expect(captureSelection()).toBeUndefined();
    });

    it('comment on a table cell: the toolbar opens the composer, and sending carries the change intent and the anchor', async () => {
        renderWith(
            storeWith(makeView()),
            <>
                <Table />
                <CommentLayer />
            </>
        );
        select(screen.getByText('support can raise one key'), 'support can raise one key');
        fireEvent(document, new Event('selectionchange'));
        const toolbar = await screen.findByRole('toolbar', { name: 'Selection actions' });
        fireEvent.click(within(toolbar).getByRole('button', { name: 'Ask to change' }));
        const composer = screen.getByRole('dialog', { name: 'Comment' });
        expect(within(composer).getByRole('radio', { name: 'Change this' })).toHaveAttribute('aria-checked', 'true');
        const user = userEvent.setup();
        await user.type(within(composer).getByLabelText('Comment'), 'Overrides need an owner and an expiry');
        await user.click(within(composer).getByRole('button', { name: 'Send to agent' }));
        await waitFor(() =>
            expect(posted).toEqual([
                {
                    type: 'comment.create',
                    anchor: {
                        target: 'block:s4-table',
                        position: { start: 9, end: 34 },
                        quote: { exact: 'support can raise one key', prefix: 'Overrides', suffix: '' }
                    },
                    intent: 'change',
                    text: 'Overrides need an owner and an expiry'
                }
            ])
        );
    });

    it('keyboard: selecting text and pressing C opens the composer for that selection', () => {
        renderWith(
            storeWith(makeView()),
            <>
                <Table />
                <CommentLayer />
            </>
        );
        select(screen.getByText('support can raise one key'), 'raise one key');
        fireEvent.keyDown(document, { key: 'c' });
        const composer = screen.getByRole('dialog', { name: 'Comment' });
        expect(within(composer).getByText('raise one key')).toBeInTheDocument();
        expect(within(composer).getByRole('radio', { name: 'Question' })).toHaveAttribute('aria-checked', 'true');
        act(() => closeComposer());
    });

    it('ask to clarify a question: anchored to the question id, not a quote of the whole card', async () => {
        renderWith(
            storeWith(makeView()),
            <>
                <div data-anchor-target="question:Q-3">How should the rate limit fail? Fail open or fail closed</div>
                <CommentLayer />
            </>
        );
        act(() => commentOnWhole('question:Q-3', 'question'));
        const composer = screen.getByRole('dialog', { name: 'Comment' });
        expect(within(composer).getByText('Comment on Q-3')).toBeInTheDocument();
        const user = userEvent.setup();
        await user.type(within(composer).getByLabelText('Comment'), 'Which callers?');
        await user.click(within(composer).getByRole('button', { name: 'Send to agent' }));
        await waitFor(() =>
            expect(posted).toEqual([
                { type: 'comment.create', anchor: { target: 'question:Q-3' }, intent: 'question', text: 'Which callers?' }
            ])
        );
    });

    it('opening another comment box keeps the text typed in the open one, and closing the box clears it', async () => {
        renderWith(
            storeWith(makeView()),
            <>
                <Table />
                <div data-anchor-target="question:Q-3">How should the rate limit fail?</div>
                <CommentLayer />
            </>
        );
        select(screen.getByText('support can raise one key'), 'raise one key');
        fireEvent.keyDown(document, { key: 'c' });
        const user = userEvent.setup();
        await user.type(within(screen.getByRole('dialog', { name: 'Comment' })).getByLabelText('Comment'), 'Halfway through');
        act(() => commentOnWhole('question:Q-3', 'question'));
        const composer = screen.getByRole('dialog', { name: 'Comment' });
        expect(within(composer).getByText('Comment on Q-3')).toBeInTheDocument();
        expect(within(composer).getByLabelText('Comment')).toHaveValue('Halfway through');
        act(() => closeComposer());
        act(() => commentOnWhole('question:Q-3', 'question'));
        expect(within(screen.getByRole('dialog', { name: 'Comment' })).getByLabelText('Comment')).toHaveValue('');
        act(() => closeComposer());
    });

    it('does not open the composer when C is typed into a field', () => {
        renderWith(
            storeWith(makeView()),
            <>
                <Table />
                <textarea aria-label="notes" />
                <CommentLayer />
            </>
        );
        select(screen.getByText('support can raise one key'), 'raise one key');
        fireEvent.keyDown(screen.getByLabelText('notes'), { key: 'c' });
        expect(screen.queryByRole('dialog', { name: 'Comment' })).toBeNull();
    });
});

describe('threads', () => {
    it('quoted text removed: the thread shows as detached with its original quote', () => {
        renderWith(
            storeWith(
                makeView({
                    threads: [
                        commentThread('C-1', 'block:b1', {
                            anchor: {
                                target: 'block:b1',
                                position: { start: 0, end: 10 },
                                quote: { exact: 'raise a key', prefix: '', suffix: '' }
                            }
                        })
                    ]
                })
            ),
            <Thread id="C-1" />
        );
        act(() => setAnchorStates(new Map([['C-1', 'detached']])));
        expect(screen.getByText('Detached · the quoted text is gone')).toBeInTheDocument();
        expect(screen.getByText('raise a key')).toHaveClass('is-detached');
        act(() => setAnchorStates(new Map()));
    });

    it('reply with edits: the agent reply lists each section it changed', () => {
        const thread = commentThread('C-1', 'block:s4-table', {
            messages: [
                { id: 'C-1.1', author: 'user', text: 'Overrides need an owner and an expiry', at: NOW },
                {
                    id: 'C-1.2',
                    author: 'agent',
                    text: 'Done: overrides last up to 30 days and need a named owner.',
                    at: NOW,
                    touched: [
                        { ref: 'section:s4', note: '§4 edited' },
                        { ref: 'section:s8', note: '§8 1 item added' }
                    ]
                }
            ]
        });
        renderWith(storeWith(makeView({ threads: [thread] })), <Thread id="C-1" />);
        expect(screen.getByRole('link', { name: '§4 edited' })).toBeInTheDocument();
        expect(screen.getByRole('link', { name: '§8 1 item added' })).toBeInTheDocument();
    });

    it('messages render as markdown: a list and code in a reply read as a list and code, not one run-on line', () => {
        const thread = commentThread('C-1', 'block:b1', {
            messages: [
                { id: 'C-1.1', author: 'user', text: 'Where is the client built?', at: NOW },
                {
                    id: 'C-1.2',
                    author: 'agent',
                    text: 'Two places:\n\n- `uplinkV2.command.ts:237`\n- `constants.ts:208`',
                    at: NOW
                }
            ]
        });
        renderWith(storeWith(makeView({ threads: [thread] })), <Thread id="C-1" />);
        const items = screen.getAllByRole('listitem');
        expect(items.map((item) => item.textContent)).toEqual(['uplinkV2.command.ts:237', 'constants.ts:208']);
        expect(items[0]?.querySelector('code')).toBeInTheDocument();
    });

    it('the user replies and resolves; resolving tells the agent', async () => {
        renderWith(storeWith(makeView({ threads: [commentThread('C-1', 'block:b1')] })), <Thread id="C-1" />);
        const user = userEvent.setup();
        await user.click(screen.getByRole('button', { name: 'Reply' }));
        await user.type(screen.getByLabelText('Reply'), 'The account manager');
        await user.click(screen.getByRole('button', { name: 'Send' }));
        await user.click(screen.getByRole('button', { name: 'Resolve' }));
        await waitFor(() =>
            expect(posted).toEqual([
                { type: 'thread.reply', threadId: 'C-1', text: 'The account manager' },
                { type: 'comment.resolve', threadId: 'C-1' }
            ])
        );
    });

    it('resizing the panel: dragging or the arrow keys widen it, double-click resets, and the width is remembered', () => {
        renderWith(storeWith(makeView()), <SidePanel />);
        const splitter = screen.getByRole('separator', { name: 'Resize side panel' });
        fireEvent.keyDown(splitter, { key: 'ArrowLeft' });
        fireEvent.keyDown(splitter, { key: 'ArrowLeft' });
        expect(splitter).toHaveAttribute('aria-valuenow', '576');
        expect(screen.getByRole('complementary', { name: 'Side panel' })).toHaveStyle({ width: '576px' });
        expect(readSetting('planroom:panel-width')).toBe('576');
        // jsdom has no PointerEvent; a MouseEvent carries the same button and clientX.
        vi.stubGlobal('PointerEvent', MouseEvent);
        fireEvent.pointerDown(splitter, { button: 0, clientX: 600 });
        fireEvent.pointerMove(window, { clientX: 570 });
        fireEvent.pointerUp(window);
        fireEvent.pointerMove(window, { clientX: 100 });
        expect(splitter).toHaveAttribute('aria-valuenow', '606');
        fireEvent.doubleClick(splitter);
        expect(splitter).toHaveAttribute('aria-valuenow', '528');
        expect(readSetting('planroom:panel-width')).toBeUndefined();
    });

    it('direct message: sends from the panel, and the reply shows under it', async () => {
        const store = storeWith(makeView());
        renderWith(store, <SidePanel />);
        const user = userEvent.setup();
        await user.type(screen.getByLabelText('Message the agent'), 'Keep the EU edge in mind throughout');
        await user.click(screen.getByRole('button', { name: 'Send' }));
        await waitFor(() => expect(posted).toEqual([{ type: 'message.send', text: 'Keep the EU edge in mind throughout' }]));
        act(() =>
            store.apply([
                {
                    field: 'threads',
                    id: 'M-1',
                    value: {
                        id: 'M-1',
                        kind: 'message',
                        status: 'open',
                        messages: [
                            { id: 'M-1.1', author: 'user', text: 'Keep the EU edge in mind throughout', at: NOW },
                            { id: 'M-1.2', author: 'agent', text: 'Noted: every region gets its own limit.', at: NOW }
                        ],
                        version: 2,
                        createdAt: NOW,
                        updatedAt: NOW
                    }
                }
            ])
        );
        await user.click(screen.getByRole('tab', { name: /Comments/ }));
        const row = screen.getByRole('button', { name: /Keep the EU edge in mind throughout/ });
        expect(row).toHaveTextContent('New reply from the agent');
        await user.click(row);
        const dialog = screen.getByRole('dialog', { name: 'Message to the agent' });
        expect(dialog).toHaveTextContent('Noted: every region gets its own limit.');
        expect(row).toHaveTextContent('Agent replied');
        expect(within(dialog).queryByRole('button', { name: 'Show on the page' })).toBeNull();
    });

    it('a comment in the panel is a row that opens the whole thread in a dialog, with a way back to the page', async () => {
        const thread = commentThread('C-1', 'block:b1', {
            anchor: {
                target: 'block:b1',
                position: { start: 0, end: 11 },
                quote: { exact: 'raise a key', prefix: '', suffix: '' }
            },
            messages: [
                { id: 'C-1.1', author: 'user', text: 'Who can raise one?', at: NOW },
                { id: 'C-1.2', author: 'agent', text: 'Only **support**, for up to 30 days.', at: NOW }
            ]
        });
        renderWith(storeWith(makeView({ threads: [thread] })), <SidePanel />);
        const user = userEvent.setup();
        await user.click(screen.getByRole('tab', { name: /Comments/ }));
        const row = screen.getByRole('button', { name: /raise a key/ });
        expect(row).toHaveAttribute('id', 'thread-C-1');
        expect(row).not.toHaveTextContent('Only support');
        await user.click(row);
        const dialog = screen.getByRole('dialog', { name: 'Comment on the write-up' });
        expect(within(dialog).getByText('support').tagName).toBe('STRONG');
        await user.click(within(dialog).getByRole('button', { name: 'Show on the page' }));
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('pasted stack trace: a long paste becomes a snippet, sent as an attachment and shown as a button that opens it', async () => {
        const store = storeWith(makeView());
        renderWith(store, <SidePanel />);
        const user = userEvent.setup();
        const log = Array.from({ length: 40 }, (_, n) => `line ${n + 1}`).join('\n');
        const box = screen.getByLabelText('Message the agent');
        fireEvent.paste(box, { clipboardData: { getData: () => log, files: [] } });
        expect(box).toHaveValue('');
        await user.type(box, 'Why does this fail?');
        await user.click(screen.getByRole('button', { name: 'Send' }));
        const attachments: Attachment[] = [{ kind: 'text', text: log }];
        await waitFor(() => expect(posted).toEqual([{ type: 'message.send', text: 'Why does this fail?', attachments }]));
        expect(screen.queryByRole('button', { name: /Pasted text/ })).toBeNull();

        const message = { id: 'M-1.1', author: 'user', text: 'Why does this fail?', attachments, at: NOW } as const;
        act(() =>
            store.apply([
                {
                    field: 'threads',
                    id: 'M-1',
                    value: {
                        id: 'M-1',
                        kind: 'message',
                        status: 'open',
                        messages: [message],
                        version: 1,
                        createdAt: NOW,
                        updatedAt: NOW
                    }
                }
            ])
        );
        await user.click(screen.getByRole('tab', { name: /Comments/ }));
        await user.click(screen.getByRole('button', { name: /Why does this fail\?/ }));
        const thread = screen.getByRole('article', { name: 'Message M-1' });
        expect(thread).not.toHaveTextContent('line 40');
        await user.click(within(thread).getByRole('button', { name: 'Pasted text, 40 lines' }));
        expect(screen.getByRole('dialog', { name: 'Pasted text' })).toHaveTextContent('line 40');
    });

    it('a short paste goes into the message as text', () => {
        renderWith(storeWith(makeView()), <SidePanel />);
        const box = screen.getByLabelText('Message the agent');
        const pasted = fireEvent.paste(box, { clipboardData: { getData: () => 'EU edge', files: [] } });
        expect(pasted).toBe(true);
        expect(screen.queryByRole('button', { name: /Pasted text/ })).toBeNull();
    });
});

describe('comments on a question card', () => {
    const flow = {
        type: 'flow',
        config: {
            nodes: [
                { id: 'a', label: 'Request' },
                { id: 'b', label: 'Limiter' }
            ],
            edges: [{ from: 'a', to: 'b' }]
        }
    };
    const clarified = (messages: ThreadMessage[]) =>
        commentThread('C-1', 'question:Q-3', { anchor: { target: 'question:Q-3' }, intent: 'question', messages });
    const ask: ThreadMessage = { id: 'C-1.1', author: 'user', text: 'Why does the limiter sit before auth?', at: NOW };

    it('waiting: the card lists the comment outside the question text, before the agent replies', () => {
        renderWith(
            storeWith(makeView({ questions: [questionRecord('Q-3')], threads: [clarified([ask])] })),
            <QuestionCard id="Q-3" />
        );
        const row = screen.getByRole('button', { name: /Why does the limiter sit before auth\?/ });
        expect(row).toHaveTextContent('Waiting for the agent');
        expect(row.querySelector('.agent-now-dots')).not.toBeNull();
        expect(document.querySelector('[data-anchor-target="question:Q-3"]')).not.toHaveTextContent('limiter');
    });

    it('replying: the row says what the agent is doing about this comment', () => {
        const agent: AgentStatus = { mode: 'waiting', queued: 0, working: true, doing: 'researching the limiter', thread: 'C-1' };
        renderWith(
            storeWith(makeView({ questions: [questionRecord('Q-3')], threads: [clarified([ask])] }, { agent })),
            <QuestionCard id="Q-3" />
        );
        const row = screen.getByRole('button', { name: /Why does the limiter sit before auth\?/ });
        expect(row).toHaveTextContent('Agent researching the limiter');
        expect(row).not.toHaveTextContent('Waiting for the agent');
    });

    it('a reply half-typed on a clarification survives the card changing layout: reworded, in conflict, closed', async () => {
        const store = storeWith(makeView({ questions: [questionRecord('Q-3', 'answered')], threads: [clarified([ask])] }));
        renderWith(store, <QuestionCard id="Q-3" />);
        const user = userEvent.setup();
        await user.click(screen.getByRole('button', { name: /Why does the limiter sit before auth\?/ }));
        await user.click(screen.getByRole('button', { name: 'Reply' }));
        await user.type(screen.getByLabelText('Reply'), 'Half a thought');
        const changes: QuestionRecord[] = [
            questionRecord('Q-3', 'needs-review', { version: 2, contentVersion: 2, changedByAgentAt: NOW }),
            questionRecord('Q-3', 'conflict', {
                version: 3,
                answer: { choice: 'a', version: 1, at: NOW },
                conflict: { with: 'Q-1', reason: 'Failing closed takes the API down.' }
            }),
            questionRecord('Q-3', 'closed', { version: 4, closedReason: 'covered by Q-1' })
        ];
        for (const value of changes) {
            act(() => store.apply([{ field: 'questions', id: 'Q-3', value }]));
            const reply = within(screen.getByRole('article', { name: 'Question Q-3' })).getByLabelText('Reply');
            expect(reply).toHaveValue('Half a thought');
            expect(reply).toHaveFocus();
        }
    });

    it('a comment quoting the context or an option stays attached when the card folds to one line, conflicts or closes', async () => {
        const question = (status: QuestionStatus) =>
            questionRecord('Q-3', status, {
                context: { why: 'Every request checks Redis first.' },
                options: [
                    { id: 'a', label: 'Option A', detail: 'Counts in Redis' },
                    { id: 'b', label: 'Option B' }
                ],
                answer: { choice: 'b', version: 1, at: NOW },
                conflict: status === 'conflict' ? { with: 'Q-1', reason: 'Failing closed takes the API down.' } : undefined,
                closedReason: 'covered by Q-1'
            });
        const quoting = (id: string, exact: string) =>
            commentThread(id, 'question:Q-3', {
                anchor: {
                    target: 'question:Q-3',
                    position: { start: 40, end: 40 + exact.length },
                    quote: { exact, prefix: '', suffix: '' }
                },
                messages: [{ id: `${id}.1`, author: 'user', text: `About ${exact}`, at: NOW }]
            });
        const threads = [
            quoting('C-1', 'checks Redis'),
            quoting('C-2', 'Counts in Redis'),
            quoting('C-3', 'a line the agent removed')
        ];
        const row = (exact: string) => screen.getByRole('button', { name: new RegExp(`About ${exact}`) });
        for (const status of ['answered', 'conflict', 'closed'] as const) {
            act(() => setAnchorStates(new Map()));
            renderWith(
                storeWith(makeView({ questions: [question(status)], threads })),
                <>
                    <QuestionCard id="Q-3" />
                    <CommentLayer />
                </>
            );
            // The comment on text that really is gone shows the highlighter has resolved every anchor.
            await waitFor(() => expect(row('a line the agent removed')).toHaveTextContent('Detached'));
            expect(row('checks Redis')).not.toHaveTextContent('Detached');
            expect(row('Counts in Redis')).not.toHaveTextContent('Detached');
            cleanup();
        }
        act(() => setAnchorStates(new Map()));
    });

    it('clarification on an answered question: the dialog shows the reply and its diagram, and Escape closes one dialog at a time', async () => {
        const reply: ThreadMessage = {
            id: 'C-1.2',
            author: 'agent',
            text: 'So a flood is shed before it costs a token check.',
            at: NOW,
            blocks: [flow]
        };
        renderWith(
            storeWith(makeView({ questions: [questionRecord('Q-3', 'answered')], threads: [clarified([ask, reply])] })),
            <QuestionCard id="Q-3" />
        );
        const user = userEvent.setup();
        const row = screen.getByRole('button', { name: /Why does the limiter sit before auth\?/ });
        expect(row).toHaveTextContent('New reply from the agent');
        expect(row).toHaveTextContent('1 figure');

        await user.click(row);
        const dialog = screen.getByRole('dialog', { name: /^Q-3 · / });
        expect(dialog).toHaveTextContent('So a flood is shed before it costs a token check.');
        expect(dialog.querySelector('svg.diagram')).toBeInTheDocument();
        expect(dialog.querySelector('#thread-C-1')).toBeNull();

        await user.click(within(dialog).getByRole('button', { name: 'Full screen' }));
        expect(screen.getAllByRole('dialog')).toHaveLength(2);
        await user.keyboard('{Escape}');
        expect(screen.getAllByRole('dialog')).toHaveLength(1);
        await user.keyboard('{Escape}');
        expect(screen.queryByRole('dialog')).toBeNull();
    });
});
