// Regenerate the planroom skill's block reference from the built shared schemas.
// Run with `pnpm -C tools/planroom generate:blocks-doc`, which builds the server first.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BLOCKS_DOC_PATH, renderBlocksDoc } from '../dist/shared/blocksDoc.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
writeFileSync(`${repoRoot}${BLOCKS_DOC_PATH}`, renderBlocksDoc());
console.log(`Wrote ${BLOCKS_DOC_PATH}`);
