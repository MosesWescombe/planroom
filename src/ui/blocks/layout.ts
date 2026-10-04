import { sankey, sankeyJustify, sankeyLinkHorizontal } from 'd3-sankey';
import dagre from 'dagre';
import type { BlockConfigs, MindmapBranch } from '../../shared/blocks';

/**
 * Diagram and chart layout: the agent gives nodes and edges, tasks or flows, and the page places them, with dagre for
 * graphs and d3-sankey for flows. Everything here is pure, so layouts are tested without a browser.
 */

export type NodeTone = 'plain' | 'new' | 'changed' | 'removed' | 'fallback' | 'external';
/** `table` is a schema table with its column rows; `person`, `database` and `queue` are C4 element shapes. */
export type NodeShape = 'box' | 'decision' | 'pill' | 'table' | 'person' | 'database' | 'queue';

/** A schema table's column as its node draws it. */
export interface TableRow {
    name: string;
    type?: string;
    keys: string[];
    change?: 'added' | 'changed' | 'removed';
}

/** How many sit at an end of a schema relation, drawn as a bar (one) or a crow's foot (many). */
export type EndMark = 'one' | 'many';

export interface LaidNode {
    id: string;
    lines: string[];
    x: number;
    y: number;
    width: number;
    height: number;
    shape: NodeShape;
    tone: NodeTone;
    /** Drawn with a heavier outline, e.g. a state machine's initial state. */
    strong?: boolean;
    /** Small lines under the label, e.g. a C4 element's kind, technology and description. */
    detail?: string[];
    /** A schema table's columns, drawn as rows under its name. */
    rows?: TableRow[];
}

export interface LaidEdge {
    id: string;
    from: string;
    to: string;
    points: { x: number; y: number }[];
    label?: string;
    labelAt?: { x: number; y: number };
    dashed: boolean;
    tone: 'plain' | 'fallback' | 'new' | 'removed';
    /** Schema relations mark how many sit at each end. */
    ends?: { start: EndMark; end: EndMark };
}

export interface LaidGroup {
    label: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface Layout {
    width: number;
    height: number;
    nodes: LaidNode[];
    edges: LaidEdge[];
    groups: LaidGroup[];
}

export interface GraphInput {
    direction: 'LR' | 'RL' | 'TB' | 'BT';
    nodes: {
        id: string;
        label: string;
        shape?: NodeShape;
        tone?: NodeTone;
        strong?: boolean;
        detail?: string[];
        rows?: TableRow[];
    }[];
    edges: {
        from: string;
        to: string;
        label?: string;
        dashed?: boolean;
        tone?: LaidEdge['tone'];
        ends?: LaidEdge['ends'];
        /** The rows of the end tables the edge joins, for a schema relation that names its columns. */
        fromRow?: number;
        toRow?: number;
    }[];
    groups?: { label: string; nodes: string[] }[];
}

/** Approximate advance width of a 12-13px sans character; labels are measured, not rendered. */
const CHAR_WIDTH = 7;
/** The same for the 11px detail text, and for 11px monospace. */
const SMALL_CHAR_WIDTH = 6.2;
const MONO_CHAR_WIDTH = 6.7;
const LINE_HEIGHT = 16;
const DETAIL_HEIGHT = 14;
const MAX_LINE = 24;
/** A schema table's heading band, and each column row under it. */
export const TABLE = { head: 30, row: 20, foot: 6 };
/** Room a C4 person's head takes above its box, and a database's lid. */
export const C4_SHAPE = { head: 26, lid: 10 };

/** A number for an SVG attribute, to a tenth of a pixel. */
const round = (value: number) => Math.round(value * 10) / 10;

/**
 * An SVG path through `points` as a uniform B-spline, the curve dagre's own renderer draws: it starts and ends on the
 * first and last points and bends smoothly through the ones between. Two points are a straight line.
 */
export function curvePath(points: readonly { x: number; y: number }[]): string {
    const [first, second] = points;
    if (!first) return '';
    if (!second || points.length === 2)
        return points.map((point, index) => `${index ? 'L' : 'M'}${round(point.x)},${round(point.y)}`).join(' ');
    const bezier = (a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }) =>
        `C${round((2 * a.x + b.x) / 3)},${round((2 * a.y + b.y) / 3)} ${round((a.x + 2 * b.x) / 3)},${round((a.y + 2 * b.y) / 3)} ${round((a.x + 4 * b.x + c.x) / 6)},${round((a.y + 4 * b.y + c.y) / 6)}`;
    const parts = [
        `M${round(first.x)},${round(first.y)}`,
        `L${round((5 * first.x + second.x) / 6)},${round((5 * first.y + second.y) / 6)}`
    ];
    let [a, b] = [first, second];
    for (const c of points.slice(2)) {
        parts.push(bezier(a, b, c));
        [a, b] = [b, c];
    }
    parts.push(bezier(a, b, b), `L${round(b.x)},${round(b.y)}`);
    return parts.join(' ');
}

