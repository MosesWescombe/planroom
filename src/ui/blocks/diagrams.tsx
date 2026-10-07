import { type ReactNode, useMemo, useRef, useState } from 'react';
import { type BlockConfigs, checkBlockConfig, type DiagramType, diagramTypes } from '../../shared/blocks';
import { useRecord } from '../store';
import type { BlockProps } from './Block';
import { CodeBlock, ImageBlock } from './basic';
import {
    architectureGraph,
    C4_SHAPE,
    c4Graph,
    compareTones,
    curvePath,
    flowGraph,
    type LaidEdge,
    type LaidNode,
    type Layout,
    layoutGraph,
    layoutMindmap,
    layoutSequence,
    type MindmapLayout,
    type NodeTone,
    rowCentre,
    rowNameAt,
    type SequenceLayout,
    schemaGraph,
    stateGraph,
    TABLE
} from './layout';
import { type Pins, usePins } from './pins';

let diagramCount = 0;

/** Marker ids for one diagram: they must be unique in the document. */
interface MarkerIds {
    plain: string;
    fallback: string;
    one: string;
    many: string;
}

/** A per-instance prefix for SVG marker ids, which must be unique in the document. */
function useMarkerIds(): MarkerIds {
    const ref = useRef<string>(undefined);
    if (!ref.current) {
        diagramCount += 1;
        ref.current = `dg${diagramCount}`;
    }
    return {
        plain: `${ref.current}-arrow`,
        fallback: `${ref.current}-arrow-fallback`,
        one: `${ref.current}-one`,
        many: `${ref.current}-many`
    };
}

/**
 * The marks a diagram's edges end in: the plain and fallback arrowheads, and a schema relation's bar for "one" and
 * crow's foot for "many". Each points along its edge, so one shape serves either end.
 */
function Markers({ ids }: { ids: MarkerIds }) {
    return (
        <defs>
            <marker
                id={ids.plain}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
            >
                <path d="M0 0L10 5L0 10z" className="dg-arrow" />
            </marker>
            <marker
                id={ids.fallback}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
            >
                <path d="M0 0L10 5L0 10z" className="dg-arrow is-fallback" />
            </marker>
            <marker
                id={ids.one}
                viewBox="0 0 12 12"
                refX="12"
                refY="6"
                markerWidth="9"
                markerHeight="9"
                orient="auto-start-reverse"
            >
                <path d="M7 1V11" className="dg-end" />
            </marker>
            <marker
                id={ids.many}
                viewBox="0 0 12 12"
                refX="12"
                refY="6"
                markerWidth="9"
                markerHeight="9"
                orient="auto-start-reverse"
            >
                <path d="M2 6L12 1M2 6H12M2 6L12 11" className="dg-end" />
            </marker>
        </defs>
    );
}

/** The ids of a node and every node one edge away from it. */
function neighbours(layout: Layout, id: string): Set<string> {
    const near = new Set([id]);
    for (const edge of layout.edges) {
        if (edge.from === id) near.add(edge.to);
        if (edge.to === id) near.add(edge.from);
    }
    return near;
}

/** Where an edge's line ends: an arrowhead, or for a schema relation the mark of how many sit at each end. */
function edgeMarkers(edge: LaidEdge, ids: MarkerIds): { markerStart?: string; markerEnd: string } {
    if (edge.ends) return { markerStart: `url(#${ids[edge.ends.start]})`, markerEnd: `url(#${ids[edge.ends.end]})` };
    return { markerEnd: `url(#${edge.tone === 'fallback' ? ids.fallback : ids.plain})` };
}

