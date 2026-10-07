import { z } from 'zod';
import { blockEnvelope, recordId, TAKE_KINDS } from './blocks.js';
import { answer, contextBlock, questionContent, questionId } from './questions.js';
import { anchor, attachment, commentIntent, outstanding, sectionContent, touched, validationIssue } from './records.js';
import {
    chapter,
    EARLIER_LABELS,
    itemContent,
    noteContent,
    reviewerSettings,
    reviewPreferences,
    slideContent,
    takeAnswer,
    verdict
} from './review.js';
import type { SessionKind } from './state.js';

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
    z.object({ type: z.literal('proposal.ready') }),
    /** Stage a slide of the round's deck. It stays off the page until `deck.publish`, and is fixed after it. */
    z.object({ type: z.literal('slide.upsert'), slide: slideContent }),
    /** What the page shows while the deck builds: the planned outline, pictures drawn of those briefed, review progress. */
    z
        .object({
            type: z.literal('deck.progress'),
            outline: z
                .array(z.object({ chapter, title: z.string().trim().min(1).max(200) }))
                .max(30)
                .optional(),
            pictures: z.object({ drawn: z.number().int().min(0), total: z.number().int().min(0) }).optional(),
            review: z.string().trim().min(1).max(200).optional()
        })
        .refine((event) => event.outline || event.pictures || event.review, {
            message: 'send `outline`, `pictures` or `review`',
            path: ['outline']
        }),
    /**
     * Release the round's staged deck, in two parts: first Why to What it might impact, then, after the reviewer's
     * `impact.send`, Trade-offs.
     */
    z.object({ type: z.literal('deck.publish') }),
    z.object({ type: z.literal('item.upsert'), item: itemContent }),
    /** Take a finding back, e.g. after a rejection undermined it, before the reviewer reacts to it. */
    z.object({ type: z.literal('item.withdraw'), id: recordId, reason: z.string().trim().min(1).max(1000) }),
    /** The summary comment, drafted from the reviewer's takes and triage. */
    z.object({ type: z.literal('summary.draft'), text: z.string().trim().min(1).max(8000) }),
    /** How an earlier round's comment stands now, with the code that shows it. */
    z.object({
        type: z.literal('earlier.label'),
        key: z.string().min(1).max(200),
        label: z.enum(EARLIER_LABELS),
        note: z.string().trim().max(2000).optional(),
        code: z.string().max(20000).optional()
    })
]);
export type AgentEvent = z.infer<typeof agentEvent>;
export type AgentEventType = AgentEvent['type'];
/** Every agent event type, in union order. */
export const agentEventTypes = agentEvent.options.map((option) => option.shape.type.value);

/** The agent events only a review takes. */
const REVIEW_ONLY_AGENT_EVENTS: readonly AgentEventType[] = [
    'slide.upsert',
    'deck.progress',
    'deck.publish',
    'item.upsert',
    'item.withdraw',
    'summary.draft',
    'earlier.label'
];

/** The agent events an ask takes: its question and info cards, and replies. The rest belong to a plan's phases. */
export const ASK_AGENT_EVENTS: ReadonlySet<AgentEventType> = new Set<AgentEventType>([
    'question.upsert',
    'question.close',
    'question.merge',
    'comment.reply',
    'comment.edit',
    'suggestion.decline'
]);

/** The agent events a review takes: its blocks, slides and findings, the summary, and replies. */
export const REVIEW_AGENT_EVENTS: ReadonlySet<AgentEventType> = new Set<AgentEventType>([
    'doc.block.upsert',
    'comment.reply',
    'comment.edit',
    ...REVIEW_ONLY_AGENT_EVENTS
]);

/** The agent events each session kind takes. */
export const AGENT_EVENTS: Record<SessionKind, ReadonlySet<AgentEventType>> = {
    plan: new Set(agentEventTypes.filter((type) => !REVIEW_ONLY_AGENT_EVENTS.includes(type))),
    ask: ASK_AGENT_EVENTS,
    review: REVIEW_AGENT_EVENTS
};

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
/** One of the reviewer's questions or concerns on an impact map area. */
const concern = z.string().trim().min(1).max(1000);

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
    z.object({ type: z.literal('ask.done') }),
    /** Answer a `yourTake` card, which then reveals the agent's view. */
    z.object({ type: z.literal('take.answer'), blockId: recordId, answer: takeAnswer }),
    /** Start the round's reviewer subagents, as many as the strength says and at this model and effort. */
    z.object({ type: z.literal('reviewers.start'), reviewers: reviewerSettings }),
    /** Finish or skip the round's walkthrough, which unlocks its findings. */
    z.object({ type: z.literal('walkthrough.done'), how: z.enum(['finished', 'skipped']) }),
    /** Save the reviewer's questions and concerns on the impact map, all of them, as they write them. */
    z.object({
        type: z.literal('impact.save'),
        concerns: z.record(z.string().min(1).max(40), z.array(concern).max(20)),
        added: z.array(z.object({ title: z.string().trim().min(1).max(80), concerns: z.array(concern).max(20) })).max(6)
    }),
    /** Send the saved concerns to the agent, which investigates them and writes Trade-offs. */
    z.object({ type: z.literal('impact.send') }),
    /** Agree with a finding, reword it, or reject it with a reason. */
    z
        .object({
            type: z.literal('item.react'),
            itemId: recordId,
            verdict,
            text: z.string().trim().max(8000).optional(),
            reason: z.string().trim().max(2000).optional()
        })
        .refine((react) => react.verdict !== 'reword' || Boolean(react.text), {
            message: 'a rewording needs your text',
            path: ['text']
        })
        .refine((react) => react.verdict !== 'reject' || Boolean(react.reason), {
            message: 'say why you reject it',
            path: ['reason']
        }),
    /** Turn a comment's task on or off, or take its sign-off off. Its key is `item:<id>`, `note:<id>` or `summary`. */
    z
        .object({
            type: z.literal('comment.choose'),
            key: z.string().min(1).max(200),
            task: z.boolean().optional(),
            unsigned: z.boolean().optional()
        })
        .refine((choice) => choice.task !== undefined || choice.unsigned !== undefined, {
            message: 'send `task` or `unsigned`',
            path: ['task']
        }),
    /** Write a comment of the reviewer's own on a line or a file, or change one by its id. */
    z.object({ type: z.literal('note.save'), id: z.string().min(1).max(40).optional(), ...noteContent.shape }),
    z.object({ type: z.literal('note.delete'), id: z.string().min(1).max(40) }),
    /** Edit the summary, delete it, or bring it back. */
    z
        .object({
            type: z.literal('summary.edit'),
            text: z.string().max(8000).optional(),
            deleted: z.boolean().optional()
        })
        .refine((edit) => edit.text !== undefined || edit.deleted !== undefined, {
            message: 'send `text` or `deleted`',
            path: ['text']
        }),
    /** The reviewer opened Comments: with every finding reacted to, the round moves to the preview. */
    z.object({ type: z.literal('comments.open') }),
    /** Post the round's comments, choosing for each comment on lines the author changed since whether to move it, drop it or post it anyway. */
    z.object({
        type: z.literal('comments.post'),
        choices: z.record(z.string(), z.enum(['reanchor', 'drop', 'anyway'])).optional()
    }),
    /** Confirm an earlier comment the agent labelled addressed, so Post resolves it. */
    z.object({ type: z.literal('earlier.confirm'), key: z.string().min(1).max(200), confirmed: z.boolean() }),
    z.object({ type: z.literal('preferences.set'), preferences: reviewPreferences })
]);
export type PageRequest = z.infer<typeof pageRequest>;
export type PageRequestType = PageRequest['type'];

