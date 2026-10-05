import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { checkCommand, currentPhase } from '../shared/derive.js';
import { type LoggedEvent, type NewLoggedEvent, pageRequest } from '../shared/events.js';
import { toIssues } from '../shared/issues.js';
import type { ValidationRecord } from '../shared/records.js';
import { type Revision, revisionMeta } from '../shared/revisions.js';
import { emptyState, type PlanFormat, planDir, planFormat, type SessionState } from '../shared/state.js';
import type { ActivityEntry, AgentStatus, Patch, ProposalView, View } from '../shared/view.js';
import { applyAgentBatch, type BatchResult, parseBatch } from './agentApply.js';
import { checkMarkdownPlan, scanChangeFolder, watchChangeFolder } from './changeFolder.js';
import { type ChannelNotifier, EventDelivery, type WaitResult } from './delivery.js';
import { Draft, RejectedError } from './draft.js';
import { acquireLock, releaseLock, releaseLockSync, updateLock } from './lock.js';
import type { OpenSpecRunner } from './openspec.js';
import { applyPageRequest } from './pageApply.js';
import { planroomDir, SessionStore } from './store.js';
import { describeWork, followsAgent, PHASE_WORK, type Work } from './work.js';

/** kebab-case: lowercase letters and digits in words joined by single hyphens. */
export const CHANGE_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** How long the top bar says "Agent editing …" after a write. */
const EDITING_MS = 8_000;
const ACTIVITY_LIMIT = 60;

export interface OpenOptions {
    repoRoot: string;
    changeId: string;
    title?: string;
    /** The format for a new plan. A plan that exists keeps its own, and a different one here is refused. */
    format?: PlanFormat;
    cli: OpenSpecRunner;
    /** Returns the current time; tests pass a fixed clock. */
    now?: () => Date;
}

/** How a format reads in a message. */
const FORMAT_NAME: Record<PlanFormat, string> = { openspec: 'an OpenSpec change', markdown: 'a Markdown plan' };

/**
 * The format to open `changeId` in: the one its plan was created in, else `requested`, else OpenSpec. Refuses a
 * requested format the existing plan was not created in, and an id with a plan in both formats' folders.
 */
export function formatFor(repoRoot: string, changeId: string, requested: PlanFormat | undefined): PlanFormat {
    const planned = planFormat.options.filter((format) =>
        existsSync(join(planroomDir(repoRoot, format, changeId), 'state.json'))
    );
    const [existing] = planned;
    if (planned.length > 1) {
        const where = planned.map((format) => `${planDir(format, changeId)}/`).join(' and ');
        throw new RejectedError([{ path: 'changeId', message: `${changeId} has a plan in both ${where}: move one aside` }], 409);
    }
    if (existing && requested && requested !== existing) {
        throw new RejectedError(
            [
                {
                    path: 'format',
                    message: `${changeId} is already planned as ${FORMAT_NAME[existing]} in ${planDir(existing, changeId)}/: open it without a format, or choose another change id`
                }
            ],
            409
        );
    }
    return existing ?? requested ?? 'openspec';
}

/** The fields a page view adds to the persisted state, which the server works out live. */
export type LiveFields = Pick<View, 'agent' | 'activity' | 'revisions' | 'proposal' | 'validating' | 'viewOnly'>;

/** A plan's page view: the page's fields of its persisted state, plus the live ones. */
export function viewOf(state: SessionState, live: LiveFields): View {
    const {
        changeId,
        title,
        format,
        createdAt,
        questions,
        suggestions,
        understanding,
        sections,
        blocks,
        threads,
        checklistTicks,
        confirmedAssumptions,
        traces,
        validation,
        phases,
        revision
    } = state;
    return {
        changeId,
        title,
        format,
        createdAt,
        questions,
        suggestions,
        understanding,
        sections,
        blocks,
        threads,
        checklistTicks,
        confirmedAssumptions,
        traces,
        validation,
        phases,
        revision,
        ...live
    };
}

/**
 * One planning session for one OpenSpec change, owned by this process. Every change
 * goes through one queue, is persisted before it is acknowledged, and is broadcast to
 * connected pages as record patches.
 */
export class Session {
    private queue: Promise<unknown> = Promise.resolve();
    private readonly listeners = new Set<(patches: Patch[]) => void>();
    private activity: ActivityEntry[] = [];
    private activityId = 0;
    private editing: { label: string; until: number } | undefined;
    private editingTimer: NodeJS.Timeout | undefined;
    /** What the agent is on: set from what its last wait returned or its own `doing`, cleared when it waits again. */
    private work: Work | undefined;
    /** What the agent's running subagents are doing, as it last said. Kept across waits. */
    private subagents: string[] = [];
    private proposal: ProposalView;
    /** Validations in flight; more than one when the user re-runs while one is still going. */
    private validations = 0;
    private stopWatching: (() => void) | undefined;
    /** Releases the lock synchronously if the process exits with the session still open. */
    private readonly exitHandler = () => releaseLockSync(this.store.lockFile);
    readonly delivery: EventDelivery;
    /** The newest seq when this session was opened: events up to it were logged by an earlier run. */
    readonly openedSeq: number;
    closed = false;

