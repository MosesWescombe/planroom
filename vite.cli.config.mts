import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

/** Bundles the `planroom` command, server and all, into one dependency-free `dist/cli.js` beside the built page. */
export default defineConfig({
    logLevel: 'warn',
    ssr: { noExternal: true, target: 'node' },
    build: {
        ssr: `${root}src/cli.ts`,
        outDir: `${root}dist`,
        emptyOutDir: false,
        target: 'node24',
        rolldownOptions: {
            output: { entryFileNames: 'cli.js', banner: '#!/usr/bin/env node' }
        }
    }
});
