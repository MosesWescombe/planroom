import { memo, useEffect, useState } from 'react';
import { barConfig, fileTreeConfig, riskMatrixConfig } from '../../shared/blocks';
import {
    type ChangedFile,
    type CodeAnchor,
    commentBody,
    describeCodeAnchor,
    findingsUnlocked,
    type ItemKind,
    type ItemRecord,
    type RoundRecord,
    roundItems,
    SEVERITIES
} from '../../shared/review';
import { fetchDiff } from '../api';
import { BlockView } from '../blocks/Block';
import { type CodeRow, CodeViewer } from '../code/CodeViewer';
import { resolveLanguage } from '../code/highlight';
import { commentOnWhole } from '../comments/composer';
import { CheckIcon, LockIcon } from '../components/icons';
import { Markdown } from '../components/Markdown';
import { Modal } from '../components/Modal';
import { Rail } from '../components/Rail';
import { plural } from '../format';
import { useReadOnly } from '../readOnly';
import { deepEqual, useRecord, useSelector } from '../store';
import { quietly, useActions, useBusy } from '../ui';
import { BitbucketComment, CommentEditor } from './BitbucketComment';
import { buildTree, commonRoot, type Folder } from './FileTreeSelect';
import { useIsCurrentRound, useShownRound } from './hooks';

/** What each kind of finding is called. */
export const KIND_NAMES: Record<ItemKind, string> = {
    issue: 'Issue',
    opinion: 'Design opinion',
    question: 'Question for the author',
    followup: 'Follow-up'
};

/** The verb a reaction reads as. */
const DONE: Record<string, string> = { agree: 'You agreed', reword: 'You reworded it', reject: 'You rejected it' };

/**
 * Agree, Reword or Reject a finding, or ask the agent about it first in a thread. Agree queues its draft, Reword the
 * reviewer's text, and Reject nothing, with the reason going to the agent.
 */
function Reaction({ item }: { item: ItemRecord }) {
    const reaction = useSelector((view) => view.reactions[item.id], deepEqual);
    const posted = useSelector((view) => view.review?.rounds.at(-1)?.posts[`item:${item.id}`]?.id !== undefined);
    const current = useSelector((view) => view.review?.rounds.at(-1)?.n === item.round);
    const readOnly = useReadOnly();
    const { send } = useActions();
    const [busy, track] = useBusy();
    const [mode, setMode] = useState<'reword' | 'reject'>();
    const [text, setText] = useState(reaction?.text ?? item.draft);
    const [reason, setReason] = useState(reaction?.reason ?? '');
    const react = (request: { verdict: 'agree' | 'reword' | 'reject'; text?: string; reason?: string }) =>
        quietly(track(send({ type: 'item.react', itemId: item.id, ...request })).then(() => setMode(undefined)));
    /** The chosen reaction's button stands out. */
    const look = (verdict: string) =>
        reaction?.verdict === verdict ? 'button-primary button-small' : 'button-secondary button-small';
    const status = reaction && (
        <p className={`reaction-status is-${reaction.verdict}`} role="status">
            <CheckIcon /> {DONE[reaction.verdict]}
            {reaction.verdict === 'reject' && reaction.reason ? `: ${reaction.reason}` : '.'}
            {reaction.itemVersion < item.version && <span className="chip chip-attention">changed since you reacted</span>}
        </p>
    );
    if (readOnly || !current || posted) return status ?? null;
    return (
        <div className="reaction">
            {status}
            <div className="row reaction-buttons">
                <button
                    type="button"
                    className={look('agree')}
                    aria-pressed={reaction?.verdict === 'agree'}
                    disabled={busy}
                    onClick={() => react({ verdict: 'agree' })}
                >
                    Agree
                </button>
                <button
                    type="button"
                    className={look('reword')}
                    aria-pressed={reaction?.verdict === 'reword'}
                    aria-expanded={mode === 'reword'}
                    onClick={() => setMode(mode === 'reword' ? undefined : 'reword')}
                >
                    Reword
                </button>
                <button
                    type="button"
                    className={look('reject')}
                    aria-pressed={reaction?.verdict === 'reject'}
                    aria-expanded={mode === 'reject'}
                    onClick={() => setMode(mode === 'reject' ? undefined : 'reject')}
                >
                    Reject
                </button>
                <button type="button" className="button-link" onClick={() => commentOnWhole(`item:${item.id}`, 'question')}>
                    Ask the agent
                </button>
            </div>
            {mode === 'reword' && (
                <form
                    className="reaction-form"
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (text.trim()) react({ verdict: 'reword', text });
                    }}
                >
                    <CommentEditor
                        id={`reword-${item.id}`}
                        label="The comment in your words"
                        value={text}
                        signed
                        onChange={setText}
                    />
                    <button type="submit" className="button-primary button-small" disabled={busy || !text.trim()}>
                        Use my wording
                    </button>
                </form>
            )}
            {mode === 'reject' && (
                <form
                    className="reaction-form"
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (reason.trim()) react({ verdict: 'reject', reason });
                    }}
                >
                    <label className="field-label" htmlFor={`reject-${item.id}`}>
                        Why? The agent reads this and may soften related findings.
                    </label>
                    <textarea
                        id={`reject-${item.id}`}
                        rows={2}
                        value={reason}
                        onChange={(event) => setReason(event.target.value)}
                    />
                    <button type="submit" className="button-primary button-small" disabled={busy || !reason.trim()}>
                        Reject it
                    </button>
                </form>
            )}
        </div>
    );
}

