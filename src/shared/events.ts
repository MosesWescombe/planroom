import { z } from 'zod';
import { blockEnvelope, recordId } from './blocks.js';
import { answer, contextBlock, questionContent, questionId } from './questions.js';
import { anchor, attachment, commentIntent, outstanding, sectionContent, touched, validationIssue } from './records.js';

/**
 * Both directions of the agent-page contract.
 *
 * - Agent events arrive in `planroom_emit` batches and change page state.
 * - Page requests are what the browser posts. Each one the server accepts is
 *   appended to the session's event log as a logged event, enriched with what the
 *   agent needs to act on it (the question title, the open questions carried as
 *   assumptions, a block's validation errors).
 * - Server events (`validation.result`, `edit.undone`) are logged the same way.
 */

// ---------------------------------------------------------------- agent -> page

/** One event in a `planroom_emit` batch: a change the agent makes to the page. */
export const agentEvent = z.discriminatedUnion('type', [
    z.object({ type: z.literal('question.upsert'), question: questionContent, fromSuggestion: z.string().optional() }),
    z.object({ type: z.literal('question.close'), id: questionId, reason: z.string().min(1).max(1000) }),
    z.object({ type: z.literal('question.merge'), id: questionId, into: questionId, reason: z.string().max(1000).optional() }),
    z.object({ type: z.literal('understanding.update'), text: z.string().max(20000) }),
    /**
     * Move Phase 1 on: `explore` when the goals are agreed, or `deep-dive` straight from aligning, with the reason,
     * when there is one clear way to do the change and offering directions would add nothing.
     */
    z.object({
        type: z.literal('stage.advance'),
        to: z.enum(['explore', 'deep-dive']),
        reason: z.string().min(1).max(1000).optional()
    }),
    z.object({ type: z.literal('doc.section.upsert'), section: sectionContent }),
    z.object({ type: z.literal('doc.block.upsert'), block: blockEnvelope }),
    z.object({
        type: z.literal('comment.reply'),
        threadId: z.string().min(1),
        text: z.string().min(1).max(8000),
        touched: z.array(touched).max(20).optional(),
        /** Diagrams, tables and other blocks that explain the reply, shown under its text. */
        blocks: z.array(contextBlock).max(6).optional(),
        resolve: z.boolean().optional()
    }),
    /**
     * Rewrite one of your replies in place, by the message id `comment.reply` returned (`C-1.2`), e.g. to fix a block
     * `blockProblems` named. Each field sent replaces the reply's own; the others stay.
     */
    z
        .object({
            type: z.literal('comment.edit'),
            messageId: z.string().min(1),
            text: z.string().min(1).max(8000).optional(),
            touched: z.array(touched).max(20).optional(),
            blocks: z.array(contextBlock).max(6).optional()
        })
        .refine((edit) => edit.text !== undefined || edit.touched !== undefined || edit.blocks !== undefined, {
            message: 'send `text`, `touched` or `blocks`',
            path: ['text']
        }),
    z.object({ type: z.literal('suggestion.decline'), id: z.string().min(1), reason: z.string().min(1).max(1000) }),
    z.object({
        type: z.literal('proposal.trace'),
        spec: z.string().max(120).optional(),
        requirement: z.string().min(1).max(300),
        questions: z.array(questionId).max(40)
    }),
    z.object({ type: z.literal('proposal.ready') })
]);
export type AgentEvent = z.infer<typeof agentEvent>;
export type AgentEventType = AgentEvent['type'];
/** Every agent event type, in union order. */
export const agentEventTypes = agentEvent.options.map((option) => option.shape.type.value);

/** The agent events an ask takes: its question and info cards, and replies. The rest belong to a plan's phases. */
export const ASK_AGENT_EVENTS: ReadonlySet<AgentEventType> = new Set<AgentEventType>([
    'question.upsert',
    'question.close',
    'question.merge',
    'comment.reply',
    'comment.edit',
    'suggestion.decline'
]);

/** One `planroom_emit` call: some events, a new `doing`, the subagents you are waiting on, or any mix. */
export const emitBatch = z
    .object({
        events: z.array(agentEvent).max(100),
        summary: z.string().max(300).optional(),
        /**
         * What you are on next, shown to the user until your next `planroom_wait`: words that follow "Agent", e.g.
         * "researching how alarms are indexed". Set it for work the page cannot see.
         */
        doing: z.string().trim().min(1).max(120).optional(),
        /**
         * The subagents you are waiting on, what each one is doing, e.g. "reading the billing service". Replaces the
         * last list and lasts across waits: send it again as they report back, and `[]` once the last one has.
         */
        subagents: z.array(z.string().trim().min(1).max(120)).max(20).optional()
    })
    .refine((batch) => batch.events.length > 0 || batch.doing !== undefined || batch.subagents !== undefined, {
        message: 'send at least one event, `doing` or `subagents`',
        path: ['events']
    });

