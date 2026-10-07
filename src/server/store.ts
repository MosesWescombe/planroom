import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import isEqual from 'lodash/isEqual.js';
import { type LoggedEvent, loggedEvent } from '../shared/events.js';
import { type Revision, revision as revisionSchema } from '../shared/revisions.js';
import { ASK_ROOT, type PlanFormat, parseStateFile, planDir, REVIEW_ROOT, type SessionState } from '../shared/state.js';
import { type ActivityEntry, activityEntry } from '../shared/view.js';
import { appendLineSynced, isErrno, readIfExists, writeAtomic } from './fsutil.js';

/** A plan's `.planroom` folder: in its OpenSpec change folder, or its folder under `agent-plans/`. */
export function planroomDir(repoRoot: string, format: PlanFormat, changeId: string): string {
    return join(repoRoot, planDir(format, changeId), '.planroom');
}

/** An ask's records folder, under `.planroom/asks/`. */
export function askDir(repoRoot: string, askId: string): string {
    return join(repoRoot, ASK_ROOT, askId);
}

/** A review's folder, under `.planroom/reviews/`: its records, its assets and its worktree. */
export function reviewDir(repoRoot: string, reviewId: string): string {
    return join(repoRoot, REVIEW_ROOT, reviewId);
}

/** The files in a plan's `.planroom/` that are local mechanics rather than the planning record, which git leaves out. */
export const LOCAL_FILES: readonly string[] = ['events.jsonl*', 'activity.jsonl*', 'revisions/', 'lock', '.*.tmp'];

/**
 * Give `dir` a `.gitignore` leaving out `patterns`, by default everything in it as tool caches do, unless it already
 * has one.
 */
export async function ignoreInGit(dir: string, patterns: readonly string[] = ['*']): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
    try {
        await fs.writeFile(join(dir, '.gitignore'), `${patterns.join('\n')}\n`, { flag: 'wx' });
    } catch (error) {
        if (!isErrno(error, 'EEXIST')) throw error;
    }
}

/**
 * Everything one session keeps on disk, under its plan's `.planroom/` (see `planroomDir`):
 *
 * - `state.json`   the current snapshot, the planning record that travels with the change
 * - `events.jsonl` the page event log (gitignored)
 * - `activity.jsonl` the activity feed, oldest first, so a resumed or read-only plan keeps it (gitignored)
 * - `revisions/`   write-up revisions for undo and history (gitignored)
 * - `lock`         the live session's pid and URL (gitignored)
 * - `assets/`      images the agent references as `asset:<name>`, and images the user pastes into messages
 * - `.gitignore`   the gitignored files above (`LOCAL_FILES`), written when a plan opens
 *
 * A page event is committed by writing the snapshot that includes it (with the event
 * as `lastEvent`), then appending it to the log. A crash between the two leaves the
 * log one short, and `load` completes it from the snapshot. A log with no snapshot
 * belongs to a dead session and is moved aside, so a fresh session's log starts at seq 1.
 */
export class SessionStore {
    readonly stateFile: string;
    readonly eventsFile: string;
    readonly activityFile: string;
    readonly revisionsDir: string;
    readonly lockFile: string;
    readonly assetsDir: string;

    /** Every path lives under `dir`, the change's `.planroom` folder. */
    constructor(readonly dir: string) {
        this.stateFile = join(dir, 'state.json');
        this.eventsFile = join(dir, 'events.jsonl');
        this.activityFile = join(dir, 'activity.jsonl');
        this.revisionsDir = join(dir, 'revisions');
        this.lockFile = join(dir, 'lock');
        this.assetsDir = join(dir, 'assets');
    }

    /** Create the session folder and its revisions folder. */
    async init(): Promise<void> {
        await fs.mkdir(this.revisionsDir, { recursive: true });
    }

    /**
     * Load the snapshot, the log and the revisions, repairing the log after a crash between the two commit writes.
     * Without a snapshot there is nothing to resume: a log left behind (the snapshot was checked out away or moved
     * aside) is renamed to `events.jsonl.orphaned-<time>`, so the fresh session never appends to it. A log from another
     * history than the snapshot's is moved aside the same way and restarted from the snapshot's last event. The activity
     * feed goes with its log.
     */
    async load(): Promise<{ state: SessionState; events: LoggedEvent[]; revisions: Revision[] } | undefined> {
        const raw = await readIfExists(this.stateFile);
        if (raw === undefined) {
            await this.moveOrphanedLogAside();
            return undefined;
        }
        const state = parseStateFile(raw, this.stateFile);
        let events = await this.loadEvents();
        if (!logMatches(events, state.lastEvent)) {
            // The snapshot is written before the log, so a log ahead of it, or disagreeing at its last event, belongs
            // to another history: an older state.json checked out over a newer log.
            await this.moveOrphanedLogAside();
            events = [];
        }
        const last = events[events.length - 1]?.seq ?? 0;
        if (state.lastEvent && state.lastEvent.seq > last) {
            await this.appendEvent(state.lastEvent);
            events.push(state.lastEvent);
        }
        const revisions = (await this.loadRevisions()).filter((rev) => rev.n <= state.revision);
        return { state, events, revisions };
    }

