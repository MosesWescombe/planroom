import { describe, expect, it } from 'vitest';
import { blockCatalog } from './blockCatalog.js';
import { block, blockTypes, type BlockType, checkBlockConfig, recordId } from './blocks.js';

/** One broken config per type, and the field path its first error must name. */
const broken: Record<BlockType, { config: Record<string, unknown>; path: string }> = {
    text: { config: { body: '' }, path: 'body' },
    callout: { config: { tone: 'decision' }, path: 'title' },
    checklist: { config: { items: [] }, path: 'items' },
    table: { config: { columns: ['A', 'B'], rows: [['a', 'b'], ['only one']] }, path: 'rows[1]' },
    stats: { config: { items: [1, 2, 3, 4, 5].map((n) => ({ label: `L${n}`, value: n })) }, path: 'items' },
    flow: {
        config: {
            nodes: [{ id: 'a', label: 'A' }],
            edges: [
                { from: 'a', to: 'a' },
                { from: 'a', to: 'x' }
            ]
        },
        path: 'edges[1].to'
    },
    sequence: { config: { actors: ['A', 'B'], messages: [{ from: 5, to: 1, text: 'hi' }] }, path: 'messages[0].from' },
    architecture: {
        config: { groups: [{ label: 'G', nodes: ['a', 'ghost'] }], nodes: [{ id: 'a', label: 'A' }], links: [] },
        path: 'groups[0].nodes[1]'
    },
    state: { config: { initial: 'nowhere', states: ['a'], transitions: [] }, path: 'initial' },
    schema: {
        config: {
            tables: [{ id: 'devices', columns: [{ name: 'id' }] }],
            relations: [{ from: 'devices', fromColumn: 'farm_id', to: 'devices' }]
        },
        path: 'relations[0].fromColumn'
    },
    c4: {
        config: {
            elements: [{ id: 'api', kind: 'container', label: 'API' }],
            boundaries: [{ label: 'Platform', elements: ['api', 'ghost'] }],
            relations: []
        },
        path: 'boundaries[0].elements[1]'
    },
    mindmap: {
        config: {
            label: 'Root',
            children: [
                {
                    label: 'a',
                    children: [{ label: 'b', children: [{ label: 'c', children: [{ label: 'd', children: [{ label: 'e' }] }] }] }]
                }
            ]
        },
        path: 'children[0].children[0].children[0].children[0].children[0]'
    },
    compare: { config: { right: { label: 'After', block: 'flow-1' } }, path: 'left' },
    timeline: { config: { current: 5, steps: [{ label: 'One' }] }, path: 'current' },
    gantt: {
        config: {
            tasks: [
                { id: 'a', label: 'A', duration: 2, after: ['b'] },
                { id: 'b', label: 'B', duration: 1 }
            ]
        },
        path: 'tasks[0].after[0]'
    },
    bar: { config: { series: ['S'], data: [['Free', 1, 2]] }, path: 'data[0]' },
    line: { config: { x: ['a', 'b'], series: [{ name: 'S', values: [1] }] }, path: 'series[0].values' },
    sankey: {
        config: {
            flows: [
                { from: 'A', to: 'B', value: 1 },
                { from: 'B', to: 'A', value: 1 }
            ]
        },
        path: 'flows[1]'
    },
    riskMatrix: { config: { items: [{ label: 'R', likelihood: 4, impact: 1 }] }, path: 'items[0].likelihood' },
    optionMatrix: {
        config: { options: ['A', 'B'], rows: [{ criterion: 'Cost', cells: [1] }], recommended: 5 },
        path: 'rows[0].cells'
    },
    fileTree: { config: { files: [] }, path: 'files' },
    code: { config: { mode: 'excerpt', file: 'src/a.ts' }, path: 'lines' },
    image: { config: { src: 'https://example.com/a.png', alt: 'A' }, path: 'src' },
    mermaid: { config: { source: '' }, path: 'source' }
};

describe('block catalog', () => {
    it('has the handoff catalog of 18 types, text, and the schema, c4, mindmap, gantt and sankey diagrams', () => {
        expect(blockTypes).toHaveLength(24);
        expect(Object.keys(blockCatalog).sort()).toEqual([...blockTypes].sort());
    });

    it.each(blockTypes)('the %s example parses', (type) => {
        const check = checkBlockConfig(type, blockCatalog[type].example);
        expect(check.ok ? [] : check.issues).toEqual([]);
        expect(block.safeParse({ id: 'b1', type, config: blockCatalog[type].example }).success).toBe(true);
    });

    it.each(blockTypes)('a broken %s config fails with a field path', (type) => {
        const check = checkBlockConfig(type, broken[type].config);
        expect(check.ok).toBe(false);
        if (!check.ok) {
            expect(check.reason).toBe('invalid');
            expect(check.issues.map((issue) => issue.path)).toContain(broken[type].path);
        }
    });

    it('flow block with an edge to a missing node reports the edge path', () => {
        const check = checkBlockConfig('flow', broken.flow.config);
        expect(check).toMatchObject({ ok: false, issues: [{ path: 'edges[1].to', message: 'node "x" is not defined' }] });
    });

    it('reports an unknown type rather than guessing', () => {
        expect(checkBlockConfig('sparkline', {})).toMatchObject({ ok: false, reason: 'unknown-type' });
    });

    it('rejects duplicate node ids and a node in two groups', () => {
        const flow = checkBlockConfig('flow', {
            nodes: [
                { id: 'a', label: 'A' },
                { id: 'a', label: 'B' }
            ],
            edges: []
        });
        expect(flow.ok ? [] : flow.issues.map((issue) => issue.path)).toEqual(['nodes[1].id']);
        const arch = checkBlockConfig('architecture', {
            groups: [
                { label: 'One', nodes: ['a'] },
                { label: 'Two', nodes: ['a'] }
            ],
            nodes: [{ id: 'a', label: 'A' }],
            links: []
        });
        expect(arch.ok ? [] : arch.issues.map((issue) => issue.path)).toEqual(['groups[1].nodes[0]']);
    });

    it('keeps markup as a plain string: text is never interpreted by the schema', () => {
        const check = checkBlockConfig('callout', { tone: 'note', body: '<img src=x onerror=alert(1)>' });
        expect(check).toMatchObject({ ok: true, config: { body: '<img src=x onerror=alert(1)>' } });
    });

    it('rejects code excerpts outside the repo', () => {
        const check = checkBlockConfig('code', { mode: 'excerpt', file: '../etc/passwd', lines: '1' });
        expect(check.ok ? [] : check.issues.map((issue) => issue.path)).toContain('file');
    });
});

