import { describe, expect, it } from 'vitest';
import { emptyState, parseStateFile, StateFileError } from './state.js';

describe('persisted state', () => {
    it('round-trips a fresh session', () => {
        const state = emptyState('add-x', 'Add X', '2026-09-29T00:00:00.000Z');
        expect(parseStateFile(JSON.stringify(state), 'state.json')).toEqual(state);
    });

    it('reads a file saved before plans had a format as an OpenSpec plan', () => {
        const { format: _format, ...saved } = emptyState('add-x', 'Add X', 'now', 'markdown');
        expect(parseStateFile(JSON.stringify(saved), 'state.json').format).toBe('openspec');
    });

    it.each(['plan', 'ask'] as const)('reads a %s saved before reviews existed, with its records intact', (kind) => {
        const {
            review: _review,
            slides: _slides,
            items: _items,
            reactions: _reactions,
            takes: _takes,
            notes: _notes,
            ...state
        } = {
            ...emptyState('add-x', 'Add X', 'now'),
            kind
        };
        const saved = { ...state, counters: { thread: 2, message: 1, suggestion: 0 } };
        const loaded = parseStateFile(JSON.stringify(saved), 'state.json');
        expect(loaded).toMatchObject({ ...saved, counters: { thread: 2, message: 1, suggestion: 0, note: 0 } });
        expect(loaded).toMatchObject({ review: null, slides: {}, items: {}, reactions: {}, takes: {}, notes: {} });
    });

    it('rejects an old schema version with a message that says what to do', () => {
        const old = { ...emptyState('add-x', 'Add X', 'now'), schemaVersion: 0 };
        expect(() => parseStateFile(JSON.stringify(old), 'state.json')).toThrow(StateFileError);
        expect(() => parseStateFile(JSON.stringify(old), 'state.json')).toThrow(
            /schemaVersion 0, but this Planroom reads version 1\. Update Planroom/
        );
    });

    it('rejects a torn or mismatched file by name', () => {
        expect(() => parseStateFile('{"schemaVer', 'state.json')).toThrow(/state.json is not valid JSON/);
        expect(() => parseStateFile(JSON.stringify({ schemaVersion: 1, changeId: 3 }), 'state.json')).toThrow(
            /does not match the state schema at changeId/
        );
    });
});
