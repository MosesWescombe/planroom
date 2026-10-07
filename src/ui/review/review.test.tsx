import { EditorView } from '@codemirror/view';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { blockCatalog } from '../../shared/blockCatalog';
import type { BlockRecord } from '../../shared/records';
import {
    DEFAULT_PREFERENCES,
    FRAME_CSP,
    frameDocument,
    type ItemRecord,
    type NoteRecord,
    type ReviewPreferences,
    type RoundRecord,
    type SlideRecord,
    type TakeAnswer,
    type TakeRecord
} from '../../shared/review';
import { blockRecord, NOW } from '../../test/fixtures';
import { defined, instance, makeView, posted, renderWith, storeWith } from '../../test/harness';
import { App } from '../App';
import { BlockView } from '../blocks/Block';
import { type BlobLoader, buildHtml } from '../exportHtml';
import { setPrinting } from '../hooks';

const FLOW = {
    nodes: [
        { id: 'client', label: 'Client' },
        { id: 'retry', label: 'Retry' },
        { id: 'api', label: 'API' }
    ],
    edges: [
        { from: 'client', to: 'retry' },
        { from: 'retry', to: 'api' }
    ]
};

function slide(id: string, chapter: SlideRecord['chapter'], blocks: SlideRecord['blocks'], order = 1): SlideRecord {
    return { id, chapter, order, title: `Slide ${id}`, blocks, round: 1, version: 1, updatedAt: NOW };
}

function round(fields: Partial<RoundRecord> = {}): RoundRecord {
    return {
        n: 1,
        base: 'aaaa',
        head: 'bbbb',
        files: [
            { path: 'src/retry.ts', status: 'modified', additions: 3, deletions: 1 },
            { path: 'src/policy.ts', status: 'added', additions: 4, deletions: 0 }
        ],
        startedAt: NOW,
        summary: {},
        posts: {},
        earlier: {},
        ...fields
    };
}

function item(id: string, fields: Partial<ItemRecord> = {}): ItemRecord {
    return {
        id,
        kind: 'issue',
        title: `Finding ${id} title`,
        body: 'Two retries outlast the caller.',
        confidence: 0.8,
        anchor: { file: 'src/retry.ts', side: 'new', start: 2 },
        severity: 'blocker',
        evidence: 'The caller waits 150 ms.',
        suggestion: 'Retry once.',
        likelihood: 2,
        impact: 3,
        diagram: { block: 'how-flow', node: 'retry' },
        draft: 'Can two retries outlast the caller?',
        round: 1,
        version: 1,
        updatedAt: NOW,
        ...fields
    };
}

/** The deck every test starts from: a slide per chapter, a flow, a step-through and a predict card. */
const BLOCKS: BlockRecord[] = [
    blockRecord('why-text', 'text', { body: 'Retries ran without a cap.' }),
    blockRecord('how-flow', 'flow', FLOW),
    blockRecord('how-steps', 'stepThrough', {
        diagram: { type: 'flow', config: FLOW },
        steps: ['One', 'Two', 'Three', 'Four', 'Five'].map((caption, index) => ({
            caption: `Step ${caption}`,
            nodes: [FLOW.nodes[index % 3]!.id]
        }))
    }),
    blockRecord('take-predict', 'yourTake', blockCatalog.yourTake.example),
    blockRecord('touch-text', 'text', { body: 'It touches the client.' }),
    blockRecord('billing-text', 'text', { body: 'The export retries too.' }),
    blockRecord('impact-map', 'impactMap', {
        areas: [
            { id: 'billing', title: 'Billing exports', summary: 'The export reads the retry count.', blocks: ['billing-text'] },
            { id: 'alerts', title: 'On-call alerts', summary: 'The timeout alert fires sooner.', blocks: [] }
        ]
    }),
    blockRecord('trade-text', 'text', { body: 'Fewer retries fail faster.' })
];
const SLIDES = [
    slide('why', 'why', ['why-text']),
    slide('how', 'how', ['how-flow']),
    slide('steps', 'how', ['how-steps'], 2),
    slide('take', 'how', ['take-predict'], 3),
    slide('touches', 'touches', ['touch-text', 'impact-map']),
    slide('tradeoffs', 'tradeoffs', ['trade-text'])
];

/** A review view of a branch, with the given round, findings, reactions, takes and preferences. */
function reviewView(
    options: {
        round?: Partial<RoundRecord>;
        items?: ItemRecord[];
        reactions?: Record<string, { verdict: 'agree' | 'reword' | 'reject'; text?: string; reason?: string }>;
        takes?: Record<string, TakeRecord>;
        notes?: NoteRecord[];
        blocks?: BlockRecord[];
        slides?: SlideRecord[];
        preferences?: ReviewPreferences;
        pr?: boolean;
        postable?: { ready: boolean; problem?: string };
    } = {}
) {
    const byId = <T extends { id: string }>(records: T[]) => Object.fromEntries(records.map((record) => [record.id, record]));
    return makeView(
        {
            blocks: options.blocks ?? BLOCKS,
            patch: {
                kind: 'review',
                changeId: 'branch-feature',
                review: {
                    target: options.pr
                        ? { kind: 'pr', workspace: 'acme', repo: 'api', number: 412 }
                        : { kind: 'branch', branch: 'feature/retry', base: 'main' },
                    title: 'Cap the retries',
                    description: 'Caps the retry policy.',
                    link: 'https://bitbucket.org/acme/api/pull-requests/412',
                    worktree: '.planroom/reviews/branch-feature/worktree',
                    rounds: [round(options.round)]
                },
                slides: byId(options.slides ?? SLIDES),
                items: byId(options.items ?? []),
                reactions: Object.fromEntries(
                    Object.entries(options.reactions ?? {}).map(([id, reaction]) => [
                        id,
                        { ...reaction, itemVersion: 1, at: NOW }
                    ])
                ),
                takes: options.takes ?? {},
                notes: byId(options.notes ?? [])
            }
        },
        { preferences: options.preferences ?? DEFAULT_PREFERENCES, postable: options.postable ?? { ready: true } }
    );
}

