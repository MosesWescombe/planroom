import { type ReactNode, useCallback } from 'react';
import { currentRound, findingsUnlocked, type RoundRecord, roundItems } from '../../shared/review';
import { type Pin, type Pins, PinsContext } from '../blocks/pins';
import { deepEqual, useSelector } from '../store';
import { useActions, useUiState } from '../ui';

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
                    label: on.map((pin) => `${pin.id}: ${pin.title}`).join('\n'),
                    open: () => goTo(`item:${on[0]!.id}`)
                });
            }
            return byNode;
        },
        [pins, goTo]
    );
    return <PinsContext.Provider value={pinsFor}>{children}</PinsContext.Provider>;
}
