import { useEffect, useMemo, useState } from 'react';
import { documentAt, type Revision } from '../../shared/revisions';
import { BlockView } from '../blocks/Block';
import { Modal } from '../components/Modal';
import { relativeTime } from '../format';
import { useReadOnly } from '../readOnly';
import { deepEqual, useSelector } from '../store';
import { quietly, useActions } from '../ui';
import { diffRevisions, loadRevisions, undoReason } from './revisions';

type Mode = { kind: 'list' } | { kind: 'view'; n: number } | { kind: 'diff'; from: number; to: number };

/** A revision of the write-up, read-only, as it stood after revision `n`. */
function RevisionView({ revisions, n }: { revisions: Revision[]; n: number }) {
    const document = useMemo(() => documentAt(revisions, n), [revisions, n]);
    const sections = [...document.sections.values()].sort((a, b) => a.order - b.order);
    return (
        <div className="history-document">
            {sections.map((section, index) => (
                <section key={section.id} className="doc-section">
                    <h3>
                        <span className="section-number">{index + 1}</span>
                        {section.title}
                    </h3>
                    {section.blocks.map((item) => {
                        const ids = typeof item === 'string' ? [item] : item;
                        const blocks = ids.flatMap((blockId) => {
                            const block = document.blocks.get(blockId);
                            return block ? [<BlockView key={blockId} block={block} placement="history" />] : [];
                        });
                        return typeof item === 'string' ? (
                            blocks
                        ) : (
                            <div key={item.join(' ')} className="section-row">
                                {blocks}
                            </div>
                        );
                    })}
                </section>
            ))}
        </div>
    );
}

/** Two revisions compared: sections and blocks added, removed and changed, with word changes inside each. */
function DiffView({ revisions, from, to }: { revisions: Revision[]; from: number; to: number }) {
    const diffs = useMemo(() => diffRevisions(revisions, from, to), [revisions, from, to]);
    if (diffs.length === 0)
        return (
            <p className="muted">
                No differences between v{from} and v{to}.
            </p>
        );
    return (
        <div className="diff">
            {diffs.map((section) => (
                <section key={section.id} className={`diff-section is-${section.change}`}>
                    <h3>
                        {section.title} <span className={`chip change-chip is-${section.change}`}>{section.change}</span>
                    </h3>
                    {section.blocks.map((block) => (
                        <div key={block.id} className="diff-block">
                            <div className="diff-block-head">
                                <code>{block.id}</code> <span className="muted">({block.type})</span>{' '}
                                <span className={`chip change-chip is-${block.change}`}>{block.change}</span>
                            </div>
                            <pre className="diff-text">
                                {block.parts.map((part, index) =>
                                    part.added ? (
                                        <ins key={index}>{part.value}</ins>
                                    ) : part.removed ? (
                                        <del key={index}>{part.value}</del>
                                    ) : (
                                        <span key={index}>{part.value}</span>
                                    )
                                )}
                            </pre>
                        </div>
                    ))}
                </section>
            ))}
        </div>
    );
}

