import clamp from 'lodash/clamp';
import { captureAnchor } from '../../shared/anchors';
import type { Anchor } from '../../shared/records';

/** The longest quote an anchor keeps. */
export const MAX_QUOTE = 2000;

/** The attribute that marks a commentable element, holding its anchor target. */
export const TARGET_ATTRIBUTE = 'data-anchor-target';

/** The selector for a commentable element by its target, escaped for a double-quoted attribute value. */
export function targetSelector(target: string): string {
    return `[${TARGET_ATTRIBUTE}="${target.replace(/["\\]/g, '\\$&')}"]`;
}

/** The element a DOM node is, or sits in when it is text. */
function elementOf(node: Node): Element | null {
    return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

/** The commentable element around a node, if any. */
export function targetOf(node: Node): HTMLElement | null {
    return elementOf(node)?.closest<HTMLElement>(`[${TARGET_ATTRIBUTE}]`) ?? null;
}

/** Character offset of a DOM position within an element's plain text. */
export function textOffset(root: Element, container: Node, offset: number): number {
    const range = document.createRange();
    range.selectNodeContents(root);
    range.setEnd(container, offset);
    return range.toString().length;
}

/** A DOM range over characters `start`-`end` of an element's plain text, or null when the text is shorter. */
export function rangeFromOffsets(root: Element, start: number, end: number): Range | null {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let seen = 0;
    let started = false;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const length = node.textContent?.length ?? 0;
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
    return below ? { top: Math.min(at.bottom + 8, window.innerHeight - 320), left } : { top: Math.max(8, at.top - 46), left };
}

export interface SelectionAnchor {
    anchor: Anchor;
    rect: SelectionBox;
}

/**
 * The current selection as a comment anchor, when it lies inside one commentable
 * element and not inside a form field.
 */
export function captureSelection(selection: Selection | null = window.getSelection()): SelectionAnchor | undefined {
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return undefined;
    const range = selection.getRangeAt(0);
    const target = targetOf(range.startContainer);
    if (!target || target !== targetOf(range.endContainer)) return undefined;
    if (elementOf(range.startContainer)?.closest('input, textarea, select, button, [contenteditable="true"]')) return undefined;
    const text = target.textContent ?? '';
    let start = textOffset(target, range.startContainer, range.startOffset);
    let end = start + range.toString().length;
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
