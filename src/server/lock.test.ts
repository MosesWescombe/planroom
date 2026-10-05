import { spawn } from 'node:child_process';
import { promises as fsp, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { defined, onCleanup, tempRepo } from '../test/serverHelpers.js';
import { isErrno } from './fsutil.js';
import { acquireLock, ChangeLockedError, releaseLock, updateLock } from './lock.js';

/** A process id that is running for the rest of the test. */
function livePid(): number {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    onCleanup(async () => void child.kill());
    return defined(child.pid, 'the child pid');
}

/** A process id that has exited. */
async function deadPid(): Promise<number> {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await new Promise((resolve) => child.once('exit', resolve));
    return defined(child.pid, 'the child pid');
}

describe('the change lock', () => {
    it('is taken and released on a filesystem without hard links', async () => {
        const file = join(await tempRepo(), 'lock');
        const link = vi.spyOn(fsp, 'link').mockRejectedValue(Object.assign(new Error('no links'), { code: 'EPERM' }));
        try {
            await acquireLock(file, 'http://127.0.0.1:4000/t/', 'now');
            expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ pid: process.pid });
            await releaseLock(file);
            expect(() => readFileSync(file)).toThrow();
        } finally {
            link.mockRestore();
        }
    });

    it('a reader never sees the lock empty while it is taken, rewritten or released', async () => {
        const file = join(await tempRepo(), 'lock');
        const torn: string[] = [];
        let done = false;
        const reader = (async () => {
            while (!done) {
                try {
                    const raw = readFileSync(file, 'utf8');
                    if (!raw.trim()) torn.push(raw);
                } catch (error) {
                    if (!isErrno(error, 'ENOENT')) throw error;
                }
                await new Promise((resolve) => setImmediate(resolve));
            }
        })();
        for (let n = 0; n < 150; n += 1) {
            await acquireLock(file, '(starting)', `t${n}`);
            await updateLock(file, 'http://127.0.0.1:1/tok/', `t${n}`);
            await releaseLock(file);
        }
        done = true;
        await reader;
        expect(torn).toEqual([]);
    });

    it('stale takeover: never removes a lock another process took after this one judged the old lock stale', async () => {
        const file = join(await tempRepo(), 'lock');
        const dead = await deadPid();
        await writeFile(file, JSON.stringify({ pid: dead, url: 'http://127.0.0.1:1/dead/', startedAt: 'x' }));
        const other = JSON.stringify({ pid: livePid(), url: 'http://127.0.0.1:2/other/', startedAt: 'y' });
        const kill = process.kill.bind(process);
        const spy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
            // The other process wins the race: it replaces the stale lock right after this one checked its holder.
            if (pid === dead) {
                rmSync(file);
                writeFileSync(file, other);
            }
            return kill(pid, signal);
        });
        onCleanup(async () => void spy.mockRestore());
        await expect(acquireLock(file, 'http://127.0.0.1:3/me/', 'z')).rejects.toThrow(ChangeLockedError);
        expect(readFileSync(file, 'utf8')).toBe(other);
    });
});