/** The first part of the deck out, the reviewer's concerns not yet sent and Trade-offs not yet written. */
const FIRST_PART = { publishedAt: NOW };
/** The whole deck out: the concerns sent, then Trade-offs published. */
const PUBLISHED = { publishedAt: NOW, tradeoffsAt: NOW, impact: { concerns: {}, added: [], sentAt: NOW } };
const DONE = { ...PUBLISHED, walkthrough: { how: 'finished' as const, at: NOW } };

/** Stub `matchMedia` so the page sees a reader who asks for reduced motion. */
function reducedMotion() {
    vi.stubGlobal('matchMedia', (query: string) => ({
        matches: query.includes('prefers-reduced-motion'),
        addEventListener: () => undefined,
        removeEventListener: () => undefined
    }));
}

afterEach(() => setPrinting(false));

/** Replaces the text of the comment editor `box`, as typing it would. */
function typeInto(box: HTMLElement, text: string) {
    const view = EditorView.findFromDOM(box.closest('.markdown-editor') as HTMLElement)!;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
}

describe('the walkthrough while it builds', () => {
    it('shows a loading bar, what the agent is doing and its progress, and none of the staged slides', () => {
        const view = reviewView({
            round: {
                outline: [
                    { chapter: 'why', title: 'Retries ran forever' },
                    { chapter: 'how', title: 'A cap of two' }
                ],
                progress: { pictures: { drawn: 2, total: 4 }, review: '3 of 5 reviewers done' }
            },
            slides: SLIDES.slice(0, 1)
        });
        render(
            <App
                store={storeWith({
                    ...view,
                    agent: { ...view.agent, working: true, doing: 'writing the slides', subagents: ['reviewing correctness'] }
                })}
            />
        );
        const main = within(screen.getByRole('main'));
        expect(main.getByRole('progressbar', { name: 'Building the walkthrough' })).toBeInTheDocument();
        expect(main.getByText('Writing the slides')).toBeInTheDocument();
        expect(main.getByText('Reviewing correctness')).toBeInTheDocument();
        expect(main.getByText('1 of 2 slides drafted')).toBeInTheDocument();
        expect(main.getByText('2 of 4 pictures drawn')).toBeInTheDocument();
        expect(main.getByText('Review: 3 of 5 reviewers done')).toBeInTheDocument();
        expect(main.queryByRole('heading', { name: 'Cap the retries' })).not.toBeInTheDocument();
        expect(main.queryByText('A cap of two')).not.toBeInTheDocument();
        expect(document.querySelector('.slide')).toBeNull();
        expect(screen.queryByText('Retries ran without a cap.')).not.toBeInTheDocument();
    });

    it('asks how to review before the reviewers start, offering the saved defaults', async () => {
        const preferences = {
            ...DEFAULT_PREFERENCES,
            reviewers: { strength: 'thorough' as const, model: 'opus' as const, effort: 'high' as const }
        };
        render(<App store={storeWith(reviewView({ preferences }))} />);
        const card = within(screen.getByRole('region', { name: 'Start the review' }));
        expect(card.getByRole('combobox', { name: /Strength/ })).toHaveValue('thorough');
        await userEvent.selectOptions(card.getByRole('combobox', { name: /Strength/ }), 'single');
        await userEvent.selectOptions(card.getByRole('combobox', { name: 'Effort' }), 'low');
        await userEvent.click(card.getByRole('button', { name: 'Start review' }));
        expect(posted).toEqual([{ type: 'reviewers.start', reviewers: { strength: 'single', model: 'opus', effort: 'low' } }]);
    });

    it('hides the start card once the round has started its reviewers', () => {
        render(
            <App
                store={storeWith(
                    reviewView({ round: { reviewers: { strength: 'single', model: 'haiku', effort: 'low', at: NOW } } })
                )}
            />
        );
        expect(screen.queryByRole('region', { name: 'Start the review' })).not.toBeInTheDocument();
    });
});

