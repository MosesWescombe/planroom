import '@testing-library/jest-dom/vitest';

// jsdom does no layout, which CodeMirror measures text with.
if (typeof Range !== 'undefined') {
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () => new DOMRect();
}
