import clamp from 'lodash/clamp';
import { useEffect, useRef, useState } from 'react';
import { describeAnchor, resolveAnchor } from '../../shared/anchors';
import type { CommentIntent, ThreadRecord } from '../../shared/records';
import { Attachments, usePastes } from '../components/Attachments';
import { CommentIcon } from '../components/icons';
import { useReadOnly } from '../readOnly';
import { sendHint, useSendKey, useSendOnKey } from '../sendKey';
import { useStore } from '../store';
import { quietly, useActions, useBusy } from '../ui';
import { type AnchorState, setAnchorStates } from './anchorStatus';
import { closeComposer, openComposer, useComposition } from './composer';
import { captureSelection, rangeFromOffsets, type SelectionAnchor, targetSelector } from './selection';

const INTENTS: { intent: CommentIntent; toolbar: string; composer: string }[] = [
    { intent: 'question', toolbar: 'Comment', composer: 'Question' },
    { intent: 'change', toolbar: 'Ask to change', composer: 'Change this' },
    { intent: 'wrong', toolbar: 'Wrong', composer: "It's wrong" }
];

/** Whether keyboard input is going into a field, where `C` is just a letter. */
function typing(event: KeyboardEvent): boolean {
    const element = event.target as HTMLElement | null;
    return Boolean(element?.closest?.('input, textarea, select, [contenteditable="true"]'));
}

/** Whether the browser has the CSS Custom Highlight API. */
function supportsHighlights(): boolean {
    return typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';
}

/**
 * Paint every open comment's anchor with the CSS Custom Highlight API, so React's DOM
 * is never touched, and record which anchors are attached, detached or not on screen.
 * Re-resolves whenever the threads or the rendered text change.
 */
function useHighlights(): void {
    const store = useStore();
    useEffect(() => {
        let frame = 0;
        const paint = () => {
            frame = 0;
            const view = store.getView();
            if (!view) return;
            const states = new Map<string, AnchorState>();
            const ranges: Range[] = [];
            const open = Object.values(view.threads).filter(
                (thread): thread is ThreadRecord & { anchor: NonNullable<ThreadRecord['anchor']> } =>
                    Boolean(thread.kind === 'comment' && thread.anchor)
            );
            for (const thread of open) {
                const element = document.querySelector(targetSelector(thread.anchor.target));
                if (!element) {
                    states.set(thread.id, 'hidden');
                    continue;
                }
                const found = resolveAnchor(element.textContent ?? '', thread.anchor);
                states.set(thread.id, found ? 'attached' : 'detached');
                // A comment on a whole question has no quote: painting all of its text would bury the card.
                if (found && found.method !== 'target' && thread.status === 'open') {
                    const range = rangeFromOffsets(element, found.start, found.end);
                    if (range) ranges.push(range);
                }
            }
            setAnchorStates(states);
            if (supportsHighlights()) CSS.highlights.set('planroom-comment', new Highlight(...ranges));
        };
        const schedule = () => {
            if (!frame) frame = window.requestAnimationFrame(paint);
        };
        const unsubscribe = store.subscribe(schedule);
        const observer = new MutationObserver(schedule);
        observer.observe(document.body, { subtree: true, childList: true, characterData: true });
        schedule();
        return () => {
            unsubscribe();
            observer.disconnect();
            if (frame) window.cancelAnimationFrame(frame);
            if (supportsHighlights()) CSS.highlights.delete('planroom-comment');
        };
    }, [store]);
}

/** Paint the live selection in the selection colour while the composer is open, since focus moves to it. */
function usePendingHighlight(composition: ReturnType<typeof useComposition>): void {
    useEffect(() => {
        if (!supportsHighlights()) return undefined;
        if (!composition) {
            CSS.highlights.delete('planroom-pending');
            return undefined;
        }
        const element = document.querySelector(targetSelector(composition.anchor.target));
        const found = element && resolveAnchor(element.textContent ?? '', composition.anchor);
        const range = found && found.method !== 'target' && rangeFromOffsets(element, found.start, found.end);
        if (range) CSS.highlights.set('planroom-pending', new Highlight(range));
        return () => void CSS.highlights.delete('planroom-pending');
    }, [composition]);
}

/** Where to float a box `width` wide by a selection: above it, or below it, kept inside the window. */
function place(
    at: { top: number; left: number; bottom: number } | undefined,
    width: number,
    below: boolean
): React.CSSProperties {
    if (!at) return {};
    const left = clamp(at.left, 12, window.innerWidth - width - 12);
    return below ? { top: Math.min(at.bottom + 8, window.innerHeight - 320), left } : { top: Math.max(8, at.top - 46), left };
}

