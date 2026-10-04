import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { blockTypes } from './blocks.js';
import { BLOCKS_DOC_PATH, renderBlocksDoc } from './blocksDoc.js';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

describe('the generated block reference', () => {
    it('is up to date with the block schemas (run pnpm -C tools/planroom generate:blocks-doc)', () => {
        expect(readFileSync(`${repoRoot}${BLOCKS_DOC_PATH}`, 'utf8')).toBe(renderBlocksDoc());
    });

    it('covers every block type with an example and its schema', () => {
        const doc = renderBlocksDoc();
        for (const type of blockTypes) expect(doc).toContain(`## ${type}\n`);
        expect(doc.match(/Config schema:/g)).toHaveLength(blockTypes.length);
    });
});
