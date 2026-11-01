import { type ReactNode, useCallback } from 'react';
import { type ReadProgress, readPieces, readProgress } from '../../shared/readthrough';
import { currentRound, findingsUnlocked, type RoundRecord, roundItems } from '../../shared/review';
import type { View } from '../../shared/view';
import { type Pin, type Pins, PinsContext } from '../blocks/pins';
import { plainTitle } from '../components/Markdown';
import { deepEqual, useSelector } from '../store';
import { useActions, useUiState } from '../ui';

/** Whether a key press is someone typing, or in a dialog, which the deck's and the read-through's keys leave alone. */
export function typing(target: EventTarget | null): boolean {
    return (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
            ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) ||
            Boolean(target.closest('dialog, .modal')))
    );
}

/** The round on show: the one the reviewer switched to, else the current one. */
export function useShownRound(): RoundRecord {
    const { round } = useUiState();
    return useSelector((view) => {
        const review = view.review;
        if (!review) throw new Error('useShownRound outside a review');
        return review.rounds.find((candidate) => candidate.n === round) ?? currentRound(review);
    });
}

/** Whether the round on show is the one being worked on, which takes changes; an earlier round is only read. */
export function useIsCurrentRound(round: RoundRecord): boolean {
    return useSelector((view) => view.review?.rounds.at(-1)?.n === round.n);
}

/**
 * Pins the round's findings on the deck's diagrams, by the node each names, once the reviewer has finished or skipped
 * the walkthrough and while the pins view is on. Clicking a pin opens the finding.
 */
export function ReviewPins({ children }: { children: ReactNode }) {
    const round = useShownRound();
    const { goTo } = useActions();
    const pins = useSelector((view) => {
        if (!findingsUnlocked(round) || view.preferences?.views.pins === false) return [];
        return roundItems(view, round.n).flatMap((item) =>
            item.diagram ? [{ id: item.id, title: item.title, block: item.diagram.block, node: item.diagram.node }] : []
        );
    }, deepEqual);
    const pinsFor = useCallback(
        (blockId: string): Pins | undefined => {
            const here = pins.filter((pin) => pin.block === blockId);
            if (here.length === 0) return undefined;
            const byNode = new Map<string, Pin>();
            for (const node of new Set(here.map((pin) => pin.node))) {
                const on = here.filter((pin) => pin.node === node);
                byNode.set(node, {
                    count: on.length,
                    label: on.map((pin) => `${pin.id}: ${plainTitle(pin.title)}`).join('\n'),
                    open: () => goTo(`item:${on[0]!.id}`)
                });
            }
            return byNode;
        },
        [pins, goTo]
    );
    return <PinsContext.Provider value={pinsFor}>{children}</PinsContext.Provider>;
}

/** Each round's read pieces and progress by the ticks they were worked out from, so every selector shares one pass. */
const readCache = new WeakMap<
    View['ticks'],
    { pages: View['pages']; round: RoundRecord; read: ReadonlySet<string>; progress?: ReadProgress }
>();

/** The round's read state for the view's ticks and pages, worked out once. */
function readEntry(view: View, round: RoundRecord) {
    const cached = readCache.get(view.ticks);
    if (cached?.pages === view.pages && cached.round === round) return cached;
    const entry = { pages: view.pages, round, read: readPieces(view, round.index, round.n) };
    readCache.set(view.ticks, entry);
    return entry;
}

/** The ids of the round's read pieces, code on several pages read on each at once. */
export function readSet(view: View, round: RoundRecord): ReadonlySet<string> {
    return readEntry(view, round).read;
}

/** The reviewer's progress through the round's read-through. */
export function roundProgress(view: View, round: RoundRecord): ReadProgress {
    const entry: { read: ReadonlySet<string>; progress?: ReadProgress } = readEntry(view, round);
    entry.progress ??= readProgress(view, round.index, round.n, entry.read);
    return entry.progress;
}
