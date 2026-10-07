import { useId, useState } from 'react';
import type { ImpactMapConfig } from '../../shared/blocks';
import { blockIdsOf } from '../../shared/records';
import type { ImpactConcerns } from '../../shared/review';
import type { PageInput } from '../api';
import { CloseIcon } from '../components/icons';
import { usePrinting } from '../hooks';
import { useReadOnly } from '../readOnly';
import { deepEqual, useRecord, useSelector } from '../store';
import { useActions } from '../ui';
import { type BlockProps, BlockView } from './Block';

/** The most concerns under one area, and the most areas the reviewer adds, as the page request allows. */
const MAX_CONCERNS = 20;
const MAX_ADDED = 6;

/** The impact map's saves, one after another, so the server stores them in the order they were made. */
let saving: Promise<unknown> = Promise.resolve();

/** Send the reviewer's concerns to the agent once every save before it has landed, so none is left behind. */
export function sendImpact(send: (request: PageInput) => Promise<unknown>): Promise<unknown> {
    const sent = saving.then(() => send({ type: 'impact.send' }));
    saving = sent.catch(() => undefined);
    return sent;
}

/** Where each of `count` areas sits around the change, in percent of the map: clockwise from the top. */
function place(index: number, count: number): { x: number; y: number } {
    const angle = -Math.PI / 2 + (2 * Math.PI * index) / count;
    return { x: 50 + 38 * Math.cos(angle), y: 50 + 36 * Math.sin(angle) };
}

/** One block that explains an area, as it renders on a slide. */
function AreaBlock({ id }: { id: string }) {
    const block = useRecord('blocks', id);
    return block ? <BlockView block={block} placement="slide" /> : null;
}

/** The reviewer's questions and concerns under an area: a list, and while it is open, a box to add to it. */
function Concerns({
    area,
    concerns,
    editable,
    onChange
}: {
    area: string;
    concerns: string[];
    editable: boolean;
    onChange: (concerns: string[]) => void;
}) {
    const [text, setText] = useState('');
    const full = concerns.length >= MAX_CONCERNS;
    // Leaving the box adds what it holds, so moving on from the slide never drops a concern typed but not added.
    const add = () => {
        const concern = text.trim();
        if (!concern || full) return;
        onChange([...concerns, concern]);
        setText('');
    };
    return (
        <div className="impact-concerns">
            <span className="small strong">Your questions and concerns</span>
            {concerns.length > 0 ? (
                <ul className="concern-list">
                    {concerns.map((concern, index) => (
                        <li key={`${index}-${concern}`}>
                            <span>{concern}</span>
                            {editable && (
                                <button
                                    type="button"
                                    className="icon-button tiny"
                                    aria-label={`Remove "${concern}"`}
                                    onClick={() => onChange(concerns.filter((_, other) => other !== index))}
                                >
                                    <CloseIcon size={12} />
                                </button>
                            )}
                        </li>
                    ))}
                </ul>
            ) : (
                !editable && <span className="small muted">None.</span>
            )}
            {editable && (
                <form
                    className="row concern-form"
                    onSubmit={(event) => {
                        event.preventDefault();
                        add();
                    }}
                >
                    <input
                        className="field-input"
                        aria-label={`A question or concern about ${area}`}
                        placeholder="Add a question or concern"
                        maxLength={1000}
                        value={text}
                        onChange={(event) => setText(event.target.value)}
                        onBlur={add}
                    />
                    <button type="submit" className="button-secondary button-small" disabled={!text.trim() || full}>
                        Add
                    </button>
                </form>
            )}
        </div>
    );
}

/** An area opened from the map: how the change reaches it, the blocks that show it, and the reviewer's concerns. */
function AreaPanel({
    title,
    summary,
    blocks = [],
    concerns,
    editable,
    onChange,
    onRemove
}: {
    title: string;
    summary?: string;
    blocks?: string[];
    concerns: string[];
    editable: boolean;
    onChange: (concerns: string[]) => void;
    onRemove?: () => void;
}) {
    return (
        <section className="impact-panel" aria-label={title}>
            <h3 className="impact-title">{title}</h3>
            {summary ? <p>{summary}</p> : <p className="small muted">An area you added.</p>}
            {blocks.map((id) => (
                <AreaBlock key={id} id={id} />
            ))}
            <Concerns area={title} concerns={concerns} editable={editable} onChange={onChange} />
            {onRemove && editable && (
                <button type="button" className="button-link small impact-remove" onClick={onRemove}>
                    Remove this area
                </button>
            )}
        </section>
    );
}

/** A row to add an area the agent missed. */
function AddArea({ disabled, onAdd }: { disabled: boolean; onAdd: (title: string) => void }) {
    const [title, setTitle] = useState('');
    return (
        <form
            className="row concern-form"
            onSubmit={(event) => {
                event.preventDefault();
                if (!title.trim()) return;
                onAdd(title.trim());
                setTitle('');
            }}
        >
            <input
                className="field-input"
                aria-label="An area the agent missed"
                placeholder="An area the agent missed"
                maxLength={80}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
            />
            <button type="submit" className="button-secondary button-small" disabled={disabled || !title.trim()}>
                Add an area
            </button>
        </form>
    );
}

