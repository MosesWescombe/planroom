import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';

// A review keeps its place in the address: start every test from a bare one.
if (typeof window !== 'undefined') afterEach(() => window.history.replaceState(null, '', '/'));

// jsdom does no layout, which CodeMirror measures text with.
if (typeof Range !== 'undefined') {
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () => new DOMRect();
}
