import { describe, expect, it } from 'vitest';
import { keyMove, pastPiece, pieceAt } from './readKeys';

/** A tall piece then a short one, down an 800px view that scrolls to 2400. */
const PIECES = [
    { top: 100, bottom: 1100 },
    { top: 1116, bottom: 1416 }
];
const at = (top: number) => ({ top, height: 800, max: 2400 });

describe('the read-through keys', () => {
    it('reads the piece at the top of the view, or the one after a piece all but scrolled past', () => {
        expect(pieceAt(PIECES, at(0))).toBe(0);
        expect(pieceAt(PIECES, at(900))).toBe(1);
        expect(pieceAt(PIECES, at(2000))).toBe(1);
        expect(pieceAt([], at(0))).toBe(-1);
    });

    it('scrolls up to the start of a piece, then pulls back to the end of a tall piece before it', () => {
        expect(keyMove('ArrowUp', PIECES, 1, at(1140))).toEqual({ to: 1100, piece: 1 });
        expect(keyMove('ArrowUp', PIECES, 1, at(1100))).toEqual({ pull: -1 });
        expect(pastPiece(-1, PIECES, 1, at(1100))).toEqual({ to: 316, piece: 0 });
    });

    it('runs the first piece up to the head of the page, and the last down to its foot', () => {
        expect(keyMove('ArrowUp', PIECES, 0, at(84))).toEqual({ to: 44, piece: 0 });
        expect(keyMove('ArrowDown', PIECES, 1, at(1100))).toEqual({ to: 1140, piece: 1 });
        expect(keyMove('ArrowDown', PIECES, 1, at(2400))).toEqual({ pull: 1 });
        expect(pastPiece(1, PIECES, 1, at(2400))).toEqual({ page: 1 });
    });

    it('pages up to the head of the page, then to the page before', () => {
        expect(keyMove('PageUp', PIECES, 0, at(84))).toEqual({ to: 0 });
        expect(keyMove('PageUp', PIECES, 0, at(0))).toEqual({ page: -1 });
        expect(keyMove('PageUp', [], -1, at(0))).toEqual({ page: -1 });
        expect(keyMove('Enter', PIECES, 0, at(0))).toBeUndefined();
    });
});