describe('the deck', () => {
    it('shows one slide, moves with the arrow keys and jumps from the overview', async () => {
        render(<App store={storeWith(reviewView({ round: PUBLISHED }))} />);
        expect(screen.getByRole('heading', { name: 'Slide why' })).toBeInTheDocument();
        expect(document.querySelectorAll('.slide')).toHaveLength(1);
        fireEvent.keyDown(window, { key: 'ArrowRight' });
        expect(screen.getByRole('heading', { name: 'Slide how' })).toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'Overview' }));
        await userEvent.click(
            within(screen.getByRole('list', { name: 'All slides' })).getByRole('button', { name: /Slide tradeoffs/ })
        );
        expect(screen.getByRole('heading', { name: 'Slide tradeoffs' })).toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'Slide 1: Slide why' }));
        expect(screen.getByRole('heading', { name: 'Slide why' })).toBeInTheDocument();
    });

    it('opens a slide block full screen outside the slide frame, so the side panel cannot cover it', () => {
        render(<App store={storeWith(reviewView({ round: PUBLISHED }))} />);
        fireEvent.click(
            within(instance(document.querySelector('.slide-frame'), HTMLElement)).getByRole('button', { name: 'Full screen' })
        );
        expect(screen.getByRole('dialog').closest('.slide-frame')).toBeNull();
    });

    it('hands the arrow keys to a step-through first, then moves on from its last step', () => {
        render(<App store={storeWith(reviewView({ round: PUBLISHED }))} />);
        fireEvent.keyDown(window, { key: 'ArrowRight' });
        fireEvent.keyDown(window, { key: 'ArrowRight' });
        expect(screen.getByRole('heading', { name: 'Slide steps' })).toBeInTheDocument();
        expect(screen.getByText('Step One')).toBeInTheDocument();
        fireEvent.keyDown(window, { key: 'ArrowRight' });
        fireEvent.keyDown(window, { key: 'ArrowRight' });
        expect(screen.getByText('Step Three')).toBeInTheDocument();
        expect(screen.getByText('3/5')).toBeInTheDocument();
        expect(screen.getByRole('heading', { name: 'Slide steps' })).toBeInTheDocument();
        fireEvent.keyDown(window, { key: 'ArrowRight' });
        fireEvent.keyDown(window, { key: 'ArrowRight' });
        fireEvent.keyDown(window, { key: 'ArrowRight' });
        expect(screen.getByRole('heading', { name: 'Slide take' })).toBeInTheDocument();
    });

    it('shows every step at once under reduced motion', () => {
        reducedMotion();
        render(<App store={storeWith(reviewView({ round: PUBLISHED }))} />);
        fireEvent.keyDown(window, { key: 'ArrowRight' });
        fireEvent.keyDown(window, { key: 'ArrowRight' });
        for (const caption of ['One', 'Two', 'Three', 'Four', 'Five'])
            expect(screen.getByText(`Step ${caption}`)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Next step' })).not.toBeInTheDocument();
        fireEvent.keyDown(window, { key: 'ArrowRight' });
        expect(screen.getByRole('heading', { name: 'Slide take' })).toBeInTheDocument();
    });

    it('finishes on the last slide, and logs a skip from any slide', async () => {
        render(<App store={storeWith(reviewView({ round: PUBLISHED }))} />);
        await userEvent.click(screen.getByRole('button', { name: 'Skip to findings' }));
        expect(posted).toEqual([{ type: 'walkthrough.done', how: 'skipped' }]);
        posted.length = 0;
        await userEvent.click(screen.getByRole('button', { name: /Walkthrough/ }));
        await userEvent.click(screen.getByRole('button', { name: 'Slide 6: Slide tradeoffs' }));
        await userEvent.click(screen.getByRole('button', { name: 'Finish walkthrough' }));
        expect(posted).toEqual([{ type: 'walkthrough.done', how: 'finished' }]);
    });

    it('prints every slide, one to a page, each step-through in its final state', () => {
        render(<App store={storeWith(reviewView({ round: PUBLISHED }))} />);
        act(() => setPrinting(true));
        const printed = instance(document.querySelector('.deck-print'), HTMLElement);
        expect(printed.querySelectorAll('.print-slide')).toHaveLength(6);
        for (const caption of ['One', 'Five']) expect(within(printed).getByText(`Step ${caption}`)).toBeInTheDocument();
        expect(within(printed).getByText('Not answered.')).toBeInTheDocument();
    });
});

