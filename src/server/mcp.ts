import { EventEmitter, once } from 'node:events';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
    CallToolRequestSchema,
    type CallToolResult,
    ListToolsRequestSchema,
    type Tool
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { askTranscript } from '../shared/ask.js';
import {
    currentPhase,
    decisionRows,
    directionTabs,
    isReadOnly,
    outstandingItems,
    phase1Gate,
    phase1Stage
} from '../shared/derive.js';
import { emitBatch, type LoggedEvent, type LoggedEventType } from '../shared/events.js';
import { toIssues } from '../shared/issues.js';
import { currentRound, deckSlides, deriveComments, reviewStage, roundItems, slideShown } from '../shared/review.js';
import { type PlanFormat, type SessionKind, StateFileError } from '../shared/state.js';
import { askInput, DEFAULT_WAIT_SEC, openInput, reviewInput, stateInput, waitInput } from '../shared/tools.js';
import { BitbucketError } from './bitbucket.js';
import type { ChannelNotifier } from './delivery.js';
import { RejectedError } from './draft.js';
import { type PageServer, startPageServer } from './http.js';
import { ChangeLockedError } from './lock.js';
import type { BrowserOpener } from './opener.js';
import type { OpenSpecRunner } from './openspec.js';
import { hasPlan } from './plans.js';
import { type ReviewHost, resolveTarget } from './review.js';
import { Session } from './session.js';
import { GitError } from './worktree.js';

export { DEFAULT_WAIT_SEC };

/** A tool's JSON Schema, generated from the shared zod schema so the contract has one source. */
function inputSchema(schema: z.ZodType): Tool['inputSchema'] {
    const { $schema: _ignored, ...json } = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<
        string,
        unknown
    >;
    return { ...json, type: 'object' } as Tool['inputSchema'];
}

/** The planning server's opener. */
const OPEN_TOOL: Tool = {
    name: 'planroom_open',
    description:
        'Open or resume the Planroom planning page for a change. A new plan becomes an OpenSpec change in openspec/changes/<changeId>/ ' +
        '(created when it does not exist), or with format "markdown" a plan at agent-plans/<changeId>/<changeId>.md. ' +
        'Returns { url, resumed, phase, format, cursor, repoRoot }: print the url for the user, and pass cursor as `after` to planroom_wait. ' +
        'Plan paths are relative to repoRoot, the repo the server plans in, which is not your working directory when the server was started with --dir. ' +
        "Without a changeId it opens the plan browser instead, where the user picks one of the repo's plans, and returns { url, browsing: true, repoRoot }: " +
        'print the url, then call planroom_wait with after 0. Once the user picks a plan it is refused naming that plan: call planroom_state to load it.',
    inputSchema: inputSchema(openInput)
};

/** The question server's opener. */
const ASK_TOOL: Tool = {
    name: 'planroom_ask',
    description:
        'Ask the user a series of questions on a live page, at any point in your work and in any repo: no phases, no write-up, ' +
        'just question and info cards, comments and messages both ways. Use it instead of asking in chat whenever you have ' +
        'more than one question for the user. Returns { url, askId, resumed, cursor, repoRoot }: print the url, then ' +
        'planroom_emit question.upsert events (any input but "directions", no `direction`), reply to comments with comment.reply, ' +
        'and planroom_wait from `cursor` for answers. When the user sends their answers, planroom_wait returns an ask.done ' +
        'event whose `context` is every question, answer and thread as Markdown, and whose `file` is the `output` path it was ' +
        'also written to. The ask is then read-only: call planroom_ask with the same askId to ask more, which reopens it once ' +
        'you have had its ask.done. Until then it returns `sent: true` and the ask stays read-only: planroom_wait from `cursor` for the ask.done first.',
    inputSchema: inputSchema(askInput)
};

/** The review server's opener. */
const REVIEW_TOOL: Tool = {
    name: 'planroom_review',
    description:
        'Open or resume a Planroom Review of a Bitbucket Cloud PR (a link or a number of the origin repo) or a local branch (nothing is ' +
        'posted for a branch). The server fetches the PR, adds a temporary git worktree at its head under .planroom/reviews/<id>/worktree, ' +
        'and opens the review page. Returns { url, reviewId, resumed, stage, round, pr, files, worktree, diff, preferences, postable, cursor, repoRoot }: ' +
        'print the url, read the code in `worktree` (never in your working directory), and planroom_wait from `cursor`. `diff` is the ' +
        'commit range under review: run `git diff <base> <head>` in the worktree. `preferences` say which your-take cards to use and how ' +
        'many. Start no reviewer subagent before the reviewer starts the round from the page: `reviewers.start` names how many, ' +
        'at what model and effort, and `reviewers` returns it once they have. A posted review whose PR head has moved resumes as the next round, whose `earlier` comments you follow up.',
    inputSchema: inputSchema(reviewInput)
};