/** The comment box for the open composition: its quote, intent, text and pastes, and sending it to the agent. */
function Composer() {
    const composition = useComposition();
    const { send } = useActions();
    const [text, setText] = useState('');
    const [intent, setIntent] = useState<CommentIntent>('question');
    const [busy, track] = useBusy();
    const sendKey = useSendKey();
    const sendOnKey = useSendOnKey();
    const pastes = usePastes();
    const clearPastes = pastes.clear;
    usePendingHighlight(composition);

    // Opening a box over the one already open keeps its unsent text and pastes; closing the box clears them.
    useEffect(() => {
        if (composition) {
            setIntent(composition.intent);
        } else {
            setText('');
            clearPastes();
        }
    }, [composition, clearPastes]);

    if (!composition) return null;
    const submit = () => {
        const comment = text.trim();
        const attachments = pastes.items.length ? pastes.items : undefined;
        if ((!comment && !attachments) || busy || pastes.uploading) return;
        quietly(
            track(send({ type: 'comment.create', anchor: composition.anchor, intent, text: comment, attachments })).then(() => {
                closeComposer();
                window.getSelection()?.removeAllRanges();
            })
        );
    };
    return (
        <div className="composer" role="dialog" aria-label="Comment" style={place(composition.at, 360, true)}>
            <blockquote className="composer-quote">
                {composition.anchor.quote?.exact ?? `Comment on ${describeAnchor(composition.anchor)}`}
            </blockquote>
            <div role="radiogroup" aria-label="Comment type" className="chip-row">
                {INTENTS.map((option) => (
                    <button
                        key={option.intent}
                        type="button"
                        role="radio"
                        aria-checked={intent === option.intent}
                        className={`choice-chip small${intent === option.intent ? ' is-pressed' : ''}`}
                        onClick={() => setIntent(option.intent)}
                    >
                        {option.composer}
                    </button>
                ))}
            </div>
            <label className="visually-hidden" htmlFor="composer-text">
                Comment
            </label>
            <textarea
                id="composer-text"
                rows={4}
                value={text}
                autoFocus
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                    sendOnKey(event, submit);
                    if (event.key === 'Escape') closeComposer();
                }}
                onPaste={pastes.onPaste}
            />
            <Attachments items={pastes.items} onRemove={pastes.remove} />
            <div className="row spread">
                <span className="small muted">{sendHint(sendKey)}</span>
                <div className="row">
                    <button type="button" className="button-text" onClick={closeComposer}>
                        Cancel
                    </button>
                    <button
                        type="button"
                        className="button-primary button-small"
                        disabled={busy || pastes.uploading || (!text.trim() && !pastes.items.length)}
                        onClick={submit}
                    >
                        Send to agent
                    </button>
                </div>
            </div>
        </div>
    );
}

/**
 * Commenting on any text: a toolbar over any selection inside a commentable element
 * (Comment, Ask to change, Wrong, or the `C` key), the composer, and the highlights.
 */
export function CommentLayer() {
    const readOnly = useReadOnly();
    const composition = useComposition();
    const [selection, setSelection] = useState<SelectionAnchor>();
    const latest = useRef<SelectionAnchor>();
    latest.current = selection;
    useHighlights();

    useEffect(() => {
        if (readOnly) return undefined;
        let frame = 0;
        const update = () => {
            frame = 0;
            setSelection(captureSelection());
        };
        const onChange = () => {
            if (!frame) frame = window.requestAnimationFrame(update);
        };
        const onKey = (event: KeyboardEvent) => {
            if (event.key.toLowerCase() !== 'c' || event.metaKey || event.ctrlKey || event.altKey || typing(event)) return;
            const current = latest.current ?? captureSelection();
            if (!current) return;
            event.preventDefault();
            openComposer({ anchor: current.anchor, intent: 'question', at: current.rect });
        };
        document.addEventListener('selectionchange', onChange);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('selectionchange', onChange);
            document.removeEventListener('keydown', onKey);
            if (frame) window.cancelAnimationFrame(frame);
        };
    }, [readOnly]);

    if (readOnly) return null;
    return (
        <>
            {selection && !composition && (
                <div
                    role="toolbar"
                    aria-label="Selection actions"
                    className="selection-toolbar"
                    style={place(selection.rect, 280, false)}
                >
                    {INTENTS.map((option, index) => (
                        <button
                            key={option.intent}
                            type="button"
                            className={index === 0 ? 'is-first' : undefined}
                            // Keep the selection: a mousedown on a button would otherwise clear it.
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => openComposer({ anchor: selection.anchor, intent: option.intent, at: selection.rect })}
                        >
                            {index === 0 && <CommentIcon size={13} />}
                            {option.toolbar}
                        </button>
                    ))}
                </div>
            )}
            <Composer />
        </>
    );
}
