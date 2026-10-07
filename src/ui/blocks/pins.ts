import { createContext, useContext } from 'react';

/** A badge on a diagram node: how many findings sit there, their titles, and where clicking it goes. */
export interface Pin {
    count: number;
    label: string;
    open: () => void;
}

/** Every pin of one diagram block, by node: a flow or architecture node id, or a sequence actor. */
export type Pins = ReadonlyMap<string, Pin>;

/** The pins a review puts on its deck's diagrams once its findings show; none anywhere else. */
export const PinsContext = createContext<(blockId: string) => Pins | undefined>(() => undefined);

/** The pins on diagram block `id`, if any. */
export function usePins(id: string): Pins | undefined {
    return useContext(PinsContext)(id);
}