/** A node's outline: a box, pill, diamond, or a C4 person (a head over a box), database (a cylinder) or queue. */
function NodeShapeOf({ node }: { node: LaidNode }) {
    const left = node.x - node.width / 2;
    const top = node.y - node.height / 2;
    const right = left + node.width;
    const bottom = top + node.height;
    const lid = C4_SHAPE.lid;
    switch (node.shape) {
        case 'decision':
            return (
                <polygon
                    className="dg-shape"
                    points={`${node.x},${top} ${right},${node.y} ${node.x},${bottom} ${left},${node.y}`}
                />
            );
        case 'person':
            return (
                <>
                    <circle className="dg-shape" cx={node.x} cy={top + 11} r={10} />
                    <rect
                        className="dg-shape"
                        x={left}
                        y={top + C4_SHAPE.head}
                        width={node.width}
                        height={node.height - C4_SHAPE.head}
                        rx={14}
                    />
                </>
            );
        case 'database': {
            const rx = node.width / 2;
            return (
                <>
                    <path
                        className="dg-shape"
                        d={`M${left},${top + lid} A${rx},${lid} 0 0 1 ${right},${top + lid} V${bottom - lid} A${rx},${lid} 0 0 1 ${left},${bottom - lid} Z`}
                    />
                    <path className="dg-shape-line" d={`M${left},${top + lid} A${rx},${lid} 0 0 0 ${right},${top + lid}`} />
                </>
            );
        }
        case 'queue': {
            const ry = node.height / 2;
            return (
                <>
                    <path
                        className="dg-shape"
                        d={`M${left + lid},${top} H${right - lid} A${lid},${ry} 0 0 1 ${right - lid},${bottom} H${left + lid} A${lid},${ry} 0 0 1 ${left + lid},${top} Z`}
                    />
                    <path className="dg-shape-line" d={`M${right - lid},${top} A${lid},${ry} 0 0 0 ${right - lid},${bottom}`} />
                </>
            );
        }
        default:
            return (
                <rect
                    className="dg-shape"
                    x={left}
                    y={top}
                    width={node.width}
                    height={node.height}
                    rx={node.shape === 'pill' ? node.height / 2 : 8}
                />
            );
    }
}

/** A node's label lines, then its smaller detail lines, centred in the body of its shape. */
function NodeText({ node }: { node: LaidNode }) {
    const detail = node.detail ?? [];
    const head = node.shape === 'person' ? C4_SHAPE.head : 0;
    const centre = node.y + head / 2;
    const height = node.lines.length * 16 + detail.length * 14 + (detail.length ? 4 : 0);
    const first = centre - height / 2 + 12;
    return (
        <text textAnchor="middle" className="dg-label">
            {node.lines.map((line, index) => (
                <tspan key={`l${index}`} x={node.x} y={first + index * 16}>
                    {line}
                </tspan>
            ))}
            {detail.map((line, index) => (
                <tspan
                    key={`d${index}`}
                    x={node.x}
                    y={first + node.lines.length * 16 + 4 + index * 14}
                    className={index === 0 ? 'dg-detail is-kind' : 'dg-detail'}
                >
                    {line}
                </tspan>
            ))}
        </text>
    );
}

const KEY_LABELS: Record<string, string> = { pk: 'PK', fk: 'FK', uk: 'UK' };

/** A schema table: its name over a band, then a row per column with its keys, name and type. */
function TableNode({ node }: { node: LaidNode }) {
    const left = node.x - node.width / 2;
    const top = node.y - node.height / 2;
    const rows = node.rows ?? [];
    const nameAt = rowNameAt(rows);
    return (
        <>
            <rect className="dg-shape" x={left} y={top} width={node.width} height={node.height} rx={8} />
            <path className="dg-table-rule" d={`M${left},${top + TABLE.head} H${left + node.width}`} />
            <text x={left + 12} y={top + 19} className="dg-label dg-table-name">
                {node.lines[0]}
            </text>
            {rows.map((row, index) => {
                const y = rowCentre(node, index);
                return (
                    <g key={row.name} className={`dg-row${row.change ? ` is-${row.change}` : ''}`}>
                        {row.change && (
                            <rect
                                className="dg-row-mark"
                                x={left + 1}
                                y={y - TABLE.row / 2}
                                width={node.width - 2}
                                height={TABLE.row}
                            />
                        )}
                        {row.keys.length > 0 && (
                            <text x={left + 10} y={y + 4} className="dg-row-key">
                                {row.keys.map((key) => KEY_LABELS[key] ?? key).join(' ')}
                            </text>
                        )}
                        <text x={left + nameAt} y={y + 4} className="dg-row-name">
                            {row.name}
                        </text>
                        {row.type && (
                            <text x={left + node.width - 10} y={y + 4} textAnchor="end" className="dg-row-type">
                                {row.type}
                            </text>
                        )}
                    </g>
                );
            })}
        </>
    );
}

