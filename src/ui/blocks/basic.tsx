import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { type BlockConfigs, cellText, checklistItemKey } from '../../shared/blocks';
import { assetUrl, type CodeExcerpt, fetchExcerpt, RequestError } from '../api';
import { CodeViewer } from '../code/CodeViewer';
import { resolveLanguage } from '../code/highlight';
import { commentOnWhole } from '../comments/composer';
import { LinkedText, QuestionLink } from '../components/LinkedText';
import { InlineMarkdown, Markdown } from '../components/Markdown';
import { formatValue } from '../format';
import { useReducedMotion } from '../hooks';
import { useReadOnly } from '../readOnly';
import { deepEqual, useSelector } from '../store';
import { quietly, useActions, useBusy } from '../ui';
import type { BlockProps } from './Block';
import { stagger } from './stagger';

/** Prose, rendered from the markdown subset as React elements. */
export function TextBlock({ config }: BlockProps<'text'>) {
    return (
        <div className="prose">
            <Markdown source={config.body} />
        </div>
    );
}

const TONE_LABELS = { note: 'NOTE', decision: 'DECISION', assumption: 'ASSUMPTION', risk: 'RISK' } as const;

/** A decision, note, risk or assumption. In the write-up an assumption can be confirmed or corrected. */
export function CalloutBlock({ id, config, placement }: BlockProps<'callout'>) {
    const { send } = useActions();
    const readOnly = useReadOnly();
    const [busy, track] = useBusy();
    const confirmed = useSelector(
        (view) => view.blocks[id] !== undefined && view.confirmedAssumptions[id] === view.blocks[id]!.version
    );
    const assumption = config.tone === 'assumption' && placement === 'writeup';
    return (
        <div className={`callout callout-${config.tone}`}>
            <div className="callout-text">
                <span className="callout-eyebrow">{TONE_LABELS[config.tone]}</span>
                {config.title && <span className="callout-title">{config.title}</span>}
                {config.body && (
                    <span className="callout-body">
                        <LinkedText text={config.body} />
                    </span>
                )}
            </div>
            {assumption &&
                (confirmed ? (
                    <span className="badge badge-answered">Confirmed</span>
                ) : (
                    !readOnly && (
                        <div className="row callout-actions">
                            <button
                                type="button"
                                className="button-secondary button-small"
                                onClick={() => commentOnWhole(`block:${id}`, 'change')}
                            >
                                Correct it
                            </button>
                            <button
                                type="button"
                                className="button-primary button-small"
                                disabled={busy}
                                onClick={() => quietly(track(send({ type: 'assumption.confirm', blockId: id })))}
                            >
                                Confirm
                            </button>
                        </div>
                    )
                ))}
        </div>
    );
}

/** A checklist; an interactive one in the write-up is ticked in place and each tick reaches the agent. */
export function ChecklistBlock({ id, config, placement }: BlockProps<'checklist'>) {
    const ticks = useSelector((view) => view.checklistTicks[id], deepEqual);
    const { send } = useActions();
    const readOnly = useReadOnly();
    const interactive = config.interactive && placement === 'writeup' && !readOnly;
    const items = config.items.map((item, index) => {
        const key = checklistItemKey(item, index);
        return { key, text: item.text, done: ticks?.[key] ?? item.done ?? false };
    });
    const done = items.filter((item) => item.done).length;
    return (
        <div className="checklist">
            {items.map((item) => (
                <label key={item.key} className="checklist-item">
                    <input
                        type="checkbox"
                        checked={item.done}
                        disabled={!interactive}
                        onChange={(event) =>
                            quietly(send({ type: 'checklist.tick', blockId: id, item: item.key, done: event.target.checked }))
                        }
                    />
                    <span>
                        <LinkedText text={item.text} />
                    </span>
                </label>
            ))}
            {config.interactive && (
                <span className="checklist-count">
                    {done} of {items.length} agreed
                </span>
            )}
        </div>
    );
}

type Cell = BlockConfigs['table']['rows'][number][number];

/** Order two cells by the text the user reads: numerically when both are numbers, else as natural-order strings. */
function compareCells(a: Cell, b: Cell): number {
    const [x, y] = [cellText(a), cellText(b)];
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x).localeCompare(String(y), undefined, { numeric: true });
}

