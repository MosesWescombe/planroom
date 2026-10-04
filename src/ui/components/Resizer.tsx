import clamp from 'lodash/clamp';
import { type PointerEvent as ReactPointerEvent, useEffect, useState } from 'react';
import { readSetting, writeSetting } from '../local';

/** A pane the user can resize: where its width is remembered, its default and minimum, and its largest share of the window. */
export interface PaneSize {
    key: string;
    initial: number;
    min: number;
    /** The most of the window the pane may take, so the page keeps room. */
    maxShare: number;
}

const KEY_STEP = 24;

/** The widest a pane may be at the current window size. */
function maxWidth(size: PaneSize): number {
    return Math.round(window.innerWidth * size.maxShare);
}

/** A width held between the pane's minimum and its largest share of the window, in whole pixels. */
function clampWidth(size: PaneSize, width: number): number {
    return Math.round(clamp(width, size.min, maxWidth(size)));
}

/** A pane's width, remembered per browser. */
export function useStoredWidth(size: PaneSize): [number, (width: number) => void] {
    const [width, setWidth] = useState(() => {
        const stored = Number(readSetting(size.key));
        return stored ? clampWidth(size, stored) : size.initial;
    });
    useEffect(() => writeSetting(size.key, width === size.initial ? undefined : String(width)), [size.key, size.initial, width]);
    return [width, (next) => setWidth(clampWidth(size, next))];
}

/**
 * The splitter on the `edge` of a pane that faces the page: drag it, or focus it and use the arrow keys, to resize
 * the pane. Double-click resets the width.
 */
export function ResizeHandle({
    label,
    edge,
    size,
    width,
    setWidth
}: {
    label: string;
    edge: 'left' | 'right';
    size: PaneSize;
    width: number;
    setWidth: (width: number) => void;
}) {
    // Moving away from the pane widens it.
    const grow = edge === 'right' ? 1 : -1;
    const onPointerDown = (event: ReactPointerEvent) => {
        if (event.button !== 0) return;
        // Keep the drag from selecting text, which would open the comment toolbar.
        event.preventDefault();
        const startX = event.clientX;
        const move = (next: PointerEvent) => setWidth(width + grow * (next.clientX - startX));
        const stop = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', stop);
            window.removeEventListener('pointercancel', stop);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', stop);
        window.addEventListener('pointercancel', stop);
    };
    return (
        <div
            role="separator"
            aria-orientation="vertical"
            aria-label={label}
            aria-valuenow={width}
            aria-valuemin={size.min}
            aria-valuemax={maxWidth(size)}
            tabIndex={0}
            title="Drag to resize, double-click to reset"
            className={`resize-handle resize-${edge}`}
            onPointerDown={onPointerDown}
            onDoubleClick={() => setWidth(size.initial)}
            onKeyDown={(event) => {
                const step = { ArrowRight: grow * KEY_STEP, ArrowLeft: -grow * KEY_STEP }[event.key];
                if (step === undefined) return;
                event.preventDefault();
                setWidth(width + step);
            }}
        />
    );
}
