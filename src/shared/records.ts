import { z } from 'zod';
import { recordId } from './blocks.js';
import { contextBlock, questionId } from './questions.js';

/**
 * Write-up, comment and proposal records as persisted and sent to the page. Each
 * versioned record carries a server-assigned `version`, bumped only when its
 * content changes, so the page can re-render exactly what changed.
 */

const issue = z.object({ path: z.string(), message: z.string() });

/** A stored write-up block: the agent's envelope plus its version and, when its config did not validate, why. */
export const blockRecord = z.object({
    id: recordId,
    type: z.string(),
    config: z.record(z.string(), z.unknown()),
    caption: z.string().optional(),
    refs: z.array(z.string()).optional(),
    version: z.number().int().min(1),
    /** Present when the config failed its type's schema, or the type is unknown. */
    problem: z.object({ reason: z.enum(['unknown-type', 'invalid']), issues: z.array(issue) }).optional(),
    updatedAt: z.string()
});
export type BlockRecord = z.infer<typeof blockRecord>;

/** One entry in a section's block list: a block id, or two or three ids shown side by side as columns. */
export const sectionItem = z.union([recordId, z.array(recordId).min(2).max(3)]);
export type SectionItem = z.infer<typeof sectionItem>;

/** The content the agent sends for a write-up section: its heading, its place and its blocks in order. */
export const sectionContent = z.object({
    id: recordId,
    title: z.string().min(1).max(200),
    order: z.number(),
    blocks: z.array(sectionItem).max(40)
});
export type SectionContent = z.infer<typeof sectionContent>;

/** Every block id a section lists, in order, with each row of columns read left to right. */
export function blockIdsOf(section: Pick<SectionContent, 'blocks'>): string[] {
    return section.blocks.flat();
}

/** A stored write-up section: its content plus its version and the user's review tick. */
export const sectionRecord = sectionContent.extend({
    version: z.number().int().min(1),
    /** The user's review tick. Cleared whenever the section or any of its blocks changes. */
    reviewed: z.boolean(),
    /** When a change cleared the tick, and who made it. */
    unreviewedBy: z.enum(['agent', 'undo']).optional(),
    unreviewedAt: z.string().optional(),
    updatedAt: z.string()
});
export type SectionRecord = z.infer<typeof sectionRecord>;

/**
 * A comment anchor: the W3C Web Annotation TextPositionSelector plus
 * TextQuoteSelector over the plain text of one `data-anchor-target` element.
 * Without both selectors it anchors to the whole target, e.g. a question.
 */
export const anchor = z
    .object({
        target: z.string().min(1).max(300),
        position: z.object({ start: z.number().int().min(0), end: z.number().int().min(0) }).optional(),
        quote: z.object({ exact: z.string().min(1).max(2000), prefix: z.string().max(64), suffix: z.string().max(64) }).optional()
    })
    .refine((value) => !value.position === !value.quote, {
        message: 'position and quote go together',
        path: ['quote']
    });
export type Anchor = z.infer<typeof anchor>;

/** What a comment asks of the agent: to answer a question, make a change, or fix something wrong. */
export const commentIntent = z.enum(['question', 'change', 'wrong']);
export type CommentIntent = z.infer<typeof commentIntent>;

/** What an agent reply says it changed, e.g. `{ ref: "s4", note: "edited" }`. */
export const touched = z.object({ ref: z.string().min(1).max(120), note: z.string().min(1).max(200) });
export type Touched = z.infer<typeof touched>;

/** A file name under the change's `.planroom/assets/`. */
export const assetName = z.string().regex(/^[\w.-]+\.(png|jpe?g|gif|webp|svg)$/i, 'must be an image file name');

/** The longest text snippet a message can carry. */
export const MAX_SNIPPET = 50_000;

/** Something the user pasted into a message: an image saved as an asset, or a long text snippet. */
export const attachment = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('image'), asset: assetName }),
    z.object({ kind: z.literal('text'), text: z.string().min(1).max(MAX_SNIPPET) })
]);
export type Attachment = z.infer<typeof attachment>;