/** The page requests only a review takes. */
const REVIEW_ONLY_PAGE_REQUESTS: readonly PageRequestType[] = [
    'take.answer',
    'reviewers.start',
    'walkthrough.done',
    'impact.save',
    'impact.send',
    'item.react',
    'comment.choose',
    'note.save',
    'note.delete',
    'summary.edit',
    'comments.open',
    'comments.post',
    'earlier.confirm',
    'preferences.set'
];

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

/** The page requests a review takes: its own, comments and messages, and ending or reopening it. */
export const REVIEW_PAGE_REQUESTS: ReadonlySet<PageRequestType> = new Set<PageRequestType>([
    'comment.create',
    'thread.reply',
    'comment.resolve',
    'message.send',
    'session.end',
    'session.reopen',
    ...REVIEW_ONLY_PAGE_REQUESTS
]);

/** The page requests each session kind takes. */
export const PAGE_REQUESTS: Record<SessionKind, ReadonlySet<PageRequestType>> = {
    plan: new Set(
        pageRequest.options
            .map((option) => option.shape.type.value)
            .filter((type) => type !== 'ask.done' && !REVIEW_ONLY_PAGE_REQUESTS.includes(type))
    ),
    ask: ASK_PAGE_REQUESTS,
    review: REVIEW_PAGE_REQUESTS
};

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
    }),
    /** The reviewer answered a your-take card; the page now shows your view beside theirs. */
    logged.extend({
        type: z.literal('take.answer'),
        blockId: z.string(),
        kind: z.enum(TAKE_KINDS),
        answer: takeAnswer,
        /** The answer in words. */
        summary: z.string()
    }),
    /** The reviewer started the round's review: start the `planroom-reviewer` subagents it names, at its model and effort. */
    logged.extend({ type: z.literal('reviewers.start'), round: z.number().int(), reviewers: reviewerSettings }),
    /** The reviewer finished or skipped the walkthrough: the findings are showing. */
    logged.extend({ type: z.literal('walkthrough.done'), how: z.enum(['finished', 'skipped']), round: z.number().int() }),
    /**
     * The reviewer sent their questions and concerns on the impact map, under each of your areas (by `id`) and under
     * areas they added (no `id`): investigate them, then write and publish Trade-offs.
     */
    logged.extend({
        type: z.literal('impact.send'),
        round: z.number().int(),
        areas: z.array(z.object({ id: z.string().optional(), title: z.string(), concerns: z.array(z.string()) }))
    }),
    logged.extend({
        type: z.literal('item.react'),
        itemId: z.string(),
        title: z.string(),
        verdict,
        text: z.string().optional(),
        reason: z.string().optional()
    }),
    /** The reviewer changed their preferences: follow them for slides you have not written yet. */
    logged.extend({ type: z.literal('preferences.change'), preferences: reviewPreferences }),
    /** Post ended: how many of the round's comments are on Bitbucket, and which failed. */
    logged.extend({
        type: z.literal('review.posted'),
        round: z.number().int(),
        posted: z.number().int(),
        total: z.number().int(),
        failed: z.array(z.string()),
        /** Whether the comments went up as drafts the reviewer finishes in Bitbucket. */
        drafts: z.boolean()
    })
]);
export type LoggedEvent = z.infer<typeof loggedEvent>;
export type LoggedEventType = LoggedEvent['type'];

/** Logged events that come from the server rather than a page action. */
export const serverEventTypes: readonly LoggedEventType[] = ['validation.result', 'edit.undone', 'review.posted'];

/** A logged event before the log assigns its sequence number and time. */
export type NewLoggedEvent = LoggedEvent extends infer E ? (E extends LoggedEvent ? Omit<E, 'seq' | 'at'> : never) : never;
