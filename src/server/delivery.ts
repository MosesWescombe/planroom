import type { LoggedEvent, LoggedEventType } from '../shared/events.js';
import type { AgentStatus } from '../shared/view.js';

/** Pushes one event into the agent session as a `notifications/claude/channel` message. */
export type ChannelNotifier = (event: LoggedEvent) => Promise<void>;

export interface WaitResult {
    events: LoggedEvent[];
    timedOut: boolean;
    /** True when more events exist after the last one returned; wait again right away. */
    more: boolean;
}

interface Waiter {
    after: number;
    resolve: (result: WaitResult) => void;
    timer: NodeJS.Timeout;
}

/**
 * How long after its last tool call, with no wait parked, the agent counts as working rather than away. Long enough
 * for a reasoning model to think between calls; an agent that left shows as working for up to this long.
 */
const WORKING_MS = 120_000;
/** The same window while the agent says its subagents are running: it makes no tool calls while it waits on them. */
const SUBAGENTS_WORKING_MS = 30 * 60_000;
/** The most events one wait returns. */
const PAGE_SIZE = 50;
/**
 * Events the agent only notes, so they never wake it on their own: a wait returns them with the next event that does,
 * or when it times out, and a push sends them just ahead of that event.
 */
const QUIET: ReadonlySet<LoggedEventType> = new Set<LoggedEventType>(['checklist.tick', 'assumption.confirm']);

/**
 * The page event log as the agent consumes it: read by cursor, so delivery is
 * at-least-once and the agent de-duplicates by `seq`.
 *
 * Delivery rule, per event: if a wait is parked, resolve it; otherwise push it
 * through the channel. A push is only known to have arrived once the agent reads
 * with a cursor at or past it, which confirms the channel for this connection.
 * Quiet events wait for the next event that is not quiet.
 */
export class EventDelivery {
    private readonly waiters = new Set<Waiter>();
    private readonly pushed = new Set<number>();
    /** Quiet events not yet handed to the agent, pushed ahead of the next event that wakes it. */
    private held: LoggedEvent[] = [];
    private notifier: ChannelNotifier | undefined;
    private confirmed = false;
    /** The highest seq known to have reached the agent. */
    private delivered = 0;
    private lastContact = 0;
    private workingMs = WORKING_MS;
    private contactTimer: NodeJS.Timeout | undefined;
    private readonly listeners = new Set<() => void>();

    /** Resume over the persisted log from the agent's last read cursor. `clock` is injectable for tests. */
    constructor(
        private readonly events: LoggedEvent[],
        /** The highest cursor the agent has read from. */
        private cursor: number,
        private readonly clock: () => number = Date.now
    ) {
        this.delivered = cursor;
    }

    /** The highest cursor the agent has read from. */
    get agentCursor(): number {
        return this.cursor;
    }

    /** The seq of the newest logged event, 0 while the log is empty. */
    get lastSeq(): number {
        return this.events[this.events.length - 1]?.seq ?? 0;
    }

    /** Events after `cursor`, oldest first. */
    after(cursor: number, limit = PAGE_SIZE): LoggedEvent[] {
        const start = this.events.findIndex((event) => event.seq > cursor);
        return start === -1 ? [] : this.events.slice(start, start + limit);
    }

    /** Attach or detach the channel push. Detaching forgets that the channel was confirmed. */
    setNotifier(notifier: ChannelNotifier | undefined): void {
        this.notifier = notifier;
        if (!notifier) this.confirmed = false;
        this.changed();
    }

    /** Called whenever the agent makes a tool call, so the page can show it as working. */
    touch(): void {
        this.contact();
        this.changed();
    }

    /** Start the working window. */
    private contact(): void {
        this.lastContact = this.clock();
        this.scheduleLapse();
    }

    /** Tell the page when the working window lapses, since nothing else changes then. */
    private scheduleLapse(): void {
        clearTimeout(this.contactTimer);
        this.contactTimer = setTimeout(() => this.changed(), Math.max(0, this.lastContact + this.workingMs - this.clock()));
        this.contactTimer.unref();
    }

    /** Hold the working window open for longer while the agent's subagents run. The caller tells the page. */
    setSubagentsRunning(running: boolean): void {
        this.workingMs = running ? SUBAGENTS_WORKING_MS : WORKING_MS;
        this.scheduleLapse();
    }