/** A sortable table; string cells are inline markdown, `{ text, tone }` cells are badges, and the ref column's question ids are links. */
export function TableBlock({ config }: BlockProps<'table'>) {
    const [sort, setSort] = useState<{ column: number; direction: 1 | -1 } | undefined>();
    const rows = useMemo(() => {
        if (!sort) return config.rows;
        return [...config.rows].sort((a, b) => compareCells(a[sort.column] ?? null, b[sort.column] ?? null) * sort.direction);
    }, [config.rows, sort]);
    const cell = (value: Cell, column: number) => {
        if (column === config.refColumn && typeof value === 'string') {
            const ids = value.match(/Q-\d{1,4}/g);
            if (ids) return ids.map((ref) => <QuestionLink key={ref} id={ref} />);
        }
        if (value === null) return null;
        if (typeof value === 'number') return formatValue(value);
        if (typeof value === 'string') return <InlineMarkdown source={value} />;
        return (
            <span className={`badge badge-${value.tone}`}>
                <LinkedText text={value.text} />
            </span>
        );
    };
    return (
        <div className="table-wrap">
            <table className="data-table">
                <thead>
                    <tr>
                        {config.columns.map((column, index) => {
                            const active = sort?.column === index;
                            return (
                                <th
                                    key={column}
                                    aria-sort={active ? (sort.direction === 1 ? 'ascending' : 'descending') : 'none'}
                                >
                                    <button
                                        type="button"
                                        className="sort-button"
                                        onClick={() =>
                                            setSort(
                                                active && sort.direction === -1
                                                    ? undefined
                                                    : { column: index, direction: active ? -1 : 1 }
                                            )
                                        }
                                    >
                                        {column}
                                        <span aria-hidden="true">{active ? (sort.direction === 1 ? ' ↑' : ' ↓') : ''}</span>
                                    </button>
                                </th>
                            );
                        })}
                    </tr>
                </thead>
                <tbody>
                    {rows.map((row, rowIndex) => (
                        <tr key={rowIndex}>
                            {row.map((value, column) => (
                                <td key={column} className={column === 0 ? 'strong' : undefined}>
                                    {cell(value, column)}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

/** Up to four toned figures side by side. */
export function StatsBlock({ config }: BlockProps<'stats'>) {
    return (
        <div className="stats" style={{ gridTemplateColumns: `repeat(${config.items.length}, minmax(0, 1fr))` }}>
            {config.items.map((item) => (
                <div key={item.label} className={`stat stat-${item.tone}`}>
                    <span className="stat-value">{formatValue(item.value)}</span>
                    <span className="stat-label">{item.label}</span>
                </div>
            ))}
        </div>
    );
}

/** Steps in a row, marked done, current or future against `current`; with no `current`, every step is future. */
export function TimelineBlock({ config }: BlockProps<'timeline'>) {
    return (
        <ol className="timeline" style={{ gridTemplateColumns: `repeat(${config.steps.length}, minmax(0, 1fr))` }}>
            {config.steps.map((step, index) => {
                const state =
                    config.current === undefined
                        ? 'future'
                        : index < config.current
                          ? 'done'
                          : index === config.current
                            ? 'current'
                            : 'future';
                return (
                    <li
                        key={`${index}-${step.label}`}
                        className={`timeline-step is-${state}`}
                        aria-current={state === 'current' ? 'step' : undefined}
                    >
                        <span className="timeline-dot" aria-hidden="true" />
                        <span className="timeline-label">{step.label}</span>
                        {step.duration && <span className="timeline-meta">{step.duration}</span>}
                        {step.detail && (
                            <span className="timeline-detail">
                                <LinkedText text={step.detail} />
                            </span>
                        )}
                        {step.exit && <span className="timeline-meta">Exit: {step.exit}</span>}
                    </li>
                );
            })}
        </ol>
    );
}

const CHANGE_LABELS = { added: 'ADDED', modified: 'MODIFIED', removed: 'REMOVED', renamed: 'RENAMED' } as const;

/** File paths with their change marks and notes. */
export function FileTreeBlock({ config }: BlockProps<'fileTree'>) {
    return (
        <div className="file-tree">
            {config.root && <span className="file-root">{config.root}</span>}
            {config.files.map((file) => (
                <div key={file.path} className={`file-row${file.change === 'added' ? ' is-added' : ''}`}>
                    <span className="file-path">{file.path}</span>
                    {file.note && <span className="file-note">{file.note}</span>}
                    {file.change && <span className={`change-mark change-${file.change}`}>{CHANGE_LABELS[file.change]}</span>}
                </div>
            ))}
        </div>
    );
}

/** A tracked file's lines, fetched when the block mounts or its range changes, with a note while loading or on failure. */
function Excerpt({ file, lines, lang, title }: { file: string; lines: string; lang?: string; title: string }) {
    const [state, setState] = useState<{ excerpt?: CodeExcerpt; error?: string }>({});
    useEffect(() => {
        let live = true;
        fetchExcerpt(file, lines).then(
            (excerpt) => live && setState({ excerpt }),
            (error: unknown) =>
                live && setState({ error: error instanceof RequestError ? error.message : 'The excerpt could not be read' })
        );
        return () => {
            live = false;
        };
    }, [file, lines]);
    const source = useMemo(() => state.excerpt?.lines.join('\n'), [state.excerpt]);
    const language = useMemo(
        () => (source === undefined ? undefined : resolveLanguage(source, lang, file)),
        [source, lang, file]
    );
    if (state.error) return <p className="block-note">{state.error}</p>;
    if (!state.excerpt || source === undefined) return <p className="block-note">Reading {file}…</p>;
    return (
        <CodeViewer source={source} start={state.excerpt.start} language={language} title={title} label={`Excerpt of ${file}`} />
    );
}

/** A live excerpt of a tracked file, read by the page so it is never stale, a proposed diff, or a snippet of code. */
export function CodeBlock({ config }: BlockProps<'code'>) {
    const title = [config.file, config.lines?.replace('-', '–')].filter(Boolean).join(' · ') || undefined;
    const source = (config.mode === 'snippet' ? config.source : config.patch) ?? '';
    const language = useMemo(
        () => (config.mode === 'excerpt' ? undefined : resolveLanguage(source, config.lang, config.file)),
        [config.mode, config.lang, config.file, source]
    );
    if (config.mode === 'excerpt' && config.file && config.lines)
        return <Excerpt file={config.file} lines={config.lines} lang={config.lang} title={title ?? config.file} />;
    return config.mode === 'snippet' ? (
        <CodeViewer source={source} language={language} title={title} label={title ?? 'Code'} />
    ) : (
        <CodeViewer source={source} format="diff" language={language} title={title} label="Proposed change" />
    );
}

/** A pin's 22px badge plus its 3px ring. */
const PIN_SIZE = 28;

/** An image from the change's assets with numbered pins; a missing file says so, and a new `src` tries again. */
export function ImageBlock({ config }: BlockProps<'image'>) {
    // Under reduced motion an animated SVG comes still.
    const still = useReducedMotion();
    // Which src failed, so an image re-sent under another name loads afresh rather than keeping the old failure.
    const [failedSrc, setFailedSrc] = useState<string>();
    const failed = failedSrc === config.src;
    const frame = useRef<HTMLDivElement>(null);
    const [size, setSize] = useState<{ width: number; height: number }>();
    useLayoutEffect(() => {
        const element = frame.current;
        if (!element || typeof ResizeObserver === 'undefined') return undefined;
        const observer = new ResizeObserver(() => setSize({ width: element.clientWidth, height: element.clientHeight }));
        observer.observe(element);
        return () => observer.disconnect();
    }, []);
    // Pins that would cover one another step sideways, towards the middle so they stay inside the frame. Pin 1 never moves.
    const shifts = size
        ? stagger(
              config.pins.map((pin) => ({
                  box: {
                      x: pin.x * size.width - PIN_SIZE / 2,
                      y: pin.y * size.height - PIN_SIZE / 2,
                      width: PIN_SIZE,
                      height: PIN_SIZE
                  },
                  step: { x: pin.x > 0.5 ? -PIN_SIZE : PIN_SIZE, y: 0 }
              }))
          ).map((offset) => `translate(${offset.x}px, ${offset.y}px)`)
        : [];
    return (
        <div className="image-block">
            <div className="image-frame" ref={frame}>
                {failed ? (
                    <p className="block-note">
                        {config.src.replace('asset:', '')} is not in the change&apos;s .planroom/assets/ folder.
                    </p>
                ) : (
                    <img src={assetUrl(config.src, still)} alt={config.alt} onError={() => setFailedSrc(config.src)} />
                )}
                {!failed &&
                    config.pins.map((pin, index) => (
                        <span
                            key={index}
                            className="pin"
                            style={{
                                left: `${pin.x * 100}%`,
                                top: `${pin.y * 100}%`,
                                transform: shifts[index]
                            }}
                            aria-hidden="true"
                        >
                            {index + 1}
                        </span>
                    ))}
            </div>
            {config.pins.length > 0 && (
                <ol className="pin-list">
                    {config.pins.map((pin, index) => (
                        <li key={index}>
                            <LinkedText text={pin.text} />
                        </li>
                    ))}
                </ol>
            )}
        </div>
    );
}
