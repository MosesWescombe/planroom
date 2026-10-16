import clamp from 'lodash/clamp';
import minBy from 'lodash/minBy';
import range from 'lodash/range';
import { type RefObject, useEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import { useReducedMotion } from '../hooks';
import { typing } from './hooks';

/**
 * The read-through's keys. Page Down and Page Up go piece to piece, on past the last or the first to the next or previous
 * page. The arrow keys scroll a step at a time, stop at the end or the start of the current piece and, pressed on, pull
 * the page a little way before they go on to the next piece. Space ticks the piece nearest the middle of the view read and
 * folds or opens it.
 */

/** The room the keys leave above a piece they bring to the top, and below a piece whose end they stop at. */
const EDGE = 16;
/** How far an arrow key scrolls, as far as the browser's own. */
const STEP = 40;
/** How many presses past a piece's end or start pull through to the next, and how soon a held key pulls again. */
const PULL_STEPS = 4;
const PULL_STEP_MS = 120;
/** How far the page gives as the pull nears the next piece, and how long it holds once the key is let go. */
const PULL_PX = 48;
const PULL_HOLD_MS = 400;
/** How long a smooth scroll the keys started counts as on its way, where the browser sends no scrollend. */
const AIM_MS = 1000;
/** What Space presses itself on, so the read-through leaves it alone there. */
const PRESSABLE = 'button, a[href], summary, [role="button"], [role="tab"]';

/** A piece's top and bottom in what the page scrolls, in pixels. */
export interface Extent {
    top: number;
    bottom: number;
}

/** The page's scroll: how far down it is, how tall its view, and the most it scrolls. */
export interface Scroll {
    top: number;
    height: number;
    max: number;
}

/** What a key does: scroll to `to` with `piece` the current one, pull on past the current piece, or turn the page. */
export type KeyMove = { to: number; piece?: number } | { pull: 1 | -1 } | { page: 1 | -1 };

/** The scroll that brings `piece` to the top of the view. */
const startOf = (piece: Extent, scroll: Scroll) => clamp(piece.top - EDGE, 0, scroll.max);
/** The scroll that shows the end of `piece` at the bottom of the view. */
const endOf = (piece: Extent, scroll: Scroll) => clamp(piece.bottom + EDGE - scroll.height, 0, scroll.max);

/** Whether some of `piece` is in view. */
export function inView(piece: Extent, scroll: Scroll): boolean {
    return piece.bottom > scroll.top && piece.top < scroll.top + scroll.height;
}

/**
 * The piece being read where the page is scrolled: the first that starts at the top of the view or below it, or still
 * fills its top quarter; the last once every piece is above. -1 on a page without pieces.
 */
export function pieceAt(pieces: readonly Extent[], scroll: Scroll): number {
    const at = pieces.findIndex((piece) => piece.top >= scroll.top + EDGE - 2 || piece.bottom > scroll.top + scroll.height / 4);
    return at === -1 ? pieces.length - 1 : at;
}

/** The piece nearest the middle of the view: the one across it, else the closest. -1 on a page without pieces. */
export function middlePiece(pieces: readonly Extent[], scroll: Scroll): number {
    const middle = scroll.top + scroll.height / 2;
    return minBy(range(pieces.length), (at) => Math.max(pieces[at]!.top - middle, middle - pieces[at]!.bottom, 0)) ?? -1;
}

/**
 * Where going on past the `current` piece lands: the next piece's start, or the previous piece's end when it is taller
 * than the view, for the arrow keys to read back up; past the last or the first, the next or previous page.
 */
export function pastPiece(direction: 1 | -1, pieces: readonly Extent[], current: number, scroll: Scroll): KeyMove {
    const piece = pieces[current + direction];
    if (!piece) return { page: direction };
    const to = direction === 1 ? startOf(piece, scroll) : Math.max(startOf(piece, scroll), endOf(piece, scroll));
    return { to, piece: current + direction };
}

/** What `key` does with `current` the piece being read; nothing for a key the read-through leaves alone. */
export function keyMove(key: string, pieces: readonly Extent[], current: number, scroll: Scroll): KeyMove | undefined {
    const at = scroll.top;
    const [here, before, after] = [pieces[current], pieces[current - 1], pieces[current + 1]];
    const piece = here ? { piece: current } : {};
    switch (key) {
        case 'PageDown':
            if (here && startOf(here, scroll) > at + 1) return { to: startOf(here, scroll), piece: current };
            return pastPiece(1, pieces, current, scroll);
        case 'PageUp':
            if (here && at > startOf(here, scroll) + 1) return { to: startOf(here, scroll), piece: current };
            if (before) return { to: startOf(before, scroll), piece: current - 1 };
            return at > 1 ? { to: 0 } : { page: -1 };
        case 'ArrowDown': {
            // The last piece runs on to the foot of the page, the first from its head.
            const end = here && after ? endOf(here, scroll) : scroll.max;
            return at < end - 1 ? { to: Math.min(at + STEP, end), ...piece } : { pull: 1 };
        }
        case 'ArrowUp': {
            const start = here && before ? startOf(here, scroll) : 0;
            return at > start + 1 ? { to: Math.max(at - STEP, start), ...piece } : { pull: -1 };
        }
        default:
            return undefined;
    }
}

/**
 * `element`'s top in what `main` scrolls, summed up its offset parents, which no transform moves. A summed chain, as
 * the page the pull shifts becomes its pieces' offset parent while shifted.
 */
function topIn(main: HTMLElement, element: HTMLElement): number {
    let top = 0;
    for (let node: Element | null = element; node instanceof HTMLElement && node !== main; node = node.offsetParent)
        top += node.offsetTop;
    return top;
}

/** What Space does to each piece of the page on show, by its element. */
const spaceActions = new WeakMap<Element, () => void>();

/** Have Space call the latest `action` while `ref`'s piece is the one nearest the middle of the view. */
export function useSpaceKey(ref: RefObject<HTMLElement | null>, action: () => void): void {
    const latest = useRef(action);
    latest.current = action;
    useEffect(() => {
        const element = ref.current;
        if (!element) return undefined;
        spaceActions.set(element, () => latest.current());
        return () => {
            spaceActions.delete(element);
        };
    }, [ref]);
}

/**
 * The read-through's keys on `page`, the page on show, while no field or dialog takes them; `go` turns to the page
 * before or after it. The current piece is the one with focus, which the keys move to the piece they go to, while it is
 * in view and the reader has not scrolled away by hand; else the one being read where the page is scrolled.
 */
export function useReadKeys({
    page,
    previous,
    next,
    go
}: {
    page: string | undefined;
    previous: string | undefined;
    next: string | undefined;
    go: (page: string) => void;
}): void {
    const reduced = useReducedMotion();
    const latest = useRef({ previous, next, go, reduced });
    latest.current = { previous, next, go, reduced };
    useEffect(() => {
        const main = document.getElementById('main');
        if (!page || !main) return undefined;
        // Where the last smooth scroll is headed, so a key pressed on its way goes on from there.
        let aim: { top: number; until: number } | undefined;
        let byHand = false;
        let pull = { direction: 0, steps: 0, at: Number.NEGATIVE_INFINITY };
        let hold = 0;
        const shift = (px: number) => {
            const shown = main.querySelector<HTMLElement>('.read-page');
            if (shown) shown.style.transform = px ? `translateY(${px}px)` : '';
        };
        const unpull = () => {
            window.clearTimeout(hold);
            pull = { direction: 0, steps: 0, at: Number.NEGATIVE_INFINITY };
            shift(0);
        };
        const measure = () => {
            const elements = [...main.querySelectorAll<HTMLElement>('article.piece')];
            const pieces = elements.map((element) => {
                const top = topIn(main, element);
                return { top, bottom: top + element.offsetHeight };
            });
            const top = aim && performance.now() < aim.until ? aim.top : main.scrollTop;
            const scroll = { top, height: main.clientHeight, max: main.scrollHeight - main.clientHeight };
            const focused = elements.findIndex((element) => element.contains(document.activeElement));
            const kept = !byHand && focused !== -1 && inView(pieces[focused]!, scroll);
            return { elements, pieces, scroll, current: kept ? focused : pieceAt(pieces, scroll) };
        };
        const focus = (element: HTMLElement | undefined) => {
            if (element && !element.contains(document.activeElement)) element.focus({ preventScroll: true });
        };
        const act = (move: KeyMove, elements: HTMLElement[]) => {
            if ('pull' in move) return;
            if ('page' in move) {
                const to = move.page === 1 ? latest.current.next : latest.current.previous;
                if (to) latest.current.go(to);
                return;
            }
            aim = { top: move.to, until: performance.now() + AIM_MS };
            main.scrollTo?.({ top: move.to, behavior: latest.current.reduced ? 'auto' : 'smooth' });
            focus(move.piece === undefined ? undefined : elements[move.piece]);
        };
        const pullOn = (direction: 1 | -1, measured: ReturnType<typeof measure>) => {
            const past = pastPiece(direction, measured.pieces, measured.current, measured.scroll);
            if ('page' in past && !(direction === 1 ? latest.current.next : latest.current.previous)) return;
            if (latest.current.reduced) return act(past, measured.elements);
            window.clearTimeout(hold);
            const now = performance.now();
            if (pull.direction !== direction) pull = { direction, steps: 0, at: Number.NEGATIVE_INFINITY };
            if (now - pull.at < PULL_STEP_MS) return;
            pull = { direction, steps: pull.steps + 1, at: now };
            if (pull.steps < PULL_STEPS) return shift((-direction * PULL_PX * pull.steps) / PULL_STEPS);
            unpull();
            act(past, measured.elements);
        };
        const space = ({ elements, pieces, scroll }: ReturnType<typeof measure>): boolean => {
            const at = middlePiece(pieces, scroll);
            const element = elements[at];
            const action = element && inView(pieces[at]!, scroll) ? spaceActions.get(element) : undefined;
            if (!element || !action) return false;
            flushSync(action);
            focus(element);
            // Folded from inside, the piece's header comes back to the top, the piece after it under it.
            aim = undefined;
            const top = topIn(main, element);
            if (top < main.scrollTop) main.scrollTo?.({ top: Math.max(0, top - EDGE) });
            return true;
        };
        const onKey = (event: KeyboardEvent) => {
            if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
            if (typing(event.target)) return;
            if (event.key === ' ') {
                if (event.target instanceof Element && event.target.closest(PRESSABLE)) return;
                byHand = false;
                if (space(measure())) event.preventDefault();
                return;
            }
            const measured = measure();
            const move = keyMove(event.key, measured.pieces, measured.current, measured.scroll);
            if (!move) return;
            event.preventDefault();
            byHand = false;
            if ('pull' in move) return pullOn(move.pull, measured);
            unpull();
            act(move, measured.elements);
        };
        const onKeyUp = (event: KeyboardEvent) => {
            if (pull.steps && (event.key === 'ArrowDown' || event.key === 'ArrowUp'))
                hold = window.setTimeout(unpull, PULL_HOLD_MS);
        };
        const onHand = () => {
            byHand = true;
            aim = undefined;
        };
        const onPoint = () => {
            byHand = false;
        };
        const onEnd = () => {
            aim = undefined;
        };
        window.addEventListener('keydown', onKey);
        window.addEventListener('keyup', onKeyUp);
        main.addEventListener('wheel', onHand, { passive: true });
        main.addEventListener('touchmove', onHand, { passive: true });
        main.addEventListener('pointerdown', onPoint);
        main.addEventListener('scrollend', onEnd);
        return () => {
            unpull();
            window.removeEventListener('keydown', onKey);
            window.removeEventListener('keyup', onKeyUp);
            main.removeEventListener('wheel', onHand);
            main.removeEventListener('touchmove', onHand);
            main.removeEventListener('pointerdown', onPoint);
            main.removeEventListener('scrollend', onEnd);
        };
    }, [page]);
}