describe('the impact map', () => {
    it('opens an area, saves the concerns and an added area, sends them on moving on, then shows Trade-offs when it lands', async () => {
        const store = storeWith(reviewView({ round: FIRST_PART }));
        render(<App store={store} />);
        expect(screen.queryByRole('button', { name: /Slide tradeoffs/ })).toBeNull();
        await userEvent.click(screen.getByRole('button', { name: 'Slide 5: Slide touches' }));
        await userEvent.click(screen.getByRole('button', { name: 'Billing exports' }));
        const panel = within(screen.getByRole('region', { name: 'Billing exports' }));
        expect(panel.getByText('The export reads the retry count.')).toBeInTheDocument();
        expect(panel.getByText('The export retries too.')).toBeInTheDocument();
        await userEvent.type(
            panel.getByRole('textbox', { name: 'A question or concern about Billing exports' }),
            'Does the export retry?{Enter}'
        );
        await userEvent.type(screen.getByRole('textbox', { name: 'An area the agent missed' }), 'Search indexing');
        await userEvent.click(screen.getByRole('button', { name: 'Add an area' }));
        expect(screen.getByRole('button', { name: 'Search indexing' })).toHaveAttribute('aria-pressed', 'true');
        await userEvent.click(screen.getByRole('button', { name: 'Next' }));
        expect(posted).toEqual([
            { type: 'impact.save', concerns: { billing: ['Does the export retry?'] }, added: [] },
            {
                type: 'impact.save',
                concerns: { billing: ['Does the export retry?'] },
                added: [{ title: 'Search indexing', concerns: [] }]
            },
            { type: 'impact.send' }
        ]);
        expect(screen.getByRole('progressbar', { name: 'Writing Trade-offs' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Finish walkthrough' })).toBeNull();

        act(() => store.snapshot(reviewView({ round: PUBLISHED })));
        expect(screen.getByRole('heading', { name: 'Slide tradeoffs' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Finish walkthrough' })).toBeInTheDocument();
    });

    it('sends the concerns before a skip', async () => {
        render(<App store={storeWith(reviewView({ round: FIRST_PART }))} />);
        await userEvent.click(screen.getByRole('button', { name: 'Skip to findings' }));
        expect(posted).toEqual([{ type: 'impact.send' }, { type: 'walkthrough.done', how: 'skipped' }]);
    });

    it('keeps the concerns read-only once they are sent', async () => {
        const sent = { concerns: { billing: ['Does the export retry?'] }, added: [], sentAt: NOW };
        render(<App store={storeWith(reviewView({ round: { ...FIRST_PART, impact: sent } }))} />);
        await userEvent.click(screen.getByRole('button', { name: 'Slide 5: Slide touches' }));
        await userEvent.click(screen.getByRole('button', { name: /Billing exports/ }));
        const panel = within(screen.getByRole('region', { name: 'Billing exports' }));
        expect(panel.getByText('Does the export retry?')).toBeInTheDocument();
        expect(panel.queryByRole('textbox')).toBeNull();
        expect(screen.queryByRole('textbox', { name: 'An area the agent missed' })).toBeNull();
        expect(screen.getByText(/Sent to the agent/)).toBeInTheDocument();
    });
});

describe('your takes', () => {
    /** The predict card's slide, published. */
    function onTake(takes: Record<string, TakeRecord> = {}) {
        const store = storeWith(reviewView({ round: PUBLISHED, takes }));
        render(<App store={store} />);
        for (let step = 0; step < 7; step += 1) fireEvent.keyDown(window, { key: 'ArrowRight' });
        return store;
    }

    it('keeps the agent view off the page until the answer is logged, then reveals it', async () => {
        onTake();
        expect(screen.getByRole('heading', { name: 'Slide take' })).toBeInTheDocument();
        expect(screen.queryByText(/availability wins/)).not.toBeInTheDocument();
        await userEvent.click(screen.getByRole('radio', { name: 'It gets a 503' }));
        await userEvent.click(screen.getByRole('button', { name: 'Lock in my take' }));
        expect(posted).toEqual([
            { type: 'take.answer', blockId: 'take-predict', answer: { kind: 'predict', guess: 'It gets a 503' } }
        ]);
        // The answer is logged; the reveal waits for the record the server sends back.
        expect(screen.queryByText(/availability wins/)).not.toBeInTheDocument();
    });

    it('shows the guess beside the answer once taken', () => {
        onTake({ 'take-predict': { answer: { kind: 'predict', guess: 'It gets a 503' }, blockVersion: 1, at: NOW } });
        expect(screen.getByText('It gets a 503')).toBeInTheDocument();
        expect(screen.getByText('It goes through unlimited')).toBeInTheDocument();
        expect(screen.getByText(/availability wins/)).toBeInTheDocument();
    });

    const cases: [string, Record<string, unknown>, TakeAnswer, string][] = [
        [
            'prosCons',
            { kind: 'prosCons', pros: ['Adds a retry cap'], cons: ['More code'] },
            { kind: 'prosCons', pros: ['adds a retry cap', 'faster'], cons: [] },
            'Adds a retry cap'
        ],
        [
            'risk',
            { kind: 'risk', ratings: { correctness: 2, performance: 1, security: 4, maintainability: 3 }, why: 'Retry storms.' },
            { kind: 'risk', ratings: { security: 4, correctness: 2 } },
            'Retry storms.'
        ],
        [
            'check',
            {
                kind: 'check',
                question: 'What caps retries?',
                options: ['A policy', 'Nothing'],
                correct: 0,
                explanation: 'The policy does.',
                slide: 'how'
            },
            { kind: 'check', choice: 1 },
            'The policy does.'
        ]
    ];
    it.each(cases)('a %s card hides the agent view until answered, then shows both', (_kind, config, answer, agentText) => {
        const block = blockRecord('take-x', 'yourTake', config);
        const blocks = [...BLOCKS, block];
        const slides = [...SLIDES, slide('takex', 'tradeoffs', ['take-x'], 2)];
        const view = (takes: Record<string, TakeRecord>) => reviewView({ round: PUBLISHED, blocks, slides, takes });
        const first = render(<App store={storeWith(view({}))} />);
        for (let step = 0; step < 12; step += 1) fireEvent.keyDown(window, { key: 'ArrowRight' });
        expect(screen.getByRole('heading', { name: 'Slide takex' })).toBeInTheDocument();
        expect(screen.queryByText(agentText)).not.toBeInTheDocument();
        first.unmount();
        render(<App store={storeWith(view({ 'take-x': { answer, blockVersion: 1, at: NOW } }))} />);
        for (let step = 0; step < 12; step += 1) fireEvent.keyDown(window, { key: 'ArrowRight' });
        expect(screen.getByText(agentText)).toBeInTheDocument();
        if (answer.kind === 'prosCons') expect(document.querySelectorAll('.take-points li.is-shared')).toHaveLength(2);
        if (answer.kind === 'check')
            expect(screen.getByRole('button', { name: 'See the slide that explains it' })).toBeInTheDocument();
    });
});

describe('the findings', () => {
    it('stay off the page, on the diagrams too, until the walkthrough is done', async () => {
        const store = storeWith(reviewView({ round: PUBLISHED, items: [item('I-1')] }));
        render(<App store={store} />);
        fireEvent.keyDown(window, { key: 'ArrowRight' });
        expect(screen.getByRole('heading', { name: 'Slide how' })).toBeInTheDocument();
        expect(document.querySelector('.dg-pin')).toBeNull();
        expect(screen.getByRole('button', { name: /Review/ })).toBeDisabled();
        expect(screen.queryByText('Finding I-1 title')).not.toBeInTheDocument();

        act(() => store.snapshot(reviewView({ round: DONE, items: [item('I-1')] })));
        expect(document.querySelector('.dg-pin')).not.toBeNull();
        await userEvent.click(screen.getByRole('button', { name: /Review/ }));
        expect(screen.getAllByText('Finding I-1 title').length).toBeGreaterThan(0);
        expect(screen.getByText('80% confidence')).toBeInTheDocument();
    });

    it("shows a finding's context blocks under its claim", () => {
        const blocks = [{ type: 'text', config: { body: 'The client gives up after one timeout.' }, caption: 'The caller' }];
        render(<App store={storeWith(reviewView({ round: DONE, items: [item('I-1', { blocks })] }))} />);
        const card = within(instance(document.getElementById('item-I-1'), HTMLElement));
        expect(card.getByText('Context')).toBeInTheDocument();
        expect(card.getByText('The client gives up after one timeout.')).toBeInTheDocument();
    });

    it('opens the comment a finding drafts as Bitbucket will show it, signed', async () => {
        render(<App store={storeWith(reviewView({ round: DONE, items: [item('I-1', { draft: 'Cap it at **one**?' })] }))} />);
        await userEvent.click(screen.getByRole('button', { name: 'See the comment it drafts' }));
        const dialog = within(screen.getByRole('dialog', { name: 'The comment I-1 drafts' }));
        expect(dialog.getByText('src/retry.ts:2')).toBeInTheDocument();
        expect(dialog.getByText('one').tagName).toBe('STRONG');
        expect(dialog.getByText('- Claude')).toBeInTheDocument();
    });

    it('opens the change a finding sits on, scrolled to the finding', async () => {
        const patch = '@@ -1,2 +1,3 @@\n const a = 1;\n+const b = 2;\n const c = 3;\n';
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response(JSON.stringify({ patch }), { status: 200 }))
        );
        const scrolled = vi.fn();
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: scrolled, configurable: true });
        try {
            const anchor = { file: 'src/focus.ts', side: 'new' as const, start: 2 };
            render(<App store={storeWith(reviewView({ round: DONE, items: [item('I-1', { anchor })] }))} />);
            await userEvent.click(screen.getByRole('button', { name: 'Show the change at src/focus.ts:2' }));
            const dialog = within(screen.getByRole('dialog', { name: 'The change at src/focus.ts:2' }));
            const card = await dialog.findByRole('button', { name: /Finding I-1 title/ });
            expect(dialog.getByRole('group', { name: 'Diff of src/focus.ts' })).toHaveTextContent('const b = 2;');
            expect(scrolled.mock.contexts).toContain(card);
        } finally {
            Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
        }
    });

    it('makes the chosen reaction stand out, whichever it is', () => {
        for (const verdict of ['agree', 'reword', 'reject'] as const) {
            const { unmount } = render(
                <App store={storeWith(reviewView({ round: DONE, items: [item('I-1')], reactions: { 'I-1': { verdict } } }))} />
            );
            const card = within(instance(document.getElementById('item-I-1'), HTMLElement));
            const chosen = card.getByRole('button', { pressed: true });
            expect(chosen).toHaveClass('button-primary');
            expect(
                card.getAllByRole('button', { pressed: false }).every((other) => !other.classList.contains('button-primary'))
            ).toBe(true);
            unmount();
        }
    });

    it('renders a reworded comment while it is typed, with the sign-off under it', async () => {
        render(<App store={storeWith(reviewView({ round: DONE, items: [item('I-1')] }))} />);
        await userEvent.click(screen.getByRole('button', { name: 'Reword' }));
        const box = screen.getByRole('textbox', { name: 'The comment in your words' });
        typeInto(box, 'Cap it at `one`?');
        expect(box.querySelector('.cm-md-code')).toHaveTextContent('one');
        expect(screen.getByText('- Claude')).toBeInTheDocument();
    });

    it('agree, reword and reject each send their reaction, a rejection with its reason', async () => {
        render(<App store={storeWith(reviewView({ round: DONE, items: [item('I-1'), item('I-2'), item('I-3')] }))} />);
        const card = (id: string) => within(instance(document.getElementById(`item-${id}`), HTMLElement));
        await userEvent.click(card('I-1').getByRole('button', { name: 'Agree' }));
        await userEvent.click(card('I-2').getByRole('button', { name: 'Reword' }));
        typeInto(card('I-2').getByRole('textbox'), 'Cap it at one?');
        await userEvent.click(card('I-2').getByRole('button', { name: 'Use my wording' }));
        await userEvent.click(card('I-3').getByRole('button', { name: 'Reject' }));
        await userEvent.type(card('I-3').getByRole('textbox'), 'handled in the caller');
        await userEvent.click(card('I-3').getByRole('button', { name: 'Reject it' }));
        expect(posted).toEqual([
            { type: 'item.react', itemId: 'I-1', verdict: 'agree' },
            { type: 'item.react', itemId: 'I-2', verdict: 'reword', text: 'Cap it at one?' },
            { type: 'item.react', itemId: 'I-3', verdict: 'reject', reason: 'handled in the caller' }
        ]);
    });

    it.each([
        ['charts', () => document.querySelector('[data-block-type="bar"]')],
        ['matrix', () => document.querySelector('[data-block-type="riskMatrix"]')],
        ['heatmap', () => document.querySelector('[data-block-type="fileTree"]')],
        ['diff', () => document.querySelector('.review-files')]
    ] as const)('the %s view shows, and goes at once when turned off', async (name, find) => {
        const store = storeWith(reviewView({ round: DONE, items: [item('I-1')] }));
        render(<App store={store} />);
        await userEvent.click(screen.getByRole('button', { name: /Review/ }));
        expect(find()).not.toBeNull();
        const off = { ...DEFAULT_PREFERENCES, views: { ...DEFAULT_PREFERENCES.views, [name]: false } };
        act(() => store.apply([{ field: 'preferences', value: off }]));
        expect(find()).toBeNull();
        if (name === 'heatmap') expect(document.querySelector('[data-block-type="bar"]')).not.toBeNull();
    });

    it('counts findings on the heat map and pins them on the diagram unless pins are off', async () => {
        const store = storeWith(reviewView({ round: DONE, items: [item('I-1'), item('I-2')] }));
        render(<App store={store} />);
        await userEvent.click(screen.getByRole('button', { name: /Review/ }));
        expect(screen.getByText('2 findings')).toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: /Walkthrough/ }));
        fireEvent.keyDown(window, { key: 'ArrowRight' });
        expect(screen.getByRole('button', { name: /2 findings: I-1/ })).toBeInTheDocument();
        act(() =>
            store.apply([
                { field: 'preferences', value: { ...DEFAULT_PREFERENCES, views: { ...DEFAULT_PREFERENCES.views, pins: false } } }
            ])
        );
        expect(document.querySelector('.dg-pin')).toBeNull();
    });
});