/** Break a label into at most three lines of about MAX_LINE characters. */
export function wrapLabel(label: string, max = MAX_LINE): string[] {
    const words = label.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let line = '';
    for (const word of words) {
        if (line && `${line} ${word}`.length > max) {
            lines.push(line);
            line = word;
        } else {
            line = line ? `${line} ${word}` : word;
        }
    }
    if (line) lines.push(line);
    if (lines.length > 3)
        return [
            ...lines.slice(0, 2),
            `${lines
                .slice(2)
                .join(' ')
                .slice(0, max - 1)}…`
        ];
    return lines.length ? lines : [''];
}

/** Where a schema column's name starts: past the key marks when any row in its table has keys. */
export function rowNameAt(rows: readonly TableRow[]): number {
    return rows.some((row) => row.keys.length > 0) ? 40 : 12;
}

/** A schema column's width: the indent to its name, its 12px name, then its 11px monospace type and the right padding. */
function rowWidth(row: TableRow, nameAt: number): number {
    return nameAt + row.name.length * CHAR_WIDTH + (row.type ? 14 + row.type.length * MONO_CHAR_WIDTH : 0) + 10;
}

/**
 * The box a node needs: its label lines, then any detail lines or table rows. Pills have a wider minimum, diamonds
 * need room around the text, and a C4 person or database needs room for its head or lid.
 */
function sizeOf(
    lines: string[],
    shape: NodeShape,
    detail: string[] = [],
    rows: TableRow[] = []
): { width: number; height: number } {
    const longest = Math.max(...lines.map((line) => line.length));
    if (shape === 'table') {
        const width = Math.max(120, longest * CHAR_WIDTH + 28, ...rows.map((row) => rowWidth(row, rowNameAt(rows))));
        return { width, height: TABLE.head + rows.length * TABLE.row + TABLE.foot };
    }
    const detailWidth = Math.max(0, ...detail.map((line) => line.length * SMALL_CHAR_WIDTH + 28));
    const width = Math.max(shape === 'pill' ? 96 : 84, longest * CHAR_WIDTH + 32, detailWidth);
    const height = 24 + lines.length * LINE_HEIGHT + detail.length * DETAIL_HEIGHT + (detail.length ? 4 : 0);
    if (shape === 'decision') return { width: width + 28, height: height + 22 };
    if (shape === 'person') return { width: Math.max(width, 120), height: height + C4_SHAPE.head };
    if (shape === 'database') return { width, height: height + C4_SHAPE.lid * 2 };
    if (shape === 'queue') return { width: width + C4_SHAPE.lid * 2, height };
    return { width, height };
}

/** The y of a schema table's row `index`, at the middle of the row. */
export function rowCentre(node: Pick<LaidNode, 'y' | 'height'>, index: number): number {
    return node.y - node.height / 2 + TABLE.head + index * TABLE.row + TABLE.row / 2;
}

/**
 * Move an edge's end from where dagre left it, at the table's border, to the side of the row it joins: the side
 * facing the edge's next point, so the line leaves the column it names.
 */
function attachToRow(node: LaidNode, row: number, toward: { x: number; y: number }): { x: number; y: number } {
    const right = toward.x >= node.x;
    return { x: node.x + (right ? node.width / 2 : -node.width / 2), y: rowCentre(node, row) };
}

/**
 * The id a node goes by inside dagre. dagre 0.8 keeps nodes in plain objects, so an agent's id such as
 * `constructor` or `__proto__` would hit `Object.prototype`; a prefix keeps every id an own key.
 */
