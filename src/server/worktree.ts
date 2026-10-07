import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import type { ChangedFile } from '../shared/review.js';

/**
 * The git a review runs: resolving what to review, reading its diff, and a temporary worktree at the reviewed commit
 * under the review's folder, so the agent reads the change's code without touching the reviewer's working copy.
 */

/** A git command that failed, with what it printed. */
export class GitError extends Error {}

/** Run git in `cwd` and resolve with its stdout. */
export function git(cwd: string, args: readonly string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) reject(new GitError(`git ${args[0]} failed: ${(stderr || error.message).trim()}`));
            else resolve(stdout);
        });
    });
}

/** The full hash `ref` names, or undefined when it names no commit. */
export async function commitOf(repoRoot: string, ref: string): Promise<string | undefined> {
    try {
        return (await git(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim() || undefined;
    } catch {
        return undefined;
    }
}

/**
 * The branch a local branch is reviewed against: the remote's default branch when `origin/HEAD` is set, else a local
 * `main` or `master`.
 */
export async function defaultBranch(repoRoot: string): Promise<string> {
    try {
        const head = (await git(repoRoot, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])).trim();
        if (head) return head;
    } catch {
        // No origin/HEAD: fall back to a local default branch.
    }
    for (const name of ['main', 'master']) if (await commitOf(repoRoot, `refs/heads/${name}`)) return name;
    throw new GitError('Could not tell the default branch: set origin/HEAD (git remote set-head origin -a) or create main');
}

/** The commit two commits share, where a branch left its base. */
export async function mergeBase(repoRoot: string, a: string, b: string): Promise<string> {
    return (await git(repoRoot, ['merge-base', a, b])).trim();
}

/** The `origin` remote's URL as configured, before any `insteadOf` rewrite, or undefined when there is none. */
export async function originUrl(repoRoot: string): Promise<string | undefined> {
    try {
        return (await git(repoRoot, ['config', '--get', 'remote.origin.url'])).trim() || undefined;
    } catch {
        return undefined;
    }
}

/** Fetch `branch` from origin, so the PR's commits are here to read. */
export async function fetchBranch(repoRoot: string, branch: string): Promise<void> {
    await git(repoRoot, ['fetch', '--no-tags', '--quiet', '--', 'origin', branch]);
}

const STATUS: Record<string, ChangedFile['status']> = { A: 'added', D: 'removed', R: 'renamed', C: 'added' };

/** Every file changed from `base` to `head`, by path, renames followed, with its added and removed line counts. */
export async function changedFiles(repoRoot: string, base: string, head: string): Promise<ChangedFile[]> {
    const names = (await git(repoRoot, ['diff', '-M', '--name-status', '-z', base, head])).split('\0');
    const counts = (await git(repoRoot, ['diff', '-M', '--numstat', '-z', base, head])).split('\0');
    const lines = new Map<string, { additions: number; deletions: number }>();
    for (let index = 0; index < counts.length; index += 1) {
        const [added = '', deleted = '', path = ''] = (counts[index] ?? '').split('\t');
        if (!added) continue;
        // A rename's paths follow in the next two fields: old, then new.
        const file = path || counts[(index += 2)] || '';
        // A binary file counts as "-".
        lines.set(file, { additions: Number(added) || 0, deletions: Number(deleted) || 0 });
    }
    const files: ChangedFile[] = [];
    for (let index = 0; index < names.length - 1; index += 1) {
        const code = names[index] ?? '';
        if (!code) continue;
        const renamed = code.startsWith('R') || code.startsWith('C');
        const from = renamed ? names[(index += 1)] : undefined;
        const path = names[(index += 1)] ?? '';
        files.push({
            path,
            status: STATUS[code[0] ?? ''] ?? 'modified',
            ...(from && code.startsWith('R') ? { from } : {}),
            ...(lines.get(path) ?? { additions: 0, deletions: 0 })
        });
    }
    return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** The unified diff from `base` to `head`, of one file or all of them. */
export function filePatch(repoRoot: string, base: string, head: string, file?: string): Promise<string> {
    return git(repoRoot, ['diff', '-M', '--no-color', '--no-ext-diff', base, head, ...(file ? ['--', file] : [])]);
}

/** A file's lines at `commit`, or undefined when it does not exist there. */
export async function fileAt(repoRoot: string, commit: string, file: string): Promise<string[] | undefined> {
    try {
        return (await git(repoRoot, ['show', `${commit}:${file}`])).split('\n');
    } catch {
        return undefined;
    }
}

/**
 * The lines of `file` at `from` that changed by `to`, by their numbers at `from`: `removed` lines are deleted with
 * nothing in their place, and `touched` ones are deleted, rewritten, or have new lines added before them.
 */
export async function changedLines(
    repoRoot: string,
    from: string,
    to: string,
    file: string
): Promise<{ removed: Set<number>; touched: Set<number> }> {
    const removed = new Set<number>();
    const touched = new Set<number>();
    let old = 0;
    let deletion = false;
    for (const line of (await git(repoRoot, ['diff', '-U0', '--no-color', '-M', from, to, '--', file])).split('\n')) {
        const hunk = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
        if (hunk) {
            old = Number(hunk[1]);
            // A pure insertion's hunk names the line before it, with an old count of 0.
            if (hunk[2] === '0') touched.add(old + 1);
            deletion = hunk[3] === '0';
        } else if (line.startsWith('-') && !line.startsWith('---')) {
            if (deletion) removed.add(old);
            touched.add(old);
            old += 1;
        }
    }
    return { removed, touched };
}

/**
 * Whether `dir` is the top of a working tree of its own. A plain folder inside the reviewer's checkout is not: git run
 * there acts on the checkout, so nothing is checked out in it.
 */
async function isOwnWorktree(dir: string): Promise<boolean> {
    try {
        const top = (await git(dir, ['rev-parse', '--show-toplevel'])).trim();
        return top === (await fs.realpath(dir));
    } catch {
        return false;
    }
}

/** Whether `dir` is a worktree of its own checked out at `commit`. */
async function checkedOutAt(dir: string, commit: string): Promise<boolean> {
    return (await isOwnWorktree(dir)) && (await git(dir, ['rev-parse', 'HEAD'])).trim() === commit;
}

/** Remove the worktree at `dir`, and whatever is left of it. Removing one that is not there does nothing. */
export async function removeWorktree(repoRoot: string, dir: string): Promise<void> {
    await git(repoRoot, ['worktree', 'remove', '--force', dir]).catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true });
    await git(repoRoot, ['worktree', 'prune']).catch(() => undefined);
}

/**
 * A detached worktree at `commit` in `dir`: kept when it is already there, moved when it is at another commit, and
 * added afresh when it is missing or broken, as after a crash.
 */
export async function ensureWorktree(repoRoot: string, dir: string, commit: string): Promise<void> {
    if (await checkedOutAt(dir, commit)) return;
    if (await isOwnWorktree(dir)) {
        try {
            await git(dir, ['checkout', '--quiet', '--detach', '--force', commit]);
            if (await checkedOutAt(dir, commit)) return;
        } catch {
            // A broken worktree: add it afresh.
        }
    }
    await removeWorktree(repoRoot, dir);
    await git(repoRoot, ['worktree', 'add', '--quiet', '--detach', dir, commit]);
}