// ---------------------------------------------------------------- page -> server

const text = z.string().trim().min(1).max(8000);

/** A message's words and pastes: either may be empty, not both. */
const message = {
    text: z.string().trim().max(8000),
    attachments: z.array(attachment).max(10).optional()
};
const saysSomething: [(value: { text: string; attachments?: unknown[] }) => boolean, { message: string; path: string[] }] = [
    (value) => value.text.length > 0 || Boolean(value.attachments?.length),
    { message: 'write a message or paste something', path: ['text'] }
];

/** A request the page posts: one user action, parsed at the HTTP boundary. */
export const pageRequest = z.discriminatedUnion('type', [
    z.object({ type: z.literal('answer.submit'), questionId, version: z.number().int().min(1), answer }),
    z.object({ type: z.literal('question.reopen'), questionId }),
    z.object({ type: z.literal('conflict.resolve'), questionId, choice: z.enum(['keep', 'change-other']) }),
    z.object({ type: z.literal('question.suggest'), text }),
    z.object({ type: z.literal('comment.create'), anchor, intent: commentIntent, ...message }).refine(...saysSomething),
    z.object({ type: z.literal('thread.reply'), threadId: z.string().min(1), ...message }).refine(...saysSomething),
    z.object({ type: z.literal('comment.resolve'), threadId: z.string().min(1) }),
    z.object({ type: z.literal('message.send'), ...message }).refine(...saysSomething),
    z.object({ type: z.literal('review.mark'), sectionId: recordId, reviewed: z.boolean() }),
    z.object({ type: z.literal('checklist.tick'), blockId: recordId, item: z.string().min(1), done: z.boolean() }),
    z.object({ type: z.literal('assumption.confirm'), blockId: recordId }),
    /** `thrown`: the page's error when a block that validated threw while drawing, so there is no stored problem. */
    z.object({ type: z.literal('block.fix'), blockId: recordId, thrown: z.string().min(1).max(2000).optional() }),
    z.object({ type: z.literal('edit.undo'), revision: z.number().int().min(1) }),
    z.object({ type: z.literal('stage.advance'), to: z.literal('explore') }),
    z.object({
        type: z.literal('phase.complete'),
        path: z.enum(['finished', 'assumptions']),
        /** The direction to go ahead with. Required once directions are being investigated. */
        direction: z.string().min(1).max(40).optional()
    }),
    z.object({
        type: z.literal('phase.submit'),
        changeId: z.string().min(1),
        revision: z.number().int().min(0),
        validate: z.boolean(),
        anyway: z.boolean().default(false)
    }),
    z.object({ type: z.literal('validation.rerun') }),
    z.object({ type: z.literal('proposal.accept') }),
    z.object({ type: z.literal('proposal.requestChanges'), text: z.string().trim().max(8000).optional() }),
    z.object({ type: z.literal('session.end') }),
    /** Make a read-only session editable again: one the user ended, or whose proposal they accepted. */
    z.object({ type: z.literal('session.reopen') }),
    /** Send an ask's answers to the agent, ending it. */
    z.object({ type: z.literal('ask.done') })
]);
export type PageRequest = z.infer<typeof pageRequest>;
export type PageRequestType = PageRequest['type'];

/** The page requests an ask takes: answers, suggestions, comments, messages and sending the answers. */
export const ASK_PAGE_REQUESTS: ReadonlySet<PageRequestType> = new Set<PageRequestType>([
    'answer.submit',
    'question.reopen',
    'conflict.resolve',
    'question.suggest',
    'comment.create',
    'thread.reply',
    'comment.resolve',
    'message.send',
    'ask.done'
]);

// ---------------------------------------------------------------- logged events (what the agent reads)

const logged = z.object({ seq: z.number().int().min(1), at: z.string() });
const issue = z.object({ path: z.string(), message: z.string() });

/** A paste as the agent reads it: an image also carries the repo-relative `path` to open it at. */
export const loggedAttachment = z.discriminatedUnion('kind', [
    attachment.options[0].extend({ path: z.string() }),
    attachment.options[1]
]);
export type LoggedAttachment = z.infer<typeof loggedAttachment>;
const pasted = { attachments: z.array(loggedAttachment).optional() };

