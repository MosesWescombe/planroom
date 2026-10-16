import { EditorView } from '@codemirror/view';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LineIndex, PageRecord, TickRecord } from '../../shared/readthrough';
import type { ThreadRecord } from '../../shared/records';
import { DEFAULT_PREFERENCES, type ItemRecord, type ReviewPreferences, type RoundRecord } from '../../shared/review';
import { commentThread, NOW } from '../../test/fixtures';
import { defined, makeView, posted, storeWith } from '../../test/harness';
import { App } from '../App';
import { CodeViewer, type LineSelection } from '../code/CodeViewer';
import { rangeFromOffsets } from '../comments/selection';
import { writeSetting } from '../local';
import { editorLink } from './Readthrough';

const SEND_PATCH = `diff --git a/src/send.ts b/src/send.ts
--- a/src/send.ts
+++ b/src/send.ts
@@ -1,12 +1,11 @@
 import { deliver } from './deliver';

-export function send(job) {
+export function send(job, policy: RetryPolicy) {
     for (let attempt = 1; ; attempt += 1) {
         try {
             return deliver(job);
         } catch (error) {
-            if (attempt >= 3) throw error;
+            if (attempt >= policy.maxAttempts) throw error;
         }
-        log.warn('retrying');
     }
 }
`;

const job = (name: string, call: string) => `diff --git a/src/jobs/${name}.ts b/src/jobs/${name}.ts
--- a/src/jobs/${name}.ts
+++ b/src/jobs/${name}.ts
@@ -1,5 +1,5 @@
 import { send } from '../send';

 export function ${name}(job) {
-    return send(job, { retries: 3 });
+    return send(job, ${call});
 }
`;

/** `src/deliver.ts` from line 3, as the dialog fetches a declaration: its block, then the next statement. */
const DELIVER = ['export function deliver(job: Job) {', '    return send(job);', '}', 'export const retries = 3;'];

const PATCHES: Record<string, string> = {
    'src/send.ts': SEND_PATCH,
    'src/jobs/email.ts': job('email', 'policy'),
    'src/jobs/push.ts': job('push', 'policy, 10'),
    'src/jobs/sms.ts': job('sms', 'policy'),
    'src/a.ts': `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,6 +1,2 @@
 export const a = 1;

-export function helper(x) {
-    const y = x * 2;
-    return y + 1;
-}
`,
    'src/b.ts': `diff --git a/src/b.ts b/src/b.ts
--- /dev/null
+++ b/src/b.ts
@@ -0,0 +1,4 @@
+export function helper(x) {
+    const y = x * 3;
+    return y + 1;
+}
`,
    'src/send.test.ts': `diff --git a/src/send.test.ts b/src/send.test.ts
--- /dev/null
+++ b/src/send.test.ts
@@ -0,0 +1,6 @@
+it('retries up to the policy', () => {
+    expect(send).toBeDefined();
+});
+it('gives up', () => {
+    expect(true).toBe(true);
+});
`
};

const hunk = (oldStart: number, oldCount: number, newStart: number, newCount: number) => ({
    oldStart,
    oldCount,
    newStart,
    newCount
});

const INDEX: LineIndex = {
    files: [
        { path: 'pnpm-lock.yaml', hunks: [hunk(1, 1, 1, 1)], shown: [hunk(1, 1, 1, 1)], housekeeping: 'lock' },
        { path: 'src/a.ts', hunks: [hunk(3, 4, 2, 0)], shown: [hunk(1, 6, 1, 2)] },
        { path: 'src/b.ts', hunks: [hunk(0, 0, 1, 4)], shown: [hunk(0, 0, 1, 4)] },
        ...['email', 'push', 'sms'].map((name) => ({
            path: `src/jobs/${name}.ts`,
            hunks: [hunk(4, 1, 4, 1)],
            shown: [hunk(1, 5, 1, 5)]
        })),
        { path: 'src/send.test.ts', hunks: [hunk(0, 0, 1, 6)], shown: [hunk(0, 0, 1, 6)], test: true },
        { path: 'src/send.ts', hunks: [hunk(3, 1, 3, 1), hunk(8, 1, 8, 1), hunk(10, 1, 9, 0)], shown: [hunk(1, 12, 1, 11)] }
    ],
    repeats: [
        {
            key: 'R1',
            change: '`{ retries: 3 }` to `policy`',
            places: [
                { file: 'src/jobs/email.ts', new: [4, 4], old: [4, 4] },
                { file: 'src/jobs/push.ts', new: [4, 4], old: [4, 4], differs: 'also changes `policy` to `policy, 10`' },
                { file: 'src/jobs/sms.ts', new: [4, 4], old: [4, 4] }
            ]
        }
    ],
    moves: [{ from: { file: 'src/a.ts', lines: [3, 6] }, to: { file: 'src/b.ts', lines: [1, 4] } }]
};

function page(fields: Partial<PageRecord> & Pick<PageRecord, 'id' | 'pieces'>): PageRecord {
    return { kind: 'concept', title: `Page ${fields.id}`, order: 1, round: 1, added: [], version: 1, updatedAt: NOW, ...fields };
}

const RETRY = page({
    id: 'retry-limit',
    title: 'The retry limit is a setting',
    pieces: [
        { id: 'send', file: 'src/send.ts', lines: '1-11', view: 'now' },
        { id: 'callers', file: 'src/jobs/email.ts', lines: '4', repeat: 'R1', view: 'diff' }
    ],
    content: {
        summary: 'Retries stop at **the policy** limit now.',
        pieces: [
            {
                id: 'send',
                note: 'The send loop reads the limit.',
                blocks: [{ type: 'callout', config: { tone: 'note', body: 'It stops at the last attempt.' } }],
                related: [{ file: 'src/policy.ts', lines: '1-2', note: 'The policy' }]
            },
            { id: 'callers', note: 'Every job passes the policy.' }
        ]
    }
});
const MOVED = page({
    id: 'helper-moved',
    title: 'The helper moved',
    order: 2,
    pieces: [{ id: 'helper', file: 'src/b.ts', lines: '1-4', from: { file: 'src/a.ts', oldLines: '3-6' } }]
});
const TESTS = page({
    id: 'send-tests',
    kind: 'tests',
    title: 'Tests of the send loop',
    pieces: [
        { id: 'test-retries', file: 'src/send.test.ts', lines: '1-3', title: 'retries up to the policy' },
        { id: 'test-gives-up', file: 'src/send.test.ts', lines: '4-6', title: 'gives up' }
    ],
    content: {
        summary: 'Two cases.',
        pieces: [],
        tests: [
            {
                piece: 'test-retries',
                title: 'retries up to the policy',
                pseudo: 'send fails twice, then works: one call returns'
            },
            { piece: 'test-gives-up', title: 'gives up', pseudo: 'send always fails: it throws after the limit' }
        ]
    }
});

const tick: TickRecord = { how: 'manual', at: NOW };

