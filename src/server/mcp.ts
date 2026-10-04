import { EventEmitter, once } from 'node:events';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
    CallToolRequestSchema,
    type CallToolResult,
    ListToolsRequestSchema,
    type Tool
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
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
import { type PlanFormat, StateFileError } from '../shared/state.js';
import { DEFAULT_WAIT_SEC, openInput, stateInput, waitInput } from '../shared/tools.js';
import type { ChannelNotifier } from './delivery.js';
import { RejectedError } from './draft.js';
import { type PageServer, startPageServer } from './http.js';
import { ChangeLockedError } from './lock.js';
import type { OpenSpecRunner } from './openspec.js';
import type { BrowserOpener } from './opener.js';
import { hasPlan } from './plans.js';
import { Session } from './session.js';

export { DEFAULT_WAIT_SEC };

/** A tool's JSON Schema, generated from the shared zod schema so the contract has one source. */
function inputSchema(schema: z.ZodType): Tool['inputSchema'] {
    const { $schema: _ignored, ...json } = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<
        string,
        unknown
    >;
    return { ...json, type: 'object' } as Tool['inputSchema'];
}

/** The four Planroom tools as `tools/list` returns them, with input schemas generated from the shared zod schemas. */
export const TOOLS: Tool[] = [
    {
        name: 'planroom_open',
        description:
            'Open or resume the Planroom planning page for a change. A new plan becomes an OpenSpec change in openspec/changes/<changeId>/ ' +
            '(created when it does not exist), or with format "markdown" a plan at agent-plans/<changeId>/<changeId>.md. ' +
            'Returns { url, resumed, phase, format, cursor, repoRoot }: print the url for the user, and pass cursor as `after` to planroom_wait. ' +
            'Plan paths are relative to repoRoot, the repo the server plans in, which is not your working directory when the server was started with --dir. ' +
            "Without a changeId it opens the plan browser instead, where the user picks one of the repo's plans, and returns { url, browsing: true, repoRoot }: " +
            'print the url, then call planroom_wait with after 0. Once the user picks a plan it is refused naming that plan: call planroom_state to load it.',
        inputSchema: inputSchema(openInput)
    },
    {
        name: 'planroom_emit',
        description:
            'Apply a batch of agent events to the open page, atomically: question.upsert/close/merge, understanding.update, ' +
            'doc.section.upsert, doc.block.upsert, comment.reply (markdown `text`, optionally with diagram, table or other `blocks`), comment.edit (rewrite your reply in place), suggestion.decline, proposal.trace, proposal.ready. ' +
            'A malformed batch applies nothing and lists every problem by path. A block whose config fails its type is still stored, ' +
            'shown as an error card, and listed in blockProblems: fix it in place by re-sending it, never by adding a new one. `summary` labels the write-up revision. `doing` tells the user what you are on next, ' +
            'e.g. "researching how alarms are indexed", until your next planroom_wait. `subagents` lists what each subagent you are waiting on is doing, ' +
            'and lasts across waits until you send a new list, [] once they have all reported back. Both can be sent with no events: ' +
            'send that emit in the same message as the tool calls it describes, since one on its own costs a whole turn. ' +
            "Block shapes: the planroom skill's references/blocks.md.",
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
            'Use it to rebuild context after a compaction or in a resumed session.',
        inputSchema: inputSchema(stateInput)
    }
];

/**
 * The server instructions the agent session receives when it connects: load the skill, print the URL, handle events in
 * seq order.
 */
export const INSTRUCTIONS = [
    'Planroom is the live planning page for changes in any repo with an openspec/ directory, proposed as an OpenSpec change or a Markdown plan. Load the planroom skill before calling these tools.',
    'planroom_open returns the page URL: always print it for the user.',
    'Page events arrive through planroom_wait. When this Claude Code session was launched with channels, events that arrive while you',
    'are not waiting are also pushed to you as <channel source="planroom" seq="…" kind="…" change_id="…"> messages. They are the same',
    'events planroom_wait returns: handle events strictly in seq order, skip any seq you have already handled, and pass the highest',
    'seq you handled as `after` to your next planroom_wait.'
].join(' ');

