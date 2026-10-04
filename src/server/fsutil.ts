import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * Durable file writes. A snapshot is written to a temp file, fsynced and renamed
 * over the old one, so a crash leaves either the old file or the new one, never a
 * torn one. An append is fsynced before it returns.
 */

/** Fsync a directory so a rename or a new file in it survives a power loss. Some platforms refuse; that is not an error. */
async function syncDir(dir: string): Promise<void> {
    let handle: fs.FileHandle | undefined;
    try {
        handle = await fs.open(dir, 'r');
        await handle.sync();
    } catch {
        // Directory fsync is unsupported on some platforms (Windows); the rename is still atomic.
    } finally {
        await handle?.close();
    }
}

/** A unique hidden temp path next to `file`, which the repo's `.*.tmp` ignore rule covers. */
export function tempPathFor(file: string): string {
    return join(dirname(file), `.${basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
}

/** Atomically replace `file` with `contents`. */
export async function writeAtomic(file: string, contents: string): Promise<void> {
    const dir = dirname(file);
    const temp = tempPathFor(file);
    const handle = await fs.open(temp, 'w');
    try {
        await handle.writeFile(contents, 'utf8');
        await handle.sync();
    } finally {
        await handle.close();
    }
    try {
        await fs.rename(temp, file);
    } catch (error) {
        await fs.rm(temp, { force: true });
        throw error;
    }
    await syncDir(dir);
}

/**
 * Append one JSON line to `file` and fsync it before returning. A final line with no newline is finished first when
 * it is complete JSON (a crash lost only the newline), and cut off when it is a torn fragment, so the new line always
 * starts on a line of its own.
 */
export async function appendLineSynced(file: string, line: string): Promise<void> {
    const handle = await fs.open(file, 'a+');
    try {
        const { size } = await handle.stat();
        const end = await lastLineEnd(handle, size);
        let prefix = '';
        if (end < size) {
            const tail = Buffer.alloc(size - end);
            await handle.read(tail, 0, tail.length, end);
            if (isJson(tail.toString('utf8'))) prefix = '\n';
            else await handle.truncate(end);
        }
        await handle.appendFile(`${prefix}${line}\n`, 'utf8');
        await handle.sync();
    } finally {
        await handle.close();
    }
}

/** Whether `text` parses as JSON. */
function isJson(text: string): boolean {
    try {
        JSON.parse(text);
        return true;
    } catch {
        return false;
    }
}

/** The offset just past the last newline in the first `size` bytes, or 0 when there is none. */
async function lastLineEnd(handle: fs.FileHandle, size: number): Promise<number> {
    const chunk = Buffer.alloc(4096);
    for (let end = size; end > 0; ) {
        const start = Math.max(0, end - chunk.length);
        const { bytesRead } = await handle.read(chunk, 0, end - start, start);
        const newline = chunk.subarray(0, bytesRead).lastIndexOf(0x0a);
        if (newline !== -1) return start + newline + 1;
        end = start;
    }
    return 0;
}

/** Read a file, or return undefined when it does not exist. */
export async function readIfExists(file: string): Promise<string | undefined> {
    try {
        return await fs.readFile(file, 'utf8');
    } catch (error) {
        if (isErrno(error, 'ENOENT')) return undefined;
        throw error;
    }
}

/** Whether `error` is a Node system error with the given code. */
export function isErrno(error: unknown, code: string): boolean {
    return error instanceof Error && 'code' in error && error.code === code;
}
