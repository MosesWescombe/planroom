import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { tempRepo } from '../test/serverHelpers.js';

const fsutil = fileURLToPath(new URL('./fsutil.ts', import.meta.url));

/** Two large, distinct snapshots, so a torn write would be visible as neither. */
const snapshot = (tag: string) => JSON.stringify({ tag, filler: tag.repeat(400_000) });

describe('crash during a write', () => {
    it('always reloads the state before or after the write, never a torn one', async () => {
        const dir = await tempRepo();
        const file = join(dir, 'state.json');
        const [a, b] = [snapshot('a'), snapshot('b')];
        await writeFile(file, a);
        const script = join(dir, 'writer.mjs');
        await writeFile(
            script,
            `import { writeAtomic } from ${JSON.stringify(fsutil)};
const [a, b] = [${JSON.stringify(a)}, ${JSON.stringify(b)}];
for (let n = 0; ; n += 1) {
    await writeAtomic(${JSON.stringify(file)}, n % 2 ? a : b);
    if (n === 1) process.stdout.write('writing\\n');
}`
        );
        const seen = new Set<string>();
        for (let round = 0; round < 12; round += 1) {
            const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'ignore'] });
            // Kill only once the writer has written both snapshots, so a slow start on a busy machine cannot
            // make every round end before the first write.
            await new Promise((resolve) => child.stdout.once('data', resolve));
            await new Promise((resolve) => setTimeout(resolve, round * 13));
            child.kill('SIGKILL');
            await new Promise((resolve) => child.once('exit', resolve));
            const raw = await readFile(file, 'utf8');
            expect(raw === a || raw === b).toBe(true);
            seen.add(z.object({ tag: z.string() }).parse(JSON.parse(raw)).tag);
        }
        // Both snapshots showed up, so the writer really was mid-loop when killed.
        expect([...seen].sort()).toEqual(['a', 'b']);
    });
});
