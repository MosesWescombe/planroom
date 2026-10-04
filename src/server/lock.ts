import { promises as fs, readFileSync, rmSync } from 'node:fs';
import { z } from 'zod';
import { isErrno, readIfExists, tempPathFor, writeAtomic } from './fsutil.js';

/**
 * The one-live-session-per-change lock: `.planroom/lock` holds the owning process
 * id and its page URL. A lock whose process is gone is taken over. The file is only
 * ever created or replaced whole (written to a temp file, then linked or renamed into
 * place), so a reader never sees it empty, except on a filesystem without hard links.
 */

const lockFile = z.object({ pid: z.number().int(), url: z.string(), startedAt: z.string() });
export type LockInfo = z.infer<typeof lockFile>;

/** Thrown when another running agent session holds the change. */
export class ChangeLockedError extends Error {
    /** The message names the holder's pid and page URL. */
    constructor(readonly holder: LockInfo) {
        super(`This change is already open in another Claude Code session (pid ${holder.pid}) at ${holder.url}`);
    }
}

/** Whether a process with this id is running. EPERM means it exists but belongs to someone else. */
export function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return isErrno(error, 'EPERM');
    }
}

/**
 * Take the lock for this process, or throw ChangeLockedError naming the live holder.
 * `url` is written now and can be updated once the page server is listening.
 * ponytail: pid liveness only, so a reused pid keeps a stale lock alive until that process exits.
 */
export async function acquireLock(file: string, url: string, now: string): Promise<void> {
    const mine = JSON.stringify({ pid: process.pid, url, startedAt: now } satisfies LockInfo);
    for (let attempt = 0; attempt < 3; attempt += 1) {
        if (await createLock(file, mine)) return;
        const raw = await readIfExists(file);
        if (raw === undefined) continue;
        const holder = lockFile.safeParse(safeJson(raw)).data;
        if (holder && holder.pid !== process.pid && isAlive(holder.pid)) throw new ChangeLockedError(holder);
        // Stale, unreadable or our own: remove it and try again.
        await removeIfUnchanged(file, raw);
    }
    throw new Error(`Could not take the lock at ${file}`);
}

/** Create the lock with its full contents in one step, or return false when a lock already exists. */
async function createLock(file: string, contents: string): Promise<boolean> {
    const temp = tempPathFor(file);
    try {
        await fs.writeFile(temp, contents);
        await linkOrCreate(temp, file, contents);
        return true;
    } catch (error) {
        if (isErrno(error, 'EEXIST')) return false;
        throw error;
    } finally {
        await fs.rm(temp, { force: true });
    }
}

/**
 * Remove the lock only if it still holds `raw`, the contents judged stale. It is renamed away first, which only one
 * process can do, and put back if it turns out to be a lock another process took in the meantime.
 * ponytail: a third process can take the lock while it is renamed away, and then the one put back is lost.
 */
async function removeIfUnchanged(file: string, raw: string): Promise<void> {
    const aside = tempPathFor(file);
    try {
        await fs.rename(file, aside);
    } catch (error) {
        if (isErrno(error, 'ENOENT')) return;
        throw error;
    }
    try {
        const held = await fs.readFile(aside, 'utf8');
        if (held !== raw) await linkOrCreate(aside, file, held);
    } catch (error) {
        if (!isErrno(error, 'EEXIST')) throw error;
    } finally {
        await fs.rm(aside, { force: true });
    }
}

/**
 * Hard-link `source` to `target`, failing with EEXIST when `target` exists. On a filesystem without hard links
 * (vfat, exFAT, some network mounts) fall back to an exclusive create, which a reader can briefly see empty.
 */
async function linkOrCreate(source: string, target: string, contents: string): Promise<void> {
    try {
        await fs.link(source, target);
    } catch (error) {
        if (!['EPERM', 'ENOTSUP', 'ENOSYS', 'EOPNOTSUPP'].some((code) => isErrno(error, code))) throw error;
        await fs.writeFile(target, contents, { flag: 'wx' });
    }
}

/** Replace our own lock in one step, e.g. to record the page URL once it is known. */
export async function updateLock(file: string, url: string, now: string): Promise<void> {
    await writeAtomic(file, JSON.stringify({ pid: process.pid, url, startedAt: now } satisfies LockInfo));
}

/** The running process other than this one that holds the lock, if any. */
export async function liveHolder(file: string): Promise<LockInfo | undefined> {
    const raw = await readIfExists(file);
    const holder = raw === undefined ? undefined : lockFile.safeParse(safeJson(raw)).data;
    return holder && holder.pid !== process.pid && isAlive(holder.pid) ? holder : undefined;
}

/** Release the lock if this process still holds it. */
export async function releaseLock(file: string): Promise<void> {
    const raw = await readIfExists(file);
    const holder = raw === undefined ? undefined : lockFile.safeParse(safeJson(raw)).data;
    if (holder?.pid === process.pid) await fs.rm(file, { force: true });
}

/** Synchronous release, for process exit handlers where no promise will run. */
export function releaseLockSync(file: string): void {
    try {
        const holder = lockFile.safeParse(safeJson(readFileSync(file, 'utf8'))).data;
        if (holder?.pid === process.pid) rmSync(file);
    } catch {
        // Nothing to release.
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
