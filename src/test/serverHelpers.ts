import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema, type Notification } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, vi } from 'vitest';
import type { BitbucketAccess, BitbucketClient, InlineAnchor, PullRequestComment, PullRequestInfo } from '../server/bitbucket.js';
import { RejectedError } from '../server/draft.js';
import { createPlanroom } from '../server/mcp.js';
import type { OpenSpecRunner } from '../server/openspec.js';
import type { ReviewHost } from '../server/review.js';
import { Session } from '../server/session.js';
import { git } from '../server/worktree.js';
import type { AgentEvent } from '../shared/events.js';
import type { SectionItem, ValidationRecord } from '../shared/records.js';
import type { PlanFormat, SessionKind } from '../shared/state.js';
import { questionContent } from './fixtures.js';

export const CHANGE = 'add-api-rate-limiting';

export type Outcome = Pick<ValidationRecord, 'passed' | 'issues' | 'output'>;

/** An OpenSpec CLI stand-in: `newChange` scaffolds the folder, `validate` returns `outcome`. */
export interface FakeCli extends OpenSpecRunner {
    outcome: Outcome;
    created: string[];
    validations: string[];
    /** Whether each validation ran strictly, in order. */
    strict: boolean[];
    /** Hold every validation until the returned function is called, to act while one is running. */
    hold(): () => void;
}

export function fakeCli(repoRoot: string, outcome: Outcome = { passed: true, issues: [] }): FakeCli {
    let gate = Promise.resolve();
    const cli: FakeCli = {
        outcome,
        created: [],
        validations: [],
        strict: [],
        hold() {
            let release: () => void = () => undefined;
            gate = new Promise((resolve) => (release = resolve));
            return release;
        },
        async newChange(changeId) {
            cli.created.push(changeId);
            await mkdir(join(repoRoot, 'openspec', 'changes', changeId), { recursive: true });
            await writeFile(join(repoRoot, 'openspec', 'changes', changeId, '.openspec.yaml'), 'schema: spec-driven\n');
        },
        async validate(changeId, strict) {
            cli.validations.push(changeId);
            cli.strict.push(strict);
            await gate;
            return cli.outcome;
        }
    };
    return cli;
}

/** A controllable clock, so "working" windows and timestamps are deterministic. */
export function testClock(start = Date.parse('2026-09-29T00:00:00.000Z')): { now: () => Date; advance: (ms: number) => void } {
    let current = start;
    return { now: () => new Date(current), advance: (ms) => (current += ms) };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (let cleanup = cleanups.pop(); cleanup; cleanup = cleanups.pop()) await cleanup();
});

/** Run `fn` after the current test. */
export function onCleanup(fn: () => Promise<void>): void {
    cleanups.push(fn);
}

/** A throwaway repo root with an `openspec/changes/` folder, removed after the test. */
export async function tempRepo(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'planroom-'));
    await mkdir(join(dir, 'openspec', 'changes'), { recursive: true });
    onCleanup(() => rm(dir, { recursive: true, force: true }));
    return dir;
}

/** A throwaway git repo for review tests: commit files on branches, and read them back. */
export interface GitRepo {
    dir: string;
    run(args: string[]): Promise<string>;
    /** Write `files` (a null content deletes one), commit them, and return the commit's hash. */
    commit(files: Record<string, string | null>, message?: string): Promise<string>;
}

/** A git repo on `main` with one commit, removed after the test. */
export async function gitRepo(): Promise<GitRepo> {
    const dir = await tempRepo();
    const run = (args: string[]) => git(dir, ['-c', 'user.email=dev@example.com', '-c', 'user.name=Dev', ...args]);
    await run(['init', '--quiet', '-b', 'main']);
    const repo: GitRepo = {
        dir,
        run,
        async commit(files, message = 'change') {
            for (const [path, content] of Object.entries(files)) {
                if (content === null) await rm(join(dir, path));
                else {
                    await mkdir(join(dir, path, '..'), { recursive: true });
                    await writeFile(join(dir, path), content);
                }
            }
            await run(['add', '-A']);
            await run(['commit', '--quiet', '--allow-empty', '-m', message]);
            return (await run(['rev-parse', 'HEAD'])).trim();
        }
    };
    await repo.commit({ 'README.md': 'hello\n' }, 'initial');
    return repo;
}

export interface Harness {
    repo: string;
    cli: FakeCli;
    clock: ReturnType<typeof testClock>;
    session: Session;
    /** Reopen the change in a new Session, as a new agent session would, after closing this one. */
    reopen(): Promise<Session>;
}

/** Open a session on a fresh repo, closed after the test. */
export async function harness(options: { changeId?: string; outcome?: Outcome; format?: PlanFormat } = {}): Promise<Harness> {
    const repo = await tempRepo();
    const cli = fakeCli(repo, options.outcome);
    const clock = testClock();
    const changeId = options.changeId ?? CHANGE;
    const open = async () => {
        const { session } = await Session.open({
            repoRoot: repo,
            changeId,
            cli,
            now: clock.now,
            ...(options.format ? { format: options.format } : {})
        });
        onCleanup(() => session.close());
        return session;
    };
    const h: Harness = {
        repo,
        cli,
        clock,
        session: await open(),
        async reopen() {
            await h.session.close();
            h.session = await open();
            return h.session;
        }
    };
    return h;
}

/** `question.upsert` for a single-choice question. */
export function upsert(id: string, overrides: Parameters<typeof questionContent>[1] = {}): AgentEvent {
    return { type: 'question.upsert', question: questionContent(id, overrides) };
}

