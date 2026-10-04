import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { readIfExists, writeAtomic } from './fsutil.js';

/**
 * The user-level list of repos Planroom has run in, so the plan switcher can list plans in other repos. Every
 * Planroom server adds its repo on start; nothing removes one, and a repo that has gone away just lists no plans.
 */

const registry = z.object({ repos: z.array(z.string()) });

/** Where the list lives: `$XDG_STATE_HOME/planroom/repos.json`, by default under `~/.local/state`. */
export function registryFile(env: NodeJS.ProcessEnv = process.env): string {
    return join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'planroom', 'repos.json');
}

/** Every repo in the list, or none when the file is missing or unreadable. */
export async function knownRepos(file: string): Promise<string[]> {
    const raw = await readIfExists(file);
    if (raw === undefined) return [];
    try {
        return registry.parse(JSON.parse(raw)).repos;
    } catch {
        return [];
    }
}

/**
 * Add a repo to the list, written whole so a reader never sees it torn.
 * ponytail: read-modify-write without a lock, so two servers starting at once can drop one repo until it starts again.
 */
export async function rememberRepo(file: string, repoRoot: string): Promise<void> {
    const repos = await knownRepos(file);
    const repo = resolve(repoRoot);
    if (repos.includes(repo)) return;
    await fs.mkdir(dirname(file), { recursive: true });
    await writeAtomic(file, `${JSON.stringify({ repos: [...repos, repo].sort() }, null, 2)}\n`);
}
