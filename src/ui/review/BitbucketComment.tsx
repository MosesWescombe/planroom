import { type ReactNode, useEffect, useState } from 'react';
import { type CodeAnchor, describeCodeAnchor, SIGN_OFF_MARKDOWN } from '../../shared/review';
import { fetchDiff } from '../api';
import { type CodeRow, parsePatch } from '../code/CodeViewer';
import { BitbucketMarkdown } from '../components/Markdown';
import { MarkdownEditor } from '../components/MarkdownEditor';

/** The lines a comment sits on, with two on each side, from the round's diff of its file. */
function DiffContext({ round, anchor }: { round: number; anchor: CodeAnchor }) {
    const [rows, setRows] = useState<CodeRow[]>();
    useEffect(() => {
        let live = true;
        fetchDiff(round, anchor.file).then(
            (patch) => live && setRows(parsePatch(patch)),
            () => live && setRows([])
        );
        return () => {
            live = false;
        };
    }, [round, anchor.file]);
    if (!rows || anchor.start === undefined) return null;
    const line = (row: CodeRow) => (anchor.side === 'old' ? row.oldNumber : row.kind === 'remove' ? undefined : row.number);
    const at = rows.findIndex((row) => line(row) === anchor.start);
    const end = rows.findIndex((row) => line(row) === (anchor.end ?? anchor.start));
    if (at === -1) return null;
    const shown = rows.slice(Math.max(0, at - 2), Math.max(at, end) + 3).filter((row) => row.kind !== 'hunk');
    return (
        <div className="bb-context" aria-label={`The diff at ${describeCodeAnchor(anchor)}`}>
            {shown.map((row, index) => {
                const number = line(row) ?? row.oldNumber;
                const marked = number !== undefined && number >= anchor.start! && number <= (anchor.end ?? anchor.start!);
                return (
                    <div key={index} className={`code-line is-${row.kind}${marked ? ' is-marked' : ''}`}>
                        <span className="line-number">{number}</span>
                        <span className="line-text">{row.text}</span>
                    </div>
                );
            })}
        </div>
    );
}

/** A comment's Markdown in one editor that renders as it is typed, with the sign-off Bitbucket will add under it. */
export function CommentEditor({
    id,
    label,
    value,
    signed,
    onChange
}: {
    id: string;
    label: string;
    value: string;
    signed: boolean;
    onChange: (value: string) => void;
}) {
    return (
        <div className="comment-editor">
            <span className="field-label" id={`${id}-label`}>
                {label}
            </span>
            <MarkdownEditor id={id} labelId={`${id}-label`} value={value} onChange={onChange} />
            {signed && (
                <div className="bb-body comment-signoff" aria-label="Sign-off added when posted">
                    <BitbucketMarkdown source={SIGN_OFF_MARKDOWN} />
                </div>
            )}
        </div>
    );
}

/**
 * A comment as Bitbucket shows it: the file and the lines it sits under, then the comment by the reviewer, its body
 * rendered as Bitbucket renders Markdown, or `editor` in its place while it is edited. `tag` sits beside the file;
 * `target` makes the body commentable; `children` go under the comment.
 */
export function BitbucketComment({
    round,
    anchor,
    body,
    tag,
    id,
    summary,
    editor,
    target,
    children
}: {
    round: number;
    anchor: CodeAnchor | undefined;
    body: string;
    tag?: ReactNode;
    id?: string;
    summary?: boolean;
    editor?: ReactNode;
    /** The anchor target that makes the rendered body commentable. */
    target?: string;
    children?: ReactNode;
}) {
    return (
        <article className={`bb-card${summary ? ' is-summary' : ''}`} id={id}>
            <header className="bb-file-head">
                <span className="mono truncate">{anchor ? describeCodeAnchor(anchor) : 'On the pull request'}</span>
                {tag}
            </header>
            {anchor && <DiffContext round={round} anchor={anchor} />}
            <div className="bb-comment">
                <span className="bb-avatar" aria-hidden="true">
                    Y
                </span>
                <div className="bb-comment-main">
                    <span className="strong">You</span>
                    {editor ?? (
                        <div className="bb-body" data-anchor-target={target}>
                            <BitbucketMarkdown source={body} />
                        </div>
                    )}
                </div>
            </div>
            {children}
        </article>
    );
}