/** The tools every server serves after its opener, over whichever session it opened. */
const SESSION_TOOLS: Tool[] = [
    {
        name: 'planroom_emit',
        description:
            'Apply a batch of agent events to the open page, atomically: question.upsert/close/merge, understanding.update, ' +
            'doc.section.upsert, doc.block.upsert, comment.reply (markdown `text`, optionally with diagram, table or other `blocks`), comment.edit (rewrite your reply in place), suggestion.decline, proposal.trace, proposal.ready; ' +
            'in a review, slide.upsert, deck.progress, deck.publish, item.upsert, item.withdraw, summary.draft and earlier.label. Each session kind refuses the events of the others. ' +
            'A malformed batch applies nothing and lists every problem by path. A block whose config fails its type is still stored, ' +
            'shown as an error card, and listed in blockProblems: fix it in place by re-sending it, never by adding a new one. `summary` labels the write-up revision. `doing` tells the user what you are on next, ' +
            'e.g. "researching how alarms are indexed", until your next planroom_wait. `subagents` lists what each subagent you are waiting on is doing, ' +
            'and lasts across waits until you send a new list, [] once they have all reported back. Both can be sent with no events: ' +
            'send that emit in the same message as the tool calls it describes, since one on its own costs a whole turn. ' +
            'Block shapes: references/blocks.md in the planroom, planroom-ask or planroom-review skill.',
        inputSchema: inputSchema(emitBatch)
    },
    {
        name: 'planroom_wait',
        description:
            'Wait for page events (answers, comments, submissions, validation results) after a cursor. Returns at once when events are ' +
            'waiting, otherwise when one arrives or the timeout passes ({ events: [], timedOut: true }). Checklist ticks and assumption ' +
            'confirmations need no reply, so they never end a wait on their own: they come with the next event or at the timeout. ' +
            'Handle events in seq order, then call again with `after` set to the last seq you handled. When `more` is true, call again right away. ' +
            'Leave timeoutSec unset. While your subagents run, do not wait: end your turn, and you are woken as each one reports back.',
        inputSchema: inputSchema(waitInput)
    },
    {
        name: 'planroom_state',
        description:
            'Return the whole planning session: questions and answers, the write-up, comment threads, phases, validation and your event cursor. ' +
            'For an ask, `context` is its questions, answers and threads as Markdown so far. ' +
            'Use it to rebuild context after a compaction or in a resumed session.',
        inputSchema: inputSchema(stateInput)
    }
];

/**
 * Each server's tools as `tools/list` returns them, with input schemas generated from the shared zod schemas: the
 * planning server (`plan`) opens plans, the question server (`ask`) opens asks, so a user can turn either off in `/mcp`.
 */
export const TOOLS: Record<SessionKind, Tool[]> = {
    plan: [OPEN_TOOL, ...SESSION_TOOLS],
    ask: [ASK_TOOL, ...SESSION_TOOLS],
    review: [REVIEW_TOOL, ...SESSION_TOOLS]
};

/** Each server's name, which `planroom install` registers it under and channel messages carry as their source. */
export const SERVER_NAMES: Record<SessionKind, string> = { plan: 'planroom', ask: 'planroom-ask', review: 'planroom-review' };

/** How page events reach the agent, from the server named `source`. */
const delivery = (source: string) =>
    [
        'Page events arrive through planroom_wait. When this Claude Code session was launched with channels, events that arrive while you',
        `are not waiting are also pushed to you as <channel source="${source}" seq="…" kind="…" change_id="…"> messages. They are the same`,
        'events planroom_wait returns: handle events strictly in seq order, skip any seq you have already handled, and pass the highest',
        'seq you handled as `after` to your next planroom_wait.'
    ].join(' ');

/**
 * The server instructions the agent session receives when it connects: load the skill, print the URL, handle events in
 * seq order.
 */
