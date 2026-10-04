import { type ReactNode, useMemo, useState } from 'react';
import type { BlockConfigs } from '../../shared/blocks';
import { CheckIcon, CloseIcon, DashIcon } from '../components/icons';
import { InlineMarkdown } from '../components/Markdown';
import { formatValue } from '../format';
import type { BlockProps } from './Block';
import { dayLabel, ganttTicks, layoutSankey, type SankeyLayout, scheduleGantt } from './layout';
import { stagger } from './stagger';

/**
 * Axis ticks at a round step: 0, 1,000, 2,000 … covering `min` (at most 0) to `max`. Every tick is a multiple of the
 * step, so 0 is one of them when the range crosses it.
 */
export function niceTicks(max: number, count = 4, min = 0): number[] {
    if (max <= min) return [min, min + 1];
    const raw = (max - min) / count;
    const power = 10 ** Math.floor(Math.log10(raw));
    const step = ([1, 2, 2.5, 5, 10].find((factor) => factor * power >= raw) ?? 10) * power;
    const ticks: number[] = [];
    // Count in whole steps from the one at or below `min`, so 0 comes out as exactly 0.
    for (let index = Math.floor(min / step); index * step < max + step * 0.999; index += 1)
        ticks.push(Number((index * step).toFixed(10)));
    return ticks.length > 1 ? ticks : [ticks[0]!, ticks[0]! + step];
}

interface Tip {
    x: number;
    y: number;
    text: string;
}

