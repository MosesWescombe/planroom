import { createContext, useCallback, useRef } from 'react';

/** A step-through as the deck or a full-screen view drives it: `move` takes it a step and says whether it could. */
export interface Stepper {
    move(direction: 1 | -1): boolean;
}

/** How a step-through offers its steps to whatever holds it; the arrow keys move it before anything else. */
export const StepperContext = createContext<((stepper: Stepper) => () => void) | undefined>(undefined);

/** The step-throughs registered under this provider: `move` moves the first that can and says whether one did. */
export function useSteppers(): { register: (stepper: Stepper) => () => void; move: (direction: 1 | -1) => boolean } {
    const steppers = useRef(new Set<Stepper>());
    const register = useCallback((stepper: Stepper) => {
        steppers.current.add(stepper);
        return () => {
            steppers.current.delete(stepper);
        };
    }, []);
    const move = useCallback((direction: 1 | -1) => [...steppers.current].some((stepper) => stepper.move(direction)), []);
    return { register, move };
}
