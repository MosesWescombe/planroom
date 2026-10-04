import { useEffect, useState } from 'react';
import { readSetting, writeSetting } from './local';

/** The main column widths the user can choose, narrowest first. */
export const PAGE_WIDTHS = ['narrow', 'normal', 'wide'] as const;
export type PageWidth = (typeof PAGE_WIDTHS)[number];

const KEY = 'planroom:width';

/** The stored width, or `normal` when nothing valid is stored. */
export function readPageWidth(): PageWidth {
    const stored = readSetting(KEY);
    return PAGE_WIDTHS.find((width) => width === stored) ?? 'normal';
}

/** Put the width on the root element, where the stylesheet turns it into `--page-width`. */
export function applyPageWidth(width: PageWidth, root: HTMLElement = document.documentElement): void {
    root.dataset.width = width;
}

/** The main column's narrow/normal/wide choice, remembered in this browser and applied to the page. */
export function usePageWidth(): { width: PageWidth; setWidth: (next: PageWidth) => void } {
    const [width, setWidth] = useState<PageWidth>(readPageWidth);
    useEffect(() => {
        writeSetting(KEY, width === 'normal' ? undefined : width);
        applyPageWidth(width);
    }, [width]);
    return { width, setWidth };
}