    /** Rename a log that has no snapshot, and its activity feed, out of the way, keeping them for inspection. */
    private async moveOrphanedLogAside(): Promise<void> {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        for (const file of [this.eventsFile, this.activityFile]) {
            try {
                await fs.rename(file, `${file}.orphaned-${stamp}`);
            } catch (error) {
                if (!isErrno(error, 'ENOENT')) throw error;
            }
        }
    }

    /** Replace the snapshot atomically. */
    async saveState(state: SessionState): Promise<void> {
        await writeAtomic(this.stateFile, `${JSON.stringify(state, null, 2)}\n`);
    }

    /** Append one event to the log, cutting off a torn final line first, and sync it to disk. */
    async appendEvent(event: LoggedEvent): Promise<void> {
        await appendLineSynced(this.eventsFile, JSON.stringify(event));
    }

    /** Every logged event, in order. A torn final line from a crash mid-append is dropped; the next append cuts it off. */
    async loadEvents(): Promise<LoggedEvent[]> {
        const raw = await readIfExists(this.eventsFile);
        if (!raw) return [];
        const lines = raw.split('\n').filter((line) => line.trim());
        const events: LoggedEvent[] = [];
        lines.forEach((line, index) => {
            const parsed = loggedEvent.safeParse(safeJson(line));
            if (parsed.success) events.push(parsed.data);
            else if (index < lines.length - 1) throw new Error(`${this.eventsFile} line ${index + 1} is not a valid event`);
        });
        return events;
    }

    /**
     * Append activity entries, oldest first. Unsynced: the feed is a convenience, not the record, so a crash may lose
     * its last entries, and a torn line is skipped on load.
     */
    async appendActivity(entries: readonly ActivityEntry[]): Promise<void> {
        await fs.appendFile(this.activityFile, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''), 'utf8');
    }

    /**
     * The newest `limit` activity entries, newest first, as the page shows them. The feed is a convenience, not the
     * record, so an unreadable line is skipped rather than refused.
     * ponytail: reads the whole append-only file; trim it on load if a session ever logs enough for that to matter.
     */
    async loadActivity(limit: number): Promise<ActivityEntry[]> {
        const raw = await readIfExists(this.activityFile);
        if (!raw) return [];
        return raw
            .split('\n')
            .flatMap((line) => activityEntry.safeParse(safeJson(line)).data ?? [])
            .slice(-limit)
            .reverse();
    }

    /** Write a revision to its own file, atomically. */
    async saveRevision(rev: Revision): Promise<void> {
        await writeAtomic(join(this.revisionsDir, `${rev.n}.json`), JSON.stringify(rev));
    }

    /** Every readable revision, oldest first. An unreadable file is skipped, and a missing folder reads as none. */
    async loadRevisions(): Promise<Revision[]> {
        let names: string[];
        try {
            names = await fs.readdir(this.revisionsDir);
        } catch {
            return [];
        }
        const revisions = await Promise.all(
            names
                .filter((name) => /^\d+\.json$/.test(name))
                .map(
                    async (name) =>
                        revisionSchema.safeParse(safeJson(await fs.readFile(join(this.revisionsDir, name), 'utf8'))).data
                )
        );
        return revisions.filter((rev): rev is Revision => rev !== undefined).sort((a, b) => a.n - b.n);
    }
}

/** Parse JSON, or undefined when it is not. */
function safeJson(raw: string): unknown {
    try {
        return JSON.parse(raw);
    } catch {
        return undefined;
    }
}

/**
 * Whether the log can continue the snapshot: it may lag the snapshot by its last event (a crash between the two
 * commit writes), but never run ahead of it or disagree with the event both hold.
 */
function logMatches(events: LoggedEvent[], lastEvent: LoggedEvent | null): boolean {
    const last = events[events.length - 1]?.seq ?? 0;
    const target = lastEvent?.seq ?? 0;
    if (last > target) return false;
    if (!lastEvent || last < target) return true;
    return isEqual(events[events.length - 1], lastEvent);
}
