import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import type { ValidationRecord } from '../shared/records.js';

/** What Planroom needs from the OpenSpec CLI. Tests pass their own. */
export interface OpenSpecRunner {
    /** Scaffold `openspec/changes/<id>/`. */
    newChange(changeId: string): Promise<void>;
    /** Run validation, `--strict` when `strict` is set, and return its issues. */
    validate(changeId: string, strict: boolean): Promise<Pick<ValidationRecord, 'passed' | 'issues' | 'output'>>;
}

const validateOutput = z.object({
    items: z.array(
        z.object({
            id: z.string(),
            valid: z.boolean(),
            issues: z
                .array(
                    z.object({ level: z.string().default('ERROR'), path: z.string().default(''), message: z.string() }).loose()
                )
                .default([])
        })
    )
});

/** The nearest of `start` and its ancestors holding an `openspec/` directory, as the CLI itself looks for its root. */
export function findOpenSpecRoot(start: string): string | undefined {
    for (let dir = resolve(start); ; dir = dirname(dir)) {
        if (existsSync(join(dir, 'openspec'))) return dir;
        if (dirname(dir) === dir) return undefined;
    }
}

/** The repo's pinned CLI, falling back to one on PATH. */
function openspecBin(repoRoot: string): string {
    const pinned = join(repoRoot, 'node_modules', '.bin', 'openspec');
    return existsSync(pinned) ? pinned : 'openspec';
}

/** Run the CLI without colour or usage telemetry, resolving with its exit code and output. */
function run(bin: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
        execFile(
            bin,
            args,
            {
                cwd,
                maxBuffer: 16 * 1024 * 1024,
                timeout: 120_000,
                env: { ...process.env, NO_COLOR: '1', OPENSPEC_TELEMETRY: '0' }
            },
            (error, stdout, stderr) => {
                const code = error && typeof error.code === 'number' ? error.code : error ? 1 : 0;
                resolve({ code, stdout, stderr: stderr || (error && !stdout ? error.message : '') });
            }
        );
    });
}

/** The real CLI, run from the repo root so it finds the repo's `openspec/`. */
export function openSpecCli(repoRoot: string, bin = openspecBin(repoRoot)): OpenSpecRunner {
    return {
        async newChange(changeId) {
            const result = await run(bin, ['new', 'change', changeId], repoRoot);
            if (result.code !== 0)
                throw new Error(`openspec new change ${changeId} failed: ${(result.stderr || result.stdout).trim()}`);
        },
        async validate(changeId, strict) {
            const args = ['validate', changeId, ...(strict ? ['--strict'] : []), '--json', '--no-interactive'];
            const result = await run(bin, args, repoRoot);
            const start = result.stdout.indexOf('{');
            let json: unknown;
            try {
                json = start === -1 ? undefined : JSON.parse(result.stdout.slice(start));
            } catch {
                json = undefined;
            }
            const parsed = validateOutput.safeParse(json);
            const item = parsed.data?.items.find((candidate) => candidate.id === changeId) ?? parsed.data?.items[0];
            if (!item) {
                return {
                    passed: false,
                    issues: [{ level: 'ERROR', path: '', message: 'openspec validate produced no result for this change' }],
                    output: `${result.stdout}\n${result.stderr}`.trim().slice(0, 8000)
                };
            }
            return {
                passed: item.valid,
                issues: item.issues.map(({ level, path, message }) => ({ level, path, message }))
            };
        }
    };
}
