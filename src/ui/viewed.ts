import { type RefObject, useState } from 'react';
import { z } from 'zod';
import { useOnScreenFor } from './hooks';
import { readJson, storageScope, writeJson } from './local';
import { useSelector } from './store';

/**
 * What this browser has had on screen, kept per change in localStorage as the quiz refs `shared/quiz.ts` names: the
 * write-up and slide blocks, findings and read-through pieces read so far. Quiz me asks only about these.
 */

/** How long something stays on screen before it counts as seen. */
export const VIEWED_MS = 2000;

const viewedSchema = z.array(z.string());

/** The localStorage key a page's seen refs are kept under, by its `storageScope`. */
function viewedKey(scope: string): string {
    return `planroom:${scope}:viewed`;
}

/** The refs a page has had on screen in this browser, or none when nothing valid is stored. */
export function readViewed(scope: string): string[] {
    return viewedSchema.safeParse(readJson(viewedKey(scope))).data ?? [];
}

/** Record that `ref` has been on screen. */
function markViewed(scope: string, ref: string): void {
    const viewed = readViewed(scope);
    if (!viewed.includes(ref)) writeJson(viewedKey(scope), [...viewed, ref]);
}

/**
 * Record `ref` as seen once `element` has been on screen for `VIEWED_MS` while `active`, as a folded piece is not; one
 * already seen is not watched.
 */
export function useViewed(ref: string, element: RefObject<HTMLElement | null>, active = true): void {
    const scope = useSelector(storageScope);
    const [seen] = useState(() => readViewed(scope).includes(ref));
    useOnScreenFor(element, active && !seen, VIEWED_MS, () => markViewed(scope, ref));
}
