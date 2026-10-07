import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import { linkChildren } from './LinkedText';

/** The markdown subset a `text` block may use. Anything else is unwrapped to its text. */
const PROSE = ['p', 'ul', 'ol', 'li', 'strong', 'em', 'code', 'a', 'br', 'blockquote'];

/** Everything else the proposal's markdown files use (react-markdown has no tables without a plugin). */
const DOCUMENT = [...PROSE, 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'hr'];

/** What a table cell may use: inline marks inside plain paragraphs. */
const INLINE = ['p', 'strong', 'em', 'code', 'a', 'br'];

/** micromark's block constructs, turned off in a cell so `> 5 ms`, `1. Draft` or `# of users` keep their leading characters. */
const BLOCK_CONSTRUCTS = [
    'blockQuote',
    'codeFenced',
    'codeIndented',
    'definition',
    'headingAtx',
    'list',
    'setextUnderline',
    'thematicBreak'
];

/** A remark plugin that stops the parser from recognising block syntax. */
function inlineOnly(this: { data(key: string, value?: unknown): unknown }) {
    const extensions = (this.data('micromarkExtensions') as unknown[] | undefined) ?? [];
    this.data('micromarkExtensions', [...extensions, { disable: { null: BLOCK_CONSTRUCTS } }]);
}

/** A markdown element renderer for `Tag` that links question ids in its children. */
function linked(Tag: 'p' | 'li' | 'strong' | 'em' | 'blockquote' | 'h1' | 'h2' | 'h3' | 'h4') {
    return function Linked({ children }: { children?: ReactNode }) {
        return <Tag>{linkChildren(children)}</Tag>;
    };
}

const components = {
    p: linked('p'),
    li: linked('li'),
    strong: linked('strong'),
    em: linked('em'),
    blockquote: linked('blockquote'),
    h1: linked('h1'),
    h2: linked('h2'),
    h3: linked('h3'),
    h4: linked('h4'),
    a: ({ href, children }: { href?: string; children?: ReactNode }) => (
        <a href={href} target="_blank" rel="noopener noreferrer">
            {children}
        </a>
    )
};

/**
 * Markdown rendered as React elements. Raw HTML in the source is escaped and shown
 * as text, never parsed; links open outside the page; `Q-<n>` becomes a question link.
 */
export function Markdown({ source, document = false }: { source: string; document?: boolean }) {
    return (
        <ReactMarkdown allowedElements={document ? DOCUMENT : PROSE} unwrapDisallowed components={components}>
            {source}
        </ReactMarkdown>
    );
}

/** Markdown for a table cell: **bold**, *italic*, `code`, links and `Q-<n>`, with any block syntax left as text. */
export function InlineMarkdown({ source }: { source: string }) {
    return (
        <ReactMarkdown allowedElements={INLINE} unwrapDisallowed remarkPlugins={[inlineOnly]} components={components}>
            {source}
        </ReactMarkdown>
    );
}

/** What a Bitbucket comment renders, as Bitbucket's Python-Markdown does: no raw HTML, task lists or suggestion blocks. */
const BITBUCKET = [...DOCUMENT];

/** A pipe table's separator row, `| --- | :-: |`. */
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/** A pipe table row's cells. */
function cells(line: string): string[] {
    return line
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((cell) => cell.trim());
}

/** The source cut into pipe tables and the Markdown between them, fenced code left whole. */
function splitTables(source: string): ({ table: string[][] } | { text: string })[] {
    const lines = source.split('\n');
    const parts: ({ table: string[][] } | { text: string })[] = [];
    let text: string[] = [];
    let fenced = false;
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? '';
        if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
        if (!fenced && line.includes('|') && TABLE_RULE.test(lines[index + 1] ?? '')) {
            const table = [cells(line)];
            index += 2;
            while (index < lines.length && (lines[index] ?? '').includes('|') && (lines[index] ?? '').trim()) {
                table.push(cells(lines[index] ?? ''));
                index += 1;
            }
            index -= 1;
            if (text.length) parts.push({ text: text.join('\n') });
            text = [];
            parts.push({ table });
            continue;
        }
        text.push(line);
    }
    if (text.length) parts.push({ text: text.join('\n') });
    return parts;
}

/**
 * A comment as Bitbucket will show it: fenced code, tables, emphasis, lists, links and headings, with raw HTML shown as
 * literal text and a task list or suggestion block left as the plain text and code Bitbucket makes of them.
 */
export function BitbucketMarkdown({ source }: { source: string }) {
    return (
        <>
            {splitTables(source).map((part, index) =>
                'table' in part ? (
                    <div key={index} className="table-wrap">
                        <table className="data-table">
                            <thead>
                                <tr>
                                    {part.table[0]!.map((cell, column) => (
                                        <th key={column}>
                                            <InlineMarkdown source={cell} />
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {part.table.slice(1).map((row, rowIndex) => (
                                    <tr key={rowIndex}>
                                        {row.map((cell, column) => (
                                            <td key={column}>
                                                <InlineMarkdown source={cell} />
                                            </td>
                                        ))}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                ) : (
                    <ReactMarkdown key={index} allowedElements={BITBUCKET} unwrapDisallowed components={{ a: components.a }}>
                        {part.text}
                    </ReactMarkdown>
                )
            )}
        </>
    );
}