    /** Private: sessions come from `Session.open`, which takes the lock and loads the state first. */
    private constructor(
        readonly changeDir: string,
        readonly store: SessionStore,
        private state: SessionState,
        events: LoggedEvent[],
        private revisions: Revision[],
        private readonly cli: OpenSpecRunner,
        private readonly clock: () => Date
    ) {
        this.delivery = new EventDelivery(events, state.agentCursor, () => clock().getTime());
        this.openedSeq = this.delivery.lastSeq;
        this.delivery.onChange(() => this.agentChanged());
        this.proposal = { files: [], scannedAt: this.nowIso() };
        process.once('exit', this.exitHandler);
    }

    /**
     * Open or resume the session for a change: reject a non-kebab-case id before
     * touching anything, scaffold an OpenSpec change with `openspec new change` when it
     * does not exist, take the lock, and restore the persisted state. A Markdown plan
     * lives in `agent-plans/<id>/` instead, which needs no scaffold.
     */
    static async open(options: OpenOptions): Promise<{ session: Session; resumed: boolean }> {
        const { repoRoot, changeId, cli } = options;
        const clock = options.now ?? (() => new Date());
        if (!CHANGE_ID.test(changeId)) {
            throw new RejectedError(
                [
                    {
                        path: 'changeId',
                        message: `"${changeId}" is not kebab-case: use lowercase letters, digits and single hyphens, like add-api-rate-limiting`
                    }
                ],
                400
            );
        }
        // Otherwise `openspec new change` would quietly create an OpenSpec root here.
        if (!existsSync(join(repoRoot, 'openspec')))
            throw new Error(
                `No openspec/ directory in ${repoRoot} or above it. Planroom plans OpenSpec changes: run \`openspec init\` first.`
            );
        const format = formatFor(repoRoot, changeId, options.format);
        const changeDir = join(repoRoot, planDir(format, changeId));
        if (format === 'openspec' && !existsSync(changeDir)) {
            await cli.newChange(changeId);
            if (!existsSync(changeDir)) throw new Error(`openspec new change did not create ${changeDir}`);
        }
        const store = new SessionStore(planroomDir(repoRoot, format, changeId));
        await store.init();
        await acquireLock(store.lockFile, '(starting)', clock().toISOString());
        try {
            const loaded = await store.load();
            if (loaded) {
                const session = new Session(changeDir, store, loaded.state, loaded.events, loaded.revisions, cli, clock);
                await session.startWatching();
                return { session, resumed: true };
            }
            const state = emptyState(changeId, options.title?.trim() || changeId, clock().toISOString(), format);
            await store.saveState(state);
            const session = new Session(changeDir, store, state, [], [], cli, clock);
            await session.startWatching();
            return { session, resumed: false };
        } catch (error) {
            await releaseLock(store.lockFile);
            throw error;
        }
    }

    /** The OpenSpec change this session plans. */
    get changeId(): string {
        return this.state.changeId;
    }

    /** The committed state. Treat it as read-only: writes go through a `Draft`. */
    get current(): SessionState {
        return this.state;
    }

    /** The session clock's time as an ISO string. */
    private nowIso(): string {
        return this.clock().toISOString();
    }

    /** Record the page URL in the lock, so a second session's error can name it. */
    async publishUrl(url: string): Promise<void> {
        await updateLock(this.store.lockFile, url, this.nowIso());
    }

