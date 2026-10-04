import clamp from 'lodash/clamp';
import { type KeyboardEvent, type PointerEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MinusIcon, PlusIcon } from './icons';

const MIN_SCALE = 0.25;
const MAX_SCALE = 8;
/** One button press or key. */
const STEP = 1.25;
/** Pixels in a wheel event's line, for browsers that report a mouse wheel in lines. */
const WHEEL_LINE = 33;
/** Fitting enlarges a small picture at most this much, so a bitmap stays sharp enough. */
const FIT_MAX = 2;

interface Point {
    x: number;
    y: number;
}

/** Move a viewport's scroll position. */
function scrollTo(view: HTMLElement, to: Point): void {
    view.scrollLeft = to.x;
    view.scrollTop = to.y;
}

/** Keys that zoom in or out a step; `0` fits instead. */
const ZOOM_KEYS: Partial<Record<string, number>> = { '+': STEP, '=': STEP, '-': 1 / STEP, _: 1 / STEP };

/** Controls inside the content keep their clicks rather than starting a drag. */
const INTERACTIVE = 'button, a, input, select, textarea, summary';

/**
 * A full-screen image or diagram that zooms and scrolls. The content lays out at the picture's own width, is scaled
 * with a transform, and sits in a box of the scaled size, so the viewport's own scrolling reaches all of it and no
 * more. It opens fitted to the screen. The wheel, a trackpad pinch, the buttons, or + and − zoom, keeping the point
 * under the cursor in place; 0 fits again. Drag, the scrollbars, the arrow keys or a sideways swipe move it.
 */