/** A labelled piece of a finding, in Markdown. */
function Part({ label, text }: { label: string; text: string | undefined }) {
    if (!text) return null;
    return (
        <div className="finding-part">
            <span className="small strong">{label}</span>
            <div className="prose">
                <Markdown source={text} />
            </div>
        </div>
    );
}

/** Where a finding sits in the code, which opens its file's diff over the page at the finding's lines. */
function AnchorLink({ item, anchor }: { item: ItemRecord; anchor: CodeAnchor }) {
    const [open, setOpen] = useState(false);
    const where = describeCodeAnchor(anchor);
    return (
        <>
            <button
                type="button"
                className="finding-anchor"
                aria-label={`Show the change at ${where}`}
                title="Show the change"
                onClick={() => setOpen(true)}
            >
                <code>{where}</code>
            </button>
            {open && (
                <Modal label={`The change at ${where}`} onClose={() => setOpen(false)} className="dialog dialog-wide">
                    <h2 className="dialog-title">The change it sits on</h2>
                    <FileDiff round={item.round} path={anchor.file} items={[item]} focus={item.id} />
                </Modal>
            )}
        </>
    );
}

/** The comment a finding drafts, opened over the page as Bitbucket will show it once agreed. */
function DraftPreview({ item }: { item: ItemRecord }) {
    const [open, setOpen] = useState(false);
    return (
        <>
            <button type="button" className="button-link small finding-draft" onClick={() => setOpen(true)}>
                See the comment it drafts
            </button>
            {open && (
                <Modal label={`The comment ${item.id} drafts`} onClose={() => setOpen(false)} className="dialog dialog-wide">
                    <h2 className="dialog-title">The comment it drafts</h2>
                    <BitbucketComment round={item.round} anchor={item.anchor} body={commentBody(item.draft, true)} />
                </Modal>
            )}
        </>
    );
}

/**
 * One finding: its kind, severity and confidence, what it says, where it sits, the blocks that give it context, the
 * comment it drafts, and its reaction.
 */
