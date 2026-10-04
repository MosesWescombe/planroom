import { describe, expect, it } from 'vitest';
import { captureAnchor, resolveAnchor } from './anchors.js';

const text = 'Support can raise one key. Overrides are rare and need an owner.';

describe('comment anchors', () => {
    const start = text.indexOf('raise one key');
    const anchor = captureAnchor('block:b1', text, start, start + 'raise one key'.length);

    it('captures offsets and the quote with context', () => {
        expect(anchor).toEqual({
            target: 'block:b1',
            position: { start, end: start + 13 },
            quote: { exact: 'raise one key', prefix: 'Support can ', suffix: '. Overrides are rare and need an' }
        });
    });

    it('resolves by position when nothing moved', () => {
        expect(resolveAnchor(text, anchor)).toEqual({ start, end: start + 13, method: 'position' });
    });

    it('neighbouring text rewritten: re-attaches to the same phrase', () => {
        const rewritten = `Only the support team lead can raise one key. Overrides are rare and need an owner.`;
        const found = resolveAnchor(rewritten, anchor);
        expect(found && rewritten.slice(found.start, found.end)).toBe('raise one key');
        expect(found?.method).toBe('quote');
    });

    it('prefers the occurrence whose context still matches', () => {
        const doubled = `We raise one key rarely. ${text}`;
        const found = resolveAnchor(doubled, anchor);
        expect(found?.method).toBe('context');
        expect(found?.start).toBe(doubled.indexOf('Support can raise one key') + 'Support can '.length);
    });

    it('quoted text removed: returns null so the thread shows as detached', () => {
        expect(resolveAnchor('Support can raise two keys.', anchor)).toBeNull();
    });
});
