import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';
import { Compartment, EditorState, Prec, type Range, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, keymap, placeholder as placeholderText, WidgetType } from '@codemirror/view';
import { useEffect, useRef } from 'react';
import { isSendKey, useSendKey } from '../sendKey';

/** A node of the parsed Markdown, typed through @codemirror/language since @lezer/common is not a direct dependency. */
type SyntaxNode = ReturnType<ReturnType<typeof syntaxTree>['resolve']>;

/** The class each styled Markdown element gets while it is rendered. */
const STYLES: Record<string, string> = {
    StrongEmphasis: 'cm-md-strong',
    Emphasis: 'cm-md-em',
    InlineCode: 'cm-md-code',
    Link: 'cm-md-link',
    ATXHeading1: 'cm-md-h1',
    ATXHeading2: 'cm-md-h2',
    ATXHeading3: 'cm-md-h3',
    ATXHeading4: 'cm-md-h4',
    ATXHeading5: 'cm-md-h4',
    ATXHeading6: 'cm-md-h4',
    SetextHeading1: 'cm-md-h1',
    SetextHeading2: 'cm-md-h2'
};

/** The class every line of each block element gets, rendered or not. */
const LINE_STYLES: Record<string, string> = {
    Blockquote: 'cm-md-quote',
    FencedCode: 'cm-md-pre',
    CodeBlock: 'cm-md-pre'
};

/** The syntax of each element, hidden while the caret is outside it: the child nodes and the elements they sit in. */
const SYNTAX: Record<string, readonly string[]> = {
    EmphasisMark: ['StrongEmphasis', 'Emphasis'],
    CodeMark: ['InlineCode', 'FencedCode'],
    CodeInfo: ['FencedCode'],
    LinkMark: ['Link'],
    URL: ['Link'],
    LinkTitle: ['Link'],
    HeaderMark: [
        'ATXHeading1',
        'ATXHeading2',
        'ATXHeading3',
        'ATXHeading4',
        'ATXHeading5',
        'ATXHeading6',
        'SetextHeading1',
        'SetextHeading2'
    ]
};

const HIDDEN = Decoration.replace({});

/** A code block's fence line while its fence is hidden, shrunk to the padding at the top or bottom of the block. */
const FENCE = Decoration.line({ class: 'cm-md-fence' });

/** A thematic break's line while its `---` is hidden. */
const RULE = Decoration.line({ class: 'cm-md-hr' });

/** A bullet list's `-`, `*` or `+` drawn as the bullet it renders to. */
class BulletWidget extends WidgetType {
    eq(): boolean {
        return true;
    }

    toDOM(): HTMLElement {
        const bullet = document.createElement('span');
        bullet.className = 'cm-md-bullet';
        bullet.textContent = '•';
        return bullet;
    }
}

const BULLET = Decoration.replace({ widget: new BulletWidget() });

/** A stretch of a table cell's text with the classes its inline Markdown gives it. */
type Run = { text: string; classes: string };

/** The text from `from` to `to` cut where its inline elements start and end, with their syntax left out. */
function runs(state: EditorState, from: number, to: number): Run[] {
    const styled: { from: number; to: number; style: string }[] = [];
    const hidden: { from: number; to: number }[] = [];
    const cuts = new Set([from, to]);
    syntaxTree(state).iterate({
        from,
        to,
        enter(node) {
            const style = STYLES[node.name];
            if (style) styled.push({ from: node.from, to: node.to, style });
            else if (SYNTAX[node.name]?.includes(node.node.parent?.name ?? '')) hidden.push({ from: node.from, to: node.to });
            else return;
            cuts.add(node.from);
            cuts.add(node.to);
        }
    });
    const edges = [...cuts].filter((at) => at >= from && at <= to).sort((a, b) => a - b);
    return edges.slice(1).flatMap((end, index) => {
        const start = edges[index]!;
        const covers = (range: { from: number; to: number }) => range.from <= start && end <= range.to;
        if (hidden.some(covers)) return [];
        return [
            {
                text: state.sliceDoc(start, end),
                classes: styled
                    .filter(covers)
                    .map((range) => range.style)
                    .join(' ')
            }
        ];
    });
}

/**
 * The cells of each row of `table`, the header row first. A cell left blank between two pipes stays an empty cell;
 * text before the first pipe or after the last is a cell only when there is some, as GFM counts them.
 */
