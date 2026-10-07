import { Component, type ComponentType, lazy, memo, type ReactNode, Suspense, useState } from 'react';
import { type BlockConfigs, type BlockType, checkBlockConfig } from '../../shared/blocks';
import type { Issue } from '../../shared/issues';
import { commentOnWhole } from '../comments/composer';
import { CommentIcon, ExpandIcon, WarningIcon } from '../components/icons';
import { LinkedText, QuestionLink } from '../components/LinkedText';
import { Modal } from '../components/Modal';
import { ZoomView } from '../components/ZoomView';
import { useReadOnly } from '../readOnly';
import { quietly, useActions, useBusy } from '../ui';
import {
    CalloutBlock,
    ChecklistBlock,
    CodeBlock,
    FileTreeBlock,
    ImageBlock,
    StatsBlock,
    TableBlock,
    TextBlock,
    TimelineBlock
} from './basic';
import { BarBlock, GanttBlock, LineBlock, OptionMatrixBlock, RiskMatrixBlock, SankeyBlock } from './charts';
import {
    ArchitectureBlock,
    C4Block,
    CompareBlock,
    FlowBlock,
    MindmapBlock,
    SchemaBlock,
    SequenceBlock,
    StateBlock
} from './diagrams';
import { ImpactMapBlock } from './impact';
import { AnalogyBlock, HtmlBlock, StepThroughBlock, YourTakeBlock } from './review';

/**
 * Where a block sits: the write-up and a review's slides own interactive blocks; question context, replies and history
 * are read-only.
 */
export type Placement = 'writeup' | 'slide' | 'question' | 'thread' | 'history';

/** What every renderer receives: its parsed config, its id and where it sits. */
export interface BlockProps<T extends BlockType> {
    id: string;
    config: BlockConfigs[T];
    placement: Placement;
}

type Renderer<T extends BlockType> = ComponentType<BlockProps<T>>;

/** The Mermaid renderer, split into its own chunk and loaded on first use: Mermaid is large. */
const MermaidBlock = lazy(() => import('./mermaid'));

/** The renderer registry: one component per block type, mirroring the schema union. */
export const renderers: { [T in BlockType]: Renderer<T> } = {
    text: TextBlock,
    callout: CalloutBlock,
    checklist: ChecklistBlock,
    table: TableBlock,
    stats: StatsBlock,
    flow: FlowBlock,
    sequence: SequenceBlock,
    architecture: ArchitectureBlock,
    state: StateBlock,
    schema: SchemaBlock,
    c4: C4Block,
    mindmap: MindmapBlock,
    compare: CompareBlock,
    timeline: TimelineBlock,
    gantt: GanttBlock,
    bar: BarBlock,
    line: LineBlock,
    sankey: SankeyBlock,
    riskMatrix: RiskMatrixBlock,
    optionMatrix: OptionMatrixBlock,
    fileTree: FileTreeBlock,
    code: CodeBlock,
    image: ImageBlock,
    mermaid: MermaidBlock,
    analogy: AnalogyBlock,
    stepThrough: StepThroughBlock,
    yourTake: YourTakeBlock,
    impactMap: ImpactMapBlock,
    html: HtmlBlock
};

/** Blocks drawn as pictures, which zoom and scroll in full screen; text-like blocks keep their plain full screen. */
const ZOOMS: ReadonlySet<string> = new Set<BlockType>([
    'flow',
    'sequence',
    'architecture',
    'state',
    'schema',
    'c4',
    'mindmap',
    'gantt',
    'bar',
    'line',
    'sankey',
    'riskMatrix',
    'image',
    'mermaid',
    'stepThrough',
    'compare'
]);

/** A block as the page holds it: the agent's envelope, and the server's verdict when its config failed. */
export interface BlockInput {
    id: string;
    type: string;
    config: Record<string, unknown>;
    caption?: string;
    refs?: string[];
    problem?: { reason: 'unknown-type' | 'invalid'; issues: Issue[] };
}

/** A block's config as indented JSON. */
function RawConfig({ block }: { block: BlockInput }) {
    return <pre className="raw-config">{JSON.stringify(block.config, null, 2)}</pre>;
}

const NOUNS: Partial<Record<string, string>> = {
    bar: 'chart',
    line: 'chart',
    riskMatrix: 'matrix',
    optionMatrix: 'matrix',
    flow: 'diagram',
    sequence: 'diagram',
    architecture: 'diagram',
    state: 'diagram',
    schema: 'diagram',
    c4: 'diagram',
    mindmap: 'mind map',
    gantt: 'chart',
    sankey: 'diagram',
    compare: 'comparison',
    table: 'table'
};

/**
 * An invalid config: every error, the raw config, and a fix request to the agent. `thrown` is the error of a block
 * that validated but threw while drawing; it goes with the fix request, since the server holds no problem for it.
 */
export function ErrorCard({
    block,
    issues,
    placement,
    thrown
}: {
    block: BlockInput;
    issues: Issue[];
    placement: Placement;
    thrown?: string;
}) {
    const { send } = useActions();
    const readOnly = useReadOnly();
    const [showConfig, setShowConfig] = useState(false);
    const [busy, track] = useBusy();
    const [asked, setAsked] = useState(false);
    return (
        <div className="block-error" role="group" aria-label={`Block ${block.id} could not render`}>
            <span className="block-error-title">
                <WarningIcon />
                This {NOUNS[block.type] ?? `${block.type} block`} couldn&apos;t render
            </span>
            <ul className="issue-list">
                {issues.map((issue) => (
                    <li key={`${issue.path}-${issue.message}`}>
                        <code>{issue.path ? `${issue.path}: ${issue.message}` : issue.message}</code>
                    </li>
                ))}
            </ul>
            <div className="row">
                {placement === 'writeup' && !readOnly && (
                    <button
                        type="button"
                        className="button-primary button-small"
                        disabled={busy || asked}
                        onClick={() =>
                            quietly(
                                track(send({ type: 'block.fix', blockId: block.id, ...(thrown && { thrown }) })).then(() =>
                                    setAsked(true)
                                )
                            )
                        }
                    >
                        {asked ? 'Asked the agent' : 'Ask agent to fix'}
                    </button>
                )}
                <button
                    type="button"
                    className="button-secondary button-small"
                    aria-expanded={showConfig}
                    onClick={() => setShowConfig(!showConfig)}
                >
                    {showConfig ? 'Hide config' : 'View config'}
                </button>
            </div>
            {showConfig && <RawConfig block={block} />}
        </div>
    );
}