/** One message in a thread, from the user or the agent. Only agent replies carry `touched` and `blocks`. */
export const threadMessage = z.object({
    id: z.string(),
    author: z.enum(['user', 'agent']),
    text: z.string(),
    attachments: z.array(attachment).optional(),
    touched: z.array(touched).optional(),
    /** An agent reply's diagrams and tables, validated like a question's context blocks. */
    blocks: z.array(contextBlock).optional(),
    at: z.string()
});
export type ThreadMessage = z.infer<typeof threadMessage>;

/** A comment thread (anchored) or a direct message thread (no anchor). */
export const threadRecord = z.object({
    id: z.string(),
    kind: z.enum(['comment', 'message']),
    anchor: anchor.optional(),
    intent: commentIntent.optional(),
    status: z.enum(['open', 'resolved']),
    messages: z.array(threadMessage),
    version: z.number().int().min(1),
    createdAt: z.string(),
    updatedAt: z.string()
});
export type ThreadRecord = z.infer<typeof threadRecord>;

/** A question the user suggested, until the agent adds it as a question or declines it. */
export const suggestionRecord = z.object({
    id: z.string(),
    text: z.string(),
    status: z.enum(['pending', 'added', 'declined']),
    questionId: questionId.optional(),
    reason: z.string().optional(),
    version: z.number().int().min(1),
    createdAt: z.string()
});
export type SuggestionRecord = z.infer<typeof suggestionRecord>;

/** The agent's summary of the change as it understands it. Version 0 until it first writes one. */
export const understandingRecord = z.object({
    text: z.string(),
    version: z.number().int().min(0),
    updatedAt: z.string().optional()
});
export type UnderstandingRecord = z.infer<typeof understandingRecord>;

/** One issue from `openspec validate --strict --json`. */
export const validationIssue = z.object({ level: z.string(), path: z.string(), message: z.string() });

/** The last `openspec validate` result, and what triggered it. */
export const validationRecord = z.object({
    passed: z.boolean(),
    issues: z.array(validationIssue),
    /** Raw output when the CLI failed before producing JSON. */
    output: z.string().optional(),
    trigger: z.enum(['proposal.ready', 'rerun']),
    at: z.string()
});
export type ValidationRecord = z.infer<typeof validationRecord>;

/** A requirement traced back to the questions whose answers it came from. */
export const traceRecord = z.object({
    spec: z.string().optional(),
    requirement: z.string().min(1),
    questions: z.array(questionId)
});
export type TraceRecord = z.infer<typeof traceRecord>;

/** Outstanding work recorded with a submission that went ahead anyway. */
export const outstanding = z.object({
    kind: z.enum(['section', 'assumption', 'comment', 'question']),
    ref: z.string(),
    label: z.string()
});
export type Outstanding = z.infer<typeof outstanding>;

/** Where the session is in its phases: Phase 1's stages, the submission, the proposal's readiness and acceptance, and the end. */
export const phaseState = z.object({
    phase1: z.object({
        completed: z.boolean(),
        path: z.enum(['finished', 'assumptions']).optional(),
        at: z.string().optional(),
        /** When the goals were agreed, ending the align stage, and who said so. */
        aligned: z.object({ by: z.enum(['user', 'agent']), at: z.string() }).optional(),
        /** Why the agent went straight to the deep dive without offering directions. */
        exploreSkipped: z.string().optional(),
        /** The direction the user went ahead with, when directions were investigated. */
        direction: z.string().optional()
    }),
    submission: z
        .object({ revision: z.number().int().min(0), validate: z.boolean(), outstanding: z.array(outstanding), at: z.string() })
        .nullable(),
    /** Set by the agent's `proposal.ready`; cleared by a new submission. */
    proposalReadyAt: z.string().nullable(),
    proposalUnlocked: z.boolean(),
    acceptedAt: z.string().nullable(),
    /** Set when the user ended the agent session: `cancelled` before the proposal validated, `finished` after. */
    ended: z.object({ how: z.enum(['cancelled', 'finished']), at: z.string() }).optional()
});
export type PhaseState = z.infer<typeof phaseState>;

/** The record stored under `id` in a map of records, never an inherited property such as `constructor`. */
export function ownRecord<T>(records: Record<string, T>, id: string): T | undefined {
    return Object.hasOwn(records, id) ? records[id] : undefined;
}