/** A laid-out graph in words, for screen readers: its nodes, then each edge with its label. */
function describeGraph(layout: Layout): string {
    const labels = new Map(layout.nodes.map((node) => [node.id, node.lines.join(' ')]));
    const parts = layout.edges.map(
        (edge) => `${labels.get(edge.from)} to ${labels.get(edge.to)}${edge.label ? ` (${edge.label})` : ''}`
    );
    return `Diagram of ${layout.nodes.map((node) => node.lines.join(' ')).join(', ')}${parts.length ? `; ${parts.join('; ')}` : ''}`;
}

/** A finding's badge at the top right of a node or actor: the count, its titles on hover, and a click to the findings. */
function PinBadge({ x, y, pin }: { x: number; y: number; pin: { count: number; label: string; open: () => void } }) {
    return (
        <g
            className="dg-pin"
            role="button"
            tabIndex={0}
            aria-label={`${pin.count} finding${pin.count === 1 ? '' : 's'}: ${pin.label}`}
            onClick={pin.open}
            onKeyDown={(event) => (event.key === 'Enter' || event.key === ' ') && pin.open()}
        >
            <title>{pin.label}</title>
            <circle cx={x} cy={y} r={10} />
            <text x={x} y={y + 4} textAnchor="middle">
                {pin.count}
            </text>
        </g>
    );
}

/**
 * Draw a laid-out graph in the handoff's diagram vocabulary, edges curved through dagre's points. Hovering a node
 * fades everything but it, its neighbours and the edges between them; a step-through's `highlight` does the same for
 * its step's nodes. `pins` badge the nodes findings sit on.
 */
export function GraphDiagram({
    layout,
    label,
    highlight,
    pins
}: {
    layout: Layout;
    label?: string;
    highlight?: ReadonlySet<string>;
    pins?: Pins;
}) {
    const ids = useMarkerIds();
    const [focus, setFocus] = useState<string>();
    const hovered = useMemo(() => (focus === undefined ? undefined : neighbours(layout, focus)), [layout, focus]);
    const lit = hovered ?? highlight;
    return (
        <svg
            className={`diagram${lit ? ' has-focus' : ''}`}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            style={{ maxWidth: layout.width }}
            role="img"
            aria-label={label ?? describeGraph(layout)}
        >
            <Markers ids={ids} />
            {layout.groups.map((group) => (
                <g key={group.label} className="dg-group">
                    <rect x={group.x} y={group.y} width={group.width} height={group.height} rx="12" />
                    <text x={group.x + 12} y={group.y + 16} className="dg-group-label">
                        {group.label.toUpperCase()}
                    </text>
                </g>
            ))}
            {layout.edges.map((edge) => (
                <g
                    key={edge.id}
                    className={`dg-link${
                        hovered
                            ? edge.from === focus || edge.to === focus
                                ? ' is-lit'
                                : ''
                            : lit?.has(edge.from) && lit.has(edge.to)
                              ? ' is-lit'
                              : ''
                    }`}
                >
                    <path
                        className={`dg-edge${edge.dashed ? ' is-dashed' : ''}${edge.tone === 'plain' ? '' : ` is-${edge.tone}`}`}
                        d={curvePath(edge.points)}
                        {...edgeMarkers(edge, ids)}
                    />
                    {edge.label && edge.labelAt && (
                        <text
                            x={edge.labelAt.x}
                            y={edge.labelAt.y + 4}
                            textAnchor="middle"
                            className={`dg-edge-label${edge.tone === 'fallback' ? ' is-fallback' : ''}`}
                        >
                            {edge.label}
                        </text>
                    )}
                </g>
            ))}
            {layout.nodes.map((node) => (
                <g
                    key={node.id}
                    className={`dg-node is-${node.tone}${node.strong ? ' is-strong' : ''}${node.shape === 'table' ? ' is-table' : ''}${lit?.has(node.id) ? ' is-lit' : ''}`}
                    onMouseEnter={() => setFocus(node.id)}
                    onMouseLeave={() => setFocus(undefined)}
                >
                    {node.shape === 'table' ? (
                        <TableNode node={node} />
                    ) : (
                        <>
                            <NodeShapeOf node={node} />
                            <NodeText node={node} />
                        </>
                    )}
                </g>
            ))}
            {pins &&
                layout.nodes.map((node) => {
                    const pin = pins.get(node.id);
                    return pin ? (
                        <PinBadge
                            key={`pin-${node.id}`}
                            x={node.x + node.width / 2 - 2}
                            y={node.y - node.height / 2 + 2}
                            pin={pin}
                        />
                    ) : null;
                })}
        </svg>
    );
}

