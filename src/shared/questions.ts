import { z } from 'zod';
import { blockEnvelope } from './blocks.js';

/** Question ids are `Q-<n>`, so the page can link any mention of one. */
export const questionId = z.string().regex(/^Q-\d{1,4}$/, 'must look like "Q-12"');

/**
 * How a card is answered. `assumption` is the agent stating something it believes, for the user to confirm or
 * correct. `directions` is the one card that offers ways to achieve the change, a tab per option, of which the user
 * picks the ones to investigate. `info` asks nothing: it gives the reader context, in its `context`, and takes no answer.
 */
export const questionInput = z.enum(['single', 'multi', 'chips', 'freeform', 'assumption', 'directions', 'info']);
export type QuestionInput = z.infer<typeof questionInput>;

/** A question's status. The agent sets `streaming`, `open` and `conflict`; the page and the server set the rest. */
export const questionStatus = z.enum(['streaming', 'open', 'answered', 'needs-review', 'conflict', 'closed', 'merged']);
export type QuestionStatus = z.infer<typeof questionStatus>;

/** Statuses the agent may set directly; answered and needs-review come from the page and the server. */
export const agentQuestionStatus = z.enum(['streaming', 'open', 'conflict']);

/** A catalog block inside a question's context. It has no id of its own; it is addressed by its index. */
export const contextBlock = blockEnvelope.omit({ id: true });
export type ContextBlock = z.infer<typeof contextBlock>;

/** One option on a card: a choice to pick, or on the directions card, a direction to investigate. */
export const questionOption = z.object({
    id: z.string().min(1).max(40),
    label: z.string().min(1).max(300),
    /** Plain text, except on a direction, where it is the direction's markdown description. */
    detail: z.string().max(4000).optional(),
    tradeoff: z.string().max(2000).optional(),
    recommended: z.boolean().optional(),
    /** A direction's supporting diagrams and tables. Only a `directions` question's options carry blocks. */
    blocks: z.array(contextBlock).max(6).optional()
});
export type QuestionOption = z.infer<typeof questionOption>;

/** The answer to an assumption card that says it holds. A correction is written in the answer's `text` instead. */
export const ASSUMPTION_HOLDS = 'holds';

/** Inputs without options, each named as the card it is. */
const OPTIONLESS: ReadonlyMap<QuestionInput, string> = new Map([
    ['freeform', 'a freeform question'],
    ['assumption', 'an assumption'],
    ['info', 'an info card']
]);

/** Whether a card is an info card: context for the reader, not counted as a question by progress or any gate. */
export function isInfo(question: { input: QuestionInput }): boolean {
    return question.input === 'info';
}

/** Why the agent asks: its reasoning, findings, references and supporting blocks. */
export const questionContext = z.object({
    why: z.string().max(4000).optional(),
    findings: z.array(z.string().max(2000)).max(20).optional(),
    refs: z.array(z.string().max(400)).max(20).optional(),
    blocks: z.array(contextBlock).max(6).optional()
});

/** The questions this one depends on or unblocks, and the spec it feeds. */
export const questionLinks = z.object({
    dependsOn: z.array(questionId).optional(),
    unblocks: z.array(questionId).optional(),
    spec: z.string().max(120).optional()
});

/**
 * What the agent owns on a question: everything but its version, answer and the
 * review state. A `conflict` status must say which question it conflicts with.
 */
export const questionContent = z
    .object({
        id: questionId,
        group: z.string().min(1).max(200),
        title: z.string().max(500),
        /** A few words naming the decision, e.g. "Redis outage", for the write-up's Decisions table. Changing it never needs a re-answer. */
        topic: z.string().trim().min(1).max(80).optional(),
        impact: z.enum(['high', 'medium', 'low']).optional(),
        context: questionContext.optional(),
        input: questionInput,
        options: z.array(questionOption).max(12).optional(),
        allowOther: z.boolean().optional(),
        status: agentQuestionStatus.optional(),
        conflict: z.object({ with: questionId, reason: z.string().min(1).max(1000) }).optional(),
        links: questionLinks.optional(),
        /** The direction (an option id of the `directions` question) this card belongs to. Unset: shared by every direction. */
        direction: z.string().min(1).max(40).optional()
    })
    .superRefine((question, ctx) => {
        const options = question.options ?? [];
        if (!OPTIONLESS.has(question.input) && options.length === 0 && question.status !== 'streaming') {
            ctx.addIssue({ code: 'custom', path: ['options'], message: `a ${question.input} question needs options` });
        }
        const card = OPTIONLESS.get(question.input);
        if (card && options.length > 0) {
            ctx.addIssue({ code: 'custom', path: ['options'], message: `${card} has no options` });
        }
        if (isInfo(question) && (question.conflict || question.status === 'conflict')) {
            ctx.addIssue({ code: 'custom', path: ['conflict'], message: 'an info card asks nothing, so it cannot conflict' });
        }
        if (question.input !== 'directions') {
            options.forEach((option, index) => {
                if (option.blocks)
                    ctx.addIssue({
                        code: 'custom',
                        path: ['options', index, 'blocks'],
                        message: 'only a directions question has blocks on its options; put them in context.blocks'
                    });
            });
        }
        if (question.input === 'directions' && question.direction !== undefined) {
            ctx.addIssue({ code: 'custom', path: ['direction'], message: 'the directions question belongs to no direction' });
        }
        const seen = new Set<string>();
        options.forEach((option, index) => {
            if (seen.has(option.id))
                ctx.addIssue({ code: 'custom', path: ['options', index, 'id'], message: `duplicate id "${option.id}"` });
            seen.add(option.id);
        });
        const recommended = options.flatMap((option, index) => (option.recommended ? [index] : []));
        recommended.slice(1).forEach((index) => {
            ctx.addIssue({
                code: 'custom',
                path: ['options', index, 'recommended'],
                message: 'at most one option can be recommended'
            });
        });
        if (question.status === 'conflict' && !question.conflict) {
            ctx.addIssue({ code: 'custom', path: ['conflict'], message: 'a conflict status needs { with, reason }' });
        }
        if (question.conflict?.with === question.id) {
            ctx.addIssue({ code: 'custom', path: ['conflict', 'with'], message: 'a question cannot conflict with itself' });
        }
    });
