import clamp from 'lodash/clamp';
import minBy from 'lodash/minBy';
import { captureAnchor, type ResolvedAnchor, resolveAnchor } from '../../shared/anchors';
import type { Anchor } from '../../shared/records';

/** The longest quote an anchor keeps. */
export const MAX_QUOTE = 2000;

/** The attribute that marks a commentable element, holding its anchor target. */
export const TARGET_ATTRIBUTE = 'data-anchor-target';

/** The selector for a commentable element by its target, escaped for a double-quoted attribute value. */
export function targetSelector(target: string): string {
    return `[${TARGET_ATTRIBUTE}="${target.replace(/["\\]/g, '\\$&')}"]`;
}

/** Resolution methods, best first. */
const METHODS: readonly ResolvedAnchor['method'][] = ['position', 'context', 'quote', 'target'];

/**
 * Where an anchor is on the page: the element of its target it resolves in, and where in that element's text, with
 * `found` null when its quote is gone; undefined when its target is not rendered. A target can mark several elements,
 * such as every passage of a read-through page, and the anchor is in the one that holds its quote best: with its
 * context first, then by the method that found it.
 * ponytail: it reads the whole text of every element of the target on each paint, and a read-through page or a tab
 * holds all of its text, so painting grows with page size times the comments on it; cache each element's text until
 * something in it changes if long pages stutter.
 */
export function locateAnchor(anchor: Anchor): { element: Element; found: ResolvedAnchor | null } | undefined {
    const located = [...document.querySelectorAll(targetSelector(anchor.target))].map((element) => {
        const text = anchorText(element);
        const found = resolveAnchor(text, anchor);
        const inContext =
            found !== null &&
            text.slice(0, found.start).endsWith(anchor.quote?.prefix ?? '') &&
            text.slice(found.end).startsWith(anchor.quote?.suffix ?? '');
        const rank = found ? METHODS.indexOf(found.method) + (inContext ? 0 : METHODS.length) : Number.POSITIVE_INFINITY;
        return { element, found, rank };
    });
    const best = minBy(located, 'rank');
    return best && { element: best.element, found: best.found };
}

/** The element a DOM node is, or sits in when it is text. */
function elementOf(node: Node): Element | null {
    return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

/** The commentable element around a node, if any. */
export function targetOf(node: Node): HTMLElement | null {
    return elementOf(node)?.closest<HTMLElement>(`[${TARGET_ATTRIBUTE}]`) ?? null;
}

/**
 * The text nodes of an element that comments anchor in, in order: all but those under `data-no-comment`, such as the
 * side panel or a page's list of its comments, whose quotes would otherwise hold every comment's anchor in place.
 */
function anchorNodes(root: Element): Text[] {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => {
            if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
            return (node as Element).hasAttribute('data-no-comment') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
        }
    });
    const nodes: Text[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
    return nodes;
}

/** The plain text of an element that comments anchor in, leaving out what is marked `data-no-comment`. */
export function anchorText(root: Element): string {
    return anchorNodes(root)
        .map((node) => node.data)
        .join('');
}

/** Character offset of a DOM position within an element's anchor text. */
export function textOffset(root: Element, container: Node, offset: number): number {
    const point = document.createRange();
    point.setStart(container, offset);
    let seen = 0;
    for (const node of anchorNodes(root)) {
        if (node === container) return seen + offset;
        if (point.comparePoint(node, 0) >= 0) break;
        seen += node.length;
    }
    return seen;
}

/** A DOM range over characters `start`-`end` of an element's anchor text, or null when the text is shorter. */
export function rangeFromOffsets(root: Element, start: number, end: number): Range | null {
    const range = document.createRange();
    let seen = 0;
    let started = false;
    for (const node of anchorNodes(root)) {
        const length = node.length;
        if (!started && start <= seen + length) {
            range.setStart(node, start - seen);
            started = true;
        }
        if (started && end <= seen + length) {
            range.setEnd(node, end - seen);
            return range;
        }
        seen += length;
    }
    return null;
}

/** Where a selection sits in the window. */
export interface SelectionBox {
    top: number;
    left: number;
    bottom: number;
}

/** Where `range` sits in the window, or where `fallback` does where ranges have no layout. */
export function boxOf(range: Range, fallback: Element): SelectionBox {
    const box =
        typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : fallback.getBoundingClientRect();
    return { top: box.top, left: box.left, bottom: box.bottom };
}

/** Where to float a box `width` wide by a selection: above it, or below it, kept inside the window. */
export function place(at: SelectionBox | undefined, width: number, below: boolean): React.CSSProperties {
    if (!at) return {};
    const left = clamp(at.left, 12, window.innerWidth - width - 12);
    // Kept on screen, so a box opened by something scrolled out of sight still shows.
    return below
        ? { top: clamp(at.bottom + 8, 8, window.innerHeight - 320), left }
        : { top: clamp(at.top - 46, 8, window.innerHeight - 54), left };
}

export interface SelectionAnchor {
    anchor: Anchor;
    rect: SelectionBox;
}

/**
 * The current selection as a comment anchor on the nearest commentable element around all of it. Nothing when it
 * starts in a form field or either end sits in text marked `data-no-comment`.
 */
export function captureSelection(selection: Selection | null = window.getSelection()): SelectionAnchor | undefined {
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return undefined;
    const range = selection.getRangeAt(0);
    if (elementOf(range.startContainer)?.closest('input, textarea, select, button, [contenteditable="true"]')) return undefined;
    return captureRange(range);
}

/** Whether a comment can anchor in `element`: it sits in a commentable element, and in nothing marked `data-no-comment`. */
export function commentable(element: Element): boolean {
    return targetOf(element) !== null && !element.closest('[data-no-comment]');
}

/**
 * A range as a comment anchor on the nearest commentable element around all of it, as if it were selected: what a
 * button that asks about some text, such as a code walk's step, quotes. Nothing when either end sits in text marked
 * `data-no-comment`.
 */
export function captureRange(range: Range): SelectionAnchor | undefined {
    // The side panel, and code with a Comment bar of its own, are marked as no place for one.
    if ([range.startContainer, range.endContainer].some((node) => elementOf(node)?.closest('[data-no-comment]')))
        return undefined;
    // The nearest target around both ends: the passage they share, else what holds both, such as the page or the tab.
    const target = targetOf(range.commonAncestorContainer);
    if (!target) return undefined;
    const text = anchorText(target);
    let start = textOffset(target, range.startContainer, range.startOffset);
    let end = textOffset(target, range.endContainer, range.endOffset);
    // Trim the whitespace a double-click or drag often picks up.
    while (start < end && /\s/.test(text[start] ?? '')) start += 1;
    while (end > start && /\s/.test(text[end - 1] ?? '')) end -= 1;
    if (end <= start) return undefined;
    end = Math.min(end, start + MAX_QUOTE);
    return {
        anchor: captureAnchor(target.getAttribute(TARGET_ATTRIBUTE)!, text, start, end),
        rect: boxOf(range, target)
    };
}