const inDagre = (id: string) => `n:${id}`;

/** Place a graph's nodes, edges and groups with dagre, shifted so the drawing starts at a small margin. */
export function layoutGraph(input: GraphInput): Layout {
    const graph = new dagre.graphlib.Graph({ compound: true, multigraph: true });
    graph.setGraph({ rankdir: input.direction, nodesep: 28, ranksep: 48, edgesep: 12, marginx: 12, marginy: 12 });
    graph.setDefaultEdgeLabel(() => ({}));
    const meta = new Map<string, Omit<LaidNode, 'id' | 'x' | 'y' | 'width' | 'height'>>();
    for (const node of input.nodes) {
        const shape = node.shape ?? 'box';
        // A table's name is one line: its rows set the width anyway.
        const lines = shape === 'table' ? [node.label] : wrapLabel(node.label);
        meta.set(node.id, {
            lines,
            shape,
            tone: node.tone ?? 'plain',
            ...(node.strong ? { strong: true } : {}),
            ...(node.detail?.length ? { detail: node.detail } : {}),
            ...(node.rows ? { rows: node.rows } : {})
        });
        graph.setNode(inDagre(node.id), sizeOf(lines, shape, node.detail, node.rows));
    }
    input.groups?.forEach((group, index) => {
        const id = `__group${index}`;
        graph.setNode(id, { label: group.label });
        for (const child of group.nodes) if (meta.has(child)) graph.setParent(inDagre(child), id);
    });
    input.edges.forEach((edge, index) => {
        if (!meta.has(edge.from) || !meta.has(edge.to)) return;
        const label = edge.label ? { label: edge.label, width: edge.label.length * 6.4 + 8, height: 14, labelpos: 'c' } : {};
        graph.setEdge(inDagre(edge.from), inDagre(edge.to), label, `e${index}`);
    });
    dagre.layout(graph);

    const nodes: LaidNode[] = input.nodes.map((node) => {
        const placed = graph.node(inDagre(node.id));
        const info = meta.get(node.id)!;
        return { id: node.id, x: placed.x, y: placed.y, width: placed.width, height: placed.height, ...info };
    });
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const edges: LaidEdge[] = [];
    input.edges.forEach((edge, index) => {
        const placed = graph.edge({ v: inDagre(edge.from), w: inDagre(edge.to), name: `e${index}` }) as
            | (dagre.GraphEdge & { x?: number; y?: number })
            | undefined;
        if (!placed) return;
        const points = placed.points.map(({ x, y }) => ({ x, y }));
        // dagre loops a self-edge around its node; only an edge between two tables moves to the rows it joins.
        if (edge.from !== edge.to && points.length >= 2) {
            const source = byId.get(edge.from)!;
            const target = byId.get(edge.to)!;
            if (edge.fromRow !== undefined) points[0] = attachToRow(source, edge.fromRow, points[1]!);
            if (edge.toRow !== undefined) points[points.length - 1] = attachToRow(target, edge.toRow, points[points.length - 2]!);
        }
        edges.push({
            id: `e${index}`,
            from: edge.from,
            to: edge.to,
            points,
            ...(edge.label ? { label: edge.label } : {}),
            ...(edge.label && placed.x !== undefined && placed.y !== undefined ? { labelAt: { x: placed.x, y: placed.y } } : {}),
            dashed: Boolean(edge.dashed),
            tone: edge.tone ?? (edge.dashed ? 'fallback' : 'plain'),
            ...(edge.ends ? { ends: edge.ends } : {})
        });
    });
    const groups: LaidGroup[] = (input.groups ?? []).flatMap((group, index) => {
        const placed = graph.node(`__group${index}`);
        if (!placed || placed.width === undefined) return [];
        // Room above the children for the group's label.
        return [
            {
                label: group.label,
                x: placed.x - placed.width / 2,
                y: placed.y - placed.height / 2 - 18,
                width: placed.width,
                height: placed.height + 18
            }
        ];
    });

    const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    const extend = (x: number, y: number) => {
        box.minX = Math.min(box.minX, x);
        box.minY = Math.min(box.minY, y);
        box.maxX = Math.max(box.maxX, x);
        box.maxY = Math.max(box.maxY, y);
    };
    for (const node of nodes) {
        extend(node.x - node.width / 2, node.y - node.height / 2);
        extend(node.x + node.width / 2, node.y + node.height / 2);
    }
    for (const edge of edges) {
        for (const point of edge.points) extend(point.x, point.y);
        if (edge.labelAt && edge.label) {
            extend(edge.labelAt.x - (edge.label.length * 6.4) / 2, edge.labelAt.y - 10);
            extend(edge.labelAt.x + (edge.label.length * 6.4) / 2, edge.labelAt.y + 10);
        }
    }
    for (const group of groups) {
        extend(group.x, group.y);
        extend(group.x + group.width, group.y + group.height);
    }
    // Shift everything so the drawing starts at a small margin.
    const dx = 4 - box.minX;
    const dy = 4 - box.minY;
    return {
        width: Math.ceil(box.maxX - box.minX + 8),
        height: Math.ceil(box.maxY - box.minY + 8),
        nodes: nodes.map((node) => ({ ...node, x: node.x + dx, y: node.y + dy })),
        edges: edges.map((edge) => ({
            ...edge,
            points: edge.points.map((point) => ({ x: point.x + dx, y: point.y + dy })),
            ...(edge.labelAt ? { labelAt: { x: edge.labelAt.x + dx, y: edge.labelAt.y + dy } } : {})
        })),
        groups: groups.map((group) => ({ ...group, x: group.x + dx, y: group.y + dy }))
    };
}

