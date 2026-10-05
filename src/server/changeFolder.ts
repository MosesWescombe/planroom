import { type FSWatcher, promises as fs, watch } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { ValidationRecord } from '../shared/records.js';
import { parseSpecDelta, parseTasks } from '../shared/specDelta.js';
import type { ProposalFile, ProposalView } from '../shared/view.js';

/** Files larger than this are listed without their content. */
const MAX_FILE_BYTES = 512 * 1024;

/** Every file under the change folder the Proposal tab shows: no dotfiles and nothing under `.planroom/`. */
async function listFiles(dir: string, root = dir): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    const nested = await Promise.all(
        entries
            .filter((entry) => !entry.name.startsWith('.'))
            .map(async (entry) => {
                const path = join(dir, entry.name);
                if (entry.isDirectory()) return listFiles(path, root);
                return entry.isFile() ? [relative(root, path).split(sep).join('/')] : [];
            })
    );
    return nested.flat().sort(fileOrder);
}

const TOP = ['proposal.md', 'design.md', 'tasks.md'];

/** proposal, design, tasks first, then specs, then anything else. */
function fileOrder(a: string, b: string): number {
    const rank = (path: string) => {
        const top = TOP.indexOf(path);
        if (top !== -1) return top;
        return path.startsWith('specs/') ? 3 : 4;
    };
    return rank(a) - rank(b) || a.localeCompare(b);
}

/** Classify one change-folder file for the Proposal tab: its kind, its marks, and its parsed tasks or spec delta. */
function describe(path: string, content: string): ProposalFile {
    if (path === 'proposal.md' || path === 'design.md')
        return { path, kind: path === 'proposal.md' ? 'proposal' : 'design', marks: ['new'], content };
    if (path === 'tasks.md') return { path, kind: 'tasks', marks: ['new'], content, tasks: parseTasks(content) };
    if (path.startsWith('specs/') && path.endsWith('.md')) {
        const spec = parseSpecDelta(content);
        const marks = [...new Set(spec.sections.map((section) => section.operation))];
        return { path, kind: 'spec', marks, content, spec };
    }
    return { path, kind: 'other', marks: [], content };
}

/** Read the change folder into what the Proposal tab renders. */
export async function scanChangeFolder(changeDir: string, now: string): Promise<ProposalView> {
    const paths = await listFiles(changeDir);
    const files = await Promise.all(
        paths.map(async (path) => {
            const absolute = join(changeDir, path);
            const stat = await fs.stat(absolute).catch(() => undefined);
            const content = stat && stat.size <= MAX_FILE_BYTES ? await fs.readFile(absolute, 'utf8').catch(() => '') : '';
            return describe(path, content);
        })
    );
    return { files, scannedAt: now };
}

/**
 * A Markdown plan's check, in place of `openspec validate`: its `<change-id>.md` is in the plan folder and is not
 * empty.
 */
export async function checkMarkdownPlan(
    changeDir: string,
    changeId: string
): Promise<Pick<ValidationRecord, 'passed' | 'issues'>> {
    const file = `${changeId}.md`;
    const content = await fs.readFile(join(changeDir, file), 'utf8').catch(() => undefined);
    if (content?.trim()) return { passed: true, issues: [] };
    const message = content === undefined ? `${file} does not exist in the plan folder` : `${file} is empty`;
    return { passed: false, issues: [{ level: 'ERROR', path: file, message }] };
}

/**
 * Watch the change folder and call `onChange` (debounced) when any file outside
 * `.planroom/` changes. Returns a function that stops watching.
 * ponytail: recursive fs.watch (Node 20+ on Linux, native on macOS/Windows); a polling fallback if a platform lacks it.
 */
export function watchChangeFolder(changeDir: string, onChange: () => void, debounceMs = 150): () => void {
    let timer: NodeJS.Timeout | undefined;
    let watcher: FSWatcher | undefined;
    const schedule = (filename: string | Buffer | null) => {
        const name = filename?.toString() ?? '';
        if (name.split(/[\\/]/).some((part) => part.startsWith('.'))) return;
        clearTimeout(timer);
        timer = setTimeout(onChange, debounceMs);
    };
    try {
        watcher = watch(changeDir, { recursive: true }, (_event, filename) => schedule(filename));
        watcher.on('error', () => undefined);
    } catch {
        const interval = setInterval(onChange, 2000);
        return () => clearInterval(interval);
    }
    return () => {
        clearTimeout(timer);
        watcher?.close();
    };
}