describe('the comments', () => {
    const rewording = 'one two three four five alpha beta gamma delta epsilon zeta eta theta';
    const draft = 'one two three four five six seven eight nine ten';

    /** The Comments tab of a round in preview, which the page opens on. */
    async function comments(options: Parameters<typeof reviewView>[0]) {
        render(<App store={storeWith(reviewView({ round: { ...DONE, previewing: true }, ...options }))} />);
        expect(await screen.findByRole('heading', { name: 'What you will post' })).toBeInTheDocument();
    }

    it('draws each comment as Bitbucket will, raw HTML as text, with its share and sign-off', async () => {
        await comments({
            items: [
                item('I-1', { draft: 'Use <b>bold</b>' }),
                item('I-2', { draft, severity: 'minor' }),
                item('I-3', { draft, severity: 'minor' })
            ],
            reactions: {
                'I-1': { verdict: 'agree' },
                'I-2': { verdict: 'reword', text: rewording },
                'I-3': { verdict: 'reword', text: 'one two three four five alpha beta gamma delta epsilon' }
            }
        });
        expect(screen.getByText('Use <b>bold</b>')).toBeInTheDocument();
        // The sign-off reads as text, not as a bullet list.
        expect(document.querySelector('.bb-body li')).toBeNull();
        expect(screen.getAllByText('- Claude').length).toBeGreaterThan(0);
        expect(document.querySelector('.bb-body b')).toBeNull();
        const card = (text: string) => within(instance(screen.getByText(text).closest('.bb-card'), HTMLElement));
        expect(card('Use <b>bold</b>').getByRole('checkbox', { name: /Sign/ })).toBeDisabled();
        expect(card('Use <b>bold</b>').getByRole('checkbox', { name: 'Make it a task' })).toBeChecked();
        expect(card(rewording).getByText('62% yours')).toBeInTheDocument();
        expect(card(rewording).getByRole('checkbox', { name: /Sign/ })).toBeEnabled();
        expect(card(rewording).getByRole('checkbox', { name: 'Make it a task' })).not.toBeChecked();
        expect(card('one two three four five alpha beta gamma delta epsilon').getByText('50% yours')).toBeInTheDocument();
        expect(
            card('one two three four five alpha beta gamma delta epsilon').getByRole('checkbox', { name: /Sign/ })
        ).toBeDisabled();
        await userEvent.click(card(rewording).getByRole('checkbox', { name: /Sign/ }));
        await userEvent.click(card(rewording).getByRole('checkbox', { name: 'Make it a task' }));
        expect(posted).toEqual([
            { type: 'comment.choose', key: 'item:I-2', unsigned: true },
            { type: 'comment.choose', key: 'item:I-2', task: true }
        ]);
    });

    it('makes each comment body a target the reviewer can select and comment on', async () => {
        await comments({ items: [item('I-1', { draft })], reactions: { 'I-1': { verdict: 'agree' } } });
        expect(instance(screen.getByText(draft).closest('.bb-body'), HTMLElement)).toHaveAttribute(
            'data-anchor-target',
            'comment:item:I-1'
        );
    });

    it('lists the findings that still need a reaction, and keeps Post off until they have one', async () => {
        await comments({ pr: true, items: [item('I-1'), item('I-2')], reactions: { 'I-1': { verdict: 'agree' } } });
        expect(screen.getByText('1 finding still needs a reaction')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'I-2: Finding I-2 title' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Post as drafts' })).toBeDisabled();
    });

    it('keeps Post off with what to set while the credentials are missing', async () => {
        await comments({
            pr: true,
            items: [item('I-1')],
            reactions: { 'I-1': { verdict: 'agree' } },
            postable: { ready: false, problem: 'Set BITBUCKET_API_TOKEN' }
        });
        expect(screen.getByText('Set BITBUCKET_API_TOKEN')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Post as drafts' })).toBeDisabled();
    });

    it('copies a local branch review as Markdown, with no request to Bitbucket', async () => {
        const writeText = vi.fn(async () => undefined);
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
        await comments({ items: [item('I-1')], reactions: { 'I-1': { verdict: 'agree' } } });
        await userEvent.click(screen.getByRole('button', { name: 'Copy as Markdown' }));
        expect(writeText).toHaveBeenCalledWith(
            '## Review: Cap the retries\n\n### src/retry.ts:2\n\nCan two retries outlast the caller?\n\n\\- Claude\n\n_Task_\n'
        );
        const requests = vi.mocked(fetch).mock.calls.map(([url]) => String(url));
        expect(requests.every((url) => url.startsWith('api/'))).toBe(true);
    });

    it("edits an agreed finding's comment in place, as a reword, rendering all but the part being typed in", async () => {
        await comments({ items: [item('I-1')], reactions: { 'I-1': { verdict: 'agree' } } });
        await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
        const box = screen.getByRole('textbox', { name: 'Edit the comment' });
        expect(box).toHaveTextContent('Can two retries outlast the caller?');
        const view = EditorView.findFromDOM(box.closest('.markdown-editor') as HTMLElement)!;
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'Retry **once**?' } });
        expect(box.querySelector('.cm-md-strong')).toHaveTextContent('once');
        expect(box).toHaveTextContent('Retry once?');
        view.focus();
        view.dispatch({ selection: { anchor: 9 } });
        expect(box).toHaveTextContent('Retry **once**?');
        await userEvent.click(screen.getByRole('button', { name: 'Save' }));
        expect(posted).toContainEqual({ type: 'item.react', itemId: 'I-1', verdict: 'reword', text: 'Retry **once**?' });
    });

    it('edits and deletes a comment of your own', async () => {
        const anchor = { file: 'src/retry.ts', side: 'new' as const, start: 3 };
        await comments({ items: [], notes: [{ id: 'N-1', round: 1, anchor, text: 'Nice name', at: NOW }] });
        await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
        typeInto(screen.getByRole('textbox', { name: 'Edit the comment' }), 'Nice name!');
        await userEvent.click(screen.getByRole('button', { name: 'Save' }));
        await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
        expect(posted).toEqual([
            { type: 'note.save', id: 'N-1', anchor, text: 'Nice name!' },
            { type: 'note.delete', id: 'N-1' }
        ]);
    });

    it('adds a comment of your own on a line, with no sign-off', async () => {
        await comments({ items: [] });
        await userEvent.click(screen.getByRole('button', { name: 'Add a comment of your own' }));
        await userEvent.click(screen.getByRole('button', { name: 'File' }));
        await userEvent.click(screen.getByRole('button', { name: 'retry.ts' }));
        await userEvent.type(screen.getByRole('textbox', { name: 'Line, or blank for the whole file' }), '12');
        typeInto(screen.getByRole('textbox', { name: 'Your comment' }), 'Nice name');
        await userEvent.click(screen.getByRole('button', { name: 'Add comment' }));
        expect(posted).toEqual([
            { type: 'note.save', anchor: { file: 'src/retry.ts', side: 'new', start: 12 }, text: 'Nice name' }
        ]);
    });

    it('adds a comment of your own on the pull request, with no file', async () => {
        await comments({ items: [] });
        await userEvent.click(screen.getByRole('button', { name: 'Add a comment of your own' }));
        expect(screen.queryByRole('textbox', { name: 'Line, or blank for the whole file' })).toBeNull();
        typeInto(screen.getByRole('textbox', { name: 'Your comment' }), 'Overall fine');
        await userEvent.click(screen.getByRole('button', { name: 'Add comment' }));
        expect(posted).toEqual([{ type: 'note.save', text: 'Overall fine' }]);
    });
});