/** Node tones for a compare side: what the other side lacks is painted as added or removed. */
export function compareTones(
    own: readonly string[],
    other: readonly string[],
    side: 'left' | 'right',
    highlight: 'added' | 'removed' | 'both' | 'none'
): Map<string, NodeTone> {
    const tones = new Map<string, NodeTone>();
    const others = new Set(other);
    const paint =
        side === 'right' ? highlight === 'added' || highlight === 'both' : highlight === 'removed' || highlight === 'both';
    if (!paint) return tones;
    for (const id of own) if (!others.has(id)) tones.set(id, side === 'right' ? 'new' : 'removed');
    return tones;
}

/** A `flow` config as layout input. `tones`, for a compare side, override each node's emphasis. */
export function flowGraph(config: BlockConfigs['flow'], tones?: Map<string, NodeTone>): GraphInput {
    return {
        direction: config.direction,
        nodes: config.nodes.map((node) => ({
            id: node.id,
            label: node.label,
            shape: node.shape === 'decision' ? 'decision' : 'box',
            tone: tones?.get(node.id) ?? node.emphasis ?? 'plain'
        })),
        edges: config.edges.map((edge) => ({
            from: edge.from,
            to: edge.to,
            ...(edge.label ? { label: edge.label } : {}),
            dashed: edge.style === 'dashed'
        }))
    };
}

/**
 * A `state` config as layout input: pill states, the initial one strong, and states in `emphasis` with the transitions
 * into them in the fallback tone.
 */
export function stateGraph(config: BlockConfigs['state'], tones?: Map<string, NodeTone>): GraphInput {
    const emphasized = new Set(config.emphasis);
    return {
        direction: 'LR',
        nodes: config.states.map((state) => ({
            id: state,
            label: state,
            shape: 'pill',
            tone: tones?.get(state) ?? (emphasized.has(state) ? 'fallback' : 'plain'),
            strong: state === config.initial
        })),
        edges: config.transitions.map((transition) => ({
            from: transition.from,
            to: transition.to,
            ...(transition.on ? { label: transition.on } : {}),
            tone: emphasized.has(transition.to) ? 'fallback' : 'plain'
        }))
    };
}

/** An `architecture` config as layout input, groups included. `tones`, for a compare side, override each node's emphasis. */
export function architectureGraph(config: BlockConfigs['architecture'], tones?: Map<string, NodeTone>): GraphInput {
    return {
        direction: 'LR',
        nodes: config.nodes.map((node) => ({
            id: node.id,
            label: node.label,
            tone: tones?.get(node.id) ?? node.emphasis ?? 'plain'
        })),
        edges: config.links.map((link) => ({
            from: link.from,
            to: link.to,
            ...(link.label ? { label: link.label } : {}),
            dashed: link.style === 'dashed'
        })),
        groups: config.groups
    };
}

