import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
    root: `${root}src/ui`,
    base: './',
    plugins: [react({ jsxRuntime: 'automatic' })],
    build: {
        outDir: `${root}dist/ui`,
        emptyOutDir: true,
        sourcemap: true,
        // Mermaid's lazy chunks are large by nature; only a `mermaid` block ever loads them.
        chunkSizeWarningLimit: 1600
    },
    test: {
        root,
        setupFiles: ['src/test/setup.ts'],
        testTimeout: 20000,
        projects: [
            { extends: true, test: { name: 'node', include: ['src/{server,shared}/**/*.test.ts'], environment: 'node' } },
            { extends: true, test: { name: 'ui', include: ['src/ui/**/*.test.{ts,tsx}'], environment: 'jsdom' } }
        ]
    }
});