    /**
     * Record that the agent has read up to `cursor`; confirms the channel if it passes a
     * pushed seq that no wait returned, since then only the push can have told the agent.
     */
    acknowledge(cursor: number): void {
        this.cursor = Math.max(this.cursor, Math.min(cursor, this.lastSeq));
        const passed = [...this.pushed].filter((seq) => seq <= cursor);
        if (passed.length) {
            this.confirmed = true;
            passed.forEach((seq) => this.pushed.delete(seq));
        }
        this.delivered = Math.max(this.delivered, this.cursor);
        this.changed();
    }

    /**
     * Hand a newly persisted event to the agent: through a parked wait if there is one, by push otherwise. A quiet
     * event is held for the next one that is not.
     */
    publish(event: LoggedEvent): void {
        this.events.push(event);
        if (QUIET.has(event.type)) {
            this.held.push(event);
        } else if (this.waiters.size) {
            for (const waiter of [...this.waiters]) this.settle(waiter, false);
        } else if (this.notifier) {
            // Held events go first: the agent passes the highest seq it handled as its next cursor.
            for (const next of [...this.held.splice(0), event]) this.push(this.notifier, next);
        }
        this.changed();
    }

    /** Push one event through the channel. */
    private push(notifier: ChannelNotifier, event: LoggedEvent): void {
        this.pushed.add(event.seq);
        if (this.confirmed) this.delivered = Math.max(this.delivered, event.seq);
        notifier(event).catch(() => this.pushed.delete(event.seq));
    }

    /**
     * Return events after `after` at once if any of them is not quiet, otherwise park until
     * one is published or `timeoutMs` passes. An aborted wait returns what it has.
     */
    wait(after: number, timeoutMs: number, signal?: AbortSignal): Promise<WaitResult> {
        this.touch();
        this.acknowledge(after);
        const ready = this.after(after);
        if (this.events.some((event) => event.seq > after && !QUIET.has(event.type))) {
            this.handOver(ready);
            this.changed();
            return Promise.resolve({
                events: ready,
                timedOut: false,
                more: this.after(ready[ready.length - 1]!.seq, 1).length > 0
            });
        }
        return new Promise((resolve) => {
            const waiter: Waiter = { after, resolve, timer: setTimeout(() => this.settle(waiter, true), timeoutMs) };
            this.waiters.add(waiter);
            signal?.addEventListener('abort', () => this.settle(waiter, true), { once: true });
            this.changed();
        });
    }

    /** Resolve a parked wait, once, with the events after its cursor. It reports a timeout only when it returns nothing. */
    private settle(waiter: Waiter, timedOut: boolean): void {
        if (!this.waiters.delete(waiter)) return;
        clearTimeout(waiter.timer);
        const events = this.after(waiter.after);
        const last = events[events.length - 1];
        this.handOver(events);
        this.contact();
        waiter.resolve({
            events,
            timedOut: timedOut && events.length === 0,
            more: last ? this.after(last.seq, 1).length > 0 : false
        });
        this.changed();
    }

    /** Mark events a wait returned as delivered; a wait delivering a pushed event proves nothing about the channel. */
    private handOver(events: readonly LoggedEvent[]): void {
        for (const event of events) this.pushed.delete(event.seq);
        const last = events[events.length - 1];
        if (!last) return;
        this.delivered = Math.max(this.delivered, last.seq);
        this.held = this.held.filter((event) => event.seq > last.seq);
    }

    /** Whether a wait is parked right now. */
    get waiting(): boolean {
        return this.waiters.size > 0;
    }

    /**
     * The agent's delivery state for the page: how it is reached, how many events it has yet to receive, and whether it
     * is working.
     */
    status(): Pick<AgentStatus, 'mode' | 'queued'> & { working: boolean } {
        const queued = this.events.filter((event) => event.seq > this.delivered).length;
        const working = !this.waiters.size && this.clock() - this.lastContact < this.workingMs;
        const mode = this.waiters.size ? 'waiting' : this.confirmed ? 'push' : 'offline';
        return { mode, queued, working };
    }

    /** Listen for any change to the delivery status. Returns the unsubscribe. */
    onChange(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** Tell every listener the status may have changed. */
    private changed(): void {
        for (const listener of this.listeners) listener();
    }

    /** Resolve every parked wait, e.g. when the session closes. */
    close(): void {
        for (const waiter of [...this.waiters]) this.settle(waiter, true);
        clearTimeout(this.contactTimer);
    }
}