function rowsOf(state: EditorState, table: SyntaxNode): Run[][][] {
    const rows: Run[][][] = [];
    for (let row = table.firstChild; row; row = row.nextSibling) {
        if (row.name !== 'TableHeader' && row.name !== 'TableRow') continue;
        const edges = [row.from, ...row.getChildren('TableDelimiter').flatMap((pipe) => [pipe.from, pipe.to]), row.to];
        const cells: Run[][] = [];
        for (let at = 0; at < edges.length; at += 2) {
            const [from, to] = [edges[at]!, edges[at + 1]!];
            const text = state.sliceDoc(from, to);
            const start = from + text.length - text.trimStart().length;
            const end = to - (text.length - text.trimEnd().length);
            const outer = at === 0 || at === edges.length - 2;
            if (start < end) cells.push(runs(state, start, end));
            else if (!outer) cells.push([]);
        }
        rows.push(cells);
    }
    return rows;
}

/** A pipe table drawn as the table it renders to, as BitbucketMarkdown draws one, in place of its lines. */
class TableWidget extends WidgetType {
    constructor(
        readonly source: string,
        readonly rows: Run[][][]
    ) {
        super();
    }

    eq(other: TableWidget): boolean {
        return other.source === this.source;
    }

    toDOM(): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'table-wrap cm-md-table';
        const table = wrap.appendChild(document.createElement('table'));
        table.className = 'data-table';
        const [head = [], ...body] = this.rows;
        const addRow = (section: HTMLTableSectionElement, cells: Run[][], tag: 'th' | 'td') => {
            const row = section.insertRow();
            for (const cell of cells) {
                const element = row.appendChild(document.createElement(tag));
                for (const { text, classes } of cell) {
                    const span = element.appendChild(document.createElement('span'));
                    span.className = classes;
                    span.textContent = text;
                }
            }
        };
        addRow(table.createTHead(), head, 'th');
        const tbody = table.createTBody();
        for (const cells of body) addRow(tbody, cells, 'td');
        return wrap;
    }

    /** A click reaches the editor, which puts the caret in the table and so shows its Markdown. */
    ignoreEvent(): boolean {
        return false;
    }
}

/**
 * The rendering of every Markdown element, and the hiding of its syntax (`**`, `` ` ``, `[](...)`, `#`, `>`, fences)
 * unless a selection touches the element, or for a quote, list item or rule its line, or the editor is not focused.
 * Moving the caret in unrenders an element; moving it out renders it again. A pipe table is replaced by the table
 * itself, and a bullet's `-` by a bullet.
 */
function livePreview(state: EditorState, focused: boolean): DecorationSet {
    const selection = focused ? state.selection.ranges : [];
    const editing = (from: number, to: number) => selection.some((range) => range.from <= to && range.to >= from);
    const lineOf = (at: number) => state.doc.lineAt(at);
    const decorations: Range<Decoration>[] = [];
    // ponytail: decorates the whole document on every transaction, cheap at comment length; decorate only
    // view.visibleRanges (with tables in a separate state field) if the editor ever holds long documents.
    syntaxTree(state).iterate({
        enter(node) {
            const { name, from, to } = node;
            const style = STYLES[name];
            if (style) decorations.push(Decoration.mark({ class: style }).range(from, to));
            const lineStyle = LINE_STYLES[name];
            for (let at = from; lineStyle && at <= to; at = lineOf(at).to + 1)
                decorations.push(Decoration.line({ class: lineStyle }).range(lineOf(at).from));
            if (name === 'Table') {
                // A table on whole lines only, as one in a quote or a list item cannot be replaced line by line.
                if (editing(from, to) || lineOf(from).from !== from || lineOf(to).to !== to) return;
                const widget = new TableWidget(state.sliceDoc(from, to), rowsOf(state, node.node));
                decorations.push(Decoration.replace({ widget, block: true }).range(from, to));
                return false;
            }
            if (name === 'HorizontalRule' || name === 'QuoteMark' || name === 'ListMark') {
                if (editing(lineOf(from).from, lineOf(from).to)) return;
                if (name === 'HorizontalRule') decorations.push(RULE.range(lineOf(from).from), HIDDEN.range(from, to));
                else if (name === 'QuoteMark')
                    decorations.push(HIDDEN.range(from, state.sliceDoc(to, to + 1) === ' ' ? to + 1 : to));
                else if (node.node.parent?.parent?.name === 'BulletList') decorations.push(BULLET.range(from, to));
                return;
            }
            const parents = SYNTAX[name];
            const parent = parents && node.node.parent;
            if (!parent || !parents.includes(parent.name) || editing(parent.from, parent.to)) return;
            const space = name === 'HeaderMark' && state.sliceDoc(to, to + 1) === ' ' ? 1 : 0;
            if (to + space > from) decorations.push(HIDDEN.range(from, to + space));
            if (name === 'CodeMark' && parent.name === 'FencedCode') decorations.push(FENCE.range(lineOf(from).from));
        }
    });
    return Decoration.set(decorations, true);
}

/** The editor gaining (true) or losing (false) focus. */
const focusChanged = StateEffect.define<boolean>();

