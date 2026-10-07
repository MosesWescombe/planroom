import { z } from 'zod';
import { loggedEvent } from './events.js';
import { questionRecord } from './questions.js';
import {
    blockRecord,
    phaseState,
    sectionRecord,
    suggestionRecord,
    threadRecord,
    traceRecord,
    understandingRecord,
    validationRecord
} from './records.js';
import { itemRecord, noteRecord, reactionRecord, reviewRecord, slideRecord, takeRecord } from './review.js';

/** Bump when the persisted shape changes incompatibly; older files are rejected with a clear message. */
export const STATE_SCHEMA_VERSION = 1;

/**
 * What a plan becomes on submit: an OpenSpec change, or a Markdown plan at `agent-plans/<id>/<id>.md`. Fixed when the
 * plan is created, since it decides the folder the plan lives in.
 */
export const planFormat = z.enum(['openspec', 'markdown']);
export type PlanFormat = z.infer<typeof planFormat>;

/** The repo folder each format's plans live in, one folder per plan. */
export const PLAN_ROOTS: Readonly<Record<PlanFormat, string>> = { openspec: 'openspec/changes', markdown: 'agent-plans' };

/** The repo-relative folder a plan's files and its `.planroom/` live in. */
export function planDir(format: PlanFormat, changeId: string): string {
    return `${PLAN_ROOTS[format]}/${changeId}`;
}

/**
 * What a session is: a `plan`, taken through the four phases to a proposal, an `ask`, a page of question cards an
 * agent puts to the user at any point in its work, which ends in a transcript of the answers, or a `review` of a PR or
 * a branch, walked through as a deck, reviewed and turned into comments.
 */
export const sessionKind = z.enum(['plan', 'ask', 'review']);
export type SessionKind = z.infer<typeof sessionKind>;

/** The repo folder asks keep their records in, one folder per ask. Its parent ignores itself in git. */
export const ASK_ROOT = '.planroom/asks';

/** The repo folder reviews keep their records and worktree in, one folder per review. */
export const REVIEW_ROOT = '.planroom/reviews';

/** The repo-relative folder a session keeps its records in: a plan's `.planroom/`, or an ask's or a review's own folder. */
export function recordsDir(state: Pick<SessionState, 'kind' | 'format' | 'changeId'>): string {
    if (state.kind === 'ask') return `${ASK_ROOT}/${state.changeId}`;
    if (state.kind === 'review') return `${REVIEW_ROOT}/${state.changeId}`;
    return `${planDir(state.format, state.changeId)}/.planroom`;
}

/**
 * Everything Planroom persists for one change, in `.planroom/state.json`. It is the
 * planning record that travels with the change.
 */
export const sessionState = z.object({
    schemaVersion: z.literal(STATE_SCHEMA_VERSION),
    changeId: z.string(),
    title: z.string(),
    /** Sessions saved before asks existed are plans. */
    kind: sessionKind.default('plan'),
    /** Plans saved before the format existed are OpenSpec ones. An ask has no use for it. */
    format: planFormat.default('openspec'),
    /** An ask's repo-relative Markdown file, written with the transcript when the user sends their answers. */
    output: z.string().optional(),
    createdAt: z.string(),
    questions: z.record(z.string(), questionRecord),
    suggestions: z.record(z.string(), suggestionRecord),
    understanding: understandingRecord,
    sections: z.record(z.string(), sectionRecord),
    blocks: z.record(z.string(), blockRecord),
    threads: z.record(z.string(), threadRecord),
    /** Page-owned checklist ticks: blockId -> item key -> done. */
    checklistTicks: z.record(z.string(), z.record(z.string(), z.boolean())),
    /** Page-owned assumption confirmations: blockId -> the block version confirmed. */
    confirmedAssumptions: z.record(z.string(), z.number().int()),
    traces: z.array(traceRecord),
    validation: validationRecord.nullable(),
    phases: phaseState,
    /** A review's target, PR summary and rounds; null for a plan or an ask. */
    review: reviewRecord.nullable().default(null),
    /** A review's slides, staged until the agent publishes its round's deck. */
    slides: z.record(z.string(), slideRecord).default({}),
    /** A review's findings. */
    items: z.record(z.string(), itemRecord).default({}),
    /** Page-owned: the reviewer's reaction to each finding, by finding id. */
    reactions: z.record(z.string(), reactionRecord).default({}),
    /** Page-owned: the reviewer's answer to each `yourTake` card, by block id. */
    takes: z.record(z.string(), takeRecord).default({}),
    /** Page-owned: the comments the reviewer wrote on lines and files. */
    notes: z.record(z.string(), noteRecord).default({}),
    /** The number of write-up revisions recorded; the next one is `revision + 1`. */
    revision: z.number().int().min(0),
    counters: z.object({
        thread: z.number().int(),
        message: z.number().int(),
        suggestion: z.number().int(),
        note: z.number().int().default(0)
    }),
    /** The highest cursor the agent has read from, returned by `planroom_open` so a new agent session resumes there. */
    agentCursor: z.number().int().min(0),
    /**
     * The last event appended to the log, stored with the snapshot that includes it.
     * The snapshot is written first, so after a crash between the two writes the
     * log is completed from here on reload.
     */
    lastEvent: loggedEvent.nullable()
});
export type SessionState = z.infer<typeof sessionState>;

/** A fresh session for a change with no planning yet. */
export function emptyState(changeId: string, title: string, now: string, format: PlanFormat = 'openspec'): SessionState {
    return {
        schemaVersion: STATE_SCHEMA_VERSION,
        changeId,
        title,
        kind: 'plan',
        format,
        createdAt: now,
        questions: {},
        suggestions: {},
        understanding: { text: '', version: 0 },
        sections: {},
        blocks: {},
        threads: {},
        checklistTicks: {},
        confirmedAssumptions: {},
        traces: [],
        validation: null,
        phases: {
            phase1: { completed: false },
            submission: null,
            proposalReadyAt: null,
            proposalUnlocked: false,
            acceptedAt: null
        },
        review: null,
        slides: {},
        items: {},
        reactions: {},
        takes: {},
        notes: {},
        revision: 0,
        counters: { thread: 0, message: 0, suggestion: 0, note: 0 },
        agentCursor: 0,
        lastEvent: null
    };
}

/** Why a persisted file could not be loaded. */
export class StateFileError extends Error {}

/** Parse a persisted state file, rejecting other schema versions with a message that says what to do. */
export function parseStateFile(raw: string, file: string): SessionState {
    let json: unknown;
    try {
        json = JSON.parse(raw);
    } catch (error) {
        throw new StateFileError(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const version = z.object({ schemaVersion: z.unknown() }).safeParse(json).data?.schemaVersion;
    if (version !== STATE_SCHEMA_VERSION) {
        throw new StateFileError(
            `${file} has schemaVersion ${JSON.stringify(version)}, but this Planroom reads version ${STATE_SCHEMA_VERSION}. ` +
                'Update Planroom (npm i -g @moses-wescombe/planroom@latest) or move the file aside to start the session over.'
        );
    }
    const parsed = sessionState.safeParse(json);
    if (!parsed.success) {
        const first = parsed.error.issues[0];
        throw new StateFileError(`${file} does not match the state schema at ${first?.path.join('.') ?? '?'}: ${first?.message}`);
    }
    return parsed.data;
}