/** A chart's frame: legend, "view as table", and a hover tooltip layer. */
function ChartFrame({
    legend,
    note,
    table,
    children,
    tip
}: {
    legend?: string[];
    note?: ReactNode;
    table: { columns: string[]; rows: (string | number | null)[][] };
    children: ReactNode;
    tip: Tip | undefined;
}) {
    const [asTable, setAsTable] = useState(false);
    return (
        <div className="chart">
            <div className="chart-head">
                {legend && legend.length > 0 && (
                    <div className="legend">
                        {legend.map((name, index) => (
                            <span key={name} className="legend-item">
                                <span className={`swatch series-${(index % 6) + 1}`} aria-hidden="true" />
                                {name}
                            </span>
                        ))}
                    </div>
                )}
                {note}
                <button type="button" className="button-text small" aria-pressed={asTable} onClick={() => setAsTable(!asTable)}>
                    {asTable ? 'View as chart' : 'View as table'}
                </button>
            </div>
            {asTable ? (
                <div className="table-wrap">
                    <table className="data-table">
                        <thead>
                            <tr>
                                {table.columns.map((column) => (
                                    <th key={column}>{column}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {table.rows.map((row, index) => (
                                <tr key={index}>
                                    {row.map((value, column) => (
                                        <td key={column}>{formatValue(value)}</td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            ) : (
                <div className="chart-body">
                    {children}
                    {tip && (
                        <div className="tooltip" role="tooltip" style={{ left: tip.x, top: tip.y }}>
                            {tip.text}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

/** Hover state for a chart: where the pointer is inside the chart body, and what to say. */
function useTip(): [Tip | undefined, (event: React.MouseEvent, text: string) => void, () => void] {
    const [tip, setTip] = useState<Tip>();
    const show = (event: React.MouseEvent, text: string) => {
        const body = (event.currentTarget as Element).closest('.chart-body')?.getBoundingClientRect();
        setTip({ x: event.clientX - (body?.left ?? 0) + 12, y: event.clientY - (body?.top ?? 0) + 12, text });
    };
    return [tip, show, () => setTip(undefined)];
}

/** A bar chart, horizontal or vertical, grouped or stacked, with a tooltip per bar and a table view. */
export function BarBlock({ config }: BlockProps<'bar'>) {
    const [tip, show, hide] = useTip();
    const rows = config.data.map((row) => ({
        label: String(row[0]),
        values: row.slice(1).map((value) => (typeof value === 'number' ? value : null))
    }));
    const total = (values: (number | null)[]) => values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
    const max = Math.max(
        ...rows.map((row) => (config.stacked ? total(row.values) : Math.max(0, ...row.values.map((value) => value ?? 0))))
    );
    const ticks = niceTicks(max);
    const top = ticks[ticks.length - 1]!;
    const unit = config.unit ? ` ${config.unit}` : '';
    const describe = (label: string, series: string, value: number | null) =>
        `${label} · ${series}: ${value === null ? 'no value' : `${formatValue(value)}${unit}`}`;
    const table = { columns: ['', ...config.series], rows: config.data };
    const summary = `Bar chart${config.unit ? ` in ${config.unit}` : ''}: ${rows.map((row) => `${row.label} ${row.values.map((value) => formatValue(value)).join(' + ')}`).join('; ')}`;

    if (config.orientation === 'vertical') {
        return (
            <ChartFrame legend={config.series.length > 1 ? config.series : undefined} table={table} tip={tip}>
                <div className="bars-vertical" role="img" aria-label={summary}>
                    {rows.map((row) => (
                        <div key={row.label} className="bar-column">
                            <div className={`bar-stack${config.stacked ? ' is-stacked' : ''}`}>
                                {row.values.map((value, index) =>
                                    value === null ? null : (
                                        <span
                                            key={index}
                                            className={`bar series-${(index % 6) + 1}`}
                                            style={{ height: `${(value / top) * 100}%` }}
                                            onMouseMove={(event) =>
                                                show(event, describe(row.label, config.series[index] ?? '', value))
                                            }
                                            onMouseLeave={hide}
                                        />
                                    )
                                )}
                            </div>
                            <span className="bar-label">{row.label}</span>
                        </div>
                    ))}
                </div>
            </ChartFrame>
        );
    }

    return (
        <ChartFrame
            legend={config.series.length > 1 ? config.series : undefined}
            table={table}
            tip={tip}
            note={config.unit ? <span className="small muted">{config.unit}</span> : undefined}
        >
            <div className="bars" role="img" aria-label={summary}>
                {rows.map((row) => (
                    <div key={row.label} className="bar-row">
                        <span className="bar-label">{row.label}</span>
                        <div className={`bar-track${config.stacked ? ' is-stacked' : ''}`}>
                            {row.values.map((value, index) =>
                                value === null ? null : (
                                    <span
                                        key={index}
                                        className={`bar series-${(index % 6) + 1}`}
                                        style={{ width: `${(value / top) * 100}%` }}
                                        onMouseMove={(event) =>
                                            show(event, describe(row.label, config.series[index] ?? '', value))
                                        }
                                        onMouseLeave={hide}
                                    />
                                )
                            )}
                            {row.values.every((value) => value === null) && <span className="bar-empty">no value</span>}
                        </div>
                        <span className="bar-value">
                            {formatValue(row.values[0] ?? null)}
                            {row.values.slice(1).map((value, index) => (
                                <span key={index} className="muted">
                                    {' '}
                                    {config.stacked ? '+' : '/'}
                                    {formatValue(value)}
                                </span>
                            ))}
                        </span>
                    </div>
                ))}
                <div className="bar-row bar-axis" aria-hidden="true">
                    <span />
                    <div className="axis-ticks">
                        {ticks.map((tick) => (
                            <span key={tick}>{formatValue(tick)}</span>
                        ))}
                    </div>
                    <span />
                </div>
            </div>
        </ChartFrame>
    );
}

const PLOT = { width: 560, height: 200, left: 44, right: 16, top: 20, bottom: 28 };

/** Annotation labels are 11px text: roughly this wide per character, set this far off their line, rows this tall. */
const LABEL = { charWidth: 6.5, gap: 6, row: 14 };

/** A line chart with annotation labels that rise a row rather than overlap, a tooltip per point and a table view. */
export function LineBlock({ config }: BlockProps<'line'>) {
    const [tip, show, hide] = useTip();
    const values = config.series.flatMap((series) => series.values.filter((value): value is number => value !== null));
    const ticks = niceTicks(Math.max(...values, 1), 4, Math.min(0, ...values));
    const bottom = ticks[0]!;
    const top = ticks[ticks.length - 1]!;
    const innerWidth = PLOT.width - PLOT.left - PLOT.right;
    const innerHeight = PLOT.height - PLOT.top - PLOT.bottom;
    const xAt = (index: number) =>
        PLOT.left + (config.x.length === 1 ? innerWidth / 2 : (index / (config.x.length - 1)) * innerWidth);
    const found = config.annotations
        .map((annotation) => ({ ...annotation, index: config.x.indexOf(annotation.x) }))
        .filter((annotation) => annotation.index !== -1)
        .sort((a, b) => a.index - b.index);
    // Left to right, a label that would run into an earlier one rises a row, and the plot moves down to make room.
    const offsets = stagger(
        found.map((annotation) => ({
            box: {
                x: xAt(annotation.index),
                y: 0,
                width: LABEL.gap * 2 + annotation.text.length * LABEL.charWidth,
                height: LABEL.row
            },
            step: { x: 0, y: -LABEL.row }
        }))
    );
    const marks = found.map((annotation, index) => ({
        ...annotation,
        at: xAt(annotation.index),
        rise: -(offsets[index]?.y ?? 0)
    }));
    const plotTop = PLOT.top + Math.max(0, ...marks.map((mark) => mark.rise));
    const height = PLOT.height + plotTop - PLOT.top;
    const yAt = (value: number) => plotTop + innerHeight - ((value - bottom) / (top - bottom || 1)) * innerHeight;
    const labelEvery = Math.ceil(config.x.length / 10);
    const unit = config.unit ? ` ${config.unit}` : '';
    const table = {
        columns: ['', ...config.series.map((series) => series.name)],
        rows: config.x.map((x, index) => [x, ...config.series.map((series) => series.values[index] ?? null)])
    };
    const summary = `Line chart${config.unit ? ` of ${config.unit}` : ''}: ${config.series.map((series) => `${series.name} ${series.values.map((value) => formatValue(value)).join(', ')}`).join('; ')}`;

    /** Split a series at its gaps, so a null breaks the line. */
    const segments = (series: (number | null)[]) => {
        const runs: string[][] = [[]];
        series.forEach((value, index) => {
            if (value === null) runs.push([]);
            else runs[runs.length - 1]!.push(`${xAt(index)},${yAt(value)}`);
        });
        return runs.filter((run) => run.length > 0);
    };

    return (
        <ChartFrame
            legend={config.series.length > 1 ? config.series.map((series) => series.name) : undefined}
            table={table}
            tip={tip}
            note={
                <span className="small muted">
                    {config.unit}
                    {config.sample && <span className="chip sample-chip">sample data</span>}
                </span>
            }
        >
            <svg className="line-chart" viewBox={`0 0 ${PLOT.width} ${height}`} role="img" aria-label={summary}>
                {ticks.map((tick) => (
                    <g key={tick}>
                        <line
                            x1={PLOT.left}
                            x2={PLOT.width - PLOT.right}
                            y1={yAt(tick)}
                            y2={yAt(tick)}
                            className={tick === 0 ? 'axis-line' : 'grid-line'}
                        />
                        <text x={PLOT.left - 8} y={yAt(tick) + 4} textAnchor="end" className="axis-label">
                            {formatValue(tick)}
                        </text>
                    </g>
                ))}
                {config.x.map((x, index) =>
                    index % labelEvery === 0 || index === config.x.length - 1 ? (
                        <text key={index} x={xAt(index)} y={height - 8} textAnchor="middle" className="axis-label">
                            {String(x)}
                        </text>
                    ) : null
                )}
                {marks.length > 0 && (
                    // Every line first, so a line rising to a higher row passes behind the labels it crosses.
                    <g className="annotation">
                        {marks.map((mark) => (
                            <line
                                key={`${mark.x}-${mark.text}`}
                                x1={mark.at}
                                x2={mark.at}
                                y1={plotTop - LABEL.gap - mark.rise}
                                y2={plotTop + innerHeight}
                            />
                        ))}
                        {marks.map((mark) => (
                            <text key={`${mark.x}-${mark.text}`} x={mark.at + LABEL.gap} y={plotTop - LABEL.gap - mark.rise}>
                                {mark.text}
                            </text>
                        ))}
                    </g>
                )}
                {config.series.map((series, seriesIndex) => (
                    <g key={series.name} className={`line-series series-${(seriesIndex % 6) + 1}`}>
                        {segments(series.values).map((points, index) => (
                            <polyline key={index} points={points.join(' ')} />
                        ))}
                        {series.values.map((value, index) =>
                            value === null ? null : (
                                <circle
                                    key={index}
                                    cx={xAt(index)}
                                    cy={yAt(value)}
                                    r="4"
                                    onMouseMove={(event) =>
                                        show(event, `${series.name} · ${String(config.x[index])}: ${formatValue(value)}${unit}`)
                                    }
                                    onMouseLeave={hide}
                                />
                            )
                        )}
                    </g>
                ))}
            </svg>
        </ChartFrame>
    );
}

/** Risks numbered on a 3 by 3 grid of impact against likelihood, listed beside it with their mitigations. */
export function RiskMatrixBlock({ config }: BlockProps<'riskMatrix'>) {
    const [tip, show, hide] = useTip();
    const cells = [3, 2, 1].flatMap((impact) => [1, 2, 3].map((likelihood) => ({ impact, likelihood })));
    const levels = ['low', 'medium', 'high'];
    const table = {
        columns: ['#', 'Risk', 'Likelihood', 'Impact', 'Mitigation'],
        rows: config.items.map((item, index) => [
            index + 1,
            item.label,
            levels[item.likelihood - 1]!,
            levels[item.impact - 1]!,
            item.mitigation ?? null
        ])
    };
    const summary = `Risk matrix: ${config.items.map((item) => `${item.label}, likelihood ${levels[item.likelihood - 1]}, impact ${levels[item.impact - 1]}`).join('; ')}`;
    return (
        <ChartFrame table={table} tip={tip}>
            <div className="risk">
                <div className="risk-grid-wrap" role="img" aria-label={summary}>
                    <span className="risk-axis risk-axis-y">IMPACT →</span>
                    <div className="risk-grid">
                        {cells.map((cell) => {
                            const items = config.items.flatMap((item, index) =>
                                item.impact === cell.impact && item.likelihood === cell.likelihood ? [{ item, index }] : []
                            );
                            return (
                                <span
                                    key={`${cell.impact}-${cell.likelihood}`}
                                    className={`risk-cell heat-${cell.impact + cell.likelihood - 1}`}
                                >
                                    {items.map(({ item, index }) => (
                                        <span
                                            key={index}
                                            className="risk-marker"
                                            onMouseMove={(event) => show(event, item.label)}
                                            onMouseLeave={hide}
                                        >
                                            {index + 1}
                                        </span>
                                    ))}
                                </span>
                            );
                        })}
                    </div>
                    <span className="risk-axis risk-axis-x">LIKELIHOOD →</span>
                </div>
                <ol className="risk-list">
                    {config.items.map((item, index) => (
                        <li key={index}>
                            <span className="strong">{item.label}</span>
                            {item.mitigation && <span className="risk-mitigation">→ {item.mitigation}</span>}
                        </li>
                    ))}
                </ol>
            </div>
        </ChartFrame>
    );
}

/** A 0 to 3 score as three dots, filled up to the score. */
function Dots({ score }: { score: number }) {
    return (
        <span className="dots" role="img" aria-label={`${score} of 3`}>
            {[1, 2, 3].map((dot) => (
                <span key={dot} className={dot <= score ? 'dot-on' : 'dot-off'} />
            ))}
        </span>
    );
}

type OptionCell = BlockConfigs['optionMatrix']['rows'][number]['cells'][number];

const VERDICTS = {
    good: { Icon: CheckIcon, words: 'good' },
    mixed: { Icon: DashIcon, words: 'mixed' },
    bad: { Icon: CloseIcon, words: 'bad' }
} as const;

/** One option matrix cell: dots for a score, the text, or the text marked with its verdict's icon and colour. */
function OptionCellView({ cell }: { cell: OptionCell }) {
    if (typeof cell === 'number') return <Dots score={cell} />;
    if (typeof cell === 'string') return <InlineMarkdown source={cell} />;
    const { Icon, words } = VERDICTS[cell.verdict];
    return (
        <span className={`verdict is-${cell.verdict}`}>
            <span className="verdict-icon" aria-hidden="true">
                <Icon size={10} />
            </span>
            <span>
                <InlineMarkdown source={cell.text} />
                <span className="visually-hidden"> ({words})</span>
            </span>
        </span>
    );
}

/** Options side by side, a column each, judged on a row per criterion, with the recommended option's column highlighted. */
export function OptionMatrixBlock({ config }: BlockProps<'optionMatrix'>) {
    const recommended = (index: number) => (index === config.recommended ? 'is-recommended' : undefined);
    const scored = config.rows.some((row) => row.cells.some((cell) => typeof cell === 'number'));
    return (
        <div className="option-matrix">
            <div className="table-wrap">
                <table className="data-table">
                    <thead>
                        <tr>
                            <th scope="col">
                                <span className="visually-hidden">Criterion</span>
                            </th>
                            {config.options.map((option, index) => (
                                <th key={index} scope="col" className={recommended(index)}>
                                    {option}
                                    {index === config.recommended && <span className="recommended-tag">Recommended</span>}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {config.rows.map((row, rowIndex) => (
                            <tr key={rowIndex}>
                                <th scope="row">{row.criterion}</th>
                                {row.cells.map((cell, index) => (
                                    <td key={index} className={recommended(index)}>
                                        <OptionCellView cell={cell} />
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            {scored && <p className="block-note">More dots = better.</p>}
        </div>
    );
}

/** A gantt chart's drawing width, and the heights of its rows. */
const GANTT = { width: 600, right: 16, head: 24, group: 24, row: 28, bar: 14 };

/**
 * Tasks as bars on a time axis, grouped under headings, milestones as diamonds, and a curve from each task to the tasks
 * that wait on it, with a tooltip per task and a table view.
 */
export function GanttBlock({ config }: BlockProps<'gantt'>) {
    const [tip, show, hide] = useTip();
    const tasks = useMemo(() => scheduleGantt(config), [config]);
    const span = Math.max(1, ...tasks.map((task) => task.end));
    const ticks = ganttTicks(span, config.start);
    const labelWidth = Math.min(220, Math.max(100, ...tasks.map((task) => task.label.length * 6.6 + 24)));
    const plotWidth = GANTT.width - labelWidth - GANTT.right;
    const xAt = (day: number) => labelWidth + (day / span) * plotWidth;
    const when = (day: number) => (config.start ? dayLabel(config.start, day) : `day ${formatValue(day)}`);

    // Rows top to bottom: a heading where the group changes, then the task.
    const rows: ({ kind: 'group'; label: string; y: number } | { kind: 'task'; task: (typeof tasks)[number]; y: number })[] = [];
    let y = GANTT.head;
    let group: string | undefined;
    for (const task of tasks) {
        if (task.group !== undefined && task.group !== group) {
            rows.push({ kind: 'group', label: task.group, y });
            y += GANTT.group;
        }
        group = task.group;
        rows.push({ kind: 'task', task, y });
        y += GANTT.row;
    }
    const height = y + 4;
    const middleOf = new Map(rows.flatMap((row) => (row.kind === 'task' ? [[row.task.id, row.y + GANTT.row / 2] as const] : [])));
    const describe = (task: (typeof tasks)[number]) =>
        task.milestone
            ? `${task.label} · ${when(task.start)}`
            : `${task.label} · ${when(task.start)} to ${when(task.end)} (${formatValue(task.end - task.start)} days)`;
    const table = {
        columns: ['Task', 'Group', 'Start', 'End', 'Days'],
        rows: tasks.map((task) => [task.label, task.group ?? null, when(task.start), when(task.end), task.end - task.start])
    };
    return (
        <ChartFrame table={table} tip={tip}>
            <svg
                className="gantt"
                viewBox={`0 0 ${GANTT.width} ${height}`}
                role="img"
                aria-label={`Gantt chart: ${tasks.map(describe).join('; ')}`}
            >
                {ticks.map((tick) => (
                    <g key={tick.day}>
                        <line x1={xAt(tick.day)} x2={xAt(tick.day)} y1={GANTT.head - 6} y2={height} className="grid-line" />
                        <text x={xAt(tick.day)} y={GANTT.head - 10} textAnchor="middle" className="axis-label">
                            {tick.label}
                        </text>
                    </g>
                ))}
                {tasks.flatMap((task) =>
                    task.after.map((id) => {
                        const before = tasks.find((other) => other.id === id);
                        const fromY = middleOf.get(id);
                        const toY = middleOf.get(task.id);
                        if (!before || fromY === undefined || toY === undefined) return null;
                        const x1 = xAt(before.end);
                        const x2 = xAt(task.start);
                        return (
                            <path
                                key={`${id}-${task.id}`}
                                className="gantt-link"
                                d={`M${x1},${fromY} C${x1 + 14},${fromY} ${x2 - 14},${toY} ${x2},${toY}`}
                            />
                        );
                    })
                )}
                {rows.map((row) =>
                    row.kind === 'group' ? (
                        <text key={`g-${row.label}-${row.y}`} x={0} y={row.y + 16} className="gantt-group">
                            {row.label.toUpperCase()}
                        </text>
                    ) : (
                        <g
                            key={row.task.id}
                            className={`gantt-task${row.task.status ? ` is-${row.task.status}` : ''}`}
                            onMouseMove={(event) => show(event, describe(row.task))}
                            onMouseLeave={hide}
                        >
                            <text x={0} y={row.y + GANTT.row / 2 + 4} className="gantt-label">
                                {row.task.label}
                            </text>
                            {row.task.milestone ? (
                                <path
                                    className="gantt-milestone"
                                    d={`M${xAt(row.task.start)},${row.y + 6} l8,8 l-8,8 l-8,-8 z`}
                                />
                            ) : (
                                <rect
                                    className="gantt-bar"
                                    x={xAt(row.task.start)}
                                    y={row.y + (GANTT.row - GANTT.bar) / 2}
                                    width={Math.max(2, xAt(row.task.end) - xAt(row.task.start))}
                                    height={GANTT.bar}
                                    rx={3}
                                />
                            )}
                        </g>
                    )
                )}
            </svg>
        </ChartFrame>
    );
}

/**
 * Flows between nodes as bands as wide as their values, in their source's colour, with a tooltip per band and node.
 * Hovering a node lights the flows through it; hovering a band lights that flow.
 */
export function SankeyBlock({ config }: BlockProps<'sankey'>) {
    const [tip, show, hide] = useTip();
    const [focus, setFocus] = useState<{ node: string } | { link: number }>();
    const layout = useMemo(() => layoutSankey(config), [config]);
    const unit = config.unit ? ` ${config.unit}` : '';
    const lit = (link: SankeyLayout['links'][number], index: number) =>
        focus !== undefined && ('node' in focus ? link.from === focus.node || link.to === focus.node : focus.link === index);
    const table = {
        columns: ['From', 'To', config.unit ?? 'Value'],
        rows: config.flows.map((flow) => [flow.from, flow.to, flow.value])
    };
    const summary = `Sankey${config.unit ? ` in ${config.unit}` : ''}: ${config.flows.map((flow) => `${flow.from} to ${flow.to} ${formatValue(flow.value)}`).join('; ')}`;
    return (
        <ChartFrame table={table} tip={tip} note={config.unit ? <span className="small muted">{config.unit}</span> : undefined}>
            <svg
                className={`sankey${focus ? ' has-focus' : ''}`}
                viewBox={`0 0 ${layout.width} ${layout.height}`}
                role="img"
                aria-label={summary}
                onMouseLeave={() => {
                    setFocus(undefined);
                    hide();
                }}
            >
                {layout.links.map((link, index) => (
                    <path
                        key={`${link.from}-${link.to}`}
                        className={`sankey-link series-${link.colour + 1}${lit(link, index) ? ' is-lit' : ''}`}
                        d={link.path}
                        strokeWidth={link.width}
                        onMouseEnter={() => setFocus({ link: index })}
                        onMouseMove={(event) => show(event, `${link.from} → ${link.to}: ${formatValue(link.value)}${unit}`)}
                    />
                ))}
                {layout.nodes.map((node) => (
                    <g
                        key={node.name}
                        className={`sankey-node series-${node.colour + 1}${focus && 'node' in focus && focus.node === node.name ? ' is-lit' : ''}`}
                        onMouseEnter={() => setFocus({ node: node.name })}
                        onMouseMove={(event) => show(event, `${node.name}: ${formatValue(node.value)}${unit}`)}
                    >
                        <rect x={node.x0} y={node.y0} width={node.x1 - node.x0} height={Math.max(1, node.y1 - node.y0)} />
                        <text
                            x={node.labelLeft ? node.x0 - 6 : node.x1 + 6}
                            y={(node.y0 + node.y1) / 2 + 4}
                            textAnchor={node.labelLeft ? 'end' : 'start'}
                        >
                            {node.name} <tspan className="sankey-value">{formatValue(node.value)}</tspan>
                        </text>
                    </g>
                ))}
            </svg>
        </ChartFrame>
    );
}