const Finding = memo(function Finding({ id }: { id: string }) {
    const item = useRecord('items', id);
    const earlier = useSelector((view) => {
        const replyTo = view.items[id]?.replyTo;
        return replyTo ? view.review?.rounds.at(-1)?.earlier[replyTo]?.post.body : undefined;
    });
    if (!item) return null;
    return (
        <article id={`item-${id}`} className={`finding is-${item.kind}${item.severity ? ` is-${item.severity}` : ''}`}>
            <div className="finding-meta">
                <span className="badge badge-kind">{KIND_NAMES[item.kind]}</span>
                {item.severity && <span className={`badge severity-${item.severity}`}>{item.severity}</span>}
                {item.dimension && <span className="chip">{item.dimension}</span>}
                <span className="small muted">{Math.round(item.confidence * 100)}% confidence</span>
                <span className="mono small muted">{item.id}</span>
            </div>
            <h3 className="finding-title">
                <span data-anchor-target={`item:${id}`}>{item.title}</span>
            </h3>
            {item.anchor && <AnchorLink item={item} anchor={item.anchor} />}
            <div className="prose">
                <Markdown source={item.body} />
            </div>
            {item.blocks && item.blocks.length > 0 && (
                <div className="finding-part">
                    <span className="small strong">Context</span>
                    {item.blocks.map((block, index) => (
                        <BlockView key={index} block={{ ...block, id: `${item.id}-context-${index}` }} placement="question" />
                    ))}
                </div>
            )}
            {earlier && <Part label="Replying to your earlier comment" text={earlier} />}
            <Part label="Evidence" text={item.evidence} />
            <Part label="Suggested fix" text={item.suggestion} />
            {item.likelihood !== undefined && item.impact !== undefined && (
                <span className="small muted">
                    Likelihood {item.likelihood} of 3 · impact {item.impact} of 3
                </span>
            )}
            <Part label="Reasoning" text={item.reasoning} />
            <Part label="The alternative weighed" text={item.alternative} />
            <DraftPreview item={item} />
            <Reaction item={item} />
        </article>
    );
});

/** Whether `row` is the line a finding's comment sits under: the last line of its range, on its side. */
function onRow(item: ItemRecord, row: CodeRow): boolean {
    const { anchor } = item;
    if (!anchor?.start) return false;
    const line = anchor.end ?? anchor.start;
    return anchor.side === 'old' ? row.kind !== 'add' && row.oldNumber === line : row.kind !== 'remove' && row.number === line;
}

/** Scroll a finding's card into the middle of the view once it renders. */
const scrollToCard = (node: HTMLElement | null) => node?.scrollIntoView?.({ block: 'center' });

/**
 * A changed file's diff, fetched when opened, with the findings on it as cards under their lines. The `focus` finding's
 * card is scrolled to once the diff renders.
 */
function FileDiff({ round, path, items, focus }: { round: number; path: string; items: ItemRecord[]; focus?: string }) {
    const [patch, setPatch] = useState<string>();
    const [error, setError] = useState<string>();
    const { goTo } = useActions();
    useEffect(() => {
        let live = true;
        fetchDiff(round, path).then(
            (text) => live && setPatch(text),
            (caught: unknown) => live && setError(caught instanceof Error ? caught.message : 'The diff could not be read')
        );
        return () => {
            live = false;
        };
    }, [round, path]);
    if (error) return <p className="block-note">{error}</p>;
    if (patch === undefined) return <p className="block-note">Reading the diff of {path}…</p>;
    if (!patch.trim()) return <p className="block-note">No line changes: a rename or a binary file.</p>;
    return (
        <CodeViewer
            source={patch}
            format="diff"
            language={resolveLanguage(patch, undefined, path)}
            title={path}
            label={`Diff of ${path}`}
            notes={(row) => {
                const here = items.filter((item) => item.anchor?.file === path && onRow(item, row));
                return here.length
                    ? here.map((item) => (
                          <button
                              key={item.id}
                              ref={item.id === focus ? scrollToCard : undefined}
                              type="button"
                              className="diff-card"
                              onClick={() => goTo(`item:${item.id}`)}
                          >
                              <span className="badge badge-kind">{KIND_NAMES[item.kind]}</span>
                              {item.severity && <span className={`badge severity-${item.severity}`}>{item.severity}</span>}
                              <span className="strong">{item.title}</span>
                          </button>
                      ))
                    : null;
            }}
        />
    );
}

/** One changed file, its diff fetched once opened, with how many findings sit on it. */
function FileEntry({ round, file, name, items }: { round: number; file: ChangedFile; name: string; items: ItemRecord[] }) {
    const [shown, setShown] = useState(false);
    const count = items.filter((item) => item.anchor?.file === file.path).length;
    return (
        <details className="review-file" onToggle={(event) => setShown(event.currentTarget.open)}>
            <summary>
                <span className="file-path">{name}</span>
                <span className="mono small change-add">+{file.additions}</span>
                <span className="mono small change-remove">−{file.deletions}</span>
                {count > 0 && <span className="count">{count}</span>}
            </summary>
            {shown && <FileDiff round={round} path={file.path} items={items} />}
        </details>
    );
}

