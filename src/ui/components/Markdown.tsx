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
