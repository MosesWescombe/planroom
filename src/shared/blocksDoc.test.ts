import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { blockTypes } from './blocks.js';
import { BLOCKS_DOCS, renderBlocksDoc } from './blocksDoc.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

describe('the generated block reference', () => {
    it.each(BLOCKS_DOCS)('$path is up to date with the block schemas (run pnpm generate:blocks-doc)', ({ path, kind }) => {
        expect(readFileSync(`${repoRoot}${path}`, 'utf8')).toBe(renderBlocksDoc(kind));
    });

    it('covers every block type with an example and its schema in the review skill', () => {
        const doc = renderBlocksDoc('review');
        for (const type of blockTypes) expect(doc).toContain(`## ${type}\n`);
        expect(doc.match(/Config schema:/g)).toHaveLength(blockTypes.length);
    });

    it.each(['plan', 'ask'] as const)('gives the %s skill the shared new blocks and leaves out the review-only ones', (kind) => {
        const doc = renderBlocksDoc(kind);
        for (const type of ['analogy', 'stepThrough', 'compare']) expect(doc).toContain(`## ${type}\n`);
        for (const type of ['yourTake', 'html']) expect(doc).not.toContain(`## ${type}\n`);
    });
});