/**
 * The live preview, kept in a state field because only a field's decorations may replace whole lines, as a table's
 * do, beside whether the editor has focus, which CodeMirror reports a moment after the focus moves.
 */
const livePreviewField = StateField.define<{ focused: boolean; decorations: DecorationSet }>({
    create: (state) => ({ focused: false, decorations: livePreview(state, false) }),
    update(value, transaction) {
        const focused = transaction.effects.reduce(
            (was, effect) => (effect.is(focusChanged) ? effect.value : was),
            value.focused
        );
        return { focused, decorations: livePreview(transaction.state, focused) };
    },
    provide: (field) => EditorView.decorations.from(field, (value) => value.decorations)
});

const livePreviewExtension = [livePreviewField, EditorView.focusChangeEffect.of((_state, focusing) => focusChanged.of(focusing))];

/** Whether the text can be changed, reconfigured as `disabled` changes. */
const editability = new Compartment();

/** The extensions that make an editor read-only while `disabled`, as a disabled textarea is. */
const editableUnless = (disabled: boolean) => [EditorView.editable.of(!disabled), EditorState.readOnly.of(disabled)];

/**
 * Submit the form `editor` sits in through its default button, as Enter does in a form's text field, and nothing while
 * that button is disabled. False when the editor is in no form, so the key types a new line.
 */
function submitForm(editor: EditorView): boolean {
    const form = editor.contentDOM.closest('form');
    if (!form) return false;
    const button = Array.from(form.elements).find(
        (element): element is HTMLButtonElement | HTMLInputElement =>
            (element instanceof HTMLButtonElement || element instanceof HTMLInputElement) && element.type === 'submit'
    );
    if (!button?.disabled) form.requestSubmit(button);
    return true;
}

/**
 * One Markdown editor with no preview beside it: text is shown rendered, and the part under the caret shows its
 * Markdown syntax so it can be edited, then renders again when the caret leaves. Labelled by the element `labelId`,
 * and at least `rows` lines tall, growing with its text. The chosen send key calls `onSend`, or without it submits the
 * form the editor sits in, as in every other message box; `onPaste` sees each paste before the editor takes it.
 */
export function MarkdownEditor({
    id,
    labelId,
    value,
    onChange,
    placeholder,
    rows = 6,
    autoFocus = false,
    disabled = false,
    onSend,
    onPaste
}: {
    id: string;
    labelId: string;
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    rows?: number;
    autoFocus?: boolean;
    disabled?: boolean;
    onSend?: () => void;
    onPaste?: (event: ClipboardEvent) => void;
}) {
    const host = useRef<HTMLDivElement>(null);
    const view = useRef<EditorView>(null);
    const changed = useRef(onChange);
    changed.current = onChange;
    const sent = useRef(onSend);
    sent.current = onSend;
    const pasted = useRef(onPaste);
    pasted.current = onPaste;
    const chosen = useSendKey();
    const sendKey = useRef(chosen);
    sendKey.current = chosen;

    // biome-ignore lint/correctness/useExhaustiveDependencies: the editor is built once; `value` and `disabled` are synced below
    useEffect(() => {
        const editor = new EditorView({
            parent: host.current!,
            doc: value,
            extensions: [
                history(),
                Prec.highest(
                    EditorView.domEventHandlers({
                        keydown: (event, editor) => {
                            if (!isSendKey(event, sendKey.current)) return false;
                            if (!sent.current) return submitForm(editor);
                            sent.current();
                            return true;
                        },
                        paste: (event) => {
                            pasted.current?.(event);
                            return event.defaultPrevented;
                        }
                    })
                ),
                keymap.of([...defaultKeymap, ...historyKeymap]),
                markdown({ base: markdownLanguage }),
                EditorView.lineWrapping,
                livePreviewExtension,
                editability.of(editableUnless(disabled)),
                placeholder ? placeholderText(placeholder) : [],
                EditorView.contentAttributes.of({ id, role: 'textbox', 'aria-multiline': 'true', 'aria-labelledby': labelId }),
                EditorView.updateListener.of((update) => {
                    if (update.docChanged) changed.current(update.state.doc.toString());
                })
            ]
        });
        view.current = editor;
        if (autoFocus) editor.focus();
        return () => editor.destroy();
    }, [id, labelId, placeholder]);

    useEffect(() => {
        const editor = view.current;
        if (editor && editor.state.doc.toString() !== value)
            editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
    }, [value]);

    useEffect(() => view.current?.dispatch({ effects: editability.reconfigure(editableUnless(disabled)) }), [disabled]);

    // Text being written, its placeholder or a read-only answer is no passage to comment on or anchor in.
    return <div className="markdown-editor" data-no-comment ref={host} style={{ ['--editor-rows' as string]: rows }} />;
}
