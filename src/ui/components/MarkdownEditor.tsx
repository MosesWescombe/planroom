import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';
import { Compartment, EditorState, Prec, type Range } from '@codemirror/state';
import {
    Decoration,
    type DecorationSet,
    EditorView,
    keymap,
    placeholder as placeholderText,
    ViewPlugin,
    type ViewUpdate
} from '@codemirror/view';
import { useEffect, useRef } from 'react';
import { isSendKey, useSendKey } from '../sendKey';

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
                markdown(),
                EditorView.lineWrapping,
                livePreviewPlugin,
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
