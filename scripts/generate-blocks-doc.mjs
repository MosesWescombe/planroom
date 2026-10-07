// Regenerate the block reference in each skill from the built shared schemas.
// Run with `pnpm generate:blocks-doc`, which builds the server first.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BLOCKS_DOCS, renderBlocksDoc } from '../dist/shared/blocksDoc.js';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
for (const { path, kind } of BLOCKS_DOCS) {
    mkdirSync(dirname(`${repoRoot}${path}`), { recursive: true });
    writeFileSync(`${repoRoot}${path}`, renderBlocksDoc(kind));
    console.log(`Wrote ${path}`);
}