/**
 * Draw a laid-out sequence: actors with lifelines, and messages between them, dashed for replies, looped for
 * self-calls. A step-through's `highlight` lights its step's messages, by index; `pins` badge actors by label.
 */
export function SequenceDiagram({
    layout,
    highlight,
    pins
}: {
    layout: SequenceLayout;
    highlight?: ReadonlySet<number>;
    pins?: Pins;
}) {
    const ids = useMarkerIds();
    const label = `Sequence between ${layout.actors.map((actor) => actor.label).join(', ')}: ${layout.messages
        .map((message) => `${layout.actors[message.from]?.label} to ${layout.actors[message.to]?.label}, ${message.text}`)
        .join('; ')}`;
    return (
        <svg
            className={`diagram${highlight ? ' has-focus' : ''}`}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            style={{ maxWidth: layout.width }}
            role="img"
            aria-label={label}
        >
            <Markers ids={ids} />
            {layout.actors.map((actor) => (
                <g key={actor.label} className={`dg-node is-actor is-${actor.tone}`}>
                    <rect className="dg-shape" x={actor.x - actor.width / 2} y={4} width={actor.width} height={28} rx="6" />
                    <text x={actor.x} y={23} textAnchor="middle" className="dg-label">
                        {actor.label}
                    </text>
                    <line x1={actor.x} y1={32} x2={actor.x} y2={layout.height} className="dg-lifeline" />
                </g>
            ))}
            {layout.messages.map((message, index) => {
                const from = layout.actors[message.from];
                const to = layout.actors[message.to];
                if (!from || !to) return null;
                const lit = highlight?.has(index) ? ' is-lit' : '';
                if (from === to) {
                    const x = from.x;
                    return (
                        <g key={index} className={`dg-message${lit}`}>
                            <polyline
                                className="dg-edge"
                                points={`${x},${message.y - 8} ${x + 28},${message.y - 8} ${x + 28},${message.y + 6} ${x + 3},${message.y + 6}`}
                                markerEnd={`url(#${ids.plain})`}
                            />
                            <text x={x + 34} y={message.y + 2} className="dg-edge-label is-message">
                                {message.text}
                            </text>
                        </g>
                    );
                }
                const direction = to.x > from.x ? 1 : -1;
                return (
                    <g key={index} className={`dg-message${lit}`}>
                        <line
                            x1={from.x}
                            y1={message.y}
                            x2={to.x - direction * 2}
                            y2={message.y}
                            className={`dg-edge${message.reply ? ' is-dashed is-reply' : ''}`}
                            markerEnd={`url(#${ids.plain})`}
                        />
                        <text
                            x={(from.x + to.x) / 2}
                            y={message.y - 7}
                            textAnchor="middle"
                            className={`dg-edge-label is-message${message.reply ? ' is-reply' : ''}`}
                        >
                            {message.text}
                        </text>
                    </g>
                );
            })}
            {pins &&
                layout.actors.map((actor) => {
                    const pin = pins.get(actor.label);
                    return pin ? <PinBadge key={`pin-${actor.label}`} x={actor.x + actor.width / 2 - 2} y={6} pin={pin} /> : null;
                })}
        </svg>
    );
}

/** A `flow` block, laid out once per config. */
export function FlowBlock({ id, config }: BlockProps<'flow'>) {
    const layout = useMemo(() => layoutGraph(flowGraph(config)), [config]);
    return <GraphDiagram layout={layout} pins={usePins(id)} />;
}

/** A `state` block, laid out once per config. */
export function StateBlock({ config }: BlockProps<'state'>) {
    const layout = useMemo(() => layoutGraph(stateGraph(config)), [config]);
    return <GraphDiagram layout={layout} />;
}

/** An `architecture` block, laid out once per config. */
export function ArchitectureBlock({ id, config }: BlockProps<'architecture'>) {
    const layout = useMemo(() => layoutGraph(architectureGraph(config)), [config]);
    return <GraphDiagram layout={layout} pins={usePins(id)} />;
}