export type QuestionContent = z.infer<typeof questionContent>;

/** A saved answer. Which fields apply depends on the question's input type. */
export const answer = z.object({
    choice: z.string().max(40).optional(),
    choices: z.array(z.string().max(40)).max(12).optional(),
    text: z.string().max(4000).optional(),
    note: z.string().max(4000).optional()
});
export type Answer = z.infer<typeof answer>;

/** An answer as stored: the question version it answered and when. */
export const savedAnswer = answer.extend({ version: z.number().int().min(1), at: z.string() });
export type SavedAnswer = z.infer<typeof savedAnswer>;

/** The full question record as persisted and sent to the page. */
export const questionRecord = z.object({
    ...questionContent.shape,
    status: questionStatus,
    /** Bumped on every change the page renders: content, status or answer. */
    version: z.number().int().min(1),
    /** The version at which the agent last changed the content. An answer to an older version is stale. */
    contentVersion: z.number().int().min(1),
    /** The last saved answer. It is kept, and shown as "your last answer", when the question needs review or is reopened. */
    answer: savedAnswer.nullable(),
    closedReason: z.string().optional(),
    mergedInto: questionId.optional(),
    /** When the agent last changed the content of a question the user had answered. */
    changedByAgentAt: z.string().optional(),
    createdAt: z.string(),
    updatedAt: z.string()
});
export type QuestionRecord = z.infer<typeof questionRecord>;

/**
 * Check a submitted answer against the question it answers, returning the reason it
 * does not fit, or null when it does.
 */
export function answerProblem(question: Pick<QuestionRecord, 'input' | 'options' | 'allowOther'>, given: Answer): string | null {
    const ids = new Set((question.options ?? []).map((option) => option.id));
    const ownText = Boolean(given.text?.trim());
    switch (question.input) {
        case 'info':
            return 'an info card takes no answer';
        case 'freeform':
            return ownText ? null : 'a freeform answer needs text';
        case 'assumption':
            if (given.choice !== undefined && given.choice !== ASSUMPTION_HOLDS) return 'an assumption holds or is corrected';
            if (given.choice === ASSUMPTION_HOLDS && ownText) return 'an assumption either holds or is corrected, not both';
            return given.choice === ASSUMPTION_HOLDS || ownText ? null : 'say whether it holds, or correct it';
        case 'single':
        case 'chips':
            if (given.choice !== undefined && !ids.has(given.choice)) return `option "${given.choice}" does not exist`;
            if (given.choice === undefined && !ownText) return 'pick an option or write an answer';
            if (given.choice === undefined && question.input === 'single' && !question.allowOther) {
                return 'this question does not take a written answer';
            }
            return null;
        case 'multi':
        case 'directions': {
            const unknown = (given.choices ?? []).find((choice) => !ids.has(choice));
            if (unknown !== undefined) return `option "${unknown}" does not exist`;
            if ((given.choices ?? []).length === 0 && !ownText)
                return question.input === 'directions'
                    ? 'pick at least one direction to investigate'
                    : 'pick at least one option';
            return null;
        }
        default:
            return 'unknown input type';
    }
}

/** A short, human reading of an answer, for summaries and the agent's log. */
export function describeAnswer(question: Pick<QuestionRecord, 'options' | 'input'>, given: Answer): string {
    if (question.input === 'assumption') {
        return given.choice === ASSUMPTION_HOLDS ? 'Holds' : `Not quite: ${given.text?.trim() ?? ''}`;
    }
    const labelOf = (id: string) => question.options?.find((option) => option.id === id)?.label ?? id;
    const parts = [
        ...(given.choice !== undefined ? [labelOf(given.choice)] : []),
        ...(given.choices ?? []).map(labelOf),
        ...(given.text?.trim() ? [given.text.trim()] : [])
    ];
    return parts.join(', ');
}