export interface SequenceLayout {
    width: number;
    height: number;
    actors: { label: string; x: number; width: number; tone: NodeTone }[];
    messages: { from: number; to: number; y: number; text: string; reply: boolean }[];
}

/** Actors in evenly spaced columns, one row per message. */
export function layoutSequence(config: BlockConfigs['sequence'], tones?: Map<string, NodeTone>): SequenceLayout {
    const widths = config.actors.map((actor) => Math.max(84, actor.length * CHAR_WIDTH + 24));
    const longestMessage = Math.max(0, ...config.messages.map((message) => message.text.length * 6.4 + 16));
    const column = Math.max(...widths, longestMessage, 110) + 24;
    const actors = config.actors.map((label, index) => ({
        label,
        x: 8 + column / 2 + index * column,
        width: widths[index]!,
        tone: tones?.get(label) ?? 'plain'
    }));
    const top = 60;
    const messages = config.messages.map((message, index) => ({
        ...message,
        y: top + index * 34,
        reply: Boolean(message.reply)
    }));
    return { width: 16 + column * config.actors.length, height: top + config.messages.length * 34 + 8, actors, messages };
}

/** The node tone a schema `change` paints. */
const CHANGE_TONE = { added: 'new', changed: 'changed', removed: 'removed' } as const;

/** The marks a schema relation's cardinality draws at its `from` and `to` ends. */
const CARDINALITY_ENDS: Record<BlockConfigs['schema']['relations'][number]['cardinality'], { start: EndMark; end: EndMark }> = {
    'many-to-one': { start: 'many', end: 'one' },
    'one-to-one': { start: 'one', end: 'one' },
    'one-to-many': { start: 'one', end: 'many' },
    'many-to-many': { start: 'many', end: 'many' }
};

/** A `schema` config as layout input: tables as nodes with their column rows, relations joining the rows they name. */
export function schemaGraph(config: BlockConfigs['schema']): GraphInput {
    const rowOf = (tableId: string, column?: string) => {
        if (column === undefined) return undefined;
        const index = config.tables.find((table) => table.id === tableId)?.columns.findIndex((entry) => entry.name === column);
        return index === undefined || index < 0 ? undefined : index;
    };
    return {
        direction: 'LR',
        nodes: config.tables.map((table) => ({
            id: table.id,
            label: table.name ?? table.id,
            shape: 'table',
            tone: table.change ? CHANGE_TONE[table.change] : 'plain',
            rows: table.columns.map((column) => ({
                name: column.name,
                ...(column.type ? { type: column.type } : {}),
                keys: column.keys ?? [],
                ...(column.change ? { change: column.change } : {})
            }))
        })),
        edges: config.relations.map((relation) => {
            const fromRow = rowOf(relation.from, relation.fromColumn);
            const toRow = rowOf(relation.to, relation.toColumn);
            return {
                from: relation.from,
                to: relation.to,
                ...(relation.label ? { label: relation.label } : {}),
                dashed: relation.change === 'removed',
                tone: relation.change === 'added' ? 'new' : relation.change === 'removed' ? 'removed' : 'plain',
                ends: CARDINALITY_ENDS[relation.cardinality],
                ...(fromRow !== undefined ? { fromRow } : {}),
                ...(toRow !== undefined ? { toRow } : {})
            };
        })
    };
}

/** How a C4 element's kind reads in its detail line, and the shape it draws. */
const C4_KINDS = {
    person: { name: 'Person', shape: 'person' },
    system: { name: 'Software system', shape: 'box' },
    container: { name: 'Container', shape: 'box' },
    component: { name: 'Component', shape: 'box' },
    database: { name: 'Database', shape: 'database' },
    queue: { name: 'Queue', shape: 'queue' }
} as const;

/**
 * A `c4` config as layout input, top to bottom as C4 views are read: each element's kind and technology, then its
 * description, as detail lines; boundaries as groups. An external element is greyed unless it is emphasised.
 */