/** A `schema` block: tables and their relations, laid out once per config. */
export function SchemaBlock({ config }: BlockProps<'schema'>) {
    const layout = useMemo(() => layoutGraph(schemaGraph(config)), [config]);
    // The svg is one image to a screen reader, so its label says what each change does.
    const column = (entry: BlockConfigs['schema']['tables'][number]['columns'][number]) =>
        entry.change ? `${entry.name} ${entry.change}` : entry.name;
    const label = `Schema of ${config.tables
        .map(
            (table) =>
                `${table.name ?? table.id}${table.change ? ` ${table.change}` : ''} (${table.columns.map(column).join(', ')})`
        )
        .join('; ')}`;
    return <GraphDiagram layout={layout} label={label} />;
}

/** A `c4` block, laid out top to bottom once per config. */
export function C4Block({ config }: BlockProps<'c4'>) {
    const layout = useMemo(() => layoutGraph(c4Graph(config)), [config]);
    return <GraphDiagram layout={layout} />;
}

/** A mind map: its centre, branches in their own colours, and on hover the path through the hovered node lit. */
export function MindmapDiagram({ layout }: { layout: MindmapLayout }) {
    const [focus, setFocus] = useState<string>();
    const lit = useMemo(() => {
        if (focus === undefined) return undefined;
        const node = layout.nodes.find((candidate) => candidate.id === focus);
        // Its ancestors, itself and everything under it.
        return new Set([
            ...(node?.ancestors ?? []),
            ...layout.nodes.filter((other) => other.id === focus || other.ancestors.includes(focus)).map((other) => other.id)
        ]);
    }, [layout, focus]);
    const label = `Mind map of ${layout.nodes[0]?.lines.join(' ')}: ${layout.nodes
        .slice(1)
        .map((node) => node.lines.join(' '))
        .join(', ')}`;
    return (
        <svg
            className={`diagram mindmap${lit ? ' has-focus' : ''}`}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            style={{ maxWidth: layout.width }}
            role="img"
            aria-label={label}
        >
            {layout.links.map((link) => (
                <path
                    key={link.to}
                    className={`mm-link series-${(link.branch % 6) + 1}${lit?.has(link.to) && lit.has(link.from) ? ' is-lit' : ''}`}
                    d={link.path}
                />
            ))}
            {layout.nodes.map((node): ReactNode => {
                const left = node.x - node.width / 2;
                const top = node.y - node.height / 2;
                const first = node.y - ((node.lines.length - 1) * 16) / 2 + 4;
                const kind = node.depth === 0 ? 'is-root' : node.depth === 1 ? 'is-branch' : 'is-leaf';
                return (
                    <g
                        key={node.id}
                        className={`mm-node ${kind}${node.branch >= 0 ? ` series-${(node.branch % 6) + 1}` : ''}${node.emphasis ? ` is-${node.emphasis}` : ''}${lit?.has(node.id) ? ' is-lit' : ''}`}
                        onMouseEnter={() => setFocus(node.id)}
                        onMouseLeave={() => setFocus(undefined)}
                    >
                        <rect
                            x={left}
                            y={top}
                            width={node.width}
                            height={node.height}
                            rx={node.depth === 1 ? 8 : node.height / 2}
                        />
                        <text textAnchor="middle">
                            {node.lines.map((line, index) => (
                                <tspan key={index} x={node.x} y={first + index * 16}>
                                    {line}
                                </tspan>
                            ))}
                        </text>
                    </g>
                );
            })}
        </svg>
    );
}

/** A `mindmap` block, laid out once per config. */
export function MindmapBlock({ config }: BlockProps<'mindmap'>) {
    const layout = useMemo(() => layoutMindmap(config), [config]);
    return <MindmapDiagram layout={layout} />;
}

/** A `sequence` block, laid out once per config. */
export function SequenceBlock({ id, config }: BlockProps<'sequence'>) {
    const layout = useMemo(() => layoutSequence(config), [config]);
    return <SequenceDiagram layout={layout} pins={usePins(id)} />;
}

type Diagram = { [T in DiagramType]: { type: T; config: BlockConfigs[T] } }[DiagramType];

/** Node ids to their labels, for naming what a compare side added or removed. */
function nodeLabels(diagram: Diagram): Map<string, string> {
    switch (diagram.type) {
        case 'flow':
        case 'architecture':
            return new Map(diagram.config.nodes.map((node) => [node.id, node.label]));
        case 'state':
            return new Map(diagram.config.states.map((state) => [state, state]));
        case 'sequence':
            return new Map(diagram.config.actors.map((actor) => [actor, actor]));
        default:
            return new Map();
    }
}

