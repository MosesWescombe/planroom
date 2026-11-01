import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { readIfExists, writeAtomic } from './fsutil.js';

/**
 * The user-level list of repos Planroom has run in, so the plan switcher can list plans in other repos, and each repo's
 * folder for Markdown plans where the user chose one. Every Planroom server adds its repo on start or on its first
 * plan; nothing removes one, and a repo that has gone away just lists no plans.
 */

const registry = z.object({
    repos: z.array(z.string()),
    /** Each repo's Markdown plans folder, relative to it, by its resolved path. Files from before it existed have none. */
    plansDirs: z.record(z.string(), z.string()).default({})
});
export type Registry = z.infer<typeof registry>;

/** Where the list lives: `$XDG_STATE_HOME/planroom/repos.json`, by default under `~/.local/state`. */
export function registryFile(env: NodeJS.ProcessEnv = process.env): string {
    return join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'planroom', 'repos.json');
}

/** The whole registry, or an empty one when the file is missing or unreadable. */
export async function readRegistry(file: string): Promise<Registry> {
    const raw = await readIfExists(file);
    if (raw === undefined) return { repos: [], plansDirs: {} };
    try {
        return registry.parse(JSON.parse(raw));
    } catch {
        return { repos: [], plansDirs: {} };
    }
}

/** Every repo in the list, or none when the file is missing or unreadable. */
export async function knownRepos(file: string): Promise<string[]> {
    return (await readRegistry(file)).repos;
}

/** The Markdown plans folder remembered for a repo, if the user chose one. */
export async function plansDirOf(file: string, repoRoot: string): Promise<string | undefined> {
    return (await readRegistry(file)).plansDirs[resolve(repoRoot)];
}

/**
 * Add a repo to the list, and remember `plansDir` as its Markdown plans folder when given, written whole so a reader
 * never sees it torn.
 * ponytail: read-modify-write without a lock, so two servers starting at once can drop one repo until it starts again.
 */
export async function rememberRepo(file: string, repoRoot: string, plansDir?: string): Promise<void> {
    const { repos, plansDirs } = await readRegistry(file);
    const repo = resolve(repoRoot);
    if (repos.includes(repo) && (plansDir === undefined || plansDirs[repo] === plansDir)) return;
    await fs.mkdir(dirname(file), { recursive: true });
    const next: Registry = {
        repos: repos.includes(repo) ? repos : [...repos, repo].sort(),
        plansDirs: plansDir === undefined ? plansDirs : { ...plansDirs, [repo]: plansDir }
    };
    await writeAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
}
