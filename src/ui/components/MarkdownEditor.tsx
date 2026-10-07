import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';
import type { Range } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, keymap, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { useEffect, useRef } from 'react';

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
    ATXHeading6: 'cm-md-h4'
};

/** The syntax of each element, hidden while the caret is outside it: the child nodes and the elements they sit in. */
const SYNTAX: Record<string, readonly string[]> = {
    EmphasisMark: ['StrongEmphasis', 'Emphasis'],
    CodeMark: ['InlineCode'],
    LinkMark: ['Link'],
    URL: ['Link'],
    LinkTitle: ['Link'],
    HeaderMark: ['ATXHeading1', 'ATXHeading2', 'ATXHeading3', 'ATXHeading4', 'ATXHeading5', 'ATXHeading6']
};

const HIDDEN = Decoration.replace({});

/**
 * The styling of every Markdown element in view, and the hiding of its syntax (`**`, `` ` ``, `[](...)`, `#`) unless a
 * selection touches the element or the editor is not focused. Moving the caret in unrenders an element; moving it out
 * renders it again.
 */
function livePreview(view: EditorView): DecorationSet {
    const { state } = view;
    const selection = view.hasFocus ? state.selection.ranges : [];
    const decorations: Range<Decoration>[] = [];
    for (const { from, to } of view.visibleRanges) {
        syntaxTree(state).iterate({
            from,
            to,
            enter(node) {
                const style = STYLES[node.name];
                if (style) decorations.push(Decoration.mark({ class: style }).range(node.from, node.to));
                const parents = SYNTAX[node.name];
                const parent = parents && node.node.parent;
                if (!parent || !parents.includes(parent.name)) return;
                if (selection.some((range) => range.from <= parent.to && range.to >= parent.from)) return;
                const space = node.name === 'HeaderMark' && state.sliceDoc(node.to, node.to + 1) === ' ' ? 1 : 0;
                if (node.to + space > node.from) decorations.push(HIDDEN.range(node.from, node.to + space));
            }
        });
    }
    return Decoration.set(decorations, true);
}

const livePreviewPlugin = ViewPlugin.fromClass(
    class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
            this.decorations = livePreview(view);
        }
        update(update: ViewUpdate) {
            if (
                update.docChanged ||
                update.selectionSet ||
                update.viewportChanged ||
                update.focusChanged ||
                update.transactions.length
            )
                this.decorations = livePreview(update.view);
        }
    },
    { decorations: (plugin) => plugin.decorations }
);

/**
 * One Markdown editor with no preview beside it: text is shown rendered, and the part under the caret shows its
 * Markdown syntax so it can be edited, then renders again when the caret leaves. Labelled by the element `labelId`.
 */
export function MarkdownEditor({
    id,
    labelId,
    value,
    onChange
}: {
    id: string;
    labelId: string;
    value: string;
    onChange: (value: string) => void;
}) {
    const host = useRef<HTMLDivElement>(null);
    const view = useRef<EditorView>(null);
    const changed = useRef(onChange);
    changed.current = onChange;

    // biome-ignore lint/correctness/useExhaustiveDependencies: the editor is built once; `value` is synced below
    useEffect(() => {
        const editor = new EditorView({
            parent: host.current!,
            doc: value,
            extensions: [
                history(),
                keymap.of([...defaultKeymap, ...historyKeymap]),
                markdown(),
                EditorView.lineWrapping,
                livePreviewPlugin,
                EditorView.contentAttributes.of({ id, role: 'textbox', 'aria-multiline': 'true', 'aria-labelledby': labelId }),
                EditorView.updateListener.of((update) => {
                    if (update.docChanged) changed.current(update.state.doc.toString());
                })
            ]
        });
        view.current = editor;
        return () => editor.destroy();
    }, [id, labelId]);

    useEffect(() => {
        const editor = view.current;
        if (editor && editor.state.doc.toString() !== value)
            editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
    }, [value]);

    return <div className="markdown-editor" ref={host} />;
}
