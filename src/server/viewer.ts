import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { type Revision, revisionMeta } from '../shared/revisions.js';
import { parseStateFile, planDir } from '../shared/state.js';
import type { View } from '../shared/view.js';
import { scanChangeFolder } from './changeFolder.js';
import { RejectedError } from './draft.js';
import { hasPlan } from './plans.js';
import { formatFor, viewOf } from './session.js';
import { planroomDir, SessionStore } from './store.js';

/**
 * A plan the standalone browser shows read-only: read from disk once when opened, never locked or written, so a
 * Claude session can open the same plan meanwhile.
 * ponytail: a snapshot, so edits made after it opened show on reload; follow `state.json` if that ever matters.
 */
export class PlanViewer {
    /** Private: viewers come from `PlanViewer.open`, which reads the plan first. */
    private constructor(
        private readonly snapshot: View,
        private readonly revisions: Revision[],
        readonly store: { readonly assetsDir: string }
    ) {}

    /** Read a change's plan, rejecting a change id that has none. */
    static async open(repoRoot: string, changeId: string): Promise<PlanViewer> {
        if (!(await hasPlan(repoRoot, changeId)))
            throw new RejectedError([{ path: 'changeId', message: `${changeId} has no plan to open` }], 404);
        const format = formatFor(repoRoot, changeId, undefined);
        const store = new SessionStore(planroomDir(repoRoot, format, changeId));
        const state = parseStateFile(await fs.readFile(store.stateFile, 'utf8'), store.stateFile);
        const revisions = (await store.loadRevisions()).filter((rev) => rev.n <= state.revision);
        const now = new Date().toISOString();
        const view = viewOf(state, {
            agent: { mode: 'offline', queued: 0 },
            activity: [],
            revisions: revisionMeta(revisions),
            proposal: await scanChangeFolder(join(repoRoot, planDir(format, changeId)), now),
            validating: false,
            viewOnly: true
        });
        return new PlanViewer(view, revisions, store);
    }

    /** The plan as it was read. */
    view(): View {
        return this.snapshot;
    }

    /** Nothing changes a snapshot, so no patches ever arrive. */
    subscribe(): () => void {
        return () => undefined;
    }

    /** Refuse every page event: no agent is attached to hear it. */
    handlePage(): Promise<never> {
        return Promise.reject(
            new RejectedError(
                [{ path: '', message: `${this.snapshot.changeId} is open read-only. Ask Claude to resume it to change it.` }],
                409
            )
        );
    }

    /** Revision `n` in full, for the history and diff views. */
    revision(n: number): Revision | undefined {
        return this.revisions.find((rev) => rev.n === n);
    }
}
