import { z } from 'zod';
import type { PagePhase } from './derive.js';
import type { ReviewPreferences } from './review.js';
import type { RevisionMeta } from './revisions.js';
import type { SpecDelta } from './specDelta.js';
import type { PlanFormat, SessionState } from './state.js';

/**
 * What the page receives: a snapshot on connect, then patches. The view mirrors the
 * persisted state's field names, so the shared derivations read both, plus a few
 * live fields the server computes (agent status, activity, the change folder).
 */

/** How the page should describe the agent. The page adds "Reconnecting…" itself when its stream drops. */
export interface AgentStatus {
    /** `waiting`: a `planroom_wait` is parked. `push`: channel pushes are confirmed. `offline`: neither. */
    mode: 'waiting' | 'push' | 'offline';
    /** Set for a few seconds after an agent write, naming what it changed, e.g. "§4" or "Q-13". */
    editing?: string;
    /** Set while the agent has no wait parked but made a tool call in the last few seconds: it is working. */
    working?: true;
    /** Set while it works: what it is on, as words that follow "Agent", e.g. "replying to your comment on §4". */
    doing?: string;
    /** Set while it works on a comment thread: that thread's id. */
    thread?: string;
    /** Set while the agent says its subagents are running: what each one is doing. The agent counts as working. */
    subagents?: string[];
    /** Page events the agent has not received yet. */
    queued: number;
}

/** One entry of the activity feed, as the page shows it and `activity.jsonl` keeps it. */
export const activityEntry = z.object({
    id: z.number().int(),
    at: z.string(),
    /** e.g. "Reworded Q-13". */
    title: z.string(),
    /** e.g. "back to needs review". */
    detail: z.string().optional(),
    /** A record the entry links to: a question id, `section:<id>`, `thread:<id>`. */
    ref: z.string().optional(),
    /**
     * How the page shows it: `question` (the agent asked one; an info card is a plain change) stands out, `yours` (your own action) stays
     * quiet with its detail folded away, `attention` and `closed` are marked. Unset: any other change.
     */
    kind: z.enum(['question', 'yours', 'attention', 'closed']).optional()
});
export type ActivityEntry = z.infer<typeof activityEntry>;

/** One file of the change folder, as the Proposal tab renders it. */
export interface ProposalFile {
    /** Path relative to the change folder, e.g. `specs/rate-limits/spec.md`. */
    path: string;
    kind: 'proposal' | 'design' | 'tasks' | 'spec' | 'other';
    /** `new` for the proposal, design and tasks; the delta operations for a spec file. */
    marks: string[];
    content: string;
    spec?: SpecDelta;
    tasks?: { title: string; total: number; done: number }[];
}

export interface ProposalView {
    files: ProposalFile[];
    /** When the folder was last scanned. */
    scannedAt: string;
}

export interface View
    extends Pick<
        SessionState,
        | 'changeId'
        | 'title'
        | 'kind'
        | 'format'
        | 'output'
        | 'createdAt'
        | 'questions'
        | 'suggestions'
        | 'understanding'
        | 'sections'
        | 'blocks'
        | 'threads'
        | 'checklistTicks'
        | 'confirmedAssumptions'
        | 'traces'
        | 'validation'
        | 'phases'
        | 'revision'
        | 'review'
        | 'slides'
        | 'items'
        | 'reactions'
        | 'takes'
        | 'notes'
    > {
    agent: AgentStatus;
    activity: ActivityEntry[];
    revisions: RevisionMeta[];
    proposal: ProposalView;
    /** True while the submitted plan is being checked: `openspec validate`, or the Markdown plan's check. */
    validating: boolean;
    /** Set on a plan shown read-only, by the standalone browser or from another repo: no agent is attached and every write is refused. */
    viewOnly?: true;
    /** Set on a plan from another repo than the page server's: that repo's absolute path. */
    elsewhere?: string;
    /** A review's preferences, from this machine's `review.json`. */
    preferences?: ReviewPreferences;
    /** Whether a review can post to Bitbucket, and if not, what to set up. The credentials themselves never reach the page. */
    postable?: { ready: boolean; problem?: string };
}

/** Where a plan stands: its page phase while it takes edits, or how the user ended it. */
export type PlanStatus = PagePhase | 'cancelled' | 'finished';

/** One plan in the repo, as the plan switcher lists it. */
export interface PlanSummary {
    changeId: string;
    title: string;
    format: PlanFormat;
    status: PlanStatus;
    /** When its state file last changed. */
    updatedAt: string;
    /** The page URL of another Claude session that has the plan open right now. */
    liveUrl?: string;
}

/** The plans in another repo Planroom has run in. Those open read-only here, and to work on from a Claude session there. */
export interface RepoPlans {
    /** The repo's absolute path. */
    repoRoot: string;
    plans: PlanSummary[];
}

/** View fields that hold records keyed by id. A patch replaces one record, or removes it with `null`. */
export type MapField =
    | 'questions'
    | 'suggestions'
    | 'sections'
    | 'blocks'
    | 'threads'
    | 'checklistTicks'
    | 'confirmedAssumptions'
    | 'slides'
    | 'items'
    | 'reactions'
    | 'takes'
    | 'notes';

/** View fields replaced whole. */
export type ScalarField = Exclude<keyof View, MapField | 'changeId' | 'kind' | 'format' | 'createdAt' | 'viewOnly' | 'elsewhere'>;

export type MapPatch = { [K in MapField]: { field: K; id: string; value: View[K][string] | null } }[MapField];
export type ScalarPatch = { [K in ScalarField]: { field: K; value: View[K] } }[ScalarField];
export type Patch = MapPatch | ScalarPatch;

/** Every map field, patched one record at a time. */
export const MAP_FIELDS: readonly MapField[] = [
    'questions',
    'suggestions',
    'sections',
    'blocks',
    'threads',
    'checklistTicks',
    'confirmedAssumptions',
    'slides',
    'items',
    'reactions',
    'takes',
    'notes'
];

/** Whether a patch replaces one record of a map field rather than a whole field. */
export function isMapPatch(patch: Patch): patch is MapPatch {
    return 'id' in patch;
}

/** What the plan switcher lists: this repo's plans, other repos' plans, and `readOnly` when this repo's open read-only. */
export interface PlanListing {
    plans: PlanSummary[];
    elsewhere: RepoPlans[];
    /** Set by the standalone browser, which attaches no agent: every plan opens read-only. */
    readOnly: boolean;
}

/** Server-sent stream messages. */
/**
 * `closed`: Planroom stopped serving this session, so the page must not reconnect. `browse`: the page is the plan
 * browser, showing no plan.
 */
export type StreamMessage =
    | { type: 'snapshot'; view: View }
    | { type: 'patch'; patches: Patch[] }
    | { type: 'closed' }
    | { type: 'browse' };
