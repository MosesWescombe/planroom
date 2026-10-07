import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import dagre from 'dagre';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { blockCatalog } from '../../shared/blockCatalog';
import { blockTypes, c4Config, codeConfig, ganttConfig, mindmapConfig, sankeyConfig, schemaConfig } from '../../shared/blocks';
import { blockRecord, sectionRecord } from '../../test/fixtures';
import { defined, instance, makeView, posted, renderWith, storeWith } from '../../test/harness';
import { parsePatch } from '../code/CodeViewer';
import { CommentLayer } from '../comments/CommentLayer';
import { formatValue } from '../format';
import { type BlockInput, BlockView } from './Block';
import { ImageBlock } from './basic';
import { niceTicks } from './charts';
import {
    c4Graph,
    curvePath,
    flowGraph,
    ganttTicks,
    layoutGraph,
    layoutMindmap,
    layoutSankey,
    rowCentre,
    scheduleGantt,
    schemaGraph,
    stateGraph
} from './layout';
import { stagger } from './stagger';

const mermaid = vi.hoisted(() => ({
    initialize: vi.fn(),
    render: vi.fn(async () => ({ svg: '<svg data-testid="mermaid-svg"></svg>' }))
}));
const loadMermaid = vi.hoisted(() => vi.fn(async () => mermaid));
vi.mock('./mermaidLoader', () => ({ loadMermaid }));

beforeEach(() => {
    loadMermaid.mockClear();
    mermaid.initialize.mockClear();
});

/** A ResizeObserver that measures as soon as it observes, since jsdom has none. */
function measureAtOnce(): void {
    vi.stubGlobal(
        'ResizeObserver',
        class {
            constructor(private readonly measure: () => void) {}
            observe() {
                this.measure();
            }
            disconnect() {}
        }
    );
}

/** Render one block in the write-up, with the record in the store so interactive blocks can act. */
function renderBlock(block: BlockInput, others: BlockInput[] = []) {
    const records = [block, ...others].map((input) =>
        blockRecord(input.id, input.type, input.config, input.problem ? { problem: input.problem } : {})
    );
    const store = storeWith(
        makeView({
            blocks: records,
            sections: [
                sectionRecord(
                    's1',
                    1,
                    records.map((record) => record.id)
                )
            ]
        })
    );
    return { store, ...renderWith(store, <BlockView block={block} placement="writeup" />, 'writeup') };
}