export interface PlanroomOptions {
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
    else if (error instanceof StateFileError) body = { error: error.message };
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
const ENDS_SESSION: ReadonlySet<LoggedEventType> = new Set<LoggedEventType>(['proposal.accept', 'session.end']);

/** The channel message for one event: a readable first line, then the event itself. */
export function channelContent(event: LoggedEvent): string {
    return `Planroom page event ${event.seq} (${event.type}):\n${JSON.stringify(event)}`;
}

/**
 * The Planroom MCP server: four tools over one session at a time, the
 * `claude/channel` capability for push delivery, and the page's web server,
 * started on the first `planroom_open`.
 */
export function createPlanroom(options: PlanroomOptions): Planroom {
    const server = new Server(
        { name: 'planroom', version: '0.1.0' },
        { capabilities: { tools: {}, experimental: { 'claude/channel': {} } }, instructions: INSTRUCTIONS }
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
            throw new RejectedError([{ path: '', message: 'No Planroom session is open. Call planroom_open first.' }], 409);
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
     * Once the agent has the accept or end, close the session and stop the page server. The MCP connection stays up,
     * so a later planroom_open serves the page again. A reopen in the meantime keeps it up.
     */
    const shutDown = async (ended: Session) => {
        if (session !== ended || !isReadOnly(ended.current)) return;
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

    /**
     * Open a change and serve it in place of the open one. The new session is opened (id checked, lock taken) and
     * served before the previous one closes, so a failed open leaves the previous session as it was.
     */
    const serve = async (
        changeId: string,
        title?: string,
        format?: PlanFormat
    ): Promise<{ live: Session; url: string; resumed: boolean }> => {
        const opened = await Session.open({
            repoRoot: options.repoRoot,
            changeId,
            ...(title ? { title } : {}),
            ...(format ? { format } : {}),
            cli: options.cli,
            ...(options.now ? { now: options.now } : {})
        });
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
        if (session && !session.closed && session.changeId === changeId && url) {
            if (format && format !== session.current.format)
                throw new RejectedError(
                    [
                        {
                            path: 'format',
                            message: `${changeId} is open with format "${session.current.format}"; open it without a format`
                        }
                    ],
                    409
                );
            session.delivery.touch();
            return {
                url,
                resumed: true,
                phase: currentPhase(session.current),
                format: session.current.format,
                cursor: session.current.agentCursor,
                repoRoot: options.repoRoot,
                browserOpened: false
            };
        }
        const served = await serve(changeId, title, format);
        served.live.delivery.touch();
        const browserOpened = await options.openBrowser(served.url);
        return {
            url: served.url,
            resumed: served.resumed,
            phase: currentPhase(served.live.current),
            format: served.live.current.format,
            cursor: served.live.current.agentCursor,
            repoRoot: options.repoRoot,
            browserOpened
        };
    };

    /**
     * Switch the page to another plan in the repo, for its plan switcher, and return that plan's page URL. Only a
     * change that already has a plan opens this way, so the page cannot create one, and the page navigates itself.
     */
    const switchPlan = async (changeId: string): Promise<string> => {
        if (!(await hasPlan(options.repoRoot, changeId)))
            throw new RejectedError([{ path: 'changeId', message: `${changeId} has no plan to open` }], 404);
        if (session && !session.closed && session.changeId === changeId && url) return url;
        const served = await serve(changeId);
        switchedTo = changeId;
        picks.emit('picked');
        return served.url;
    };

    const handlers: Record<string, (input: unknown, signal: AbortSignal) => Promise<unknown>> = {
        planroom_open: (input) => serially(() => open(input)),
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
            if (result.events.some((event) => event.seq > live.openedSeq && ENDS_SESSION.has(event.type)))
                serially(() => shutDown(live)).catch((error: unknown) =>
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
            const gate = phase1Gate(state, state.phases.phase1.direction);
            return {
                url,
                phase: currentPhase(state),
                cursor: live.delivery.agentCursor,
                latestSeq: live.delivery.lastSeq,
                repoRoot: options.repoRoot,
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

    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        const handler = handlers[request.params.name];
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
