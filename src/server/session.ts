import { existsSync, promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { checkCommand, currentPhase } from '../shared/derive.js';
import { type LoggedEvent, type NewLoggedEvent, pageRequest } from '../shared/events.js';
import { toIssues } from '../shared/issues.js';
import type { ValidationRecord } from '../shared/records.js';
import { currentRound, type ReviewPreferences, reviewStage } from '../shared/review.js';
import { type Revision, revisionMeta } from '../shared/revisions.js';
import { emptyState, type PlanFormat, planDir, planFormat, type SessionState } from '../shared/state.js';
import type { ActivityEntry, AgentStatus, Patch, ProposalView, View } from '../shared/view.js';
import { applyAgentBatch, type BatchResult, parseBatch } from './agentApply.js';
import { checkMarkdownPlan, scanChangeFolder, watchChangeFolder } from './changeFolder.js';
import { type ChannelNotifier, EventDelivery, type WaitResult } from './delivery.js';
import { Draft, RejectedError } from './draft.js';
import { writeAtomic } from './fsutil.js';
import { acquireLock, releaseLock, releaseLockSync, updateLock } from './lock.js';
import type { OpenSpecRunner } from './openspec.js';
import { applyPageRequest } from './pageApply.js';
import { postRound } from './posting.js';
import { readPreferences, writePreferences } from './preferences.js';
import { freshReview, nextRound, type ResolvedTarget, type ReviewHost } from './review.js';
import { askDir, ignoreInGit, LOCAL_FILES, planroomDir, reviewDir, SessionStore } from './store.js';
import { describeWork, followsAgent, PHASE_WORK, REVIEW_WORK, type Work } from './work.js';
import { ensureWorktree, filePatch, removeWorktree } from './worktree.js';

/** kebab-case: lowercase letters and digits in words joined by single hyphens. */
export const CHANGE_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** How long the top bar says "Agent editing …" after a write. */
const EDITING_MS = 8_000;
export const ACTIVITY_LIMIT = 60;

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

/** What `Session.openAsk` needs: the repo, the ask's id, and for a new ask its title and transcript file. */
export interface AskOptions {
    repoRoot: string;
    askId: string;
    title?: string;
    /** The repo-relative `.md` file the transcript is written to when the user sends their answers. */
    output?: string;
    cli: OpenSpecRunner;
    now?: () => Date;
}

/** What `Session.openReview` needs: the repo, the resolved target, and Bitbucket access and the preferences file. */
export interface ReviewOptions {
    repoRoot: string;
    resolved: ResolvedTarget;
    host: ReviewHost;
    cli: OpenSpecRunner;
    now?: () => Date;
}

/** Reject an id that is not kebab-case before anything touches the disk. */
function checkId(id: string, path: string, example: string): void {
    if (!CHANGE_ID.test(id))
        throw new RejectedError(
            [{ path, message: `"${id}" is not kebab-case: use lowercase letters, digits and single hyphens, like ${example}` }],
            400
        );
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
export type LiveFields = Pick<
    View,
    'agent' | 'activity' | 'revisions' | 'proposal' | 'validating' | 'viewOnly' | 'elsewhere' | 'preferences' | 'postable'
>;

/** A plan's page view: the page's fields of its persisted state, plus the live ones. */
export function viewOf(state: SessionState, live: LiveFields): View {
    const {
        changeId,
        title,
        kind,
        format,
        output,
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
        review,
        slides,
        items,
        reactions,
        takes,
        notes
    } = state;
    return {
        changeId,
        title,
        kind,
        format,
        ...(output !== undefined ? { output } : {}),
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
        review,
        slides,
        items,
        reactions,
        takes,
        notes,
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
    /** The newest activity entries, newest first; every entry is also appended to the store's activity log. */
    private activity: ActivityEntry[];
    private activityId: number;
    /** The activity log's appends, in order, off the queue: the feed is a convenience, not the record. */
    private activityLog: Promise<void> = Promise.resolve();
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
    /** A review's Bitbucket access and preferences file. */
    private host: ReviewHost | undefined;
    /** A review's preferences, as last read or saved. */
    private preferences: ReviewPreferences | undefined;
    /** The Post in flight, if any. */
    private posting: Promise<void> | undefined;
    /** Releases the lock synchronously if the process exits with the session still open. */
    private readonly exitHandler = () => releaseLockSync(this.store.lockFile);
    readonly delivery: EventDelivery;
    /** The newest seq when this session was opened: events up to it were logged by an earlier run. */
    readonly openedSeq: number;
    closed = false;

    /** Private: sessions come from `Session.open` or `Session.openAsk`, which take the lock and load the state first. */
    private constructor(
        private readonly repoRoot: string,
        /** The plan's folder, or an ask's records folder, which is never watched or validated. */
        readonly changeDir: string,
        readonly store: SessionStore,
        private state: SessionState,
        events: LoggedEvent[],
        private revisions: Revision[],
        activity: ActivityEntry[],
        private readonly cli: OpenSpecRunner,
        private readonly clock: () => Date
    ) {
        this.activity = activity;
        this.activityId = Math.max(0, ...activity.map((entry) => entry.id));
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
     * lives in `agent-plans/<id>/` instead, which needs no scaffold. Its `.planroom/`
     * gets a `.gitignore` for the files that stay local.
     */
    static async open(options: OpenOptions): Promise<{ session: Session; resumed: boolean }> {
        const { repoRoot, changeId, cli } = options;
        checkId(changeId, 'changeId', 'add-api-rate-limiting');
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
        const dir = planroomDir(repoRoot, format, changeId);
        await ignoreInGit(dir, LOCAL_FILES);
        return Session.start(options, changeDir, new SessionStore(dir), (now) =>
            emptyState(changeId, options.title?.trim() || changeId, now, format)
        );
    }

    /**
     * Open or resume an ask in `.planroom/asks/<askId>/`, which needs no `openspec/` and whose `.planroom/` ignores
     * itself in git. A resumed ask is as it was left: `reopenAsk` makes a sent one editable again, and `setOutput`
     * points it at another file.
     */
    static async openAsk(options: AskOptions): Promise<{ session: Session; resumed: boolean }> {
        const { repoRoot, askId, output } = options;
        checkId(askId, 'askId', 'auth-migration-questions');
        const dir = askDir(repoRoot, askId);
        await ignoreInGit(join(repoRoot, '.planroom'));
        return Session.start(options, dir, new SessionStore(dir), (now) => ({
            ...emptyState(askId, options.title?.trim() || askId, now),
            kind: 'ask',
            ...(output === undefined ? {} : { output })
        }));
    }

    /**
     * Open or resume a review in `.planroom/reviews/<id>/`, which needs no `openspec/` and whose `.planroom/` ignores
     * itself in git. A new review starts at round 1 of the resolved target. `syncReview` then brings it up to date.
     */
    static async openReview(options: ReviewOptions): Promise<{ session: Session; resumed: boolean }> {
        const { repoRoot, resolved, host } = options;
        checkId(resolved.id, 'target', 'pr-412');
        const dir = reviewDir(repoRoot, resolved.id);
        await ignoreInGit(join(repoRoot, '.planroom'));
        const opened = await Session.start(options, dir, new SessionStore(dir), async (now) => ({
            ...emptyState(resolved.id, resolved.title, now),
            kind: 'review',
            review: await freshReview(repoRoot, resolved, now)
        }));
        opened.session.host = host;
        opened.session.preferences = await readPreferences(host.preferencesFile);
        return opened;
    }

    /** Take the lock, then restore the persisted state or start one from `fresh`, and watch a plan's folder. */
    private static async start(
        options: Pick<OpenOptions, 'repoRoot' | 'cli' | 'now'>,
        changeDir: string,
        store: SessionStore,
        fresh: (now: string) => SessionState | Promise<SessionState>
    ): Promise<{ session: Session; resumed: boolean }> {
        const clock = options.now ?? (() => new Date());
        await store.init();
        await acquireLock(store.lockFile, '(starting)', clock().toISOString());
        try {
            const loaded = await store.load();
            const state = loaded?.state ?? (await fresh(clock().toISOString()));
            if (!loaded) await store.saveState(state);
            const { repoRoot, cli } = options;
            const session = new Session(
                repoRoot,
                changeDir,
                store,
                state,
                loaded?.events ?? [],
                loaded?.revisions ?? [],
                await store.loadActivity(ACTIVITY_LIMIT),
                cli,
                clock
            );
            if (state.kind === 'plan') await session.startWatching();
            return { session, resumed: loaded !== undefined };
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

    /**
     * Make a sent ask editable again for the agent's next questions, once its `ask.done` has reached the agent, and
     * count that event as read so it is not handed over again. Until then the ask stays as the user sent it: the agent
     * has their answers to read first. Resolves with whether the ask takes questions.
     */
    reopenAsk(): Promise<boolean> {
        return this.exclusive(async () => {
            const { ended, ...phases } = this.state.phases;
            if (!ended) return true;
            // Nothing follows an ask's `ask.done`: the page and the agent are refused once it is sent.
            const done = this.state.lastEvent?.seq ?? 0;
            if (!this.delivery.reached(done)) return false;
            this.delivery.acknowledge(done);
            const draft = new Draft(this.state, this.nowIso());
            draft.state.agentCursor = this.delivery.agentCursor;
            draft.setPhases(phases);
            draft.note({ title: 'Reopened for more questions' });
            await this.store.saveState(draft.state);
            this.commit(draft);
            return true;
        });
    }

    /** Point an ask's transcript at `output` from now on. */
    setOutput(output: string): Promise<void> {
        return this.exclusive(async () => {
            if (this.state.output === output) return;
            this.state = { ...this.state, output };
            await this.store.saveState(this.state);
            this.broadcast([{ field: 'output', value: output }]);
        });
    }

    /** A review's worktree, as an absolute path. */
    get worktreeDir(): string | undefined {
        return this.state.review ? join(this.repoRoot, this.state.review.worktree) : undefined;
    }

    /** Where a review's `code` excerpts are read from: its worktree, at the commit under review. */
    get codeRoot(): string | undefined {
        return this.worktreeDir;
    }

    /**
     * Bring a review up to date with its target: reopen it if the reviewer ended it, release a Post a crash cut short so
     * it can be retried, and start the next round when a posted round's head has moved. Then check the worktree out at
     * the current round's head. A reopened review starts the agent afresh, so it counts everything logged as read.
     */
    async syncReview(resolved: ResolvedTarget): Promise<void> {
        const host = this.host;
        if (!host || !this.state.review) throw new Error('syncReview outside a review');
        await this.exclusive(async () => {
            const review = this.state.review!;
            const round = currentRound(review);
            const draft = new Draft(this.state, this.nowIso());
            const { ended, ...phases } = draft.state.phases;
            if (ended) {
                draft.setPhases(phases);
                this.delivery.acknowledge(this.delivery.lastSeq);
                draft.state.agentCursor = this.delivery.agentCursor;
                draft.note({ title: 'Reopened the review' });
            }
            const { title, description, author, link } = resolved;
            const summary = { ...review, title, description, ...(author ? { author } : {}), ...(link ? { link } : {}) };
            if (round.posting?.state === 'posting') {
                summary.rounds = review.rounds.map((each) =>
                    each.n === round.n ? { ...each, posting: { state: 'partial' as const, at: draft.now } } : each
                );
            }
            if (round.postedAt && resolved.head !== round.head) {
                const next = await nextRound(this.repoRoot, review, resolved.head, host.access, draft.now);
                summary.rounds = [...summary.rounds, next];
                draft.note({ title: `Round ${next.n} started`, detail: 'the author pushed since your review', kind: 'question' });
            }
            draft.setReview(summary);
            await this.store.saveState(draft.state);
            this.commit(draft);
        });
        await ensureWorktree(this.repoRoot, this.worktreeDir!, currentRound(this.state.review!).head);
    }

    /** A review's preferences: this machine's `review.json`, as last read or saved. */
    get reviewPreferences(): ReviewPreferences | undefined {
        return this.preferences;
    }

    /** Whether a review can post, and what to set up while it cannot. */
    get postable(): { ready: boolean; problem?: string } | undefined {
        if (!this.host) return undefined;
        const { ready, problem } = this.host.access;
        return { ready, ...(problem ? { problem } : {}) };
    }

    /** One round's diff, of one file or all of them, from its base to its head. */
    async reviewDiff(roundNumber: number | undefined, file?: string): Promise<{ round: number; patch: string }> {
        const review = this.state.review;
        const round =
            roundNumber === undefined ? review && currentRound(review) : review?.rounds.find((r) => r.n === roundNumber);
        if (!round) throw new RejectedError([{ path: 'round', message: 'There is no such round' }], 404);
        if (file !== undefined && !round.files.some((changed) => changed.path === file || changed.from === file))
            throw new RejectedError([{ path: 'file', message: `${file} is not in round ${round.n}'s diff` }], 404);
        return { round: round.n, patch: await filePatch(this.repoRoot, round.base, round.head, file) };
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
            const { result, revision, editing, validate } = applyAgentBatch(draft, events, summary, this.preferences);
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
        await this.saveCursor();
        return result;
    }

    /**
     * Record that the agent has read through `seq` without waiting again: for an event that ends the session, which no
     * later wait on it acknowledges.
     */
    async acknowledge(seq: number): Promise<void> {
        this.delivery.acknowledge(seq);
        await this.saveCursor();
    }

    /** Persist the agent's cursor once it has moved past the saved one, so a resume carries on from it. */
    private async saveCursor(): Promise<void> {
        if (this.delivery.agentCursor <= this.state.agentCursor) return;
        await this.exclusive(async () => {
            if (this.delivery.agentCursor <= this.state.agentCursor) return;
            this.state = { ...this.state, agentCursor: this.delivery.agentCursor };
            await this.store.saveState(this.state);
        });
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
            if (parsed.data.type === 'comments.post' && this.host && !this.host.access.ready)
                throw new RejectedError([{ path: 'type', message: this.host.access.problem ?? 'Posting is not set up' }], 409);
            const draft = new Draft(this.state, this.nowIso());
            const outcome = applyPageRequest(draft, parsed.data, this.revisions);
            if (outcome.preferences && this.host) {
                await writePreferences(this.host.preferencesFile, outcome.preferences);
                this.preferences = outcome.preferences;
                this.broadcast([{ field: 'preferences', value: outcome.preferences }]);
            }
            let sent = outcome.event;
            if (sent?.type === 'ask.done') sent = { ...sent, ...(await this.writeOutput(draft.state.output, sent.context)) };
            const event = sent ? this.stamp(sent, draft.now) : undefined;
            if (event) draft.state.lastEvent = event;
            if (outcome.revision) await this.store.saveRevision(outcome.revision);
            await this.store.saveState(draft.state);
            if (event) await this.store.appendEvent(event);
            this.commit(draft, outcome.revision);
            if (event) this.delivery.publish(event);
            if (outcome.validate) this.startValidation('rerun');
            if (outcome.post) this.startPosting(outcome.post);
            return event ? { seq: event.seq } : {};
        });
    }

    /** Write an ask's transcript to its `output`, when it has one, and say how that went for the `ask.done` event. */
    private async writeOutput(output: string | undefined, context: string): Promise<{ file?: string; fileError?: string }> {
        if (output === undefined) return {};
        const file = join(this.repoRoot, output);
        try {
            await fs.mkdir(dirname(file), { recursive: true });
            await writeAtomic(file, context);
            return { file: output };
        } catch (error) {
            return { fileError: `${output} could not be written: ${error instanceof Error ? error.message : String(error)}` };
        }
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

    /** Apply a server-side change through a draft, persisted before it resolves, logging the event it returns. */
    private change(fn: (draft: Draft) => NewLoggedEvent | undefined): Promise<void> {
        return this.exclusive(async () => {
            if (this.closed) return;
            const draft = new Draft(this.state, this.nowIso());
            const event = fn(draft);
            if (event) {
                await this.appendServerEvent(draft, event);
                return;
            }
            await this.store.saveState(draft.state);
            this.commit(draft);
        });
    }

    /** Post the review's comments outside the queue, each outcome recorded inside it as it lands. */
    private startPosting(choices: Record<string, 'reanchor' | 'drop' | 'anyway'>): void {
        const host = this.host;
        if (!host) return;
        this.posting = postRound(
            {
                repoRoot: this.repoRoot,
                client: host.access.client,
                state: () => this.state,
                change: (fn) => this.change(fn),
                closed: () => this.closed
            },
            choices
        ).catch((error: unknown) => console.error(`planroom: posting ${this.changeId} failed`, error));
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

    /** Wait for any validation in flight and the activity log; tests use this to observe the result. */
    async settled(): Promise<void> {
        await this.posting;
        await this.queue;
        while (this.validations > 0) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            await this.queue;
        }
        await this.activityLog;
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

    /**
     * Swap in a draft's state and broadcast its patches, with the revision list and activity feed when they grew. The
     * feed's new entries are logged in the background.
     */
    private commit(draft: Draft, revision?: Revision): void {
        this.state = draft.state;
        const patches = draft.listPatches();
        if (revision) {
            this.revisions = [...this.revisions, revision];
            patches.push({ field: 'revisions', value: revisionMeta(this.revisions) });
        }
        if (draft.activity.length) {
            const entries = draft.activity.map((entry) => ({ ...entry, id: (this.activityId += 1) }));
            this.logActivity(entries);
            this.activity = [...entries.toReversed(), ...this.activity].slice(0, ACTIVITY_LIMIT);
            patches.push({ field: 'activity', value: this.activity });
        }
        this.broadcast(patches);
    }

    /** Append entries to the activity log after the earlier ones. A failed write costs only the feed, so it is reported, not thrown. */
    private logActivity(entries: readonly ActivityEntry[]): void {
        this.activityLog = this.activityLog
            .then(() => this.store.appendActivity(entries))
            .catch((error: unknown) => console.error(`planroom: could not log activity for ${this.changeId}`, error));
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
        if (this.state.kind === 'review') return { doing: REVIEW_WORK[reviewStage(this.state)] };
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
            validating: this.validations > 0,
            ...(this.preferences ? { preferences: this.preferences } : {}),
            ...(this.postable ? { postable: this.postable } : {})
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
        await this.posting;
        await this.activityLog;
        const worktree = this.worktreeDir;
        if (worktree)
            await removeWorktree(this.repoRoot, worktree).catch((error: unknown) =>
                console.error(`planroom: could not remove the worktree of ${this.changeId}`, error)
            );
        await releaseLock(this.store.lockFile);
        process.off('exit', this.exitHandler);
        this.listeners.clear();
    }
}