export function ZoomView({ label, children }: { label: string; children: ReactNode }) {
    const viewport = useRef<HTMLDivElement>(null);
    const content = useRef<HTMLDivElement>(null);
    const [scale, setScale] = useState(1);
    const [size, setSize] = useState<{ width: number; height: number }>();
    /** The scale that fits the picture on screen. */
    const [fit, setFit] = useState(1);
    /** Whether the user zoomed since the last fit; until then a resize fits again. */
    const zoomed = useRef(false);
    const current = useRef(scale);
    current.current = scale;
    /** The scroll position that keeps the zoom's focal point still, applied once the new size has rendered. */
    const scrollAfter = useRef<Point>();
    const drag = useRef<{ from: Point; scroll: Point }>();

    const zoomTo = (next: number, focus?: Point) => {
        const view = viewport.current;
        const target = clamp(next, MIN_SCALE, MAX_SCALE);
        if (!view || target === current.current) return;
        zoomed.current = true;
        const at = focus ?? { x: view.clientWidth / 2, y: view.clientHeight / 2 };
        const ratio = target / current.current;
        scrollAfter.current = { x: (view.scrollLeft + at.x) * ratio - at.x, y: (view.scrollTop + at.y) * ratio - at.y };
        setScale(target);
    };
    const zoom = useRef(zoomTo);
    zoom.current = zoomTo;

    const fitToScreen = () => {
        const view = viewport.current;
        if (!view) return;
        zoomed.current = false;
        if (fit === current.current) scrollTo(view, { x: 0, y: 0 });
        else {
            scrollAfter.current = { x: 0, y: 0 };
            setScale(fit);
        }
    };

    useLayoutEffect(() => {
        const to = scrollAfter.current;
        scrollAfter.current = undefined;
        if (to && viewport.current) scrollTo(viewport.current, to);
    }, [scale]);

    // The content's unscaled size, re-measured as the viewport or the content changes, e.g. when an image loads. It
    // lays out at the viewport's width first: a picture narrower than that gives the width, so zooming in never
    // scrolls into empty space beside it.
    useLayoutEffect(() => {
        const view = viewport.current;
        const inner = content.current;
        if (!view || !inner || typeof ResizeObserver === 'undefined') return undefined;
        const measure = () => {
            const room = view.clientWidth;
            inner.style.width = `${room}px`;
            const pictures = [...inner.querySelectorAll('svg, img')].filter((picture) => !picture.closest('button'));
            const widest = Math.max(0, ...pictures.map((picture) => picture.getBoundingClientRect().width / current.current));
            const width = widest > 0 && widest < room ? Math.ceil(widest) : room;
            inner.style.width = `${width}px`;
            const height = inner.offsetHeight;
            setSize({ width, height });
            const fits =
                height > 0 ? clamp(Math.min(FIT_MAX, room / width, view.clientHeight / height), MIN_SCALE, MAX_SCALE) : 1;
            setFit(fits);
            if (!zoomed.current) setScale(fits);
        };
        const observer = new ResizeObserver(measure);
        observer.observe(view);
        observer.observe(inner);
        return () => observer.disconnect();
    }, []);

    // The wheel zooms rather than scrolls. React's wheel listener is passive, so it cannot stop the scroll; this one can.
    useEffect(() => {
        const view = viewport.current;
        if (!view) return undefined;
        const onWheel = (event: WheelEvent) => {
            // A sideways swipe with no vertical part still scrolls.
            if (event.deltaY === 0) return;
            event.preventDefault();
            const unit =
                event.deltaMode === WheelEvent.DOM_DELTA_LINE
                    ? WHEEL_LINE
                    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
                      ? view.clientHeight
                      : 1;
            const delta = event.deltaY * unit;
            const box = view.getBoundingClientRect();
            zoom.current(current.current * 1.002 ** -delta, { x: event.clientX - box.left, y: event.clientY - box.top });
        };
        view.addEventListener('wheel', onWheel, { passive: false });
        return () => view.removeEventListener('wheel', onWheel);
    }, []);

    // After the dialog focuses its first control, so the keys and arrow scrolling work at once.
    useEffect(() => viewport.current?.focus({ preventScroll: true }), []);

    const onKeyDown = (event: KeyboardEvent) => {
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        const step = ZOOM_KEYS[event.key];
        if (!step && event.key !== '0') return;
        event.preventDefault();
        if (step) zoomTo(scale * step);
        else fitToScreen();
    };

    // A mouse drags the view; touch keeps the browser's own panning.
    const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
        const view = viewport.current;
        if (!view || event.pointerType !== 'mouse' || event.button !== 0) return;
        if (event.target instanceof Element && event.target.closest(INTERACTIVE)) return;
        event.preventDefault();
        view.setPointerCapture?.(event.pointerId);
        drag.current = { from: { x: event.clientX, y: event.clientY }, scroll: { x: view.scrollLeft, y: view.scrollTop } };
    };
    const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
        const view = viewport.current;
        const from = drag.current;
        if (!view || !from) return;
        scrollTo(view, { x: from.scroll.x - (event.clientX - from.from.x), y: from.scroll.y - (event.clientY - from.from.y) });
    };
    const endDrag = () => {
        drag.current = undefined;
    };

    return (
        <div className="zoom" onKeyDown={onKeyDown}>
            <div className="zoom-tools" role="toolbar" aria-label="Zoom">
                <button
                    type="button"
                    className="icon-button tiny"
                    aria-label="Zoom out"
                    title="Zoom out (−)"
                    disabled={scale <= MIN_SCALE}
                    onClick={() => zoomTo(scale / STEP)}
                >
                    <MinusIcon />
                </button>
                <button
                    type="button"
                    className="zoom-level"
                    aria-label="Fit to screen"
                    title="Fit to screen (0)"
                    onClick={fitToScreen}
                >
                    {Math.round(scale * 100)}%
                </button>
                <button
                    type="button"
                    className="icon-button tiny"
                    aria-label="Zoom in"
                    title="Zoom in (+)"
                    disabled={scale >= MAX_SCALE}
                    onClick={() => zoomTo(scale * STEP)}
                >
                    <PlusIcon />
                </button>
            </div>
            <div
                ref={viewport}
                className="zoom-viewport"
                tabIndex={0}
                role="group"
                aria-label={label}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
            >
                <div
                    className="zoom-sizer"
                    style={size ? { width: size.width * scale, height: size.height * scale } : { width: '100%' }}
                >
                    <div
                        ref={content}
                        className="zoom-content"
                        style={{ ...(size ? { width: size.width } : {}), transform: `scale(${scale})` }}
                    >
                        {children}
                    </div>
                </div>
            </div>
        </div>
    );
}