describe('the block catalog renders', () => {
    it.each(blockTypes)('the %s example renders without an error card', async (type) => {
        const flow = { id: 'flow-proposed', type: 'flow', config: blockCatalog.flow.example };
        renderBlock({ id: `b-${type}`, type, config: blockCatalog[type].example }, type === 'compare' ? [flow] : []);
        expect(document.querySelector('.block-error, .block-unknown')).toBeNull();
        if (type === 'mermaid') await waitFor(() => expect(screen.getByTestId('mermaid-svg')).toBeInTheDocument());
    });

    it('markup in a config: a callout body is shown as literal text and runs nothing', () => {
        renderBlock({ id: 'c1', type: 'callout', config: { tone: 'note', body: '<img src=x onerror=alert(1)>' } });
        expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
        expect(document.querySelector('img')).toBeNull();
    });

    it('text blocks escape HTML and link question ids', () => {
        renderBlock({ id: 't1', type: 'text', config: { body: '**Bold** <script>x</script> see Q-12' } });
        expect(document.querySelector('script')).toBeNull();
        expect(screen.getByRole('link', { name: 'Q-12' })).toBeInTheDocument();
        expect(screen.getByText('Bold').tagName).toBe('STRONG');
    });

    it('leaves a question id inside a markdown link as the link text, not a nested link', () => {
        renderBlock({ id: 't1', type: 'text', config: { body: '[see Q-3](https://x.test/) and Q-4' } });
        expect(screen.getByRole('link', { name: 'see Q-3' })).toHaveAttribute('href', 'https://x.test/');
        expect(document.querySelector('a a')).toBeNull();
        expect(screen.getByRole('link', { name: 'Q-4' })).toBeInTheDocument();
    });

    it('diagram without coordinates: three nodes and two edges are laid out left to right, the new node in the accent style', () => {
        const config = {
            direction: 'LR' as const,
            nodes: [
                { id: 'c', label: 'Client', shape: 'box' as const },
                { id: 'l', label: 'Limiter', emphasis: 'new' as const, shape: 'box' as const },
                { id: 'h', label: 'Handler', shape: 'box' as const }
            ],
            edges: [
                { from: 'c', to: 'l', style: 'solid' as const },
                { from: 'l', to: 'h', style: 'solid' as const }
            ]
        };
        const layout = layoutGraph(flowGraph(config));
        const x = (id: string) => defined(layout.nodes.find((node) => node.id === id)).x;
        expect(x('c')).toBeLessThan(x('l'));
        expect(x('l')).toBeLessThan(x('h'));
        expect(layout.edges).toHaveLength(2);
        const vertical = layoutGraph(flowGraph({ ...config, direction: 'TB' }));
        const y = (id: string) => defined(vertical.nodes.find((node) => node.id === id)).y;
        expect(y('c')).toBeLessThan(y('h'));

        renderBlock({ id: 'f1', type: 'flow', config });
        expect(document.querySelectorAll('.dg-node')).toHaveLength(3);
        expect(document.querySelector('.dg-node.is-new')).toHaveTextContent('Limiter');
        expect(document.querySelectorAll('.dg-edge')).toHaveLength(2);
    });

    it('node ids and state names that name Object.prototype members lay out at finite positions', () => {
        const flow = layoutGraph(
            flowGraph({
                direction: 'LR',
                nodes: [
                    { id: 'init', label: 'Init', shape: 'box' },
                    { id: 'constructor', label: 'Build', shape: 'box' }
                ],
                edges: [{ from: 'init', to: 'constructor', style: 'solid' }]
            })
        );
        expect(flow.nodes.map((node) => node.id)).toEqual(['init', 'constructor']);
        expect(flow.edges).toMatchObject([{ from: 'init', to: 'constructor' }]);
        const machine = layoutGraph(
            stateGraph({
                states: ['idle', '__proto__', 'constructor', 'b'],
                transitions: [
                    { from: 'idle', to: '__proto__' },
                    { from: 'constructor', to: 'b' }
                ],
                emphasis: []
            })
        );
        expect(machine.edges).toMatchObject([
            { from: 'idle', to: '__proto__' },
            { from: 'constructor', to: 'b' }
        ]);
        for (const node of [...flow.nodes, ...machine.nodes]) {
            expect(Number.isFinite(node.x) && Number.isFinite(node.y)).toBe(true);
        }
    });
});

describe('a block that throws while rendering', () => {
    it('shows its error card in place, leaving the rest of the page up, and can ask the agent to fix it', async () => {
        const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const layout = vi.spyOn(dagre, 'layout').mockImplementation(() => {
            throw new Error('layout failed');
        });
        try {
            const flow = { id: 'f1', type: 'flow', config: blockCatalog.flow.example };
            const text = { id: 't1', type: 'text', config: { body: 'Still here' } };
            const store = storeWith(
                makeView({
                    blocks: [blockRecord(flow.id, flow.type, flow.config), blockRecord(text.id, text.type, text.config)],
                    sections: [sectionRecord('s1', 1, [flow.id, text.id])]
                })
            );
            renderWith(
                store,
                <>
                    <BlockView block={flow} placement="writeup" />
                    <BlockView block={text} placement="writeup" />
                </>,
                'writeup'
            );
            expect(screen.getByRole('group', { name: 'Block f1 could not render' })).toHaveTextContent('layout failed');
            expect(screen.getByText('Still here')).toBeInTheDocument();
            await userEvent.setup().click(screen.getByRole('button', { name: 'Ask agent to fix' }));
            await waitFor(() => expect(posted).toEqual([{ type: 'block.fix', blockId: 'f1', thrown: 'layout failed' }]));
        } finally {
            layout.mockRestore();
            quiet.mockRestore();
        }
    });
});

