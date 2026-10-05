// Regenerate the block reference in each skill from the built shared schemas.
// Run with `pnpm generate:blocks-doc`, which builds the server first.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BLOCKS_DOC_PATHS, renderBlocksDoc } from '../dist/shared/blocksDoc.js';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const doc = renderBlocksDoc();
for (const path of BLOCKS_DOC_PATHS) {
    mkdirSync(dirname(`${repoRoot}${path}`), { recursive: true });
    writeFileSync(`${repoRoot}${path}`, doc);
    console.log(`Wrote ${path}`);
}