    /** Run `fn` after every earlier change has committed. */
    private exclusive<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.queue.then(fn, fn);
        this.queue = run.catch(() => undefined);
        return run;
    }

    // ---------------------------------------------------------------- agent side

    /** Apply a `planroom_emit` batch: all of it, or none of it with every problem reported. */
    emit(input: unknown): Promise<BatchResult> {
        this.delivery.touch();
        return this.exclusive(async () => {
            const { events, summary, doing, subagents } = parseBatch(input);
            const draft = new Draft(this.state, this.nowIso());
            const { result, revision, editing, validate } = applyAgentBatch(draft, events, summary);
            if (revision) await this.store.saveRevision(revision);
            await this.store.saveState(draft.state);
            this.commit(draft, revision);
            if (doing) this.work = { ...this.work, doing: followsAgent(doing) };
            if (subagents) {
                this.subagents = subagents.map(followsAgent);
                this.delivery.setSubagentsRunning(subagents.length > 0);
            }
            if (editing) this.markEditing(editing);
            else if (doing || subagents) this.agentChanged();
            if (validate) this.startValidation('proposal.ready');
            return result;
        });
    }

    /** Wait for page events after `after`. Also records the agent's cursor for the next resume. */
    async wait(after: number, timeoutSec: number, signal?: AbortSignal): Promise<WaitResult> {
        this.work = undefined;
        const result = await this.delivery.wait(after, timeoutSec * 1000, signal);
        if (result.events.length) {
            this.work = describeWork(result.events, this.state);
            this.agentChanged();
        }
        if (this.delivery.agentCursor > this.state.agentCursor) {
            await this.exclusive(async () => {
                if (this.delivery.agentCursor <= this.state.agentCursor) return;
                this.state = { ...this.state, agentCursor: this.delivery.agentCursor };
                await this.store.saveState(this.state);
            });
        }
        return result;
    }

    /** Attach or detach the channel push for events that arrive while no wait is parked. */
    setNotifier(notifier: ChannelNotifier | undefined): void {
        this.delivery.setNotifier(notifier);
    }

    // ---------------------------------------------------------------- page side

    /**
     * Handle one page request. Accepted requests are persisted (snapshot, then log)
     * before this resolves, and the logged event's `seq` is the acknowledgement.
     */
    handlePage(input: unknown): Promise<{ seq?: number }> {
        return this.exclusive(async () => {
            const parsed = pageRequest.safeParse(input);
            if (!parsed.success) throw new RejectedError(toIssues(parsed.error), 400);
            const draft = new Draft(this.state, this.nowIso());
            const outcome = applyPageRequest(draft, parsed.data, this.revisions);
            const event = outcome.event ? this.stamp(outcome.event, draft.now) : undefined;
            if (event) draft.state.lastEvent = event;
            if (outcome.revision) await this.store.saveRevision(outcome.revision);
            await this.store.saveState(draft.state);
            if (event) await this.store.appendEvent(event);
            this.commit(draft, outcome.revision);
            if (event) this.delivery.publish(event);
            if (outcome.validate) this.startValidation('rerun');
            return event ? { seq: event.seq } : {};
        });
    }

    /** Give a new event the next seq and its timestamp. */
    private stamp(event: NewLoggedEvent, at: string): LoggedEvent {
        // The spread keeps the event's own discriminant; only seq and at are added.
        return { ...event, seq: this.delivery.lastSeq + 1, at } as LoggedEvent;
    }

    /** Append a server-originated event (a validation result) the same way as a page event. */
    private async appendServerEvent(draft: Draft, event: NewLoggedEvent): Promise<LoggedEvent> {
        const logged = this.stamp(event, draft.now);
        draft.state.lastEvent = logged;
        await this.store.saveState(draft.state);
        await this.store.appendEvent(logged);
        this.commit(draft);
        this.delivery.publish(logged);
        return logged;
    }

    // ---------------------------------------------------------------- OpenSpec

    /**
     * Run validation outside the queue, strict unless the submission turned it off, then store and log the result
     * inside it. A Markdown plan is checked for its plan file instead. The result is dropped when the session has
     * closed (its lock may already be released) or the user submitted again while it ran (it describes files the new
     * submission has not written yet).
     */
    private startValidation(trigger: ValidationRecord['trigger']): void {
        const { changeId, format } = this.state;
        const { submission } = this.state.phases;
        const strict = submission?.validate ?? true;
        const markdown = format === 'markdown';
        const command = checkCommand(this.state);
        this.validations += 1;
        this.broadcast([{ field: 'validating', value: true }]);
        void (markdown ? checkMarkdownPlan(this.changeDir, changeId) : this.cli.validate(changeId, strict))
            .catch((error: unknown) => ({
                passed: false,
                issues: [
                    {
                        level: 'ERROR',
                        path: '',
                        message: `${command} could not run: ${error instanceof Error ? error.message : String(error)}`
                    }
                ]
            }))
            .then((outcome) =>
                this.exclusive(async () => {
                    // A new phase.submit replaces the submission record; every other write keeps it.
                    if (this.closed || this.state.phases.submission !== submission) return;
                    const draft = new Draft(this.state, this.nowIso());
                    const record: ValidationRecord = { ...outcome, trigger, at: draft.now };
                    draft.setValidation(record);
                    if (outcome.passed) draft.setPhases({ ...draft.state.phases, proposalUnlocked: true });
                    draft.note({ title: outcome.passed ? 'Validation passed' : 'Validation failed', detail: command });
                    await this.appendServerEvent(draft, { type: 'validation.result', ...outcome, trigger });
                })
            )
            .catch((error: unknown) => console.error(`planroom: could not store the validation result for ${changeId}`, error))
            .finally(() => {
                this.validations -= 1;
                this.broadcast([{ field: 'validating', value: this.validations > 0 }]);
            });
    }

    /** Wait for any validation in flight; tests use this to observe the result. */
    async settled(): Promise<void> {
        await this.queue;
        while (this.validations > 0) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            await this.queue;
        }
    }

    /** Scan the change folder now and rescan whenever it changes. */
    private async startWatching(): Promise<void> {
        await this.rescan();
        this.stopWatching = watchChangeFolder(this.changeDir, () => void this.rescan());
    }

    /** Rescan the change folder and send the page the new Proposal view. */
    async rescan(): Promise<void> {
        this.proposal = await scanChangeFolder(this.changeDir, this.nowIso());
        this.broadcast([{ field: 'proposal', value: this.proposal }]);
    }

    // ---------------------------------------------------------------- page stream

    /** Swap in a draft's state and broadcast its patches, with the revision list and activity feed when they grew. */
    private commit(draft: Draft, revision?: Revision): void {
        this.state = draft.state;
        const patches = draft.listPatches();
        if (revision) {
            this.revisions = [...this.revisions, revision];
            patches.push({ field: 'revisions', value: revisionMeta(this.revisions) });
        }
        if (draft.activity.length) {
            const entries = draft.activity.map((entry) => ({ ...entry, id: (this.activityId += 1) }));
            this.activity = [...entries.reverse(), ...this.activity].slice(0, ACTIVITY_LIMIT);
            patches.push({ field: 'activity', value: this.activity });
        }
        this.broadcast(patches);
    }

    /** Show "Agent editing <label>" in the top bar for a few seconds after a write. */
    private markEditing(label: string): void {
        this.editing = { label, until: this.clock().getTime() + EDITING_MS };
        clearTimeout(this.editingTimer);
        this.editingTimer = setTimeout(() => {
            this.editing = undefined;
            this.agentChanged();
        }, EDITING_MS);
        this.editingTimer.unref();
        this.agentChanged();
    }

    /** Send the page the agent's current status. */
    private agentChanged(): void {
        this.broadcast([{ field: 'agent', value: this.agentStatus() }]);
    }

    /** The agent's status for the top bar: how it is reached, what is queued for it, and what it is editing or working on. */
    agentStatus(): AgentStatus {
        const { mode, queued, working } = this.delivery.status();
        const editing = this.editing && this.editing.until > this.clock().getTime() ? this.editing.label : undefined;
        const running = this.subagents.length;
        // A parked wait answers the user at once, but the agent is still busy while its subagents run.
        const busy = working || (running > 0 && this.delivery.waiting);
        return {
            mode: mode === 'offline' && working ? 'waiting' : mode,
            queued,
            ...(editing ? { editing } : {}),
            ...(busy ? { working: true, ...this.currentWork() } : {}),
            ...(running ? { subagents: this.subagents } : {})
        };
    }

    /** What a busy agent is on: what it received or said, else its subagents, else what the phase is about. */
    private currentWork(): Work {
        if (this.work) return this.work;
        const running = this.subagents.length;
        if (running) return { doing: `waiting on ${running === 1 ? 'a subagent' : `${running} subagents`}` };
        return { doing: PHASE_WORK[currentPhase(this.state)] };
    }

    /** Revision `n` in full, for the history and diff views. */
    revision(n: number): Revision | undefined {
        return this.revisions.find((rev) => rev.n === n);
    }

    /** Every revision this session holds, oldest first. */
    get allRevisions(): readonly Revision[] {
        return this.revisions;
    }

    /** The whole page view: the persisted state plus the live agent status, activity, revisions and Proposal scan. */
    view(): View {
        return viewOf(this.state, {
            agent: this.agentStatus(),
            activity: this.activity,
            revisions: revisionMeta(this.revisions),
            proposal: this.proposal,
            validating: this.validations > 0
        });
    }

    /** Receive every broadcast batch of patches. Returns the unsubscribe. */
    subscribe(listener: (patches: Patch[]) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** Send patches to every subscribed page, skipping an empty batch. */
    private broadcast(patches: Patch[]): void {
        if (!patches.length) return;
        for (const listener of this.listeners) listener(patches);
    }

    /** Close the session once: end delivery and watching, let queued writes finish, then release the lock. */
    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        this.delivery.close();
        this.stopWatching?.();
        clearTimeout(this.editingTimer);
        await this.queue.catch(() => undefined);
        await releaseLock(this.store.lockFile);
        process.off('exit', this.exitHandler);
        this.listeners.clear();
    }
}