describe('the html block', () => {
    const html = blockRecord('sim', 'html', { title: 'Retry delays', alt: 'A slider', height: 240, html: '<p>hi</p>' });

    it('runs in a sandboxed frame of its own document, labelled, and fills a slide alone', () => {
        render(
            <App
                store={storeWith(
                    reviewView({ round: PUBLISHED, blocks: [...BLOCKS, html], slides: [slide('why', 'why', ['sim'])] })
                )}
            />
        );
        const frame = instance(document.querySelector('iframe'), HTMLIFrameElement);
        expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
        expect(frame.getAttribute('src')).toBe('api/frame/sim');
        expect(screen.getByText('Retry delays · interactive, sandboxed')).toBeInTheDocument();
        expect(document.querySelector('.slide')).toHaveClass('is-fill');
    });

    it('reloads the frame when it loads anything after its own document', () => {
        renderWith(storeWith(reviewView({ blocks: [html] })), <BlockView block={html} placement="slide" />);
        const first = instance(document.querySelector('iframe'), HTMLIFrameElement);
        fireEvent.load(first);
        expect(document.querySelector('iframe')).toBe(first);
        fireEvent.load(first);
        expect(document.querySelector('iframe')).not.toBe(first);
        expect(document.querySelector('iframe')?.getAttribute('src')).toBe('api/frame/sim');
    });

    it('puts its policy first in the head, ahead of the agent HTML, with no connect-src', () => {
        const page = new DOMParser().parseFromString(
            frameDocument('<meta http-equiv="Content-Security-Policy" content="connect-src *"><p>x</p>'),
            'text/html'
        );
        const first = defined(page.head.firstElementChild);
        expect(first.getAttribute('http-equiv')).toBe('Content-Security-Policy');
        expect(first.getAttribute('content')).toBe(FRAME_CSP);
        expect(FRAME_CSP).not.toContain('connect-src');
    });

    it('stays live in the HTML export, its document moved into the sandboxed srcdoc', async () => {
        document.body.innerHTML =
            '<main id="main"><iframe data-html-block="sim" sandbox="allow-scripts" src="api/frame/sim"></iframe></main>';
        const load: BlobLoader = async () => new Blob([frameDocument('<p>live</p>')], { type: 'text/html' });
        const out = new DOMParser().parseFromString(
            await buildHtml(defined(document.getElementById('main')), document, load),
            'text/html'
        );
        const frame = defined(out.querySelector('iframe'));
        expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
        expect(frame.hasAttribute('src')).toBe(false);
        expect(frame.getAttribute('srcdoc')).toBe(frameDocument('<p>live</p>'));
    });
});