/** A folder of changed files, open by default and collapsible, with its subfolders and files indented under it. */
function FolderEntry({
    folder,
    round,
    byPath,
    items
}: {
    folder: Folder;
    round: number;
    byPath: ReadonlyMap<string, ChangedFile>;
    items: ItemRecord[];
}) {
    return (
        <>
            {folder.folders.map((child) => (
                <details key={child.name} className="review-folder" open>
                    <summary>
                        <span className="file-path">{child.name}/</span>
                    </summary>
                    <div className="review-folder-body">
                        <FolderEntry folder={child} round={round} byPath={byPath} items={items} />
                    </div>
                </details>
            ))}
            {folder.files.map(({ name, path }) => (
                <FileEntry key={path} round={round} file={byPath.get(path)!} name={name} items={items} />
            ))}
        </>
    );
}

/** The changed files as a tree of collapsible folders from their common root, each file's diff opened on demand. */
function Files({ round, items }: { round: RoundRecord; items: ItemRecord[] }) {
    const paths = round.files.map((file) => file.path);
    const root = commonRoot(paths);
    const byPath = new Map(round.files.map((file) => [file.path, file]));
    return (
        <section className="review-files" aria-label="The diff">
            <h2 className="eyebrow">The diff, with the findings beside their lines</h2>
            {root.length > 0 && <div className="mono small muted">{root.join('/')}/</div>}
            <FolderEntry folder={buildTree(paths, root)} round={round.n} byPath={byPath} items={items} />
        </section>
    );
}

/** A chart, matrix or tree the page draws from the findings, framed and captioned like any block. */
function Derived({ id, type, config, caption }: { id: string; type: string; config: Record<string, unknown>; caption: string }) {
    return <BlockView block={{ id, type, config, caption }} placement="history" />;
}

/** The findings as charts, a risk matrix and a file heat map, each shown while its view is on. */
function Views({ round, items }: { round: RoundRecord; items: ItemRecord[] }) {
    const views = useSelector((view) => view.preferences?.views, deepEqual);
    const issues = items.filter((item) => item.kind === 'issue');
    const kinds: ItemKind[] = ['issue', 'opinion', 'question', 'followup'];
    const shownKinds = kinds.filter((kind) => kind !== 'followup' || items.some((item) => item.kind === kind));
    const charts = views?.charts !== false && items.length > 0;
    const matrix = views?.matrix !== false && issues.some((item) => item.likelihood && item.impact);
    return (
        <div className="review-views">
            {charts && (
                <div className="section-row">
                    <Derived
                        id="findings-severity"
                        caption="Issues by severity"
                        type="bar"
                        config={barConfig.parse({
                            series: ['Issues'],
                            data: SEVERITIES.map((severity) => [
                                severity[0]!.toUpperCase() + severity.slice(1),
                                issues.filter((item) => item.severity === severity).length
                            ])
                        })}
                    />
                    <Derived
                        id="findings-kind"
                        caption="Findings by kind"
                        type="bar"
                        config={barConfig.parse({
                            series: ['Findings'],
                            data: shownKinds.map((kind) => [KIND_NAMES[kind], items.filter((item) => item.kind === kind).length])
                        })}
                    />
                </div>
            )}
            {matrix && (
                <Derived
                    id="findings-risk"
                    caption="The issues by likelihood and impact"
                    type="riskMatrix"
                    config={riskMatrixConfig.parse({
                        items: issues
                            .filter((item) => item.likelihood && item.impact)
                            .slice(0, 20)
                            .map((item) => ({
                                label: `${item.id} ${item.title}`,
                                likelihood: item.likelihood,
                                impact: item.impact
                            }))
                    })}
                />
            )}
            {views?.heatmap !== false && round.files.length > 0 && (
                <Derived
                    id="findings-files"
                    caption="Findings by changed file"
                    type="fileTree"
                    config={fileTreeConfig.parse({
                        files: round.files.slice(0, 200).map((file) => {
                            const count = items.filter((item) => item.anchor?.file === file.path).length;
                            return { path: file.path, change: file.status, ...(count ? { note: plural(count, 'finding') } : {}) };
                        })
                    })}
                />
            )}
        </div>
    );
}