describe('the diagram and chart schemas', () => {
    it('a gantt task waits only on tasks listed before it, and takes `at` or `after`, never both', () => {
        const check = checkBlockConfig('gantt', {
            tasks: [
                { id: 'a', label: 'A', duration: 1 },
                { id: 'b', label: 'B', duration: 1, at: 2, after: ['a'] },
                { id: 'c', label: 'C', duration: 1, after: ['ghost'] }
            ]
        });
        expect(check.ok ? [] : check.issues).toEqual([
            { path: 'tasks[1].after', message: 'give `at` or `after`, not both' },
            { path: 'tasks[2].after[0]', message: 'task "ghost" is not defined' }
        ]);
    });

    it.each(['2026-02-30', '2026-13-01', '5 Oct'])('a gantt start of "%s" is refused', (start) => {
        const check = checkBlockConfig('gantt', { start, tasks: [{ id: 'a', label: 'A', duration: 1 }] });
        expect(check.ok ? [] : check.issues.map((issue) => issue.path)).toEqual(['start']);
    });

    it('a sankey refuses a flow back to its own node, a repeated pair, and a flow that closes a longer loop', () => {
        const check = checkBlockConfig('sankey', {
            flows: [
                { from: 'A', to: 'A', value: 1 },
                { from: 'A', to: 'B', value: 1 },
                { from: 'A', to: 'B', value: 2 },
                { from: 'B', to: 'C', value: 1 },
                { from: 'C', to: 'A', value: 1 }
            ]
        });
        expect(check.ok ? [] : check.issues.map((issue) => issue.path)).toEqual(['flows[0].to', 'flows[2]', 'flows[4]']);
    });

    it('a schema relation names defined tables and, when it names columns, columns those tables have', () => {
        const check = checkBlockConfig('schema', {
            tables: [
                { id: 'readings', columns: [{ name: 'device_id' }, { name: 'device_id' }] },
                { id: 'devices', columns: [{ name: 'id', keys: ['pk'] }] }
            ],
            relations: [
                { from: 'readings', fromColumn: 'device_id', to: 'devices', toColumn: 'uuid' },
                { from: 'readings', to: 'farms' }
            ]
        });
        expect(check.ok ? [] : check.issues.map((issue) => issue.path)).toEqual([
            'tables[0].columns[1].name',
            'relations[1].to',
            'relations[0].toColumn'
        ]);
    });

    it('a mind map holds at most 80 nodes', () => {
        const leaves = Array.from({ length: 10 }, (_, index) => ({ label: `leaf ${index}` }));
        const check = checkBlockConfig('mindmap', {
            label: 'Root',
            children: Array.from({ length: 8 }, (_, index) => ({ label: `branch ${index}`, children: leaves }))
        });
        expect(check).toMatchObject({ ok: false, issues: [{ path: 'children', message: 'has 89 nodes; at most 80' }] });
    });

    it('an option matrix cell is a score, text, or text with a verdict', () => {
        const check = checkBlockConfig('optionMatrix', {
            options: ['A', 'B'],
            rows: [{ criterion: 'Cost', cells: [4, { text: 'Cheap', verdict: 'great' }] }]
        });
        expect(check.ok ? [] : check.issues.map((issue) => issue.path)).toEqual(['rows[0].cells[0]', 'rows[0].cells[1]']);
    });

    it('a compare side needs no label', () => {
        const side = { block: { type: 'flow', config: blockCatalog.flow.example } };
        expect(checkBlockConfig('compare', { left: side, right: side }).ok).toBe(true);
    });
});

describe('record ids', () => {
    it.each(['constructor', 'toString', 'valueOf', 'hasOwnProperty'])(
        'rejects "%s", which names an Object.prototype member',
        (id) => {
            expect(recordId.safeParse(id).success).toBe(false);
        }
    );

    it('still accepts ids that only contain such a name', () => {
        expect(recordId.safeParse('constructor-notes').success).toBe(true);
    });
});

describe('checklist item keys', () => {
    it('an explicit item id cannot take the position key of an item without one', () => {
        const check = checkBlockConfig('checklist', { items: [{ id: '1', text: 'A' }, { text: 'B' }] });
        expect(check).toMatchObject({ ok: false, issues: [{ path: 'items[0].id' }] });
    });
});