export function c4Graph(config: BlockConfigs['c4']): GraphInput {
    return {
        direction: 'TB',
        nodes: config.elements.map((element) => {
            const kind = C4_KINDS[element.kind];
            const external = element.external ? 'External ' : '';
            const name = external ? `${external}${kind.name.charAt(0).toLowerCase()}${kind.name.slice(1)}` : kind.name;
            return {
                id: element.id,
                label: element.label,
                shape: kind.shape,
                tone: element.emphasis ?? (element.external ? 'external' : 'plain'),
                strong: true,
                detail: [
                    `[${name}${element.technology ? `: ${element.technology}` : ''}]`,
                    ...(element.description ? wrapLabel(element.description, 30) : [])
                ]
            };
        }),
        edges: config.relations.map((relation) => {
            const label = [relation.label, relation.technology && `[${relation.technology}]`].filter(Boolean).join(' ');
            return { from: relation.from, to: relation.to, ...(label ? { label } : {}) };
        }),
        groups: config.boundaries.map((boundary) => ({ label: boundary.label, nodes: boundary.elements }))
    };
}

// ---------------------------------------------------------------- mind maps

export interface MindmapNode {
    id: string;
    lines: string[];
    x: number;
    y: number;
    width: number;
    height: number;
    /** 0 for the centre, 1 for a top-level branch, and so on. */
    depth: number;
    /** The top-level branch it hangs from, which sets its colour; -1 for the centre. */
    branch: number;
    emphasis?: 'new' | 'changed';
    /** Ids of the node's ancestors, nearest first, for highlighting the path to it. */
    ancestors: string[];
}

export interface MindmapLayout {
    width: number;
    height: number;
    nodes: MindmapNode[];
    links: { from: string; to: string; branch: number; path: string }[];
}

/** Gaps between a mind map's columns, and between siblings stacked in one. */
const MINDMAP = { column: 40, sibling: 10 };

interface TreeNode {
    id: string;
    label: string;
    emphasis?: 'new' | 'changed';
    children: TreeNode[];
}

/**
 * A mind map: the centre in the middle, its branches split left and right by size, each side a tidy tree in which a
 * node sits beside the middle of its children and siblings stack without overlapping.
 */