/** The card for a block whose type is not registered: what went wrong, then its raw config. */
export function UnknownCard({ block }: { block: BlockInput }) {
    return (
        <div className="block-unknown" role="group" aria-label={`Block ${block.id} has an unknown type`}>
            <span className="strong">Unknown block type</span>
            <code>{`type: "${block.type}" is not registered`}</code>
            <span className="small">Shown as raw config. The agent is told the supported types and can re-send it.</span>
            <RawConfig block={block} />
        </div>
    );
}

interface BoundaryProps {
    block: BlockInput;
    placement: Placement;
    children: ReactNode;
}

/**
 * Catches a renderer that throws while drawing, or a lazy renderer whose chunk failed to load, and shows the block's
 * error card in its place. Without it React unmounts the whole page. A new block envelope (the agent re-sent it)
 * tries the renderer again.
 */
class BlockBoundary extends Component<BoundaryProps, { error?: string }> {
    /** Keep the thrown message for the error card. */
    static getDerivedStateFromError(error: unknown): { error: string } {
        return { error: error instanceof Error ? error.message : String(error) };
    }

    state: { error?: string } = {};

    /** Clear the error once the block itself changes. */
    componentDidUpdate(previous: BoundaryProps): void {
        if (this.state.error !== undefined && previous.block !== this.props.block) this.setState({ error: undefined });
    }

    /** The block, or its error card once it threw. */
    render() {
        const { block, placement, children } = this.props;
        if (this.state.error === undefined) return children;
        return (
            <ErrorCard
                block={block}
                issues={[{ path: '', message: this.state.error }]}
                placement={placement}
                thrown={this.state.error.slice(0, 2000) || 'an error with no message'}
            />
        );
    }
}

/** Render a block's content from its config, or the error or raw-config card it degrades to. */
export function BlockContent({ block, placement }: { block: BlockInput; placement: Placement }) {
    if (block.problem?.reason === 'unknown-type') return <UnknownCard block={block} />;
    // Re-check on the page too: it is cheap, and it types the config for the renderer.
    const check = checkBlockConfig(block.type, block.config);
    if (!check.ok) {
        return check.reason === 'unknown-type' ? (
            <UnknownCard block={block} />
        ) : (
            <ErrorCard block={block} issues={block.problem?.issues ?? check.issues} placement={placement} />
        );
    }
    const Renderer = renderers[check.type] as Renderer<BlockType>;
    return (
        <BlockBoundary block={block} placement={placement}>
            <Suspense fallback={<div className="block-loading">Loading…</div>}>
                <Renderer id={block.id} config={check.config} placement={placement} />
            </Suspense>
        </BlockBoundary>
    );
}

/**
 * A block with its frame: the content, an optional caption and question refs, and
 * the full-screen action every block gets, plus a whole-block comment in the write-up
 * for images and diagrams that have little text to select.
 */
export const BlockView = memo(function BlockView({ block, placement }: { block: BlockInput; placement: Placement }) {
    const [full, setFull] = useState(false);
    const readOnly = useReadOnly();
    const target = placement === 'writeup' || placement === 'slide' ? `block:${block.id}` : undefined;
    const label = block.caption ?? `${block.type} ${block.id}`;
    const zooms = !block.problem && ZOOMS.has(block.type);
    return (
        <figure className={`block block-${block.type}`} data-block-type={block.type}>
            <div className="block-tools">
                <button
                    type="button"
                    className="icon-button tiny"
                    aria-label="Full screen"
                    title="Full screen"
                    onClick={() => setFull(true)}
                >
                    <ExpandIcon />
                </button>
                {target && !readOnly && (
                    <button
                        type="button"
                        className="icon-button tiny"
                        aria-label="Comment on this block"
                        title="Comment on this block"
                        onClick={() => commentOnWhole(target, 'question')}
                    >
                        <CommentIcon size={14} />
                    </button>
                )}
            </div>
            <div className="block-body" data-anchor-target={target}>
                <BlockContent block={block} placement={placement} />
            </div>
            {(block.caption || (block.refs && block.refs.length > 0)) && (
                <figcaption className="block-caption">
                    {block.caption && (
                        <span>
                            <LinkedText text={block.caption} />
                        </span>
                    )}
                    {block.refs && block.refs.length > 0 && (
                        <span className="block-refs">
                            {block.refs.map((ref) =>
                                /^Q-\d+$/.test(ref) ? <QuestionLink key={ref} id={ref} /> : <code key={ref}>{ref}</code>
                            )}
                        </span>
                    )}
                </figcaption>
            )}
            {full && (
                <Modal label={label} onClose={() => setFull(false)} className={`fullscreen${zooms ? ' fullscreen-zoom' : ''}`}>
                    {zooms ? (
                        <ZoomView label={label}>
                            <BlockContent block={block} placement={placement} />
                        </ZoomView>
                    ) : (
                        <div className="fullscreen-body">
                            <BlockContent block={block} placement={placement} />
                        </div>
                    )}
                </Modal>
            )}
        </figure>
    );
});
