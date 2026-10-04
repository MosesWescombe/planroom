/** A point, or a displacement, in whatever unit the caller lays out in. */
export interface Point {
    x: number;
    y: number;
}

/** An axis-aligned rectangle: its top-left corner and its size. */
export interface Box extends Point {
    width: number;
    height: number;
}

/** Whether two boxes overlap. Boxes that only touch do not. */
const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * Staggers annotations so none overlap. In order, each box moves by its own `step` until it clears every box placed
 * before it, so earlier boxes keep their spot. Returns each box's displacement; a zero step never moves.
 */
export function stagger(items: { box: Box; step: Point }[]): Point[] {
    const placed: Box[] = [];
    return items.map(({ box, step }) => {
        const offset = { x: 0, y: 0 };
        const at = (): Box => ({ ...box, x: box.x + offset.x, y: box.y + offset.y });
        const moves = step.x !== 0 || step.y !== 0;
        while (moves && placed.some((other) => overlaps(at(), other))) {
            offset.x += step.x;
            offset.y += step.y;
        }
        placed.push(at());
        return offset;
    });
}