/** Revision history: every agent edit with its summary, undo, a read-only view of any revision, and a diff of any two. */
export function History({ onClose }: { onClose: () => void }) {
    const { metas, sections } = useSelector((view) => ({ metas: view.revisions, sections: view.sections }), deepEqual);
    const latest = metas[metas.length - 1]?.n ?? 0;
    const [revisions, setRevisions] = useState<Revision[]>();
    const [error, setError] = useState<string>();
    const [mode, setMode] = useState<Mode>({ kind: 'list' });
    const [pair, setPair] = useState({ from: Math.max(1, latest - 1), to: latest });
    const { send } = useActions();
    const readOnly = useReadOnly();

    useEffect(() => {
        loadRevisions(latest).then(setRevisions, () => setError('The revision history could not be loaded.'));
    }, [latest]);

    return (
        <Modal label="Write-up history" onClose={onClose} className="dialog dialog-wide">
            <h2 className="dialog-title">Write-up history</h2>
            {mode.kind !== 'list' && (
                <button type="button" className="button-link" onClick={() => setMode({ kind: 'list' })}>
                    ← All revisions
                </button>
            )}
            {error && <p className="warning-note">{error}</p>}
            {mode.kind === 'list' && (
                <>
                    <form
                        className="diff-picker"
                        onSubmit={(event) => {
                            event.preventDefault();
                            setMode({ kind: 'diff', ...pair });
                        }}
                    >
                        <span className="small">Compare</span>
                        <label className="visually-hidden" htmlFor="diff-from">
                            From revision
                        </label>
                        <select
                            id="diff-from"
                            value={pair.from}
                            onChange={(event) => setPair({ ...pair, from: Number(event.target.value) })}
                        >
                            {metas.map((meta) => (
                                <option key={meta.n} value={meta.n}>
                                    v{meta.n}
                                </option>
                            ))}
                        </select>
                        <span className="small">with</span>
                        <label className="visually-hidden" htmlFor="diff-to">
                            To revision
                        </label>
                        <select
                            id="diff-to"
                            value={pair.to}
                            onChange={(event) => setPair({ ...pair, to: Number(event.target.value) })}
                        >
                            {metas.map((meta) => (
                                <option key={meta.n} value={meta.n}>
                                    v{meta.n}
                                </option>
                            ))}
                        </select>
                        <button
                            type="submit"
                            className="button-secondary button-small"
                            disabled={!revisions || pair.from === pair.to}
                        >
                            Diff
                        </button>
                    </form>
                    <ol className="revision-list">
                        {[...metas].reverse().map((meta) => {
                            const reason = undoReason(metas, meta.n, sections);
                            return (
                                <li key={meta.n} className="revision">
                                    <div className="revision-text">
                                        <span className="strong">
                                            v{meta.n} · {meta.summary}
                                        </span>
                                        <span className="small muted">
                                            {relativeTime(meta.at)}
                                            {meta.undoOf !== undefined ? ` · undoes v${meta.undoOf}` : ''}
                                            {meta.undone ? ' · undone' : ''}
                                        </span>
                                    </div>
                                    <div className="row">
                                        <button
                                            type="button"
                                            className="button-link small"
                                            disabled={!revisions}
                                            onClick={() => setMode({ kind: 'view', n: meta.n })}
                                        >
                                            View
                                        </button>
                                        {meta.n > 1 && (
                                            <button
                                                type="button"
                                                className="button-link small"
                                                disabled={!revisions}
                                                onClick={() => setMode({ kind: 'diff', from: meta.n - 1, to: meta.n })}
                                            >
                                                Diff
                                            </button>
                                        )}
                                        {!readOnly && meta.undoOf === undefined && (
                                            <button
                                                type="button"
                                                className="button-link small"
                                                disabled={reason !== undefined}
                                                title={reason}
                                                onClick={() => quietly(send({ type: 'edit.undo', revision: meta.n }))}
                                            >
                                                Undo edit
                                            </button>
                                        )}
                                        {reason && meta.undoOf === undefined && !meta.undone && (
                                            <span className="small muted">{reason}</span>
                                        )}
                                    </div>
                                </li>
                            );
                        })}
                    </ol>
                </>
            )}
            {mode.kind === 'view' && revisions && (
                <>
                    <p className="small muted">Write-up as of v{mode.n}, read-only.</p>
                    <RevisionView revisions={revisions} n={mode.n} />
                </>
            )}
            {mode.kind === 'diff' && revisions && (
                <>
                    <p className="small muted">
                        Changes from v{Math.min(mode.from, mode.to)} to v{Math.max(mode.from, mode.to)}.
                    </p>
                    <DiffView revisions={revisions} from={Math.min(mode.from, mode.to)} to={Math.max(mode.from, mode.to)} />
                </>
            )}
        </Modal>
    );
}