/** A branch review read through alone, with its pages laid out and the given round, pages, ticks and preferences. */
function readView(
    options: {
        round?: Partial<RoundRecord>;
        pages?: PageRecord[];
        ticks?: Record<string, TickRecord>;
        items?: ItemRecord[];
        threads?: ThreadRecord[];
        preferences?: ReviewPreferences;
        worktreeDir?: string;
    } = {}
) {
    const pages = options.pages ?? [RETRY, { ...MOVED, content: { summary: 'Moved.', pieces: [] } }, TESTS];
    return makeView(
        {
            threads: options.threads ?? [],
            patch: {
                kind: 'review',
                changeId: 'branch-feature',
                review: {
                    target: { kind: 'branch', branch: 'feature/retry', base: 'main' },
                    title: 'The retry limit is a setting',
                    description: '',
                    worktree: '.planroom/reviews/branch-feature/worktree',
                    rounds: [
                        {
                            n: 1,
                            base: 'aaaa',
                            head: 'bbbb',
                            files: INDEX.files.map((file) => ({
                                path: file.path,
                                status: 'modified',
                                additions: 1,
                                deletions: 1
                            })),
                            startedAt: NOW,
                            summary: {},
                            posts: {},
                            earlier: {},
                            technique: 'readthrough',
                            reviewers: { strength: 'none', model: 'sonnet', effort: 'high', at: NOW },
                            index: INDEX,
                            readthrough: { openedAt: NOW },
                            ...options.round
                        }
                    ]
                },
                pages: Object.fromEntries(pages.map((record) => [`1:${record.id}`, record])),
                ticks: options.ticks ?? {},
                items: Object.fromEntries((options.items ?? []).map((item) => [item.id, item]))
            }
        },
        {
            preferences: options.preferences ?? DEFAULT_PREFERENCES,
            postable: { ready: true },
            ...(options.worktreeDir ? { worktreeDir: options.worktreeDir } : {})
        }
    );
}

/** Answer the page's calls: events are recorded in `posted`, diffs, searches and code come from the fixtures. */
function stubServer(search?: (q: string, definition: boolean) => unknown) {
    let seq = 0;
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
            const query = new URLSearchParams(url.split('?')[1] ?? '');
            if (url === 'api/events') {
                const body: Record<string, unknown> = JSON.parse(String(init?.body));
                posted.push(body);
                seq += 1;
                if (body.type === 'comments.handoff')
                    return Response.json({
                        handoff: { file: '/repo/.planroom/reviews/branch-feature/handoff-round-1.md', prompt: 'Read it' }
                    });
                return Response.json({ seq });
            }
            if (url.startsWith('api/review/diff'))
                return Response.json({ round: 1, patch: PATCHES[query.get('file') ?? ''] ?? '' });
            if (url.startsWith('api/review/search'))
                return Response.json(search?.(query.get('q') ?? '', query.get('definition') === '1'));
            if (url.startsWith('api/code'))
                return Response.json(
                    query.get('file') === 'src/deliver.ts'
                        ? { file: 'src/deliver.ts', start: 3, end: 6, lines: DELIVER }
                        : { file: query.get('file'), start: 1, end: 2, lines: ['export const policy = 1;', ''] }
                );
            return Response.json({ error: 'not found' }, { status: 404 });
        })
    );
}

/** An IntersectionObserver stand-in whose elements the test puts on screen. */
class FakeObserver {
    static all: FakeObserver[] = [];
    element: Element | undefined;
    constructor(readonly callback: (entries: unknown[]) => void) {
        FakeObserver.all.push(this);
    }
    observe(element: Element) {
        this.element = element;
    }
    disconnect() {
        this.element = undefined;
    }
    unobserve() {}
    /** Put `element` fully on screen. */
    static show(element: Element) {
        for (const observer of FakeObserver.all)
            if (observer.element === element)
                observer.callback([
                    {
                        isIntersecting: true,
                        intersectionRect: { height: 200 },
                        boundingClientRect: { height: 200 },
                        rootBounds: { height: 800 }
                    }
                ]);
    }
}

beforeEach(() => {
    stubServer();
    FakeObserver.all = [];
    vi.stubGlobal('IntersectionObserver', FakeObserver);
});

afterEach(() => vi.useRealTimers());

/** Replace the text of the comment editor `box`, as typing it would. */
function typeInto(box: HTMLElement, text: string) {
    const view = EditorView.findFromDOM(box.closest('.markdown-editor') as HTMLElement)!;
    act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }));
}

/** The piece card for `where`. */
const piece = (where: string) => screen.getByRole('article', { name: where });

/** The code line in `container` holding `text`, once its file's diff has loaded; highlighting splits a line into spans. */
async function line(container: HTMLElement, text: string): Promise<HTMLElement> {
    let found: HTMLElement | undefined;
    await waitFor(() => {
        found = [...container.querySelectorAll<HTMLElement>('.code-line')].find((row) => row.textContent?.includes(text));
        expect(found).toBeDefined();
    });
    return found!;
}

/** Select code as a drag would, from the start of `from` in `first` to the end of `to` in `last`, then let go. */
function selectCode(first: HTMLElement, from: string, last = first, to = from): void {
    const point = (row: HTMLElement, at: (code: string) => number) => {
        const code = defined(row.querySelector('.line-code'));
        const offset = at(code.textContent ?? '');
        return defined(rangeFromOffsets(code, offset, offset));
    };
    const start = point(first, (code) => code.indexOf(from));
    const end = point(last, (code) => code.indexOf(to) + to.length);
    defined(window.getSelection()).setBaseAndExtent(start.startContainer, start.startOffset, end.startContainer, end.startOffset);
    fireEvent.mouseUp(window);
}

