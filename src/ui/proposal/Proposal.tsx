import groupBy from 'lodash/groupBy';
import { Fragment, memo, useState } from 'react';
import { checkCommand } from '../../shared/derive';
import { countDelta } from '../../shared/specDelta';
import type { ProposalFile } from '../../shared/view';
import { EndSessionButton } from '../components/EndSession';
import { CheckIcon, FolderIcon, WarningIcon } from '../components/icons';
import { Markdown } from '../components/Markdown';
import { Rail } from '../components/Rail';
import { plural } from '../format';
import { useReadOnly } from '../readOnly';
import { deepEqual, useSelector } from '../store';
import { quietly, useActions, useUiState } from '../ui';
import { Proposing } from './Proposing';
import { SpecView, TasksView } from './SpecView';

/** The mark a file shows in the file list: its task count, or its spec operations. */
function markOf(file: ProposalFile): { text: string; className: string } | undefined {
    if (file.kind === 'tasks') {
        const total = (file.tasks ?? []).reduce((sum, group) => sum + group.total, 0);
        return { text: plural(total, 'task'), className: 'muted' };
    }
    const mark = file.marks[0];
    if (!mark) return undefined;
    return { text: file.marks.join(' · '), className: mark === 'new' ? 'muted' : `op-text op-${mark.toLowerCase()}` };
}

/** A path with a break opportunity after each slash, so a narrow rail wraps it between segments, not mid-name. */
function breakable(path: string) {
    return path.split(/(?<=\/)/).flatMap((part, index) => (index === 0 ? [part] : [<wbr key={index} />, part]));
}

/** Validation: its result, the command as the submission ran it, the issues, and Re-run. */
const Validation = memo(function Validation() {
    const state = useSelector(
        (view) => ({
            command: checkCommand(view),
            validation: view.validation,
            validating: view.validating,
            ready: view.phases.proposalReadyAt !== null
        }),
        deepEqual
    );
    const { send } = useActions();
    const readOnly = useReadOnly();
    const { validation, validating } = state;
    const status = validating ? 'running' : !validation ? 'none' : validation.passed ? 'passed' : 'failed';
    return (
        <div className={`validation is-${status}`} role="status">
            <div className="validation-head">
                {status === 'passed' && (
                    <span className="state-mark state-answered" aria-hidden="true">
                        <CheckIcon />
                    </span>
                )}
                {status === 'failed' && <WarningIcon />}
                <span className="strong">
                    {status === 'running'
                        ? 'Validating…'
                        : status === 'passed'
                          ? 'Validation passed'
                          : status === 'failed'
                            ? 'Validation failed'
                            : 'Not validated yet'}
                </span>
            </div>
            <code className="command">{state.command.startsWith('openspec') ? `$ ${state.command}` : state.command}</code>
            {status === 'failed' && validation && (
                <ul className="issue-list">
                    {validation.issues.map((issue) => (
                        <li key={`${issue.path}-${issue.message}`}>
                            <code>{issue.path ? `${issue.path}: ${issue.message}` : issue.message}</code>
                        </li>
                    ))}
                    {validation.output && <pre className="raw-config">{validation.output}</pre>}
                </ul>
            )}
            {!readOnly && (
                <button
                    type="button"
                    className="button-link"
                    disabled={validating || !state.ready}
                    onClick={() => quietly(send({ type: 'validation.rerun' }))}
                >
                    Re-run
                </button>
            )}
        </div>
    );
});

/** The change folder's files as the agent wrote them, marked new or by delta operation. */
const Files = memo(function Files({ selected }: { selected: string | undefined }) {
    const { changeId, files } = useSelector(
        (view) => ({
            changeId: view.changeId,
            files: view.proposal.files.map(({ path, kind, marks, tasks }) => ({ path, kind, marks, tasks, content: '' }))
        }),
        deepEqual
    );
    const { setFile, setDrawer } = useActions();
    const top = files.filter((file) => !file.path.includes('/'));
    // Each nested file under its top folder, e.g. `specs/` or a Markdown plan's `design/`, in file order.
    const folders = Object.entries(
        groupBy(
            files.filter((file) => file.path.includes('/')),
            (file) => file.path.slice(0, file.path.indexOf('/'))
        )
    );
    const item = (file: ProposalFile, label: string, depth: number) => {
        const mark = markOf(file);
        return (
            <a
                key={file.path}
                href={`#file-${file.path}`}
                className={`file-link depth-${depth}`}
                aria-current={selected === file.path ? 'true' : undefined}
                onClick={(event) => {
                    event.preventDefault();
                    setFile(file.path);
                    setDrawer(undefined);
                }}
            >
                <span className="file-name">{breakable(label)}</span>
                {mark && <span className={`file-mark ${mark.className}`}>{mark.text}</span>}
            </a>
        );
    };
    return (
        <nav className="rail" aria-label="Change files">
            <div className="nav-heading">FILES THE AGENT WROTE</div>
            <div className="file-list">
                <div className="folder">
                    <FolderIcon />
                    {changeId}/
                </div>
                {top.map((file) => item(file, file.path, 1))}
                {folders.map(([folder, nested]) => (
                    <Fragment key={folder}>
                        <div className="folder depth-1">
                            <FolderIcon />
                            {folder}/
                        </div>
                        {nested.map((file) => item(file, file.path.slice(folder.length + 1), 2))}
                    </Fragment>
                ))}
            </div>
            <Validation />
        </nav>
    );
});