describe('annotations stagger instead of overlapping', () => {
    it('each box steps until it clears the boxes placed before it; a zero step never moves', () => {
        const box = { x: 0, y: 0, width: 10, height: 10 };
        const up = { x: 0, y: -10 };
        expect(
            stagger([
                { box, step: up },
                { box: { ...box, x: 5 }, step: up },
                { box: { ...box, x: 8 }, step: up },
                { box: { ...box, x: 12 }, step: up },
                { box, step: { x: 0, y: 0 } }
            ])
        ).toEqual([
            { x: 0, y: 0 },
            { x: 0, y: -10 },
            { x: 0, y: -20 },
            { x: 0, y: 0 },
            { x: 0, y: 0 }
        ]);
    });

    it('a line chart lifts a label that would run into its neighbour a row, and grows to make room', () => {
        const x = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];
        const annotations = [
            { x: '1', text: 'Limits tuned for the free tier' },
            { x: '2', text: 'Rolled back' },
            { x: '5', text: 'Shipped' }
        ];
        renderBlock({
            id: 'l1',
            type: 'line',
            config: { x, series: [{ name: 'A', values: x.map(Number) }], annotations, sample: false }
        });
        const labelY = [...document.querySelectorAll('.annotation text')].map((text) => Number(text.getAttribute('y')));
        expect(labelY[1]).toBe(defined(labelY[0]) - 14);
        expect(labelY[2]).toBe(labelY[0]);
        expect(document.querySelector('.line-chart')).toHaveAttribute('viewBox', '0 0 560 214');
    });

    it('image pins at the same spot step sideways towards the middle, pin 1 staying put', () => {
        measureAtOnce();
        const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400);
        const height = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(200);
        const pin = { x: 0.8, y: 0.5, text: 'Here' };
        renderBlock({ id: 'i1', type: 'image', config: { src: 'asset:a.png', alt: 'A', pins: [pin, pin, { ...pin, y: 0.1 }] } });
        const shifts = [...document.querySelectorAll('.pin')].map((element) => instance(element, HTMLElement).style.transform);
        expect(shifts).toEqual(['translate(0px, 0px)', 'translate(-28px, 0px)', 'translate(0px, 0px)']);
        width.mockRestore();
        height.mockRestore();
    });
});

describe('invalid and unknown blocks degrade visibly', () => {
    it('ask agent to fix: the error card lists each error and sends a fix request naming the block', async () => {
        const issues = [{ path: 'data[0]', message: 'expected 3 values, got 2' }];
        renderBlock({
            id: 'wu-bar',
            type: 'bar',
            config: { series: ['A', 'B'], data: [['Free', 1]] },
            problem: { reason: 'invalid', issues }
        });
        expect(screen.getByText("This chart couldn't render")).toBeInTheDocument();
        expect(screen.getByText('data[0]: expected 3 values, got 2')).toBeInTheDocument();
        await userEvent.setup().click(screen.getByRole('button', { name: 'Ask agent to fix' }));
        await waitFor(() => expect(posted).toEqual([{ type: 'block.fix', blockId: 'wu-bar' }]));
        fireEvent.click(screen.getByRole('button', { name: 'View config' }));
        expect(document.querySelector('.raw-config')).toHaveTextContent('"Free"');
    });

    it('an unknown type renders its raw config', () => {
        renderBlock({ id: 'u1', type: 'sankey', config: { flows: [1, 2] }, problem: { reason: 'unknown-type', issues: [] } });
        expect(screen.getByText('type: "sankey" is not registered')).toBeInTheDocument();
        expect(document.querySelector('.raw-config')).toHaveTextContent('"flows"');
    });

    it('a compare side that names a missing block shows the error on that side only', () => {
        renderBlock({
            id: 'cmp',
            type: 'compare',
            config: {
                left: { label: 'Today', block: { type: 'flow', config: blockCatalog.flow.example } },
                right: { label: 'After', block: 'missing-flow' },
                highlight: 'added'
            }
        });
        const sides = document.querySelectorAll('.compare-side');
        expect(defined(sides[0]).querySelector('svg.diagram')).not.toBeNull();
        expect(sides[1]).toHaveTextContent('Block "missing-flow" is not on the page');
        expect(document.querySelector('.block-error')).toBeNull();
    });
});

describe('mermaid', () => {
    it('is loaded only when a mermaid block renders, with strict security', async () => {
        renderBlock({ id: 't', type: 'table', config: blockCatalog.table.example });
        expect(loadMermaid).not.toHaveBeenCalled();
        renderBlock({ id: 'm', type: 'mermaid', config: blockCatalog.mermaid.example });
        await waitFor(() => expect(loadMermaid).toHaveBeenCalledTimes(1));
        await waitFor(() =>
            expect(mermaid.initialize).toHaveBeenCalledWith(expect.objectContaining({ securityLevel: 'strict' }))
        );
    });
});