export function layoutMindmap(config: BlockConfigs['mindmap']): MindmapLayout {
    const toTree = (branch: MindmapBranch, id: string): TreeNode => ({
        id,
        label: branch.label,
        ...(branch.emphasis ? { emphasis: branch.emphasis } : {}),
        children: (branch.children ?? []).map((child, index) => toTree(child, `${id}.${index}`))
    });
    const root = toTree(config, 'm');
    const size = (node: TreeNode, depth: number) => {
        const lines = wrapLabel(node.label, depth === 0 ? 20 : 22);
        const longest = Math.max(...lines.map((line) => line.length));
        return depth === 0
            ? { lines, width: Math.max(96, longest * 8 + 40), height: 20 + lines.length * 18 }
            : { lines, width: Math.max(56, longest * CHAR_WIDTH + 24), height: 12 + lines.length * LINE_HEIGHT };
    };
    const leaves = (node: TreeNode): number =>
        node.children.length ? node.children.reduce((sum, child) => sum + leaves(child), 0) : 1;

    // The first branches go right and the rest left, split where the two sides' leaf counts come closest.
    const total = leaves(root);
    let best = { split: root.children.length, gap: Infinity };
    let prefix = 0;
    root.children.forEach((child, index) => {
        prefix += leaves(child);
        const gap = Math.abs(total - 2 * prefix);
        if (index < root.children.length - 1 && gap < best.gap) best = { split: index + 1, gap };
    });
    const sides = root.children.map((_, index) => (index < best.split ? 1 : -1));

    const placed: MindmapNode[] = [];
    const links: MindmapLayout['links'] = [];
    const centre = size(root, 0);
    placed.push({ id: root.id, ...centre, x: 0, y: 0, depth: 0, branch: -1, ancestors: [] });

    for (const side of [1, -1] as const) {
        const branches = root.children.flatMap((child, index) => (sides[index] === side ? [{ child, index }] : []));
        if (!branches.length) continue;
        // Each column is as wide as its widest node, so a column's nodes line up on their inner edge.
        const widths: number[] = [];
        const measure = (node: TreeNode, depth: number) => {
            widths[depth] = Math.max(widths[depth] ?? 0, size(node, depth).width);
            node.children.forEach((child) => measure(child, depth + 1));
        };
        branches.forEach(({ child }) => measure(child, 1));
        const inner: number[] = [];
        let edge = centre.width / 2 + MINDMAP.column;
        for (let depth = 1; depth < widths.length; depth += 1) {
            inner[depth] = edge;
            edge += widths[depth]! + MINDMAP.column;
        }
        // The height a list of siblings takes stacked, and the height a node's subtree takes: never less than the node.
        const stacked = (nodes: readonly TreeNode[], depth: number): number =>
            nodes.reduce((sum, node) => sum + span(node, depth), 0) + MINDMAP.sibling * Math.max(0, nodes.length - 1);
        const span = (node: TreeNode, depth: number): number =>
            Math.max(size(node, depth).height, stacked(node.children, depth + 1));
        const place = (node: TreeNode, depth: number, top: number, branch: number, ancestors: string[]) => {
            const own = size(node, depth);
            const height = span(node, depth);
            const x = side * (inner[depth]! + own.width / 2);
            placed.push({
                id: node.id,
                ...own,
                x,
                y: top + height / 2,
                depth,
                branch,
                ...(node.emphasis ? { emphasis: node.emphasis } : {}),
                ancestors
            });
            let childTop = top + (height - stacked(node.children, depth + 1)) / 2;
            for (const child of node.children) {
                place(child, depth + 1, childTop, branch, [node.id, ...ancestors]);
                childTop += span(child, depth + 1) + MINDMAP.sibling;
            }
        };
        let top =
            -stacked(
                branches.map(({ child }) => child),
                1
            ) / 2;
        for (const { child, index } of branches) {
            place(child, 1, top, index, [root.id]);
            top += span(child, 1) + MINDMAP.sibling;
        }
    }

    // Shift the drawing to start at a small margin, then join each node to its parent.
    const minX = Math.min(...placed.map((node) => node.x - node.width / 2)) - 8;
    const minY = Math.min(...placed.map((node) => node.y - node.height / 2)) - 8;
    const maxX = Math.max(...placed.map((node) => node.x + node.width / 2)) + 8;
    const maxY = Math.max(...placed.map((node) => node.y + node.height / 2)) + 8;
    // The centre sits at x 0 before the shift, so a node's side is the sign of its x.
    const nodes = placed.map((node) => ({ ...node, x: node.x - minX, y: node.y - minY, side: Math.sign(node.x) || 1 }));
    const byId = new Map(nodes.map((node) => [node.id, node]));
    for (const node of nodes) {
        const parent = node.ancestors[0] === undefined ? undefined : byId.get(node.ancestors[0]);
        if (!parent) continue;
        // From the parent's outer edge to the child's inner edge, leaving and arriving level.
        const x1 = parent.x + (node.side * parent.width) / 2;
        const x2 = node.x - (node.side * node.width) / 2;
        const middle = (x1 + x2) / 2;
        links.push({
            from: parent.id,
            to: node.id,
            branch: node.branch,
            path: `M${round(x1)},${round(parent.y)} C${round(middle)},${round(parent.y)} ${round(middle)},${round(node.y)} ${round(x2)},${round(node.y)}`
        });
    }
    return {
        width: Math.ceil(maxX - minX),
        height: Math.ceil(maxY - minY),
        nodes: nodes.map(({ side: _side, ...node }) => node),
        links
    };
}

// ---------------------------------------------------------------- gantt charts

export interface ScheduledTask {
    id: string;
    label: string;
    group?: string;
    /** Days from the start. */
    start: number;
    end: number;
    milestone: boolean;
    status?: 'done' | 'active';
    /** The tasks it waits on, by id. */
    after: string[];
}

/**
 * Each task's start and end in days: at `at`, else when every task in `after` ends, else when the task before it
 * ends. The schema only lets `after` name earlier tasks, so one pass in list order settles every task. Tasks come
 * back grouped, each group where its first task was, tasks in list order within it.
 */