export function textBlock(id: string, body: string): AgentEvent {
    return { type: 'doc.block.upsert', block: { id, type: 'text', config: { body } } };
}

export function section(id: string, order: number, blocks: SectionItem[], title = `Section ${id}`): AgentEvent {
    return { type: 'doc.section.upsert', section: { id, title, order, blocks } };
}

/** The RejectedError a promise rejects with; fails the test if it resolves or throws something else. */
export async function rejection(promise: Promise<unknown>): Promise<RejectedError> {
    try {
        await promise;
    } catch (error) {
        if (error instanceof RejectedError) return error;
        throw error;
    }
    throw new Error('expected the operation to be rejected');
}

/** `value`, failing the test naming `what` when it is null or undefined. */
export function defined<T>(value: T, what = 'value'): NonNullable<T> {
    if (value === null || value === undefined) throw new Error(`expected ${what} to be defined`);
    return value;
}

/** Wait until `check` passes, polling; for watcher-driven updates. */
export async function eventually(check: () => void | Promise<void>, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            await check();
            return;
        } catch (error) {
            if (Date.now() > deadline) throw error;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
    }
}

/** A Bitbucket stand-in that records every call; `fail` makes the nth comment creation (from 1) throw. */
export interface FakeBitbucket extends BitbucketClient {
    pr: PullRequestInfo;
    thread: PullRequestComment[];
    created: { id: number; body: string; inline?: InlineAnchor; parent?: number; pending: boolean }[];
    tasks: { id: number; comment: number; body: string; pending: boolean }[];
    resolvedComments: number[];
    resolvedTasks: number[];
    calls: string[];
    fail?: (attempt: number) => Error | undefined;
}

export function fakeBitbucket(pr: Partial<PullRequestInfo> = {}): FakeBitbucket {
    let next = 100;
    let attempts = 0;
    const fake: FakeBitbucket = {
        pr: {
            title: 'Cap retries',
            description: 'Caps the retry policy at two attempts.',
            author: 'Ana',
            link: 'https://bitbucket.org/acme/api/pull-requests/412',
            source: { branch: 'feature/retry-policy', commit: '', repo: 'acme/api' },
            destination: { branch: 'main', commit: '' },
            ...pr
        },
        thread: [],
        created: [],
        tasks: [],
        resolvedComments: [],
        resolvedTasks: [],
        calls: [],
        async pullRequest(ref) {
            fake.calls.push(`pullRequest ${ref.workspace}/${ref.repo}#${ref.number}`);
            return fake.pr;
        },
        async comments() {
            fake.calls.push('comments');
            return fake.thread;
        },
        async createComment(_ref, comment) {
            fake.calls.push('createComment');
            attempts += 1;
            const failure = fake.fail?.(attempts);
            if (failure) throw failure;
            next += 1;
            fake.created.push({ id: next, ...comment });
            return next;
        },
        async createTask(_ref, task) {
            fake.calls.push('createTask');
            next += 1;
            fake.tasks.push({ id: next, ...task });
            return next;
        },
        async resolveComment(_ref, id) {
            fake.calls.push('resolveComment');
            fake.resolvedComments.push(id);
        },
        async resolveTask(_ref, id) {
            fake.calls.push('resolveTask');
            fake.resolvedTasks.push(id);
        }
    };
    return fake;
}

/** A review host over `client`, ready to post unless `problem` says what is missing. */
export function reviewHostWith(client: BitbucketClient, preferencesFile: string, problem?: string): ReviewHost {
    const access: BitbucketAccess = problem ? { client, ready: false, problem } : { client, ready: true };
    return { access, preferencesFile };
}

/** A Planroom MCP server, by default the planning server, connected to an in-memory client. */
export async function connect(
    options: {
        kind?: SessionKind;
        opened?: boolean;
        cli?: (repo: string) => OpenSpecRunner;
        registryFile?: string;
        /** The repo to serve, instead of a fresh one. */
        repoRoot?: string;
        reviewHost?: ReviewHost;
    } = {}
) {
    const repo = options.repoRoot ?? (await tempRepo());
    const { reviewHost } = options;
    const uiDir = await tempRepo();
    await writeFile(join(uiDir, 'index.html'), '<!doctype html><title>Planroom</title>');
    const cli = options.cli?.(repo) ?? fakeCli(repo);
    const openBrowser = vi.fn(async () => options.opened ?? true);
    const planroom = createPlanroom({
        kind: options.kind ?? 'plan',
        version: '0.0.0-test',
        repoRoot: repo,
        uiDir,
        cli,
        openBrowser,
        ...(options.registryFile ? { registryFile: options.registryFile } : {}),
        ...(reviewHost ? { reviewHost: async () => reviewHost } : {})
    });
    const client = new Client({ name: 'test', version: '0' });
    const notifications: Notification[] = [];
    client.fallbackNotificationHandler = async (notification) => void notifications.push(notification);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([planroom.server.connect(serverSide), client.connect(clientSide)]);
    onCleanup(async () => {
        await client.close();
        await planroom.close();
    });
    const call = async (name: string, args: Record<string, unknown> = {}) => {
        const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
        const [first] = result.content;
        if (first?.type !== 'text') throw new Error(`${name} returned no text`);
        return { isError: result.isError ?? false, body: JSON.parse(first.text) };
    };
    return { repo, uiDir, cli, planroom, client, call, openBrowser, notifications };
}