describe('the read-through tab', () => {
    it('reads a laid-out change end to end: concept pages, test pages, then Housekeeping, which reads once opened', async () => {
        render(<App store={storeWith(readView())} />);
        const tabs = within(screen.getByRole('navigation', { name: 'Review' }));
        expect(tabs.getAllByRole('button').map((tab) => tab.textContent)).toEqual([
            expect.stringContaining('Read-through'),
            expect.stringContaining('Review'),
            expect.stringContaining('Comments')
        ]);
        expect(tabs.getByRole('button', { name: /Review/ })).toBeEnabled();
        expect(tabs.getByRole('button', { name: /Comments/ })).toBeEnabled();
        const rail = within(screen.getByRole('navigation', { name: 'Read-through' }));
        expect(rail.getAllByRole('button').map((button) => button.textContent)).toEqual([
            '1The retry limit is a setting0/2',
            '2The helper moved0/1',
            'Mark all read',
            '3Tests of the send loop0/2',
            '4Housekeeping'
        ]);
        expect(screen.getByRole('heading', { level: 1, name: 'The retry limit is a setting' })).toBeInTheDocument();
        expect(screen.getByText('the policy')).toBeInTheDocument();
        expect(await screen.findByText('The send loop reads the limit.')).toBeInTheDocument();
        expect(screen.getByText('0 of 27 changed lines read')).toBeInTheDocument();

        await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
        expect(screen.getByRole('heading', { level: 1, name: 'The helper moved' })).toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
        expect(screen.getByRole('heading', { level: 1, name: 'Tests of the send loop' })).toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
        expect(screen.getByRole('heading', { level: 1, name: 'What needs no line-by-line read' })).toBeInTheDocument();
        expect(screen.getByText('pnpm-lock.yaml')).toBeInTheDocument();
        expect(posted).toEqual([{ type: 'read.tick', piece: 'housekeeping', read: true, how: 'auto' }]);
    });

    it('keeps the place on show in the address: a link opens it, and Back returns to the place before', async () => {
        const activation = { isActive: false };
        Object.defineProperty(navigator, 'userActivation', { value: activation, configurable: true });
        try {
            // A link to the walkthrough of a round read through alone: the page puts it right, leaving no step to go Back to.
            window.history.replaceState(null, '', '/#tab=walkthrough&page=helper-moved');
            const steps = window.history.length;
            render(<App store={storeWith(readView())} />);
            expect(screen.getByRole('heading', { level: 1, name: 'The helper moved' })).toBeInTheDocument();
            expect(window.location.hash).toBe('#tab=readthrough&page=helper-moved');
            expect(window.history.length).toBe(steps);

            activation.isActive = true;
            await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
            expect(window.location.hash).toBe('#tab=readthrough&page=send-tests');
            expect(window.history.length).toBe(steps + 1);
            act(() => window.history.back());
            expect(await screen.findByRole('heading', { level: 1, name: 'The helper moved' })).toBeInTheDocument();
        } finally {
            Reflect.deleteProperty(navigator, 'userActivation');
        }
    });

    it('lists concept pages under their groups, in reading order, then the tests and Housekeeping apart', async () => {
        const pages = [
            { ...RETRY, group: 'Retry policy' },
            { ...MOVED, group: 'Helpers', content: { summary: 'Moved.', pieces: [] } },
            page({ id: 'policy-default', title: 'The default policy', group: 'Retry policy', order: 3, pieces: RETRY.pieces }),
            TESTS
        ];
        const { container } = render(<App store={storeWith(readView({ pages }))} />);
        const rail = within(screen.getByRole('navigation', { name: 'Read-through' }));
        expect([...container.querySelectorAll('.contents .nav-heading')].map((heading) => heading.textContent)).toEqual([
            'Retry policy',
            'Helpers',
            'TESTSMark all read'
        ]);
        expect(rail.getAllByRole('button').map((button) => button.textContent)).toEqual([
            expect.stringContaining('The retry limit is a setting'),
            expect.stringContaining('The default policy'),
            expect.stringContaining('The helper moved'),
            'Mark all read',
            expect.stringContaining('Tests of the send loop'),
            expect.stringContaining('Housekeeping')
        ]);
        expect(
            rail.getAllByRole('list').map((list) =>
                within(list)
                    .getAllByRole('button')
                    .map((button) => button.textContent)
            )
        ).toEqual([
            [
                expect.stringContaining('The retry limit is a setting'),
                expect.stringContaining('The default policy'),
                expect.stringContaining('The helper moved')
            ],
            ['Mark all read', expect.stringContaining('Tests of the send loop')],
            ['5Housekeeping']
        ]);
        expect(screen.getByText('Retry policy', { selector: '.eyebrow' })).toBeInTheDocument();
    });

    it('shows a page that is not written yet as coming, while the ones before it read', async () => {
        render(<App store={storeWith(readView({ pages: [RETRY, MOVED, TESTS] }))} />);
        await userEvent.click(
            within(screen.getByRole('navigation', { name: 'Read-through' })).getByRole('button', { name: /The helper moved/ })
        );
        expect(screen.getByText(/This page is coming/)).toBeInTheDocument();
        expect(within(screen.getByRole('navigation', { name: 'Read-through' })).getByText('coming')).toBeInTheDocument();
    });

    it('lists, by file, a folder tree with the numbers of the pages each changed file is on', async () => {
        render(<App store={storeWith(readView())} />);
        await userEvent.click(screen.getByRole('tab', { name: 'By file' }));
        const rail = within(screen.getByRole('navigation', { name: 'Read-through' }));
        const send = within(rail.getByTitle('src/send.ts').closest('li')!);
        expect(send.getAllByRole('button').map((button) => button.textContent)).toEqual(['1']);
        expect(send.getByRole('button', { name: 'Page 1: The retry limit is a setting' })).toHaveAttribute(
            'aria-current',
            'step'
        );
        const lock = within(rail.getByTitle('pnpm-lock.yaml').closest('li')!);
        expect(lock.getByRole('button', { name: 'Page 4: Housekeeping' })).toBeInTheDocument();
        const jobs = rail.getByText('jobs').closest('details')!;
        expect(jobs).toHaveAttribute('open');
        const push = within(within(jobs).getByTitle('src/jobs/push.ts').closest('li')!);
        await userEvent.click(push.getByRole('button', { name: 'Page 1: The retry limit is a setting' }));
        await userEvent.click(within(rail.getByTitle('src/b.ts').closest('li')!).getByRole('button', { name: /^Page 2/ }));
        expect(screen.getByRole('heading', { level: 1, name: 'The helper moved' })).toBeInTheDocument();
    });

    it('marks what is read: each piece, the page, its heading in the rail, and its number by file', async () => {
        const all = { '1:send': tick, '1:callers': tick, '1:callers#1': tick, '1:helper': tick };
        const { rerender } = render(<App store={storeWith(readView({ ticks: { '1:send': tick, '1:callers': tick } }))} />);
        const rail = () => within(screen.getByRole('navigation', { name: 'Read-through' }));
        // The callers piece is ticked, but its differing place is not opened yet.
        expect(piece('src/send.ts:1-11')).toHaveClass('is-read');
        expect(within(piece('src/send.ts:1-11')).getByRole('img', { name: 'read' })).toBeInTheDocument();
        expect(piece('src/jobs/email.ts:4')).not.toHaveClass('is-read');
        expect(screen.queryByText('Page read')).not.toBeInTheDocument();
        expect(rail().getByRole('button', { name: /The retry limit/ })).toHaveTextContent('1/2');

        rerender(<App store={storeWith(readView({ ticks: all }))} />);
        expect(piece('src/jobs/email.ts:4')).toHaveClass('is-read');
        expect(screen.getByText('Page read')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Mark the page read' })).not.toBeInTheDocument();
        expect(
            within(rail().getByRole('button', { name: /The retry limit/ })).getByRole('img', { name: 'read' })
        ).toBeInTheDocument();
        expect(within(rail().getByText('CONCEPTS')).getByRole('img', { name: 'read' })).toBeInTheDocument();
        expect(within(rail().getByText('TESTS')).queryByRole('img', { name: 'read' })).not.toBeInTheDocument();

        await userEvent.click(screen.getByRole('tab', { name: 'By file' }));
        // The moved helper's page is on both the file it left and the one it moved to.
        for (const pill of rail().getAllByRole('button', { name: 'Page 2: The helper moved, read' }))
            expect(pill).toHaveClass('is-read');
        expect(rail().getByRole('button', { name: 'Page 3: Tests of the send loop' })).not.toHaveClass('is-read');
    });

    it('collapsed rail: counts the pages read and marks each one, going to the page picked', async () => {
        writeSetting('planroom:rail-collapsed', '1');
        const { container } = render(<App store={storeWith(readView({ ticks: { '1:helper': tick } }))} />);
        const strip = within(screen.getByRole('navigation', { name: 'Read-through progress' }));
        expect(screen.getByRole('navigation', { name: 'Read-through progress' })).toHaveTextContent(/^1\/4/);
        expect(strip.getByRole('button', { name: 'Page 1: The retry limit is a setting, 0 of 2 read' })).toHaveAttribute(
            'aria-current',
            'step'
        );
        expect(strip.getByRole('button', { name: 'Page 2: The helper moved, read' })).toBeInTheDocument();
        expect(
            [...container.querySelectorAll<HTMLElement>('.rail-strip-group')].map((group) =>
                within(group)
                    .getAllByRole('button')
                    .map((button) => button.textContent)
            )
        ).toEqual([['1', ''], ['3'], ['4']]);
        await userEvent.click(strip.getByRole('button', { name: /^Page 3: Tests of the send loop/ }));
        expect(screen.getByRole('heading', { level: 1, name: 'Tests of the send loop' })).toBeInTheDocument();
    });

    it('goes to the page whose number is typed at the foot, held within the first and the last', async () => {
        render(<App store={storeWith(readView())} />);
        const box = screen.getByRole('textbox', { name: 'Page number, of 4' });
        expect(box).toHaveValue('1');
        await userEvent.clear(box);
        await userEvent.type(box, '3{Enter}');
        expect(screen.getByRole('heading', { level: 1, name: 'Tests of the send loop' })).toBeInTheDocument();
        expect(box).toHaveValue('3');
        await userEvent.clear(box);
        await userEvent.type(box, '99{Enter}');
        expect(screen.getByRole('heading', { level: 1, name: 'What needs no line-by-line read' })).toBeInTheDocument();
        expect(box).toHaveValue('4');
        await userEvent.clear(box);
        await userEvent.type(box, '2');
        await userEvent.tab();
        expect(box).toHaveValue('4');
    });

    it('waits for the deck when both are chosen, saying the read-through follows it', () => {
        render(<App store={storeWith(readView({ round: { technique: 'both', readthrough: undefined } }))} />);
        const tabs = within(screen.getByRole('navigation', { name: 'Review' }));
        expect(tabs.getAllByRole('button').map((tab) => tab.textContent)).toEqual([
            expect.stringContaining('Walkthrough'),
            expect.stringContaining('Read-through'),
            expect.stringContaining('Review'),
            expect.stringContaining('Comments')
        ]);
        expect(tabs.getByRole('button', { name: /Review/ })).toBeDisabled();
    });
});

describe('pieces of code', () => {
    it('opens a piece in VS Code at its first line, from the worktree, while the round is the live one', async () => {
        const { unmount } = render(<App store={storeWith(readView({ worktreeDir: '/repo/.planroom/wt' }))} />);
        expect(within(piece('src/send.ts:1-11')).getByRole('link', { name: 'Open in VS Code: src/send.ts' })).toHaveAttribute(
            'href',
            'vscode://file/repo/.planroom/wt/src/send.ts:1:1'
        );
        expect(within(piece('src/jobs/email.ts:4')).getByRole('link', { name: /Open in VS Code/ })).toHaveAttribute(
            'href',
            'vscode://file/repo/.planroom/wt/src/jobs/email.ts:4:1'
        );
        unmount();
        render(<App store={storeWith(readView())} />);
        expect(within(piece('src/send.ts:1-11')).queryByRole('link', { name: /Open in VS Code/ })).not.toBeInTheDocument();
        expect(editorLink('C:\\work\\my repo', 'src/a#b.ts', 7)).toBe('vscode://file/C:/work/my%20repo/src/a%23b.ts:7:1');
    });

    it('shows a piece as it is now with its changed lines marked, and switches only that piece to a diff', async () => {
        render(<App store={storeWith(readView())} />);
        const send = piece('src/send.ts:1-11');
        await line(send, 'policy.maxAttempts');
        expect(send.querySelectorAll('.code-line.is-add .line-number')).toHaveLength(2);
        expect(within(send).getByRole('button', { name: /1 line removed/ })).toBeInTheDocument();
        const callers = piece('src/jobs/email.ts:4');
        expect(within(callers).getByRole('tab', { name: 'As a diff' })).toHaveAttribute('aria-selected', 'true');
        await userEvent.click(within(send).getByRole('tab', { name: 'As a diff' }));
        expect(send.querySelectorAll('.code-line.is-remove')).toHaveLength(3);
        expect(within(callers).getByRole('tab', { name: 'As a diff' })).toHaveAttribute('aria-selected', 'true');
    });

    it('explains a piece before its code: its note, then its blocks, then the code', async () => {
        render(<App store={storeWith(readView())} />);
        const send = piece('src/send.ts:1-11');
        const code = await line(send, 'policy.maxAttempts');
        const note = within(send).getByText('The send loop reads the limit.');
        const block = within(send).getByText('It stops at the last attempt.');
        expect(note.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(block.compareDocumentPosition(code) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('starts every piece as a diff when the setting fixes it, and changes pieces not switched at once', async () => {
        const preferences = {
            ...DEFAULT_PREFERENCES,
            readthrough: { ...DEFAULT_PREFERENCES.readthrough, view: 'diff' as const }
        };
        const store = storeWith(readView({ preferences }));
        render(<App store={store} />);
        const send = piece('src/send.ts:1-11');
        expect(within(send).getByRole('tab', { name: 'As a diff' })).toHaveAttribute('aria-selected', 'true');
        act(() =>
            store.apply([
                { field: 'preferences', value: { ...preferences, readthrough: { ...preferences.readthrough, view: 'now' } } }
            ])
        );
        expect(within(send).getByRole('tab', { name: 'As it is now' })).toHaveAttribute('aria-selected', 'true');
        expect(within(piece('src/jobs/email.ts:4')).getByRole('tab', { name: 'As it is now' })).toHaveAttribute(
            'aria-selected',
            'true'
        );
    });

    it('lists the other places of a repeat, flags the one that differs, and opening it counts', async () => {
        render(<App store={storeWith(readView())} />);
        const callers = within(piece('src/jobs/email.ts:4'));
        expect(callers.getByText(/in 3 places/)).toBeInTheDocument();
        const places = callers.getAllByRole('listitem');
        expect(places.map((place) => place.textContent)).toEqual([
            expect.stringMatching(/src\/jobs\/push\.ts line 4Differs: also changes/),
            expect.stringMatching(/src\/jobs\/sms\.ts line 4identical/)
        ]);
        await userEvent.click(within(places[0]!).getByRole('button', { name: 'Open' }));
        expect(posted).toEqual([{ type: 'read.tick', piece: 'callers', read: true, how: 'manual', place: 1 }]);
        expect(await line(places[0]!, 'policy, 10')).toBeInTheDocument();
    });

    it('needs the differing place opened before the repeat counts as read', () => {
        const { rerender } = render(<App store={storeWith(readView({ ticks: { '1:callers': tick } }))} />);
        const entry = () =>
            within(screen.getByRole('navigation', { name: 'Read-through' })).getByRole('button', { name: /The retry limit/ });
        expect(entry()).toHaveTextContent('0/2');
        rerender(<App store={storeWith(readView({ ticks: { '1:callers': tick, '1:callers#1': tick } }))} />);
        expect(entry()).toHaveTextContent('1/2');
    });

    it('shows moved code once, from where to where, with only the changed line marked', async () => {
        render(<App store={storeWith(readView())} />);
        await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
        const helper = piece('src/b.ts:1-4');
        expect(within(helper).getByText(/Moved from/).textContent).toBe(
            'Moved from src/a.ts removed lines 3-6 to src/b.ts lines 1-4; only what changed on the way is marked.'
        );
        await line(helper, 'x * 3');
        expect(helper.querySelectorAll('.code-line.is-add')).toHaveLength(1);
        expect(helper.querySelector('.code-line.is-add')?.textContent).toContain('x * 3');
    });

    it('shows where a clicked name is defined with its code, and every use on Ctrl-click or from the dialog', async () => {
        stubServer((q, definition) => ({
            round: 1,
            query: q,
            matches: definition
                ? [{ file: 'src/deliver.ts', line: 3, text: 'export function deliver(job: Job) {' }]
                : Array.from({ length: 200 }, (_, at) => ({ file: 'src/many.ts', line: at + 1, text: `deliver(${at});` })),
            truncated: !definition
        }));
        render(<App store={storeWith(readView())} />);
        const name = (await within(piece('src/send.ts:1-11')).findAllByText('deliver'))[0]!;
        await userEvent.click(name);
        let dialog = within(await screen.findByRole('dialog', { name: 'Where deliver is defined' }));
        expect(await dialog.findByText('1 declaration')).toBeInTheDocument();
        await userEvent.click(dialog.getByText('export function deliver(job: Job) {'));
        const code = await dialog.findByRole('group', { name: 'src/deliver.ts from line 3' });
        expect(code).toHaveTextContent('return send(job);');
        expect(code).not.toHaveTextContent('retries');
        await userEvent.click(dialog.getByRole('button', { name: 'Show every use' }));
        expect(await dialog.findByText('The first 200 matches; there are more, so the list was cut short.')).toBeInTheDocument();
        expect(dialog.getAllByRole('listitem')).toHaveLength(200);
        expect(dialog.getByRole('group', { name: 'src/many.ts line 1' })).toHaveTextContent('deliver(0);');
        await userEvent.keyboard('{Escape}');

        fireEvent.click(name, { ctrlKey: true });
        dialog = within(await screen.findByRole('dialog', { name: 'Where deliver appears' }));
        expect(await dialog.findByText('The first 200 matches; there are more, so the list was cut short.')).toBeInTheDocument();
    });
});

describe('reading and commenting', () => {
    it('ticks a piece by hand, and counts it in the page and the whole change', async () => {
        const { rerender } = render(<App store={storeWith(readView())} />);
        await userEvent.click(within(piece('src/send.ts:1-11')).getByRole('checkbox', { name: 'src/send.ts:1-11 read' }));
        expect(posted).toEqual([{ type: 'read.tick', piece: 'send', read: true, how: 'manual' }]);
        // As the server sends it back, and as a reload restores it.
        rerender(<App store={storeWith(readView({ ticks: { '1:send': tick } }))} />);
        expect(within(piece('src/send.ts:1-11')).getByRole('checkbox', { name: 'src/send.ts:1-11 read' })).toBeChecked();
        expect(screen.getByText('5 of 27 changed lines read')).toBeInTheDocument();
        expect(
            within(screen.getByRole('navigation', { name: 'Read-through' })).getByRole('button', { name: /The retry limit/ })
        ).toHaveTextContent('1/2');
    });

    it('auto-ticks a piece after ten seconds on screen, and never with auto-tick off', async () => {
        render(<App store={storeWith(readView())} />);
        vi.useFakeTimers();
        act(() => FakeObserver.show(piece('src/send.ts:1-11')));
        act(() => vi.advanceTimersByTime(9_000));
        expect(posted).toEqual([]);
        act(() => vi.advanceTimersByTime(1_000));
        expect(posted).toEqual([{ type: 'read.tick', piece: 'send', read: true, how: 'auto' }]);
    });

    it('collapses a piece to its header and opens it again, and never auto-ticks it collapsed', async () => {
        render(<App store={storeWith(readView())} />);
        const send = piece('src/send.ts:1-11');
        const fold = within(send).getByRole('button', { name: 'Collapse src/send.ts:1-11' });
        await userEvent.click(fold);
        expect(fold).toHaveAttribute('aria-expanded', 'false');
        expect(within(send).getByText('The send loop reads the limit.')).not.toBeVisible();
        expect(within(send).getByRole('checkbox', { name: 'src/send.ts:1-11 read' })).toBeVisible();
        vi.useFakeTimers();
        act(() => FakeObserver.show(send));
        act(() => vi.advanceTimersByTime(60_000));
        expect(posted).toEqual([]);
        fireEvent.click(fold);
        expect(fold).toHaveAttribute('aria-expanded', 'true');
        expect(within(send).getByText('The send loop reads the limit.')).toBeVisible();
    });

    it('leaves a piece unticked a minute on screen with auto-tick off', () => {
        const preferences = { ...DEFAULT_PREFERENCES, readthrough: { ...DEFAULT_PREFERENCES.readthrough, autoTick: false } };
        render(<App store={storeWith(readView({ preferences }))} />);
        vi.useFakeTimers();
        act(() => FakeObserver.show(piece('src/send.ts:1-11')));
        act(() => vi.advanceTimersByTime(60_000));
        expect(posted).toEqual([]);
    });

    it('comments on the whole line part of it is selected on, and auto-ticks the piece commented on', async () => {
        render(<App store={storeWith(readView())} />);
        const send = within(piece('src/send.ts:1-11'));
        selectCode(await line(piece('src/send.ts:1-11'), 'policy.maxAttempts'), 'policy.maxAttempts');
        expect(send.getByRole('toolbar', { name: 'Line 8 selected' })).toBeInTheDocument();
        await userEvent.click(send.getByRole('button', { name: 'Comment' }));
        typeInto(send.getByRole('textbox', { name: 'Your comment on line 8' }), 'Clamp it to at least one');
        await userEvent.click(send.getByRole('button', { name: 'Add comment' }));
        // The tick follows the saved comment, a promise later.
        await waitFor(() =>
            expect(posted).toEqual([
                {
                    type: 'note.save',
                    anchor: { file: 'src/send.ts', side: 'new', start: 8 },
                    text: 'Clamp it to at least one',
                    page: 'retry-limit'
                },
                { type: 'read.tick', piece: 'send', read: true, how: 'auto' }
            ])
        );
    });

    it('comments on every line a selection spans, and on a repeat example for every place unless only here', async () => {
        render(<App store={storeWith(readView())} />);
        const send = within(piece('src/send.ts:1-11'));
        selectCode(
            await line(piece('src/send.ts:1-11'), 'policy: RetryPolicy'),
            'RetryPolicy',
            await line(piece('src/send.ts:1-11'), 'policy.maxAttempts'),
            'attempt'
        );
        expect(send.getByRole('toolbar', { name: 'Lines 3-8 selected' })).toBeInTheDocument();
        await userEvent.click(send.getByRole('button', { name: 'Comment' }));
        typeInto(send.getByRole('textbox', { name: 'Your comment on lines 3-8' }), 'One loop');
        await userEvent.click(send.getByRole('button', { name: 'Add comment' }));
        expect(posted[0]).toMatchObject({ anchor: { file: 'src/send.ts', side: 'new', start: 3, end: 8 } });

        const callers = within(piece('src/jobs/email.ts:4'));
        selectCode(await line(piece('src/jobs/email.ts:4'), 'send(job, policy)'), 'policy');
        await userEvent.click(callers.getByRole('button', { name: 'Comment' }));
        await userEvent.click(callers.getByRole('checkbox', { name: 'Only here, not every place of the repeat' }));
        typeInto(callers.getByRole('textbox', { name: 'Your comment on line 4' }), 'Email only');
        await userEvent.click(callers.getByRole('button', { name: 'Add comment' }));
        expect(posted.find((event) => event.text === 'Email only')).toMatchObject({
            anchor: { file: 'src/jobs/email.ts', side: 'new', start: 4 },
            repeat: { key: 'R1', onlyHere: true }
        });
    });

    it('floats the toolbar over selected code until the selection goes, and the comment box by it until Escape', async () => {
        render(<App store={storeWith(readView())} />);
        const send = within(piece('src/send.ts:1-11'));
        const code = await line(piece('src/send.ts:1-11'), 'policy.maxAttempts');
        selectCode(code, 'policy.maxAttempts');
        expect(send.getByRole('toolbar', { name: 'Line 8 selected' })).toHaveClass('selection-toolbar');
        expect(code.closest('.code-viewer')?.querySelector('[role="toolbar"]')).toBeNull();
        act(() => {
            defined(window.getSelection()).removeAllRanges();
            fireEvent(document, new Event('selectionchange'));
        });
        expect(send.queryByRole('toolbar')).not.toBeInTheDocument();
        expect(code).not.toHaveClass('is-selected');

        selectCode(code, 'policy.maxAttempts');
        await userEvent.click(send.getByRole('button', { name: 'Comment' }));
        const box = send.getByRole('dialog', { name: 'Comment on line 8' });
        expect(box).toHaveClass('composer');
        expect(within(box).getByRole('textbox', { name: 'Your comment on line 8' })).toHaveFocus();
        fireEvent.keyDown(box, { key: 'Escape' });
        expect(send.queryByRole('dialog')).not.toBeInTheDocument();
        expect(code).not.toHaveClass('is-selected');
        expect(posted).toEqual([]);
    });

    it('asks the agent about just the code selected, on the lines it spans', async () => {
        render(<App store={storeWith(readView())} />);
        const send = within(piece('src/send.ts:1-11'));
        selectCode(await line(piece('src/send.ts:1-11'), 'policy.maxAttempts'), 'policy.maxAttempts');
        await userEvent.click(send.getByRole('button', { name: 'Ask the agent' }));
        const composer = within(screen.getByRole('dialog', { name: 'Comment' }));
        expect(composer.getByText('policy.maxAttempts')).toHaveClass('is-code');
        await userEvent.type(composer.getByRole('textbox', { name: 'Comment' }), 'Can it be zero?');
        await userEvent.click(composer.getByRole('button', { name: 'Send to agent' }));
        expect(posted).toContainEqual(
            expect.objectContaining({
                type: 'comment.create',
                anchor: {
                    target: 'page:retry-limit',
                    lines: { file: 'src/send.ts', side: 'new', start: 8, end: 8, text: 'policy.maxAttempts' }
                },
                text: 'Can it be zero?'
            })
        );
    });

    it('asks the agent about the words around the code, quoting the passage selected', async () => {
        render(<App store={storeWith(readView())} />);
        const note = within(piece('src/send.ts:1-11')).getByText('The send loop reads the limit.');
        const selection = defined(window.getSelection());
        selection.removeAllRanges();
        selection.addRange(defined(rangeFromOffsets(note, 14, 29)));
        fireEvent(document, new Event('selectionchange'));
        const toolbar = await screen.findByRole('toolbar', { name: 'Selection actions' });
        await userEvent.click(within(toolbar).getByRole('button', { name: 'Comment' }));
        const composer = within(screen.getByRole('dialog', { name: 'Comment' }));
        await userEvent.type(composer.getByRole('textbox', { name: 'Comment' }), 'Which limit?');
        await userEvent.click(composer.getByRole('button', { name: 'Send to agent' }));
        expect(posted).toContainEqual(
            expect.objectContaining({
                type: 'comment.create',
                anchor: expect.objectContaining({
                    target: 'page:retry-limit',
                    quote: expect.objectContaining({ exact: 'reads the limit', prefix: 'The send loop ' })
                }),
                intent: 'question',
                text: 'Which limit?'
            })
        );
    });

    it('lists a question on the words by its quote, attached to whichever passage holds it', async () => {
        const quoting = (id: string, exact: string, suffix: string) =>
            commentThread(id, 'page:retry-limit', {
                anchor: {
                    target: 'page:retry-limit',
                    position: { start: 0, end: exact.length },
                    quote: { exact, prefix: '', suffix }
                },
                messages: [{ id: `${id}.1`, author: 'user', text: `About ${exact}`, at: NOW }]
            });
        const threads = [quoting('T-2', 'Every job', ' passes the policy.'), quoting('T-3', 'A sentence', ' cut since.')];
        render(<App store={storeWith(readView({ threads }))} />);
        const asked = within(screen.getByRole('region', { name: 'Questions on this page' }));
        const row = (exact: string) => asked.getByRole('button', { name: new RegExp(`About ${exact}`) });
        await waitFor(() => expect(row('A sentence')).toHaveTextContent('Detached'));
        expect(row('Every job')).toHaveTextContent('"Every job"');
        expect(row('Every job')).not.toHaveTextContent('Detached');
    });

    it('shows a question folded under the last line it asks about, waiting, then the answer new until opened in a dialog', async () => {
        const asked = commentThread('T-1', 'page:retry-limit', {
            anchor: { target: 'page:retry-limit', lines: { file: 'src/send.ts', side: 'new', start: 7, end: 8 } },
            intent: 'question',
            messages: [{ id: 'T-1.1', author: 'user', text: 'Why stop here?', at: NOW }]
        });
        const { rerender } = render(<App store={storeWith(readView({ threads: [asked] }))} />);
        const send = piece('src/send.ts:1-11');
        const question = await within(send).findByText('Why stop here?');
        const below = question.closest('.code-note');
        expect(below?.previousElementSibling?.textContent).toContain('policy.maxAttempts');
        expect(below).toHaveTextContent('Waiting for the agent');

        const answer = { id: 'T-1.2', author: 'agent' as const, text: 'The policy says when.', at: '2026-09-29T00:05:00.000Z' };
        rerender(<App store={storeWith(readView({ threads: [{ ...asked, messages: [...asked.messages, answer] }] }))} />);
        const inline = await within(send).findByRole('button', { name: /Why stop here.*New reply from the agent/ });
        expect(inline).toHaveClass('is-unread');
        expect(within(send).queryByText('The policy says when.')).not.toBeInTheDocument();
        const row = within(screen.getByRole('region', { name: 'Questions on this page' })).getByRole('button', {
            name: /Why stop here/
        });
        expect(row).toHaveClass('is-unread');

        await userEvent.click(inline);
        const dialog = screen.getByRole('dialog', { name: 'Question on src/send.ts:7-8' });
        expect(within(dialog).getByText('The policy says when.')).toBeInTheDocument();
        await waitFor(() => expect(row).not.toHaveClass('is-unread'));
        expect(inline).not.toHaveClass('is-unread');
    });
});

describe('test pages', () => {
    async function openTests(preferences = DEFAULT_PREFERENCES) {
        render(<App store={storeWith(readView({ preferences }))} />);
        await userEvent.click(
            within(screen.getByRole('navigation', { name: 'Read-through' })).getByRole('button', {
                name: /Tests of the send loop/
            })
        );
    }

    it('shows each case as pseudo code at once, by default', async () => {
        await openTests();
        expect(screen.getByLabelText('Pseudo code of retries up to the policy')).toHaveTextContent('send fails twice');
        await userEvent.click(within(piece('gives up')).getByRole('tab', { name: 'Title' }));
        expect(screen.queryByLabelText('Pseudo code of gives up')).not.toBeInTheDocument();
        await userEvent.click(within(piece('gives up')).getByRole('tab', { name: 'Pseudo code' }));
        expect(screen.getByLabelText('Pseudo code of gives up')).toBeInTheDocument();
    });

    it('starts from the tests setting, switches one entry to real code, and ticks a title alone', async () => {
        await openTests({ ...DEFAULT_PREFERENCES, readthrough: { ...DEFAULT_PREFERENCES.readthrough, tests: 'title' } });
        expect(screen.queryByLabelText(/Pseudo code of/)).not.toBeInTheDocument();
        await userEvent.click(within(piece('gives up')).getByRole('tab', { name: 'Real code' }));
        expect(await line(piece('gives up'), 'expect(true)')).toBeInTheDocument();
        expect(piece('retries up to the policy').querySelector('.code-line')).toBeNull();
        await userEvent.click(
            within(piece('retries up to the policy')).getByRole('checkbox', { name: 'retries up to the policy read' })
        );
        expect(posted).toEqual([{ type: 'read.tick', piece: 'test-retries', read: true, how: 'manual' }]);
    });

    it('marks every unread case on the written test pages read from the tests heading, then hides', async () => {
        const policy = page({
            id: 'policy-tests',
            kind: 'tests',
            order: 2,
            pieces: [{ id: 'test-policy', file: 'src/send.test.ts', lines: '1-3' }],
            content: { summary: 'One case.', pieces: [] }
        });
        const coming = page({
            id: 'later-tests',
            kind: 'tests',
            order: 3,
            pieces: [{ id: 'test-later', file: 'src/send.test.ts', lines: '4-6' }]
        });
        const pages = [RETRY, TESTS, policy, coming];
        const { rerender } = render(<App store={storeWith(readView({ pages, ticks: { '1:test-retries': tick } }))} />);
        const heading = () => within(within(screen.getByRole('navigation', { name: 'Read-through' })).getByText('TESTS'));
        await userEvent.click(heading().getByRole('button', { name: 'Mark all read' }));
        expect(posted).toEqual([
            { type: 'read.tick', piece: 'test-gives-up', read: true, how: 'manual' },
            { type: 'read.tick', piece: 'test-policy', read: true, how: 'manual' }
        ]);
        const ticks = { '1:test-retries': tick, '1:test-gives-up': tick, '1:test-policy': tick };
        rerender(<App store={storeWith(readView({ pages, ticks }))} />);
        expect(heading().queryByRole('button', { name: 'Mark all read' })).not.toBeInTheDocument();
    });
});

describe('findings under their lines', () => {
    const finding: ItemRecord = {
        id: 'I-1',
        kind: 'issue',
        title: 'A limit of zero retries forever',
        body: 'b',
        confidence: 0.8,
        anchor: { file: 'src/send.ts', side: 'new', start: 8 },
        severity: 'blocker',
        evidence: 'e',
        suggestion: 's',
        likelihood: 2,
        impact: 3,
        draft: 'd',
        round: 1,
        version: 1,
        updatedAt: NOW
    };
    const standard = { strength: 'standard' as const, model: 'sonnet' as const, effort: 'high' as const, at: NOW };

    it('shows a finding as a card under its line when the Review tab is open', async () => {
        render(<App store={storeWith(readView({ items: [finding], round: { reviewers: standard } }))} />);
        const send = piece('src/send.ts:1-11');
        const card = await within(send).findByRole('button', { name: /A limit of zero retries forever/ });
        expect(card.closest('.code-note')?.previousElementSibling?.textContent).toContain('policy.maxAttempts');
    });

    it('opens a finding over the read-through instead of going to the Review tab', async () => {
        render(<App store={storeWith(readView({ items: [finding], round: { reviewers: standard } }))} />);
        await userEvent.click(
            await within(piece('src/send.ts:1-11')).findByRole('button', { name: /A limit of zero retries forever/ })
        );
        const dialog = screen.getByRole('dialog', { name: 'A limit of zero retries forever' });
        expect(within(dialog).getByRole('button', { name: 'Agree' })).toBeInTheDocument();
        await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
        expect(piece('src/send.ts:1-11')).toBeInTheDocument();
    });

    it('shows none while the deck of both is unfinished', async () => {
        render(
            <App
                store={storeWith(
                    readView({ items: [finding], round: { reviewers: standard, technique: 'both', publishedAt: NOW } })
                )}
            />
        );
        await userEvent.click(
            within(screen.getByRole('navigation', { name: 'Review' })).getByRole('button', { name: /Read-through/ })
        );
        await line(piece('src/send.ts:1-11'), 'policy.maxAttempts');
        expect(screen.queryByRole('button', { name: /A limit of zero retries forever/ })).not.toBeInTheDocument();
    });

    it('says no AI review was run at none', async () => {
        render(<App store={storeWith(readView())} />);
        await userEvent.click(within(screen.getByRole('navigation', { name: 'Review' })).getByRole('button', { name: /Review/ }));
        expect(screen.getByText(/No AI review was run for this round/)).toBeInTheDocument();
    });
});

describe('starting a round', () => {
    const fresh = { technique: undefined, reviewers: undefined, readthrough: undefined, index: undefined };

    it('offers the deck the first time, and starts the strength at none once the read-through is picked', async () => {
        render(<App store={storeWith(readView({ round: fresh, pages: [] }))} />);
        const card = within(screen.getByRole('region', { name: 'Start the review' }));
        expect(card.getByRole('radio', { name: /Overview deck/ })).toBeChecked();
        expect(card.getByRole('combobox', { name: /Strength/ })).toHaveValue('standard');
        await userEvent.click(card.getByRole('radio', { name: /Line-by-line read-through/ }));
        expect(card.getByRole('combobox', { name: /Strength/ })).toHaveValue('none');
        await userEvent.click(card.getByRole('button', { name: 'Start review' }));
        expect(posted).toEqual([
            {
                type: 'reviewers.start',
                technique: 'readthrough',
                reviewers: { strength: 'none', model: 'sonnet', effort: 'high' }
            }
        ]);
    });

    it('selects the technique chosen last time', () => {
        render(
            <App
                store={storeWith(
                    readView({ round: fresh, pages: [], preferences: { ...DEFAULT_PREFERENCES, technique: 'readthrough' } })
                )}
            />
        );
        const card = within(screen.getByRole('region', { name: 'Start the review' }));
        expect(card.getByRole('radio', { name: /Line-by-line read-through/ })).toBeChecked();
        expect(card.getByRole('combobox', { name: /Strength/ })).toHaveValue('none');
    });
});

describe('handing the comments to an agent', () => {
    it('writes the task file and copies the prompt', async () => {
        const writeText = vi.fn(async () => undefined);
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
        const view = readView();
        render(
            <App
                store={storeWith({
                    ...view,
                    notes: {
                        'N-1': {
                            id: 'N-1',
                            round: 1,
                            anchor: { file: 'src/send.ts', side: 'new', start: 8 },
                            text: 'Clamp it',
                            at: NOW
                        }
                    }
                })}
            />
        );
        await userEvent.click(
            within(screen.getByRole('navigation', { name: 'Review' })).getByRole('button', { name: /Comments/ })
        );
        await userEvent.click(screen.getByRole('button', { name: 'Hand to agent' }));
        expect(posted.at(-1)).toEqual({ type: 'comments.handoff' });
        expect(writeText).toHaveBeenCalledWith('Read it');
        expect(await screen.findByText(/Prompt copied/)).toBeInTheDocument();
    });
});

describe('the code viewer', () => {
    it('shows what a change replaced on click only, and opens a removed-lines marker', async () => {
        render(<CodeViewer source={SEND_PATCH} format="now" label="send" />);
        fireEvent.mouseEnter(screen.getByText(/policy\.maxAttempts/).closest('.code-line')!);
        expect(screen.queryByRole('note')).not.toBeInTheDocument();
        const dot = screen.getByRole('button', { name: 'What the change at line 8 replaced' });
        await userEvent.click(dot);
        expect(screen.getByRole('note', { name: 'Before the change at line 8' })).toHaveTextContent(
            'if (attempt >= 3) throw error;'
        );
        await userEvent.click(dot);
        expect(screen.queryByRole('note')).not.toBeInTheDocument();
        expect(screen.queryByText(/log\.warn/)).not.toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: /1 line removed/ }));
        expect(screen.getByText(/log\.warn/).closest('.code-line')).toHaveClass('is-remove');
    });

    it('marks each change with one dot, on its first line, holding every line the change replaced', async () => {
        const patch = '@@ -1,5 +1,5 @@\n keep\n-one\n-two\n+One\n+Two\n-three\n+Three\n';
        render(<CodeViewer source={patch} format="now" label="change" />);
        expect(
            screen.getAllByRole('button', { name: /What the change at line/ }).map((dot) => dot.getAttribute('aria-label'))
        ).toEqual(['What the change at line 2 replaced', 'What the change at line 4 replaced']);
        await userEvent.click(screen.getByRole('button', { name: 'What the change at line 2 replaced' }));
        expect(screen.getByRole('note', { name: 'Before the change at line 2' })).toHaveTextContent(/^Beforeonetwo$/);
    });

    it('picks the whole lines a selection touches with the code selected, leaving a line it only touches the edge of', async () => {
        const picked: LineSelection[] = [];
        const named: string[] = [];
        const { rerender } = render(
            <CodeViewer
                source={SEND_PATCH}
                format="diff"
                label="send"
                onSelect={(selection) => picked.push(selection)}
                onName={(name, modified) => named.push(modified ? `${name}+` : name)}
            />
        );
        const loop = await line(document.body, 'for (let');
        const call = await line(document.body, 'return deliver');
        selectCode(loop, 'for', call, 'deliver(job);');
        selectCode(loop, 'for', await line(document.body, 'try {'), '');
        expect(picked).toEqual([
            {
                side: 'new',
                start: 4,
                end: 6,
                text: 'for (let attempt = 1; ; attempt += 1) {\n        try {\n            return deliver(job);'
            },
            { side: 'new', start: 4, end: 4, text: 'for (let attempt = 1; ; attempt += 1) {' }
        ]);
        // Letting go of a drag over a name selected it rather than searching for it.
        const name = defined([...call.querySelectorAll('.code-name')].find((span) => span.textContent === 'deliver'));
        selectCode(call, 'deliver');
        fireEvent.click(name);
        expect(named).toEqual([]);
        defined(window.getSelection()).removeAllRanges();
        fireEvent.click(name);
        fireEvent.click(name, { metaKey: true });
        expect(named).toEqual(['deliver', 'deliver+']);

        rerender(<CodeViewer source={SEND_PATCH} format="diff" label="send" selection={picked[0]} onSelect={() => undefined} />);
        expect(document.querySelectorAll('.code-line.is-selected')).toHaveLength(3);
    });

    it('moves a drawn caret with the arrow keys and extends the selection with Shift, staying inside the code', () => {
        const picked: LineSelection[] = [];
        render(<CodeViewer source={SEND_PATCH} format="diff" label="send" onSelect={(selection) => picked.push(selection)} />);
        const selection = defined(window.getSelection());
        selection.removeAllRanges();
        const first = defined(document.querySelector('[data-row]'));
        const steps: string[][] = [];
        // jsdom has no `Selection.modify`: stand in for the browser on the first line, and step above it on Up.
        Object.defineProperty(selection, 'modify', {
            configurable: true,
            value: (alter: string, direction: string, granularity: string) => {
                steps.push([alter, direction, granularity]);
                if (granularity === 'line' && direction === 'backward') selection.collapse(document.body, 0);
                else if (alter === 'move') selection.collapse(first, first.childNodes.length);
                else selection.setBaseAndExtent(first, 0, first, first.childNodes.length);
            }
        });
        try {
            const code = screen.getByRole('group', { name: 'send' });
            const caret = defined(document.querySelector('.code-caret'));
            act(() => code.focus());
            expect(caret).not.toBeVisible();
            // The first key puts the caret at the start of the code without moving it.
            fireEvent.keyDown(code, { key: 'ArrowDown' });
            expect(steps).toEqual([]);
            expect(caret).toBeVisible();
            fireEvent.keyDown(code, { key: 'ArrowDown' });
            fireEvent.keyDown(code, { key: 'ArrowUp' });
            expect(first.contains(selection.focusNode)).toBe(true);
            fireEvent.keyDown(code, { key: 'ArrowRight', shiftKey: true, ctrlKey: true });
            fireEvent.keyDown(code, { key: 'Home', shiftKey: true });
            expect(steps).toEqual([
                ['move', 'forward', 'line'],
                ['move', 'backward', 'line'],
                ['extend', 'forward', 'word'],
                ['extend', 'backward', 'lineboundary']
            ]);
            expect(picked[0]).toEqual({ side: 'new', start: 1, end: 1, text: "import { deliver } from './deliver';" });
            act(() => code.blur());
            expect(caret).not.toBeVisible();
        } finally {
            Reflect.deleteProperty(selection, 'modify');
        }
    });
});