/** An entry in the event log the agent reads: its `seq`, its time, and what the agent needs to act on it. */
export const loggedEvent = z.discriminatedUnion('type', [
    logged.extend({
        type: z.literal('answer.submit'),
        questionId,
        version: z.number().int(),
        answer,
        /** The answer in words, e.g. "Plans table + per-key override". */
        summary: z.string(),
        /** True when the user answered an older version than the current one. */
        stale: z.boolean()
    }),
    logged.extend({ type: z.literal('question.reopen'), questionId }),
    logged.extend({
        type: z.literal('conflict.resolve'),
        questionId,
        choice: z.enum(['keep', 'change-other']),
        other: questionId
    }),
    logged.extend({ type: z.literal('question.suggest'), suggestionId: z.string(), text: z.string() }),
    logged.extend({
        type: z.literal('comment.create'),
        threadId: z.string(),
        anchor,
        intent: commentIntent,
        text: z.string(),
        ...pasted
    }),
    logged.extend({ type: z.literal('thread.reply'), threadId: z.string(), text: z.string(), ...pasted }),
    logged.extend({ type: z.literal('comment.resolve'), threadId: z.string() }),
    logged.extend({ type: z.literal('message.send'), threadId: z.string(), text: z.string(), ...pasted }),
    logged.extend({ type: z.literal('checklist.tick'), blockId: z.string(), item: z.string(), done: z.boolean() }),
    logged.extend({ type: z.literal('assumption.confirm'), blockId: z.string(), title: z.string() }),
    logged.extend({ type: z.literal('block.fix'), blockId: z.string(), blockType: z.string(), issues: z.array(issue) }),
    logged.extend({
        type: z.literal('stage.advance'),
        to: z.literal('explore'),
        /** Questions still unresolved when the user agreed the goals. They stay open. */
        open: z.array(z.object({ questionId, title: z.string(), status: z.string() }))
    }),
    logged.extend({
        type: z.literal('phase.complete'),
        path: z.enum(['finished', 'assumptions']),
        /** The direction the user went ahead with. Questions of the other directions are out of scope from here. */
        direction: z.object({ id: z.string(), label: z.string() }).optional(),
        /** Questions still unresolved, to carry into the write-up as assumptions. Empty when every question was resolved. */
        assumptions: z.array(z.object({ questionId, title: z.string(), status: z.string() }))
    }),
    logged.extend({
        type: z.literal('phase.submit'),
        changeId: z.string(),
        revision: z.number().int(),
        validate: z.boolean(),
        outstanding: z.array(outstanding)
    }),
    logged.extend({ type: z.literal('proposal.accept'), changeId: z.string() }),
    logged.extend({
        type: z.literal('proposal.requestChanges'),
        text: z.string().optional(),
        threadId: z.string().optional(),
        openComments: z.array(z.string())
    }),
    /** The user ended the session: stop. `cancelled` before the proposal validated, `finished` after. */
    logged.extend({ type: z.literal('session.end'), how: z.enum(['cancelled', 'finished']) }),
    /** The user sent an ask's answers: it is read-only. `context` is its questions, answers and threads as Markdown. */
    logged.extend({
        type: z.literal('ask.done'),
        context: z.string(),
        /** The repo-relative file the transcript was written to, when the ask named an `output`. */
        file: z.string().optional(),
        /** Why the transcript could not be written to the ask's `output`. */
        fileError: z.string().optional()
    }),
    /** The user reopened a read-only session: it takes edits again. `from` is how it had become read-only. */
    logged.extend({ type: z.literal('session.reopen'), from: z.enum(['cancelled', 'finished', 'accepted']) }),
    logged.extend({
        type: z.literal('validation.result'),
        passed: z.boolean(),
        issues: z.array(validationIssue),
        output: z.string().optional(),
        trigger: z.enum(['proposal.ready', 'rerun'])
    }),
    logged.extend({
        type: z.literal('edit.undone'),
        revision: z.number().int(),
        newRevision: z.number().int(),
        blocks: z.array(z.string()),
        sections: z.array(z.string())
    })
]);
export type LoggedEvent = z.infer<typeof loggedEvent>;
export type LoggedEventType = LoggedEvent['type'];

/** Logged events that come from the server rather than a page action. */
export const serverEventTypes: readonly LoggedEventType[] = ['validation.result', 'edit.undone'];

/** A logged event before the log assigns its sequence number and time. */
export type NewLoggedEvent = LoggedEvent extends infer E ? (E extends LoggedEvent ? Omit<E, 'seq' | 'at'> : never) : never;