/** The ids a compare side matches nodes by. */
function nodeIds(diagram: Diagram): string[] {
    switch (diagram.type) {
        case 'flow':
        case 'architecture':
            return diagram.config.nodes.map((node) => node.id);
        case 'state':
            return diagram.config.states;
        case 'sequence':
            return diagram.config.actors;
        default:
            return [];
    }
}

/** Draw a compare side's diagram, with its nodes toned by what the other side lacks. */
function DiagramOf({ diagram, tones }: { diagram: Diagram; tones: Map<string, NodeTone> }) {
    switch (diagram.type) {
        case 'flow':
            return <GraphDiagram layout={layoutGraph(flowGraph(diagram.config, tones))} />;
        case 'state':
            return <GraphDiagram layout={layoutGraph(stateGraph(diagram.config, tones))} />;
        case 'architecture':
            return <GraphDiagram layout={layoutGraph(architectureGraph(diagram.config, tones))} />;
        case 'sequence':
            return <SequenceDiagram layout={layoutSequence(diagram.config, tones)} />;
        default:
            return null;
    }
}

/** A compare side that is not a diagram: code or an image, drawn as its own block. */
type Other = { [T in 'code' | 'image']: { type: T; config: BlockConfigs[T] } }['code' | 'image'];

type Side = { diagram: Diagram } | { other: Other } | { error: string };

/** Resolve a compare side: an inline diagram, code or image, or the id of one of those blocks. */
function useSide(side: BlockConfigs['compare']['left']): Side {
    const referenced = useRecord('blocks', typeof side.block === 'string' ? side.block : '');
    const inline = typeof side.block === 'string' ? undefined : side.block;
    if (inline) return inline.type === 'code' || inline.type === 'image' ? { other: inline } : { diagram: inline };
    if (!referenced) return { error: `Block "${side.block}" is not on the page` };
    const check = checkBlockConfig(referenced.type, referenced.config);
    if (!check.ok) return { error: `Block "${side.block}" has an invalid config` };
    if (check.type === 'code' || check.type === 'image') return { other: { type: check.type, config: check.config } as Other };
    if (!(diagramTypes as readonly string[]).includes(referenced.type))
        return { error: `Block "${side.block}" is a ${referenced.type}, not a diagram, code or image` };
    return { diagram: { type: check.type, config: check.config } as Diagram };
}

/** A non-diagram side: code in the code viewer, or an image with its pins. */
function OtherSide({ other }: { other: Other }) {
    return other.type === 'code' ? (
        <CodeBlock id="compare-code" config={other.config} placement="question" />
    ) : (
        <ImageBlock id="compare-image" config={other.config} placement="question" />
    );
}

/**
 * Two diagrams, code excerpts or images side by side. Between two diagrams, what one side lacks is painted on the
 * other. An unresolvable side errors alone.
 */
export function CompareBlock({ config }: BlockProps<'compare'>) {
    const left = useSide(config.left);
    const right = useSide(config.right);
    const both = 'diagram' in left && 'diagram' in right;
    const leftIds = both ? nodeIds(left.diagram) : [];
    const rightIds = both ? nodeIds(right.diagram) : [];
    const sides = [
        { key: 'left', label: config.left.label, side: left, tones: compareTones(leftIds, rightIds, 'left', config.highlight) },
        {
            key: 'right',
            label: config.right.label,
            side: right,
            tones: compareTones(rightIds, leftIds, 'right', config.highlight)
        }
    ];
    return (
        <div className="compare">
            {sides.map(({ key, label, side, tones }) => (
                <div key={key} className="compare-side">
                    {label && <span className="eyebrow">{label}</span>}
                    {'diagram' in side ? (
                        <DiagramOf diagram={side.diagram} tones={tones} />
                    ) : 'other' in side ? (
                        <OtherSide other={side.other} />
                    ) : (
                        <p className="side-error">{side.error}</p>
                    )}
                    {'diagram' in side && tones.size > 0 && (
                        <span className={`compare-note ${[...tones.values()][0] === 'new' ? 'is-added' : 'is-removed'}`}>
                            {[...tones.values()][0] === 'new' ? '+ added' : '− removed'}:{' '}
                            {[...tones.keys()]
                                .map((id) => ('diagram' in side ? (nodeLabels(side.diagram).get(id) ?? id) : id))
                                .join(', ')}
                        </span>
                    )}
                </div>
            ))}
        </div>
    );
}