export const INSTRUCTIONS: Record<SessionKind, string> = {
    plan: [
        'Planroom is the live planning page for changes in any repo with an openspec/ directory, proposed as an OpenSpec change or a Markdown plan.',
        'Load the planroom skill before calling these tools.',
        'planroom_open returns the page URL: always print it for the user.',
        delivery(SERVER_NAMES.plan)
    ].join(' '),
    ask: [
        'Planroom Ask puts a series of questions for the user on a live page of question cards, in any repo and at any point in your work,',
        'and hands the answers back as context. Load the planroom-ask skill before calling these tools.',
        'planroom_ask returns the page URL: always print it for the user.',
        delivery(SERVER_NAMES.ask)
    ].join(' '),
    review: [
        'Planroom Review walks a reviewer through a Bitbucket PR or a local branch on a live page: a deck of slides, then the review',
        'findings they agree with, reword or reject, then the comments to post. Load the planroom-review skill before calling these tools.',
        'planroom_review returns the page URL: always print it for the user.',
        delivery(SERVER_NAMES.review)
    ].join(' ')
};

export interface PlanroomOptions {
    /** Which server this is: `plan` serves planroom_open, `ask` planroom_ask, `review` planroom_review. */
    kind: SessionKind;
    /** For the review server: Bitbucket access and the preferences file, worked out on its first review. */
    reviewHost?: () => Promise<ReviewHost>;
    /** Planroom's version, which the server reports when the agent connects. */
    version: string;
    repoRoot: string;
    /** The built SPA (`dist/ui`). */
    uiDir: string;
    cli: OpenSpecRunner;
    openBrowser: BrowserOpener;
    /** The list of repos Planroom has run in, for the plan switcher. Unset: it lists this repo's plans only. */
    registryFile?: string;
    now?: () => Date;
}

export interface Planroom {
    readonly server: Server;
    /** The open session, if any. */
    readonly session: Session | undefined;
    readonly url: string | undefined;
    close(): Promise<void>;
}

/** A tool result carrying `value` as JSON text. */
function ok(value: unknown): CallToolResult {
    return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

/** A tool error result: the rejection's issues, the lock holder's URL, or the error message. */
function failed(error: unknown): CallToolResult {
    let body: Record<string, unknown>;
    if (error instanceof RejectedError) body = { error: 'Rejected; nothing was applied.', issues: error.issues };
    else if (error instanceof ChangeLockedError) body = { error: error.message, url: error.holder.url };
    else if (error instanceof StateFileError || error instanceof BitbucketError || error instanceof GitError)
        body = { error: error.message };
    else body = { error: error instanceof Error ? error.message : String(error) };
    return { content: [{ type: 'text', text: JSON.stringify(body) }], isError: true };
}

/** Parse a tool's arguments, rejecting with every issue by path. Missing arguments parse as `{}`. */
function parseArgs<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
    const parsed = schema.safeParse(input ?? {});
    if (!parsed.success) throw new RejectedError(toIssues(parsed.error), 400);
    return parsed.data;
}

/** The page events after which the session is read-only and Planroom shuts down once the agent has them. */
const ENDS_SESSION: ReadonlySet<LoggedEventType> = new Set<LoggedEventType>(['proposal.accept', 'session.end', 'ask.done']);

/** The channel message for one event: a readable first line, then the event itself. */
export function channelContent(event: LoggedEvent): string {
    return `Planroom page event ${event.seq} (${event.type}):\n${JSON.stringify(event)}`;
}

/**
 * A Planroom MCP server: the planning server or the question server, each with its four tools over one session at a
 * time, the `claude/channel` capability for push delivery, and the page's web server, started on the first open.
 */