export function scheduleGantt(config: BlockConfigs['gantt']): ScheduledTask[] {
    const ends = new Map<string, number>();
    let previousEnd = 0;
    const scheduled = config.tasks.map((task): ScheduledTask => {
        const start = task.at ?? (task.after ? Math.max(...task.after.map((id) => ends.get(id) ?? 0)) : previousEnd);
        const end = start + task.duration;
        ends.set(task.id, end);
        previousEnd = end;
        return {
            id: task.id,
            label: task.label,
            ...(task.group ? { group: task.group } : {}),
            start,
            end,
            milestone: task.duration === 0,
            ...(task.status ? { status: task.status } : {}),
            after: task.after ?? []
        };
    });
    const groups = [...new Set(scheduled.map((task) => task.group))];
    return groups.flatMap((group) => scheduled.filter((task) => task.group === group));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The calendar date `days` after `start` (`YYYY-MM-DD`), as "5 Oct". */
export function dayLabel(start: string, days: number): string {
    const date = new Date(Date.parse(`${start}T00:00:00Z`) + Math.round(days) * 86_400_000);
    return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

/**
 * Axis ticks over `span` days at a calendar-friendly step: days, a fortnight, weeks of four, quarters. Labelled as
 * dates from `start` when there is one, else as days or weeks from the start.
 */
export function ganttTicks(span: number, start?: string): { day: number; label: string }[] {
    const step = [1, 2, 7, 14, 28, 56, 91, 182, 364].find((candidate) => span / candidate <= 8) ?? 728;
    const ticks: { day: number; label: string }[] = [];
    for (let day = 0; day <= span + 1e-9; day += step) {
        ticks.push({ day, label: start ? dayLabel(start, day) : step < 7 ? `Day ${day}` : `Week ${day / 7}` });
    }
    return ticks;
}

// ---------------------------------------------------------------- sankey diagrams

export interface SankeyLayout {
    width: number;
    height: number;
    nodes: { name: string; x0: number; x1: number; y0: number; y1: number; value: number; colour: number; labelLeft: boolean }[];
    links: { from: string; to: string; value: number; width: number; path: string; colour: number }[];
}

/** A sankey's drawing width, matching the line chart's, and the space each node gets in its column. */
const SANKEY = { width: 560, nodeWidth: 12, padding: 14, perNode: 40, minHeight: 160 };

/**
 * Flows laid out by d3-sankey: columns follow the flows left to right, sinks justified to the last column, and each
 * node as tall as the larger of what flows in and out. A link takes its source's colour; a label sits beside its node,
 * on the left for the last column so it stays inside the drawing.
 */
export function layoutSankey(config: BlockConfigs['sankey']): SankeyLayout {
    const names = [...new Set(config.flows.flatMap((flow) => [flow.from, flow.to]))];
    const run = (height: number) =>
        sankey<{ name: string }, { value: number }>()
            .nodeId((node) => node.name)
            .nodeWidth(SANKEY.nodeWidth)
            .nodePadding(SANKEY.padding)
            .nodeAlign(sankeyJustify)
            .extent([
                [1, 4],
                [SANKEY.width - 1, height - 4]
            ])({
            nodes: names.map((name) => ({ name })),
            links: config.flows.map((flow) => ({ source: flow.from, target: flow.to, value: flow.value }))
        });
    // A first pass finds the columns; the drawing is then tall enough for the fullest one.
    const columns = new Map<number, number>();
    for (const node of run(SANKEY.minHeight).nodes) columns.set(node.depth ?? 0, (columns.get(node.depth ?? 0) ?? 0) + 1);
    const height = Math.max(SANKEY.minHeight, Math.max(...columns.values()) * SANKEY.perNode);
    const graph = run(height);
    const colourOf = new Map(names.map((name, index) => [name, index % 6]));
    const nameOf = (end: unknown) => (typeof end === 'object' && end !== null && 'name' in end ? String(end.name) : String(end));
    const link = sankeyLinkHorizontal();
    return {
        width: SANKEY.width,
        height,
        nodes: graph.nodes.map((node) => ({
            name: node.name,
            x0: node.x0 ?? 0,
            x1: node.x1 ?? 0,
            y0: node.y0 ?? 0,
            y1: node.y1 ?? 0,
            value: node.value ?? 0,
            colour: colourOf.get(node.name) ?? 0,
            labelLeft: (node.x0 ?? 0) > SANKEY.width / 2
        })),
        links: graph.links.map((entry) => ({
            from: nameOf(entry.source),
            to: nameOf(entry.target),
            value: entry.value,
            width: Math.max(1, entry.width ?? 1),
            path: link(entry) ?? '',
            colour: colourOf.get(nameOf(entry.source)) ?? 0
        }))
    };
}