describe('block interactions', () => {
    it('sorts a table by any column', () => {
        renderBlock({ id: 't', type: 'table', config: blockCatalog.table.example });
        fireEvent.click(screen.getByRole('button', { name: 'Plan' }));
        const firstCells = () => [...document.querySelectorAll('tbody tr')].map((row) => row.firstElementChild?.textContent);
        expect(firstCells()).toEqual(['Business', 'Free', 'Team']);
        fireEvent.click(screen.getByRole('button', { name: /Plan/ }));
        expect(firstCells()).toEqual(['Team', 'Free', 'Business']);
        expect(
            within(instance(document.querySelector('tbody'), HTMLTableSectionElement))
                .getAllByRole('link')
                .map((link) => link.textContent)
        ).toEqual(['Q-08', 'Q-08', 'Q-10']);
    });

    it('styles table cells with inline markdown and badges, keeping block syntax literal', () => {
        renderBlock({
            id: 't',
            type: 'table',
            config: {
                columns: ['Limit', 'Status'],
                rows: [
                    ['> 5 ms **p99** on `GET /orders`, see Q-3', { text: 'To confirm', tone: 'attention' }],
                    ['1. Draft', { text: 'Agreed', tone: 'accent' }]
                ]
            }
        });
        const rows = document.querySelectorAll('tbody tr');
        const first = instance(rows[0], HTMLTableRowElement);
        expect(first).toHaveTextContent('> 5 ms p99 on GET /orders, see Q-3');
        expect(first.querySelector('strong')).toHaveTextContent('p99');
        expect(first.querySelector('code')).toHaveTextContent('GET /orders');
        expect(within(first).getByRole('link', { name: 'Q-3' })).toBeInTheDocument();
        expect(first.querySelector('.badge-attention')).toHaveTextContent('To confirm');
        expect(rows[1]).toHaveTextContent('1. Draft');
        expect(document.querySelector('tbody ol, tbody blockquote')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Status' }));
        expect(document.querySelector('tbody tr .badge')).toHaveTextContent('Agreed');
    });

    it('ticks an interactive checklist item and tells the agent', async () => {
        renderBlock({ id: 'list', type: 'checklist', config: blockCatalog.checklist.example });
        expect(screen.getByText('2 of 3 agreed')).toBeInTheDocument();
        await userEvent.setup().click(screen.getByRole('checkbox', { name: 'Per-IP on anon routes' }));
        await waitFor(() => expect(posted).toEqual([{ type: 'checklist.tick', blockId: 'list', item: '2', done: true }]));
    });

    it('confirm an assumption: tells the agent, then shows it as confirmed', async () => {
        const { store } = renderBlock({
            id: 'a1',
            type: 'callout',
            config: { tone: 'assumption', title: 'Limits are per region, not global' }
        });
        await userEvent.setup().click(screen.getByRole('button', { name: 'Confirm' }));
        await waitFor(() => expect(posted).toEqual([{ type: 'assumption.confirm', blockId: 'a1' }]));
        store.apply([{ field: 'confirmedAssumptions', id: 'a1', value: 1 }]);
        await waitFor(() => expect(screen.getByText('Confirmed')).toBeInTheDocument());
    });

    it('correct an assumption: the composer anchors to the whole block, quoting and highlighting nothing', async () => {
        const block = { id: 'a1', type: 'callout', config: { tone: 'assumption', title: 'Limits are per region, not global' } };
        const view = makeView({
            blocks: [blockRecord('a1', 'callout', block.config)],
            sections: [sectionRecord('s1', 1, ['a1'])]
        });
        renderWith(
            storeWith(view),
            <>
                <BlockView block={block} placement="writeup" />
                <CommentLayer />
            </>,
            'writeup'
        );
        const user = userEvent.setup();
        await user.click(screen.getByRole('button', { name: 'Correct it' }));
        const composer = screen.getByRole('dialog', { name: 'Comment' });
        expect(composer.querySelector('.composer-quote')).not.toHaveTextContent('per region');
        await user.type(within(composer).getByLabelText('Comment'), 'Limits are per org');
        await user.click(within(composer).getByRole('button', { name: 'Send to agent' }));
        await waitFor(() =>
            expect(posted).toEqual([
                { type: 'comment.create', anchor: { target: 'block:a1' }, intent: 'change', text: 'Limits are per org' }
            ])
        );
    });

    it('offers a chart as a table', () => {
        renderBlock({ id: 'bar', type: 'bar', config: blockCatalog.bar.example });
        fireEvent.click(screen.getByRole('button', { name: 'View as table' }));
        expect(screen.getByRole('table')).toHaveTextContent('Business3,0001,000');
    });

    it('opens full screen', () => {
        renderBlock({ id: 'f', type: 'flow', config: blockCatalog.flow.example });
        fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
        expect(screen.getByRole('dialog')).toBeInTheDocument();
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('zooms a full-screen diagram with the buttons, the keys and the wheel, and fits again', () => {
        renderBlock({ id: 'f', type: 'flow', config: blockCatalog.flow.example });
        fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
        const dialog = within(screen.getByRole('dialog'));
        const viewport = dialog.getByRole('group', { name: 'flow f' });
        const content = instance(viewport.querySelector('.zoom-content'), HTMLElement);
        const level = dialog.getByRole('button', { name: 'Fit to screen' });
        expect(viewport).toHaveFocus();

        fireEvent.click(dialog.getByRole('button', { name: 'Zoom in' }));
        expect(level).toHaveTextContent('125%');
        expect(content.style.transform).toBe('scale(1.25)');
        fireEvent.keyDown(viewport, { key: '+' });
        expect(level).toHaveTextContent('156%');
        fireEvent.wheel(viewport, { deltaY: 100 });
        expect(level).toHaveTextContent('128%');
        fireEvent.wheel(viewport, { deltaY: -100, ctrlKey: true });
        expect(level).toHaveTextContent('156%');
        fireEvent.wheel(viewport, { deltaY: -1, deltaMode: WheelEvent.DOM_DELTA_LINE });
        expect(level).toHaveTextContent('167%');
        fireEvent.wheel(viewport, { deltaX: 100 });
        expect(level).toHaveTextContent('167%');

        fireEvent.keyDown(viewport, { key: '0' });
        expect(level).toHaveTextContent('100%');
        for (let press = 0; press < 10; press += 1) fireEvent.click(dialog.getByRole('button', { name: 'Zoom out' }));
        expect(level).toHaveTextContent('25%');
        expect(dialog.getByRole('button', { name: 'Zoom out' })).toBeDisabled();
    });

    it('zooming a diagram: the wheel keeps the point under the pointer still, scrolling stops at the edges, and 0 fits again', () => {
        // jsdom has no layout: an 800x600 viewport and a picture 1200 tall.
        measureAtOnce();
        const spies = [
            vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800),
            vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600),
            vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(1200)
        ];
        try {
            renderBlock({ id: 'f', type: 'flow', config: blockCatalog.flow.example });
            fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
            const dialog = within(screen.getByRole('dialog'));
            const viewport = dialog.getByRole('group', { name: 'flow f' });
            const sizer = instance(viewport.querySelector('.zoom-sizer'), HTMLElement);
            const level = dialog.getByRole('button', { name: 'Fit to screen' });
            expect(level).toHaveTextContent('50%');
            expect(sizer.style.width).toBe('400px');
            expect(sizer.style.height).toBe('600px');

            // The picture point under the pointer is (scroll + pointer) / scale: (0 + 200) / 0.5 across, (0 + 150) / 0.5 down.
            fireEvent.wheel(viewport, { deltaY: -100, clientX: 200, clientY: 150 });
            const scale = 0.5 * 1.002 ** 100;
            expect(level).toHaveTextContent('61%');
            expect((viewport.scrollLeft + 200) / scale).toBeCloseTo(400);
            expect((viewport.scrollTop + 150) / scale).toBeCloseTo(300);
            expect(parseFloat(sizer.style.width)).toBeCloseTo(800 * scale);
            expect(parseFloat(sizer.style.height)).toBeCloseTo(1200 * scale);

            fireEvent.keyDown(viewport, { key: '0' });
            expect(level).toHaveTextContent('50%');
            expect([viewport.scrollLeft, viewport.scrollTop]).toEqual([0, 0]);
            expect(sizer.style.width).toBe('400px');
        } finally {
            spies.forEach((spy) => spy.mockRestore());
        }
    });

    it('zooms a full-screen compare', () => {
        renderBlock({ id: 'c', type: 'compare', config: blockCatalog.compare.example });
        fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
        expect(within(screen.getByRole('dialog')).getByRole('toolbar', { name: 'Zoom' })).toBeInTheDocument();
    });

    it('keeps text blocks in the plain full screen, without zoom', () => {
        renderBlock({ id: 't', type: 'table', config: blockCatalog.table.example });
        fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
        expect(within(screen.getByRole('dialog')).queryByRole('toolbar', { name: 'Zoom' })).toBeNull();
    });

    it('comment on an image: a whole image, which has no text to select, takes a comment anchored to its block', async () => {
        const image = { id: 'img', type: 'image', config: blockCatalog.image.example };
        const store = storeWith(makeView({ blocks: [blockRecord(image.id, image.type, image.config)] }));
        renderWith(
            store,
            <>
                <BlockView block={image} placement="writeup" />
                <CommentLayer />
            </>,
            'writeup'
        );
        const user = userEvent.setup();
        await user.click(screen.getByRole('button', { name: 'Comment on this block' }));
        const composer = screen.getByRole('dialog', { name: 'Comment' });
        expect(within(composer).getByText('Comment on block:img')).toBeInTheDocument();
        await user.type(within(composer).getByLabelText('Comment'), 'Pin 2 is on the wrong field');
        await user.click(within(composer).getByRole('button', { name: 'Send to agent' }));
        await waitFor(() =>
            expect(posted).toEqual([
                {
                    type: 'comment.create',
                    anchor: { target: 'block:img' },
                    intent: 'question',
                    text: 'Pin 2 is on the wrong field'
                }
            ])
        );
    });

    it('offers no block comment outside the write-up', () => {
        renderWith(
            storeWith(makeView()),
            <BlockView block={{ id: 'f', type: 'flow', config: blockCatalog.flow.example }} placement="question" />
        );
        expect(screen.queryByRole('button', { name: 'Comment on this block' })).toBeNull();
    });

    it('parses a unified diff into lines numbered on both sides', () => {
        expect(
            parsePatch(defined(codeConfig.parse(blockCatalog.code.example).patch)).map((line) => [
                line.kind,
                line.oldNumber,
                line.number
            ])
        ).toEqual([
            ['hunk', undefined, undefined],
            ['context', 12, 12],
            ['remove', 13, undefined],
            ['add', undefined, 13],
            ['add', undefined, 14],
            ['context', 14, 15]
        ]);
    });

    it('chooses round axis ticks', () => {
        expect(niceTicks(4000)).toEqual([0, 1000, 2000, 3000, 4000]);
        expect(niceTicks(22)).toEqual([0, 10, 20, 30]);
        expect(niceTicks(100, 4, -37)).toEqual([-50, 0, 50, 100]);
        expect(niceTicks(0.3, 4, -0.3)).toEqual([-0.4, -0.2, 0, 0.2, 0.4]);
    });

    it('a line chart that crosses zero ticks at round values and draws its axis at 0', () => {
        renderBlock({
            id: 'l1',
            type: 'line',
            config: { x: ['a', 'b'], series: [{ name: 'A', values: [-37, 100] }], annotations: [], sample: false }
        });
        const ticks = [...document.querySelectorAll('.line-chart text[text-anchor="end"]')].map((text) => text.textContent);
        expect(ticks).toEqual(['-50', '0', '50', '100']);
        expect(document.querySelectorAll('.line-chart .axis-line')).toHaveLength(1);
        expect(document.querySelector('.line-chart .axis-line')?.parentElement).toHaveTextContent(/^0$/);
    });

    it('formats small numbers by their significant digits and shows a missing value as a hyphen', () => {
        expect(formatValue(0.0004)).toBe('0.0004');
        expect(formatValue(-0.000123456)).toBe('-0.000123');
        expect(formatValue(3000)).toBe('3,000');
        expect(formatValue(1234.5678)).toBe('1,234.568');
        expect(formatValue(0)).toBe('0');
        expect(formatValue(null)).toBe('-');
    });

    it('an image that failed to load tries again when the agent re-sends it with a new src', () => {
        const config = (src: string) => ({ src, alt: 'Dashboard', pins: [] });
        const { rerender } = render(<ImageBlock id="i1" config={config('asset:early.png')} placement="question" />);
        fireEvent.error(screen.getByRole('img', { name: 'Dashboard' }));
        expect(screen.getByText(/early\.png is not in the change/)).toBeInTheDocument();
        rerender(<ImageBlock id="i1" config={config('asset:landed.png')} placement="question" />);
        expect(screen.getByRole('img', { name: 'Dashboard' })).toHaveAttribute('src', expect.stringContaining('landed.png'));
        expect(screen.queryByText(/is not in the change/)).toBeNull();
    });
});

describe('diagram rendering', () => {
    it('curved edges: a two-point edge is straight, a longer one bends through its points and ends on the last', () => {
        expect(
            curvePath([
                { x: 0, y: 0 },
                { x: 10, y: 0 }
            ])
        ).toBe('M0,0 L10,0');
        const path = curvePath([
            { x: 0, y: 0 },
            { x: 30, y: 0 },
            { x: 30, y: 30 }
        ]);
        expect(path.startsWith('M0,0 L5,0 C')).toBe(true);
        expect(path.endsWith('L30,30')).toBe(true);
        renderBlock({ id: 'f', type: 'flow', config: blockCatalog.flow.example });
        expect(document.querySelectorAll('path.dg-edge')).toHaveLength(2);
        expect(document.querySelector('polyline')).toBeNull();
    });

    it('hover highlight: hovering a node fades all but it, its neighbours and the edges between them', () => {
        renderBlock({ id: 'f', type: 'flow', config: blockCatalog.flow.example });
        const node = (label: string) => defined([...document.querySelectorAll('.dg-node')].find((g) => g.textContent === label));
        fireEvent.mouseEnter(node('Client'));
        expect(document.querySelector('svg.diagram')).toHaveClass('has-focus');
        expect(node('Client')).toHaveClass('is-lit');
        expect(node('Limiter')).toHaveClass('is-lit');
        expect(node('Handler')).not.toHaveClass('is-lit');
        expect([...document.querySelectorAll('.dg-link')].map((link) => link.classList.contains('is-lit'))).toEqual([
            true,
            false
        ]);
        fireEvent.mouseLeave(node('Client'));
        expect(document.querySelector('svg.diagram')).not.toHaveClass('has-focus');
    });

    it("schema diagram: a relation joins the rows of the columns it names, with a crow's foot at the many end and a bar at the one", () => {
        const layout = layoutGraph(schemaGraph(schemaConfig.parse(blockCatalog.schema.example)));
        const keys = defined(layout.nodes.find((node) => node.id === 'api_keys'));
        const plans = defined(layout.nodes.find((node) => node.id === 'plans'));
        const edge = defined(layout.edges.find((candidate) => candidate.from === 'api_keys'));
        expect(edge.points[0]?.y).toBe(rowCentre(keys, 1));
        expect(edge.points[edge.points.length - 1]?.y).toBe(rowCentre(plans, 0));
        expect(edge.ends).toEqual({ start: 'many', end: 'one' });
        renderBlock({ id: 's', type: 'schema', config: blockCatalog.schema.example });
        const link = defined(document.querySelector('path.dg-edge'));
        expect(link.getAttribute('marker-start')).toMatch(/-many\)$/);
        expect(link.getAttribute('marker-end')).toMatch(/-one\)$/);
        expect([...document.querySelectorAll('.dg-row.is-added .dg-row-name')].map((row) => row.textContent)).toEqual([
            'rpm',
            'rpm_override'
        ]);
        expect(
            screen.getByRole('img', { name: /api_keys \(id, plan_id, rpm_override added\); limit_events added/ })
        ).toBeInTheDocument();
        expect(document.querySelector('.dg-node.is-new')).toHaveTextContent('limit_events');
    });

    it('c4 view: a person has a head, a database a lid, an external element is greyed, and each shows its kind and technology', () => {
        const graph = c4Graph(c4Config.parse(blockCatalog.c4.example));
        expect(graph.direction).toBe('TB');
        expect(graph.nodes.find((node) => node.id === 'gw')?.detail).toEqual(['[Container: Node, Express]']);
        expect(graph.nodes.find((node) => node.id === 'pager')).toMatchObject({
            tone: 'external',
            detail: ['[External software system]']
        });
        expect(graph.edges.find((edge) => edge.to === 'redis')?.label).toBe('takes a token [Lua]');
        renderBlock({ id: 'c', type: 'c4', config: blockCatalog.c4.example });
        expect(document.querySelectorAll('.dg-node circle')).toHaveLength(1);
        expect(document.querySelector('.dg-node.is-external')).toHaveTextContent('PagerDuty');
        expect(document.querySelector('.dg-group-label')).toHaveTextContent('API PLATFORM');
    });

    it('mind map: branches split left and right of the centre, siblings never overlap, and hovering a node lights the path to it', () => {
        const layout = layoutMindmap(mindmapConfig.parse(blockCatalog.mindmap.example));
        const [centre] = layout.nodes;
        const branches = layout.nodes.filter((node) => node.depth === 1);
        expect(branches.filter((node) => node.x > defined(centre).x)).toHaveLength(2);
        expect(branches.filter((node) => node.x < defined(centre).x)).toHaveLength(2);
        for (const side of [1, -1]) {
            const column = layout.nodes
                .filter((node) => node.depth === 2 && Math.sign(node.x - defined(centre).x) === side)
                .sort((a, b) => a.y - b.y);
            column.slice(1).forEach((node, index) => {
                const above = defined(column[index]);
                expect(node.y - node.height / 2).toBeGreaterThanOrEqual(above.y + above.height / 2);
            });
        }
        renderBlock({ id: 'm', type: 'mindmap', config: blockCatalog.mindmap.example });
        const leaf = defined([...document.querySelectorAll('.mm-node')].find((node) => node.textContent === 'Shadow mode'));
        fireEvent.mouseEnter(leaf);
        const lit = [...document.querySelectorAll('.mm-node.is-lit')].map((node) => node.textContent);
        expect(lit.sort()).toEqual(['Rate limiting', 'Rollout', 'Shadow mode']);
    });

    it('gantt chart: a task starts when the tasks it waits on end, else after the one before it, else at `at`', () => {
        const tasks = scheduleGantt(
            ganttConfig.parse({
                tasks: [
                    { id: 'a', label: 'A', group: 'Build', duration: 3 },
                    { id: 'b', label: 'B', group: 'Ship', duration: 2 },
                    { id: 'c', label: 'C', group: 'Build', duration: 4, at: 1 },
                    { id: 'd', label: 'D', group: 'Ship', duration: 0, after: ['b', 'c'] }
                ]
            })
        );
        expect(tasks.map((task) => [task.id, task.start, task.end, task.milestone])).toEqual([
            ['a', 0, 3, false],
            ['c', 1, 5, false],
            ['b', 3, 5, false],
            ['d', 5, 5, true]
        ]);
        expect(ganttTicks(38, '2026-10-05').map((tick) => tick.label)).toEqual([
            '5 Oct',
            '12 Oct',
            '19 Oct',
            '26 Oct',
            '2 Nov',
            '9 Nov'
        ]);
        expect(ganttTicks(10).map((tick) => tick.label)).toEqual(['Day 0', 'Day 2', 'Day 4', 'Day 6', 'Day 8', 'Day 10']);
        expect(ganttTicks(60).map((tick) => tick.label)).toEqual(['Week 0', 'Week 2', 'Week 4', 'Week 6', 'Week 8']);
        renderBlock({ id: 'g', type: 'gantt', config: blockCatalog.gantt.example });
        expect(document.querySelectorAll('.gantt-bar')).toHaveLength(4);
        expect(document.querySelectorAll('.gantt-milestone')).toHaveLength(1);
        expect(document.querySelectorAll('.gantt-link')).toHaveLength(4);
        fireEvent.click(screen.getByRole('button', { name: 'View as table' }));
        // The build ends on day 10, the day shadow mode, which waits on it, starts.
        expect(screen.getAllByRole('cell', { name: '15 Oct' })).toHaveLength(2);
    });

    it('sankey: a node is as big as what flows through it, columns run left to right, and hovering a node lights its flows', () => {
        const layout = layoutSankey(sankeyConfig.parse(blockCatalog.sankey.example));
        const node = (name: string) => defined(layout.nodes.find((candidate) => candidate.name === name));
        expect(node('Requests').value).toBe(9000);
        expect(node('Free').x0).toBeGreaterThan(node('Requests').x0);
        expect(node('Allowed').x0).toBeGreaterThan(node('Free').x0);
        expect(node('Allowed').labelLeft).toBe(true);
        renderBlock({ id: 'k', type: 'sankey', config: blockCatalog.sankey.example });
        expect(document.querySelectorAll('.sankey-link')).toHaveLength(8);
        const free = defined([...document.querySelectorAll('.sankey-node')].find((g) => g.textContent?.startsWith('Free')));
        fireEvent.mouseEnter(free);
        expect(document.querySelectorAll('.sankey-link.is-lit')).toHaveLength(3);
    });

    it('option matrix: options are columns, the recommended column is marked, and verdicts carry an icon and their word', () => {
        renderBlock({ id: 'o', type: 'optionMatrix', config: blockCatalog.optionMatrix.example });
        const headers = [...document.querySelectorAll('thead th')].map((th) => th.textContent);
        expect(headers).toEqual(['Criterion', 'Fail openRecommended', 'Fail closed', 'Local bucket']);
        expect(document.querySelectorAll('td.is-recommended')).toHaveLength(4);
        const bad = defined(document.querySelector('.verdict.is-bad'));
        expect(bad).toHaveTextContent('Redis down is an outage (bad)');
        expect(bad.querySelector('.verdict-icon svg')).not.toBeNull();
        expect(document.querySelectorAll('.dots')).toHaveLength(3);
        expect(screen.getByText('More dots = better.')).toBeInTheDocument();
    });

    it('a compare side without a label shows no heading', () => {
        const side = { block: { type: 'flow', config: blockCatalog.flow.example } };
        renderBlock({ id: 'cmp', type: 'compare', config: { left: side, right: { label: 'After', block: side.block } } });
        expect([...document.querySelectorAll('.compare-side .eyebrow')].map((label) => label.textContent)).toEqual(['After']);
    });
});