export function createPlanroom(options: PlanroomOptions): Planroom {
    const { kind } = options;
    const opener = { plan: OPEN_TOOL, ask: ASK_TOOL, review: REVIEW_TOOL }[kind].name;
    const server = new Server(
        { name: SERVER_NAMES[kind], version: options.version },
        { capabilities: { tools: {}, experimental: { 'claude/channel': {} } }, instructions: INSTRUCTIONS[kind] }
    );
    let session: Session | undefined;
    let url: string | undefined;
    let pages: PageServer | undefined;
    let opening: Promise<unknown> = Promise.resolve();
    /** Set when the page switched plans under the agent, until it reads the new one with planroom_state or planroom_open. */
    let switchedTo: string | undefined;
    /** Set once the agent opened the plan browser, until the page server stops. With no plan open, waits park on it. */
    let browsing = false;
    /** Emits `picked` when the user opens a plan from a page, waking waits parked on the plan browser. */
    const picks = new EventEmitter();

    const notifierFor =
        (changeId: string): ChannelNotifier =>
        (event) =>
            server.notification({
                method: 'notifications/claude/channel',
                params: {
                    content: channelContent(event),
                    meta: { seq: String(event.seq), kind: event.type, change_id: changeId }
                }
            });

    const current = (): Session => {
        if (!session || session.closed)
            throw new RejectedError([{ path: '', message: `No Planroom session is open. Call ${opener} first.` }], 409);
        return session;
    };

    /** The open session for a tool that acts on the plan the agent knows: refused once the page switched plans under it. */
    const known = (): Session => {
        const live = current();
        if (switchedTo)
            throw new RejectedError(
                [
                    {
                        path: '',
                        message: `The user switched the page to the plan for ${switchedTo}; nothing was applied. Call planroom_state to load that plan, then wait from its cursor.`
                    }
                ],
                409
            );
        return live;
    };

    /** Run opens one at a time, in call order, whether the agent or the page asked. */
    const serially = <T>(fn: () => Promise<T>): Promise<T> => {
        const run = opening.then(fn);
        opening = run.catch(() => undefined);
        return run;
    };

    const closeSession = async () => {
        if (!session) return;
        pages?.remove(session);
        await session.close();
        session = undefined;
        url = undefined;
    };

    /**
     * Once the agent has the accept or end, event `seq`, close the session and stop the page server. The agent waits on
     * it no more, so the event counts as read and a resume carries on past it. The MCP connection stays up, so a later
     * open serves the page again. A reopen in the meantime keeps it up.
     */
    const shutDown = async (ended: Session, seq: number) => {
        if (session !== ended || !isReadOnly(ended.current)) return;
        await ended.acknowledge(seq);
        await closeSession();
        await pages?.close();
        pages = undefined;
        browsing = false;
    };

    /** The page server, started on first use. */
    const pageServer = async (): Promise<PageServer> =>
        (pages ??= await startPageServer({
            uiDir: options.uiDir,
            repoRoot: options.repoRoot,
            openPlan: (id) => serially(() => switchPlan(id)),
            ...(options.registryFile ? { registryFile: options.registryFile } : {})
        }));

    /** What every session opens with besides its own id and title. */
    const base = { repoRoot: options.repoRoot, cli: options.cli, ...(options.now ? { now: options.now } : {}) };

    /** Open a change's plan, for `serve`. */
    const openPlan = (changeId: string, title?: string, format?: PlanFormat) =>
        Session.open({ ...base, changeId, ...(title ? { title } : {}), ...(format ? { format } : {}) });

    /**
     * Open a session and serve it in place of the open one. The new session is opened (id checked, lock taken) and
     * served before the previous one closes, so a failed open leaves the previous session as it was.
     */
    const serve = async (
        opening: () => Promise<{ session: Session; resumed: boolean }>
    ): Promise<{ live: Session; url: string; resumed: boolean }> => {
        const opened = await opening();
        const { changeId } = opened.session;
        let openedUrl: string;
        try {
            openedUrl = (await pageServer()).add(opened.session);
            await opened.session.publishUrl(openedUrl);
            await closeSession();
        } catch (error) {
            pages?.remove(opened.session);
            await opened.session.close();
            throw error;
        }
        session = opened.session;
        url = openedUrl;
        session.setNotifier(notifierFor(changeId));
        return { live: opened.session, url: openedUrl, resumed: opened.resumed };
    };

    /** The open session and its page URL when it is the `wanted` kind's `id`, which opening again returns as it is. */
    const openHere = (wanted: SessionKind, id: string): { live: Session; url: string } | undefined =>
        session && !session.closed && session.current.kind === wanted && session.changeId === id && url
            ? { live: session, url }
            : undefined;

    /** Open the plan browser's page in the browser. Any open plan stays open until the user picks another there. */
    const browse = async () => {
        const { browseUrl } = await pageServer();
        browsing = true;
        return {
            url: browseUrl,
            browsing: true,
            repoRoot: options.repoRoot,
            browserOpened: await options.openBrowser(browseUrl)
        };
    };

    /** Open a change for the agent, or return the open one, and open its page in the browser. Without one, browse. */
    const open = async (input: unknown) => {
        const { changeId, title, format } = parseArgs(openInput, input);
        if (!changeId) return browse();
        switchedTo = undefined;
        const here = openHere('plan', changeId);
        if (here && format && format !== here.live.current.format)
            throw new RejectedError(
                [
                    {
                        path: 'format',
                        message: `${changeId} is open with format "${here.live.current.format}"; open it without a format`
                    }
                ],
                409
            );
        const {
            live,
            url: openedUrl,
            resumed
        } = here ? { ...here, resumed: true } : await serve(() => openPlan(changeId, title, format));
        live.delivery.touch();
        return {
            url: openedUrl,
            resumed,
            phase: currentPhase(live.current),
            format: live.current.format,
            cursor: live.current.agentCursor,
            repoRoot: options.repoRoot,
            browserOpened: here ? false : await options.openBrowser(openedUrl)
        };
    };

    /**
     * Open an ask for the agent, or return the open one, and open its page in the browser. A sent ask reopens for more
     * questions once the agent has had its answers; until then it stays read-only and says `sent`.
     */
    const ask = async (input: unknown) => {
        const { askId, title, output } = parseArgs(askInput, input);
        switchedTo = undefined;
        const here = openHere('ask', askId);
        const {
            live,
            url: openedUrl,
            resumed
        } = here
            ? { ...here, resumed: true }
            : await serve(() =>
                  Session.openAsk({ ...base, askId, ...(title ? { title } : {}), ...(output !== undefined ? { output } : {}) })
              );
        if (output !== undefined) await live.setOutput(output);
        const sent = !(await live.reopenAsk());
        live.delivery.touch();
        return {
            url: openedUrl,
            askId,
            resumed,
            ...(sent ? { sent: true } : {}),
            cursor: live.current.agentCursor,
            repoRoot: options.repoRoot,
            browserOpened: here ? false : await options.openBrowser(openedUrl)
        };
    };

    /** The review server's Bitbucket access and preferences file, worked out once. */
    let host: Promise<ReviewHost> | undefined;

    /** What the agent works from in a review: where it stands, the change, the worktree and the preferences. */
    const reviewContext = (live: Session) => {
        const review = live.current.review!;
        const round = currentRound(review);
        const additions = round.files.reduce((sum, file) => sum + file.additions, 0);
        const deletions = round.files.reduce((sum, file) => sum + file.deletions, 0);
        return {
            reviewId: live.changeId,
            stage: reviewStage(live.current),
            round: round.n,
            target: review.target,
            pr: {
                title: review.title,
                description: review.description,
                ...(review.author ? { author: review.author } : {}),
                ...(review.link ? { link: review.link } : {}),
                ...(review.source ? { source: review.source } : {}),
                ...(review.destination ? { destination: review.destination } : {})
            },
            files: round.files,
            stats: { files: round.files.length, additions, deletions },
            worktree: live.worktreeDir,
            diff: { base: round.base, head: round.head },
            ...(round.n > 1 ? { earlier: round.earlier } : {}),
            ...(round.reviewers ? { reviewers: round.reviewers } : {}),
            preferences: live.reviewPreferences,
            postable: live.postable
        };
    };

    /**
     * Open a review for the agent, or return the open one, and open its page in the browser. Opening resolves the
     * target first, so a resumed review whose PR head moved since it was posted starts its next round.
     */
    const review = async (input: unknown) => {
        const { target, title } = parseArgs(reviewInput, input);
        switchedTo = undefined;
        const reviewHost = await (host ??= (
            options.reviewHost ?? (() => Promise.reject(new Error('This Planroom has no review host')))
        )());
        const resolved = await resolveTarget(options.repoRoot, target, reviewHost.access);
        if (title) resolved.title = title;
        const here = openHere('review', resolved.id);
        const {
            live,
            url: openedUrl,
            resumed
        } = here ? { ...here, resumed: true } : await serve(() => Session.openReview({ ...base, resolved, host: reviewHost }));
        await live.syncReview(resolved);
        live.delivery.touch();
        return {
            url: openedUrl,
            resumed,
            ...reviewContext(live),
            cursor: live.current.agentCursor,
            repoRoot: options.repoRoot,
            browserOpened: here ? false : await options.openBrowser(openedUrl)
        };
    };

    /**
     * Switch the page to another plan in the repo, for its plan switcher, and return that plan's page URL. Only a
     * change that already has a plan opens this way, so the page cannot create one, and the page navigates itself.
     */
    const switchPlan = async (changeId: string): Promise<string> => {
        if (kind !== 'plan')
            throw new RejectedError(
                [
                    {
                        path: 'changeId',
                        message: `This Planroom ${kind === 'ask' ? 'only asks questions' : 'only reviews'}: it opens no plans`
                    }
                ],
                404
            );
        if (!(await hasPlan(options.repoRoot, changeId)))
            throw new RejectedError([{ path: 'changeId', message: `${changeId} has no plan to open` }], 404);
        const here = openHere('plan', changeId);
        if (here) return here.url;
        const served = await serve(() => openPlan(changeId));
        switchedTo = changeId;
        picks.emit('picked');
        return served.url;
    };

    const handlers: Record<string, (input: unknown, signal: AbortSignal) => Promise<unknown>> = {
        planroom_open: (input) => serially(() => open(input)),
        planroom_ask: (input) => serially(() => ask(input)),
        planroom_review: (input) => serially(() => review(input)),
        planroom_emit: (input) => known().emit(input),
        planroom_wait: async (input, signal) => {
            const { after, timeoutSec } = parseArgs(waitInput, input);
            const timeout = timeoutSec ?? DEFAULT_WAIT_SEC;
            // With only the plan browser open, wait for the user to pick a plan there; `known` then refuses, naming it.
            if (browsing && (!session || session.closed)) {
                try {
                    await once(picks, 'picked', { signal: AbortSignal.any([signal, AbortSignal.timeout(timeout * 1000)]) });
                } catch {
                    return { events: [], timedOut: true, more: false, cursor: after };
                }
            }
            const live = known();
            const result = await live.wait(after, timeout, signal);
            const last = result.events[result.events.length - 1];
            // Only an accept or end from this run: one replayed from an earlier run is history.
            const ending = result.events.find((event) => event.seq > live.openedSeq && ENDS_SESSION.has(event.type));
            if (ending)
                serially(() => shutDown(live, ending.seq)).catch((error: unknown) =>
                    console.error('planroom: error while shutting down', error)
                );
            return { ...result, cursor: last?.seq ?? after };
        },
        planroom_state: async (input) => {
            parseArgs(stateInput, input);
            const live = current();
            switchedTo = undefined;
            live.delivery.touch();
            const { lastEvent: _lastEvent, counters: _counters, ...state } = live.current;
            const cursor = { cursor: live.delivery.agentCursor, latestSeq: live.delivery.lastSeq, repoRoot: options.repoRoot };
            if (state.kind === 'ask') return { url, ...cursor, context: askTranscript(state), state };
            if (state.kind === 'review') {
                const round = currentRound(state.review!);
                return {
                    url,
                    ...cursor,
                    ...reviewContext(live),
                    deck: deckSlides(state, round.n).map((slide) => ({
                        id: slide.id,
                        chapter: slide.chapter,
                        title: slide.title,
                        published: slideShown(slide, round)
                    })),
                    impact: round.impact ?? null,
                    findings: roundItems(state, round.n).map((item) => ({
                        id: item.id,
                        kind: item.kind,
                        title: item.title,
                        reaction: state.reactions[item.id]?.verdict ?? null
                    })),
                    comments: deriveComments(state, round.n).map(({ key, body, task }) => ({ key, body, task })),
                    state
                };
            }
            const gate = phase1Gate(state, state.phases.phase1.direction);
            return {
                url,
                phase: currentPhase(state),
                ...cursor,
                phase1: {
                    stage: phase1Stage(state),
                    directions: directionTabs(state),
                    resolved: gate.resolved,
                    total: gate.total,
                    canFinish: gate.canFinish
                },
                outstanding: outstandingItems(state),
                /** The write-up's Decisions table, which the page builds from the answers. */
                decisions: decisionRows(state),
                state
            };
        }
    };

    const served = new Set(TOOLS[kind].map((tool) => tool.name));
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS[kind] }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        const handler = served.has(request.params.name) ? handlers[request.params.name] : undefined;
        if (!handler) return failed(new Error(`Unknown tool ${request.params.name}`));
        try {
            return ok(await handler(request.params.arguments, extra.signal));
        } catch (error) {
            return failed(error);
        }
    });

    return {
        server,
        get session() {
            return session;
        },
        get url() {
            return url;
        },
        async close() {
            await closeSession();
            await pages?.close();
            pages = undefined;
            await server.close();
        }
    };
}