describe('the new shared blocks', () => {
    it.each(['plan', 'ask', 'review'] as const)('render an analogy and a step-through in a %s', (kind) => {
        const store = storeWith(makeView({}, {}));
        store.snapshot({ ...defined(store.getView()), kind });
        const analogy = blockRecord('an', 'analogy', blockCatalog.analogy.example);
        const steps = blockRecord('st', 'stepThrough', blockCatalog.stepThrough.example);
        renderWith(
            store,
            <>
                <BlockView block={analogy} placement="writeup" />
                <BlockView block={steps} placement="writeup" />
            </>
        );
        expect(screen.getByText('A ticket counter')).toBeInTheDocument();
        expect(screen.getByText(/A counter serves one queue/)).toBeInTheDocument();
        expect(screen.getByText('Every request asks the limiter first.')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Next step' }));
        expect(screen.getByText('Redis says the bucket is empty.')).toBeInTheDocument();
    });
});

describe('settings', () => {
    it('has a Review section on a review page, saving to the machine', async () => {
        render(<App store={storeWith(reviewView({ round: PUBLISHED }))} />);
        await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
        const section = within(screen.getByRole('group', { name: 'Review' }));
        await userEvent.click(section.getByRole('checkbox', { name: 'Risk rating' }));
        expect(posted).toEqual([
            {
                type: 'preferences.set',
                preferences: { ...DEFAULT_PREFERENCES, takes: { ...DEFAULT_PREFERENCES.takes, risk: false } }
            }
        ]);
    });

    it('picks the review agents: strength, model and effort', async () => {
        render(<App store={storeWith(reviewView({ round: PUBLISHED }))} />);
        await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
        const section = within(screen.getByRole('group', { name: 'Review' }));
        expect(section.getByText(/then a verifier tries to refute/)).toBeInTheDocument();
        await userEvent.selectOptions(section.getByRole('combobox', { name: /Strength/ }), 'single');
        expect(posted).toEqual([
            {
                type: 'preferences.set',
                preferences: { ...DEFAULT_PREFERENCES, reviewers: { ...DEFAULT_PREFERENCES.reviewers, strength: 'single' } }
            }
        ]);
    });

    it('has none on a planning page', async () => {
        render(<App store={storeWith(makeView())} />);
        await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
        expect(screen.queryByRole('group', { name: 'Review' })).not.toBeInTheDocument();
    });
});