/** A file's counts in words: requirements and scenarios for a spec, tasks and groups for the task list, else nothing. */
function summaryOf(file: ProposalFile): string {
    if (file.kind === 'spec' && file.spec) {
        const counts = countDelta(file.spec);
        return `${plural(counts.ADDED + counts.MODIFIED + counts.REMOVED + counts.RENAMED, 'requirement')} · ${plural(counts.scenarios, 'scenario')}`;
    }
    if (file.kind === 'tasks' && file.tasks) {
        const total = file.tasks.reduce((sum, group) => sum + group.total, 0);
        return `${plural(total, 'task')} in ${plural(file.tasks.length, 'group')}`;
    }
    return '';
}

/** One file, rendered or as its raw markdown. Both are commentable. */
function FileViewer({ path }: { path: string }) {
    const file = useSelector((view) => view.proposal.files.find((candidate) => candidate.path === path), deepEqual);
    const [raw, setRaw] = useState(false);
    if (!file) return <p className="muted">{path} is not in the change folder any more.</p>;
    return (
        <article className="file-view">
            <div className="file-view-head">
                <span className="mono">{file.path}</span>
                <span className="small muted">{summaryOf(file)}</span>
                <div role="tablist" aria-label="View" className="segmented">
                    <button type="button" role="tab" aria-selected={!raw} onClick={() => setRaw(false)}>
                        Rendered
                    </button>
                    <button type="button" role="tab" aria-selected={raw} onClick={() => setRaw(true)}>
                        Markdown
                    </button>
                </div>
            </div>
            <div id={`file-${file.path}`} className="file-body" data-anchor-target={`file:${file.path}`}>
                {raw ? (
                    <pre className="raw-markdown">{file.content}</pre>
                ) : file.kind === 'spec' ? (
                    <SpecView file={file} />
                ) : file.kind === 'tasks' ? (
                    <TasksView content={file.content} />
                ) : (
                    <div className="prose document">
                        <Markdown source={file.content} document />
                    </div>
                )}
            </div>
        </article>
    );
}

/**
 * Phase 3: the OpenSpec change or Markdown plan the agent wrote, as it is on disk, updated live as the files change. It opens on submit
 * with the agent's progress, which gives way to the review once the change validates.
 */
export function Proposal() {
    const { file } = useUiState();
    const unlocked = useSelector((view) => view.phases.proposalUnlocked);
    const markdown = useSelector((view) => view.format === 'markdown');
    const paths = useSelector((view) => view.proposal.files.map((candidate) => candidate.path), deepEqual);
    const selected = file && paths.includes(file) ? file : (paths.find((path) => path.startsWith('specs/')) ?? paths[0]);
    return (
        <>
            <Rail>
                <Files selected={selected} />
            </Rail>
            <main className="main" id="main">
                <div className="main-inner">
                    {unlocked ? (
                        <header className="page-head">
                            <div className="eyebrow">{markdown ? 'PHASE 3 · MARKDOWN PLAN' : 'PHASE 3 · OPENSPEC PROPOSAL'}</div>
                            <h1>{markdown ? 'Review the plan' : 'Review the proposed change'}</h1>
                        </header>
                    ) : (
                        <Proposing />
                    )}
                    {selected ? (
                        <FileViewer path={selected} />
                    ) : (
                        <p className="muted">The agent has not written any files yet.</p>
                    )}
                    {unlocked && (
                        <footer className="proposal-foot">
                            <EndSessionButton className="button-primary" />
                        </footer>
                    )}
                </div>
            </main>
        </>
    );
}