/** The rail: every finding by kind, marked once reacted to. */
function FindingList({ round }: { round: RoundRecord }) {
    const entries = useSelector(
        (view) =>
            roundItems(view, round.n).map((item) => ({
                id: item.id,
                kind: item.kind,
                title: item.title,
                reacted: view.reactions[item.id]?.verdict
            })),
        deepEqual
    );
    const { goTo } = useActions();
    if (!findingsUnlocked(round))
        return (
            <nav className="rail" aria-label="Findings">
                <div className="nav-heading">FINDINGS</div>
                <p className="small muted">They show once you finish or skip the walkthrough.</p>
            </nav>
        );
    return (
        <nav className="rail" aria-label="Findings">
            <div className="nav-heading">
                FINDINGS{' '}
                <span className="mono">
                    {entries.filter((entry) => entry.reacted).length}/{entries.length}
                </span>
            </div>
            <ol className="contents">
                {entries.map((entry) => (
                    <li key={entry.id}>
                        <button type="button" className="nav-item" onClick={() => goTo(`item:${entry.id}`)}>
                            <span className="mono muted contents-number">{entry.id}</span>
                            <span className="nav-name">{entry.title}</span>
                            {entry.reacted && (
                                <span className="state-mark state-answered" role="img" aria-label={`you chose ${entry.reacted}`}>
                                    <CheckIcon size={9} />
                                </span>
                            )}
                        </button>
                    </li>
                ))}
            </ol>
        </nav>
    );
}

/** Before the walkthrough is done: nothing of the findings, and the ways to get to them. */
function Locked({ round }: { round: RoundRecord }) {
    const { setTab, send } = useActions();
    const current = useIsCurrentRound(round);
    const readOnly = useReadOnly();
    const [busy, track] = useBusy();
    return (
        <div className="locked">
            <LockIcon size={18} />
            <h1>The findings come after the walkthrough</h1>
            <p className="lede">
                Read the change and give your own take first, so you judge the agent's findings rather than nod along. They unlock
                when you finish the walkthrough, or skip to them.
            </p>
            <div className="row">
                <button type="button" className="button-secondary" onClick={() => setTab('walkthrough')}>
                    Back to the walkthrough
                </button>
                {current && !readOnly && round.publishedAt && (
                    <button
                        type="button"
                        className="button-link"
                        disabled={busy}
                        onClick={() => quietly(track(send({ type: 'walkthrough.done', how: 'skipped' })))}
                    >
                        Skip to findings
                    </button>
                )}
            </div>
        </div>
    );
}

/**
 * The Review tab: locked until the walkthrough is finished or skipped, then every verified finding with its reaction,
 * and the views the reviewer keeps on: charts, the risk matrix, the file heat map and the diff with cards beside lines.
 */
export function Findings() {
    const round = useShownRound();
    const items = useSelector((view) => roundItems(view, round.n), deepEqual);
    const reacted = useSelector((view) => items.filter((item) => view.reactions[item.id]).length);
    const diff = useSelector((view) => view.preferences?.views.diff !== false);
    const unlocked = findingsUnlocked(round);
    return (
        <>
            <Rail>
                <FindingList round={round} />
            </Rail>
            <main className="main" id="main">
                <div className="main-inner">
                    {!unlocked ? (
                        <Locked round={round} />
                    ) : (
                        <>
                            <header className="page-head">
                                <div className="eyebrow">
                                    Review · round {round.n}
                                    <span className="mono">
                                        {' '}
                                        · {reacted} of {plural(items.length, 'finding')} reacted to
                                    </span>
                                </div>
                                <h1>What the review found</h1>
                                <p className="lede">
                                    Each finding survived a pass that tried to refute it. Agree, reword or reject each one, or ask
                                    the agent about it first: only what you agree with or reword becomes a comment.
                                </p>
                            </header>
                            {items.length === 0 ? (
                                round.progress?.reviewedAt ? (
                                    <p className="muted">
                                        The review is done and found nothing to raise. The diff is below if you want to look
                                        yourself.
                                    </p>
                                ) : (
                                    <p className="muted">
                                        The agent's review is still running. Findings appear here as it verifies them.
                                    </p>
                                )
                            ) : (
                                <>
                                    <Views round={round} items={items} />
                                    {items.map((item) => (
                                        <Finding key={item.id} id={item.id} />
                                    ))}
                                </>
                            )}
                            {diff && <Files round={round} items={items} />}
                        </>
                    )}
                </div>
            </main>
        </>
    );
}