/** The areas, the agent's and the reviewer's, keyed for the map: an agent area by its id, an added one by `added:<n>`. */
function nodesOf(areas: ImpactMapConfig['areas'], mine: ImpactConcerns) {
    return [
        ...areas.map((area) => ({ key: area.id, title: area.title, count: mine.concerns[area.id]?.length ?? 0, added: false })),
        ...mine.added.map((area, index) => ({
            key: `added:${index}`,
            title: area.title,
            count: area.concerns.length,
            added: true
        }))
    ];
}

/**
 * `impactMap`: the areas the change might reach, drawn around it. Opening one shows how the change reaches it, the
 * blocks that explain it and the reviewer's questions and concerns under it, which they add to, with areas of their
 * own, until they move on from the slide: that sends them all to the agent. Printed, every area shows open.
 */
export function ImpactMapBlock({ id, config, placement }: BlockProps<'impactMap'>) {
    const round = useSelector((view) => {
        const n = Object.values(view.slides).find((slide) => blockIdsOf(slide).includes(id))?.round;
        const record = view.review?.rounds.find((candidate) => candidate.n === n);
        return (
            record && { publishedAt: record.publishedAt, impact: record.impact, current: view.review?.rounds.at(-1) === record }
        );
    }, deepEqual);
    const readOnly = useReadOnly();
    const printing = usePrinting();
    const { send } = useActions();
    const panel = useId();
    const saved: ImpactConcerns = { concerns: round?.impact?.concerns ?? {}, added: round?.impact?.added ?? [] };
    const editable =
        placement === 'slide' && !readOnly && !printing && Boolean(round?.current && round.publishedAt && !round.impact?.sentAt);
    // The reviewer is the only writer, so while they edit, their copy leads and each change is saved behind it.
    const [draft, setDraft] = useState(saved);
    const mine = editable ? draft : saved;
    const [open, setOpen] = useState<string>();
    const update = (next: ImpactConcerns) => {
        setDraft(next);
        saving = saving.then(() => send({ type: 'impact.save', ...next })).catch(() => undefined);
    };
    const setConcerns = (key: string, concerns: string[]) => {
        if (key.startsWith('added:')) {
            const at = Number(key.slice(6));
            update({ ...mine, added: mine.added.map((area, index) => (index === at ? { ...area, concerns } : area)) });
        } else update({ ...mine, concerns: { ...mine.concerns, [key]: concerns } });
    };
    const nodes = nodesOf(config.areas, mine);

    const panelFor = (key: string) => {
        const area = config.areas.find((candidate) => candidate.id === key);
        if (area)
            return (
                <AreaPanel
                    key={key}
                    title={area.title}
                    summary={area.summary}
                    blocks={area.blocks}
                    concerns={mine.concerns[key] ?? []}
                    editable={editable}
                    onChange={(concerns) => setConcerns(key, concerns)}
                />
            );
        const at = Number(key.slice(6));
        const added = mine.added[at];
        if (!added) return null;
        return (
            <AreaPanel
                key={key}
                title={added.title}
                concerns={added.concerns}
                editable={editable}
                onChange={(concerns) => setConcerns(key, concerns)}
                onRemove={() => {
                    update({ ...mine, added: mine.added.filter((_, index) => index !== at) });
                    setOpen(undefined);
                }}
            />
        );
    };

    return (
        <div className="impact">
            <div className="impact-map" role="group" aria-label="The areas this change might reach">
                <svg className="impact-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                    {nodes.map((node, index) => {
                        const at = place(index, nodes.length);
                        return <line key={node.key} x1={50} y1={50} x2={at.x} y2={at.y} />;
                    })}
                </svg>
                <span className="impact-center">This change</span>
                {nodes.map((node, index) => {
                    const at = place(index, nodes.length);
                    return (
                        <button
                            key={node.key}
                            type="button"
                            className={`impact-node${node.added ? ' is-added' : ''}`}
                            style={{ left: `${at.x}%`, top: `${at.y}%` }}
                            aria-pressed={open === node.key}
                            aria-controls={panel}
                            onClick={() => setOpen(open === node.key ? undefined : node.key)}
                        >
                            <span>{node.title}</span>
                            {node.count > 0 && (
                                <span className="count" title={`${node.count} of your questions and concerns`}>
                                    {node.count}
                                </span>
                            )}
                        </button>
                    );
                })}
            </div>
            {editable && (
                <AddArea
                    disabled={mine.added.length >= MAX_ADDED}
                    onAdd={(title) => {
                        update({ ...mine, added: [...mine.added, { title, concerns: [] }] });
                        setOpen(`added:${mine.added.length}`);
                    }}
                />
            )}
            <div id={panel} className="impact-panels">
                {printing ? (
                    nodes.map((node) => panelFor(node.key))
                ) : open ? (
                    panelFor(open)
                ) : (
                    <p className="small muted">
                        Open an area to see how the change reaches it{editable ? ' and add your questions or concerns' : ''}.
                    </p>
                )}
            </div>
            {placement === 'slide' && (
                <p className="small muted">
                    {round?.impact?.sentAt
                        ? 'Sent to the agent, which looks into each area and answers your concerns in Trade-offs.'
                        : editable
                          ? 'Moving on to the next slide sends your questions and concerns to the agent.'
                          : ''}
                </p>
            )}
        </div>
    );
}
