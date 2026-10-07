import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULT_PREFERENCES, type ReviewPreferences, reviewPreferences } from '../shared/review.js';
import { readIfExists, writeAtomic } from './fsutil.js';

/**
 * The reviewer's preferences, kept per machine in `$XDG_CONFIG_HOME/planroom/review.json` rather than in the browser,
 * whose storage is per port and so would reset with every session.
 */

/** Where this machine's review preferences live. */
export function preferencesFile(env: NodeJS.ProcessEnv = process.env): string {
    return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'planroom', 'review.json');
}

/** The saved preferences, with defaults for anything missing; an unreadable file reads as the defaults. */
export async function readPreferences(file: string): Promise<ReviewPreferences> {
    const raw = await readIfExists(file).catch(() => undefined);
    if (raw === undefined) return DEFAULT_PREFERENCES;
    try {
        return reviewPreferences.parse(JSON.parse(raw));
    } catch {
        console.error(`planroom: ${file} is not valid review preferences; using the defaults`);
        return DEFAULT_PREFERENCES;
    }
}

/** Save the preferences, replacing the file atomically. */
export async function writePreferences(file: string, preferences: ReviewPreferences): Promise<void> {
    await fs.mkdir(dirname(file), { recursive: true });
    await writeAtomic(file, `${JSON.stringify(preferences, null, 2)}\n`);
}
