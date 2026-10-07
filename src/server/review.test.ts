import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../shared/events.js';
import type { SectionItem } from '../shared/records.js';
import { currentRound, deriveComments, reviewStage, shownSlides } from '../shared/review.js';
import { connect, defined, fakeBitbucket, gitRepo, rejection, reviewHostWith, tempRepo } from '../test/serverHelpers.js';
import { httpBitbucket } from './bitbucket.js';
import { git } from './worktree.js';

const retry = (attempts: number) => `export function retry() {\n    return ${attempts};\n}\n`;

/** A repo whose `feature/retry-policy` branch caps the retries and adds a file, with main checked out. */
async function branchRepo() {
    const repo = await gitRepo();
    await repo.commit({ 'src/retry.ts': retry(3), 'src/api.ts': 'export const api = 1;\n' }, 'base');
    await repo.run(['checkout', '--quiet', '-b', 'feature/retry-policy']);
    const head = await repo.commit({ 'src/retry.ts': retry(2), 'src/policy.ts': 'export const max = 2;\n' }, 'cap retries');
    await repo.run(['checkout', '--quiet', 'main']);
    return { repo, head };
}

function slide(id: string, chapter: 'why' | 'how' | 'touches' | 'tradeoffs', blocks: SectionItem[]): AgentEvent {
    return { type: 'slide.upsert', slide: { id, chapter, order: 1, title: `Slide ${id}`, blocks } };
}

/** An impact map of two areas, the first explained by block `explained`, for a What it might impact slide. */
function impactMap(id: string, explained?: string): AgentEvent {
    return {
        type: 'doc.block.upsert',
        block: {
            id,
            type: 'impactMap',
            config: {
                areas: [
                    {
                        id: 'billing',
                        title: 'Billing exports',
                        summary: 'The export reads the retry count.',
                        blocks: explained ? [explained] : []
                    },
                    { id: 'alerts', title: 'On-call alerts', summary: 'The timeout alert fires sooner.' }
                ]
            }
        }
    };
}

/** A deck with a slide per chapter, a flow to pin findings to, a predict card and an impact map. */
const DECK: AgentEvent[] = [
    { type: 'doc.block.upsert', block: { id: 'why-text', type: 'text', config: { body: 'Retries ran without a cap.' } } },
    {
        type: 'doc.block.upsert',
        block: {
            id: 'how-flow',
            type: 'flow',
            config: {
                nodes: [
                    { id: 'client', label: 'Client' },
                    { id: 'retry', label: 'Retry' }
                ],
                edges: [{ from: 'client', to: 'retry' }]
            }
        }
    },
    {
        type: 'doc.block.upsert',
        block: {
            id: 'take-1',
            type: 'yourTake',
            config: {
                kind: 'predict',
                prompt: 'How many retries now?',
                options: ['One', 'Two'],
                answer: 'Two',
                explanation: 'Capped at two.'
            }
        }
    },
    {
        type: 'doc.block.upsert',
        block: { id: 'touch-files', type: 'fileTree', config: { files: [{ path: 'src/retry.ts', change: 'modified' }] } }
    },
    { type: 'doc.block.upsert', block: { id: 'trade-text', type: 'text', config: { body: 'Fewer retries fail faster.' } } },
    { type: 'doc.block.upsert', block: { id: 'billing-text', type: 'text', config: { body: 'The export retries too.' } } },
    impactMap('impact-map', 'billing-text'),
    slide('why', 'why', ['why-text']),
    slide('how', 'how', ['how-flow', 'take-1']),
    slide('touches', 'touches', ['touch-files', 'impact-map']),
    slide('tradeoffs', 'tradeoffs', ['trade-text'])
];

type Emit = (events: AgentEvent[]) => Promise<{ isError?: boolean }>;
type Page = (request: Record<string, unknown>) => Promise<unknown>;

/** With the deck's first part out: send the reviewer's concerns, publish Trade-offs and finish the walkthrough. */
async function finishWalkthrough(emit: Emit, page: Page) {
    await page({ type: 'impact.send' });
    expect((await emit([{ type: 'deck.publish' }])).isError).toBe(false);
    await page({ type: 'walkthrough.done', how: 'finished' });
}

/** A blocker on the retry line, pinned to the flow's retry node. */
function issue(id = 'I-1', start = 2): AgentEvent {
    return {
        type: 'item.upsert',
        item: {
            id,
            kind: 'issue',
            title: 'Two retries can outlast the caller timeout',
            body: 'Two retries at 100 ms each can take longer than the caller waits.',
            dimension: 'correctness',
            confidence: 0.8,
            anchor: { file: 'src/retry.ts', side: 'new', start, end: start },
            diagram: { block: 'how-flow', node: 'retry' },
            severity: 'blocker',
            evidence: 'The caller times out at 150 ms.',
            suggestion: 'Retry once.',
            likelihood: 2,
            impact: 3,
            draft: 'Can two retries outlast the caller timeout?\n\n```ts\nreturn 1;\n```'
        }
    };
}

/** A review server over `repoRoot`, its fake Bitbucket and its preferences file. */
async function reviewServer(repoRoot: string, options: { problem?: string; prefs?: string } = {}) {
    const fake = fakeBitbucket();
    const prefs = options.prefs ?? join(await tempRepo(), 'planroom', 'review.json');
    const server = await connect({ kind: 'review', repoRoot, reviewHost: reviewHostWith(fake, prefs, options.problem) });
    const emit = (events: AgentEvent[]) => server.call('planroom_emit', { events });
    const session = () => defined(server.planroom.session, 'the review session');
    const page = (request: Record<string, unknown>) => session().handlePage(request);
    return { ...server, fake, prefs, emit, session, page };
}

/** A local-branch review, opened. */
async function branchReview(options: { prefs?: string } = {}) {
    const { repo, head } = await branchRepo();
    const server = await reviewServer(repo.dir, options);
    const opened = await server.call('planroom_review', { target: 'feature/retry-policy' });
    return { ...server, repo, head, opened };
}

/** A repo cloned from a stand-in for `acme/api` on Bitbucket, whose PR 412 is `feature/retry-policy` into main. */
async function prRepo() {
    const remote = await branchRepo();
    const dir = join(await tempRepo(), 'clone');
    await git(remote.repo.dir, ['clone', '--quiet', remote.repo.dir, dir]);
    // origin names Bitbucket; git fetches from the stand-in instead.
    await git(dir, ['config', 'remote.origin.url', 'git@bitbucket.org:acme/api.git']);
    await git(dir, ['config', `url.${remote.repo.dir}.insteadOf`, 'git@bitbucket.org:acme/api.git']);
    const main = (await remote.repo.run(['rev-parse', 'main'])).trim();
    return { remote, dir, head: remote.head, main };
}

/** A PR review, opened from a clone, with the fake PR pointing at the branch's head. */
async function prReview(options: { problem?: string } = {}) {
    const setup = await prRepo();
    const server = await reviewServer(setup.dir, options);
    server.fake.pr.source.commit = setup.head.slice(0, 12);
    server.fake.pr.destination.commit = setup.main.slice(0, 12);
    const opened = await server.call('planroom_review', { target: 'https://bitbucket.org/acme/api/pull-requests/412' });
    return { ...server, ...setup, opened };
}

/** Publish the deck, finish the walkthrough and react to one blocker, so the round is ready to preview. */
async function triaged(
    server: Pick<Awaited<ReturnType<typeof reviewServer>>, 'emit' | 'page'>,
    verdict: Record<string, unknown> = { verdict: 'agree' }
) {
    expect((await server.emit([...DECK, issue(), { type: 'deck.publish' }])).isError).toBe(false);
    await finishWalkthrough(server.emit, server.page);
    await server.page({ type: 'item.react', itemId: 'I-1', ...verdict });
    await server.page({ type: 'comments.open' });
}

describe('opening a review', () => {
    it('reviews a local branch against its merge base, from a worktree, with no network call', async () => {
        const { opened, repo, head, fake, session } = await branchReview();
        expect(opened.isError).toBe(false);
        expect(opened.body).toMatchObject({
            reviewId: 'branch-feature-retry-policy',
            resumed: false,
            stage: 'building',
            round: 1,
            target: { kind: 'branch', branch: 'feature/retry-policy', base: 'main' },
            diff: { head },
            stats: { files: 2, additions: 2, deletions: 1 },
            preferences: { density: 'normal', takes: { predict: true } }
        });
        expect(opened.body.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
        expect(fake.calls).toEqual([]);
        const worktree = join(repo.dir, '.planroom', 'reviews', 'branch-feature-retry-policy', 'worktree');
        expect(opened.body.worktree).toBe(worktree);
        expect(await readFile(join(worktree, 'src/retry.ts'), 'utf8')).toBe(retry(2));
        expect(await readFile(join(repo.dir, 'src/retry.ts'), 'utf8')).toBe(retry(3));
        expect(await repo.run(['status', '--porcelain'])).toBe('');
        expect(session().current.kind).toBe('review');
    });

    it('reviews a PR by its link: fetches it, checks out its head and needs no openspec/', async () => {
        const { opened, fake, dir, head } = await prReview();
        expect(opened.isError).toBe(false);
        expect(opened.body).toMatchObject({
            reviewId: 'pr-412',
            target: { kind: 'pr', workspace: 'acme', repo: 'api', number: 412 },
            pr: { title: 'Cap retries', author: 'Ana', link: 'https://bitbucket.org/acme/api/pull-requests/412' },
            diff: { head }
        });
        expect(fake.calls).toEqual(['pullRequest acme/api#412']);
        expect((await git(join(dir, '.planroom/reviews/pr-412/worktree'), ['rev-parse', 'HEAD'])).trim()).toBe(head);
    });

    it('reviews a bare PR number of the origin repo', async () => {
        const setup = await prRepo();
        const server = await reviewServer(setup.dir);
        server.fake.pr.source.commit = setup.head;
        server.fake.pr.destination.commit = setup.main;
        const { isError, body } = await server.call('planroom_review', { target: '412' });
        expect(isError).toBe(false);
        expect(body.reviewId).toBe('pr-412');
    });

    it('refuses a PR number with no origin remote, creating nothing', async () => {
        const { repo } = await branchRepo();
        const server = await reviewServer(repo.dir);
        const { isError, body } = await server.call('planroom_review', { target: '412' });
        expect(isError).toBe(true);
        expect(JSON.stringify(body)).toMatch(/could not determine the workspace and repo/i);
        expect(existsSync(join(repo.dir, '.planroom', 'reviews'))).toBe(false);
    });

    it('resumes as it was left, and removes the worktree when the review closes', async () => {
        const first = await branchReview();
        await first.emit(DECK);
        const worktree = defined(first.opened.body.worktree);
        await first.planroom.close();
        expect(existsSync(worktree)).toBe(false);
        expect(await first.repo.run(['worktree', 'list'])).not.toContain(worktree);

        const again = await reviewServer(first.repo.dir);
        const { body } = await again.call('planroom_review', { target: 'feature/retry-policy' });
        expect(body).toMatchObject({ resumed: true, stage: 'building' });
        expect(Object.keys(again.session().current.slides).sort()).toEqual(['how', 'touches', 'tradeoffs', 'why']);
        expect(existsSync(worktree)).toBe(true);
    });
});

describe('the deck', () => {
    it('publishes the deck in two parts, Trade-offs after the concerns, and fixes each part once it is out', async () => {
        const { emit, page, session } = await branchReview();
        const round = () => currentRound(defined(session().current.review));
        const chapters = () => shownSlides(session().current, round()).map((shown) => shown.chapter);
        await emit(DECK);
        expect(reviewStage(session().current)).toBe('building');
        expect(round().publishedAt).toBeUndefined();

        expect((await emit([{ type: 'deck.publish' }])).isError).toBe(false);
        expect(reviewStage(session().current)).toBe('walkthrough');
        expect(chapters()).toEqual(['why', 'how', 'touches']);

        const again = await emit([slide('why', 'why', ['why-text', 'trade-text'])]);
        expect(again).toMatchObject({ isError: true, body: { issues: [{ path: 'events[0].slide.chapter' }] } });
        for (const id of ['why-text', 'billing-text']) {
            const edit = await emit([{ type: 'doc.block.upsert', block: { id, type: 'text', config: { body: 'Changed' } } }]);
            expect(edit).toMatchObject({ isError: true, body: { issues: [{ path: 'events[0].block.id' }] } });
        }
        const early = await emit([{ type: 'deck.publish' }]);
        expect(early.body.issues[0].message).toMatch(/waits for the reviewer/);
        const more = await emit([
            { type: 'doc.block.upsert', block: { id: 'trade-more', type: 'text', config: { body: 'The export retries.' } } },
            slide('tradeoffs', 'tradeoffs', ['trade-text', 'trade-more'])
        ]);
        expect(more.isError).toBe(false);

        await page({ type: 'impact.send' });
        expect((await emit([{ type: 'deck.publish' }])).isError).toBe(false);
        expect(chapters()).toEqual(['why', 'how', 'touches', 'tradeoffs']);
        const late = await emit([slide('tradeoffs', 'tradeoffs', ['trade-text'])]);
        expect(late).toMatchObject({ isError: true, body: { issues: [{ path: 'events[0].type' }] } });
        expect(session().current.blocks['why-text']?.config).toEqual({ body: 'Retries ran without a cap.' });
    });

    it('refuses to publish while a chapter before Trade-offs has no slide', async () => {
        const { emit } = await branchReview();
        const deck = DECK.filter((event) => event.type !== 'slide.upsert' || event.slide.chapter !== 'touches');
        const { isError, body } = await emit([...deck, { type: 'deck.publish' }]);
        expect(isError).toBe(true);
        expect(body.issues[0].message).toMatch(/What it might impact has none/);
    });

    it('refuses the first part without an impact map, or with one naming a block never sent', async () => {
        const { emit } = await branchReview();
        const bare = DECK.map((event) =>
            event.type === 'slide.upsert' && event.slide.chapter === 'touches'
                ? slide('touches', 'touches', ['touch-files'])
                : event
        );
        expect((await emit([...bare, { type: 'deck.publish' }])).body.issues[0].message).toMatch(/needs one valid impactMap/);
        const ghost = DECK.map((event) =>
            event.type === 'doc.block.upsert' && event.block.id === 'impact-map' ? impactMap('impact-map', 'ghost') : event
        );
        expect((await emit([...ghost, { type: 'deck.publish' }])).body.issues[0].message).toMatch(
            /block "ghost" for the billing area has not been sent/
        );
    });

    it("saves the reviewer's concerns, sends them to the agent once, and keeps Finish for after Trade-offs", async () => {
        const { emit, page, call } = await branchReview();
        await emit([...DECK, { type: 'deck.publish' }]);
        expect((await rejection(page({ type: 'impact.save', concerns: { search: ['Reindex?'] }, added: [] }))).message).toMatch(
            /no area "search"/
        );
        await page({
            type: 'impact.save',
            concerns: { billing: ['Does the export retry?'], alerts: [] },
            added: [{ title: 'Search', concerns: ['Does it reindex?'] }]
        });
        await page({ type: 'impact.send' });
        expect((await rejection(page({ type: 'impact.save', concerns: {}, added: [] }))).message).toMatch(/already sent/);
        expect((await rejection(page({ type: 'walkthrough.done', how: 'finished' }))).message).toMatch(/still being written/);
        const { body } = await call('planroom_wait', { after: 0, timeoutSec: 1 });
        expect(body.events).toEqual([
            expect.objectContaining({
                type: 'impact.send',
                round: 1,
                areas: [
                    { id: 'billing', title: 'Billing exports', concerns: ['Does the export retry?'] },
                    { id: 'alerts', title: 'On-call alerts', concerns: [] },
                    { title: 'Search', concerns: ['Does it reindex?'] }
                ]
            })
        ]);
    });

    it('refuses a slide listing a block that was never sent, naming the entry', async () => {
        const { emit } = await branchReview();
        const { body } = await emit([slide('why', 'why', ['why-text', ['ghost', 'why-text']])]);
        expect(body.issues.map((issue: { path: string }) => issue.path)).toEqual([
            'events[0].slide.blocks[0]',
            'events[0].slide.blocks[1][0]',
            'events[0].slide.blocks[1][1]'
        ]);
    });

    it('refuses a your-take card of a kind the reviewer turned off', async () => {
        const prefs = join(await tempRepo(), 'planroom', 'review.json');
        const first = await branchReview({ prefs });
        await first.page({
            type: 'preferences.set',
            preferences: {
                takes: { predict: false, prosCons: true, risk: true, check: true },
                density: 'normal',
                views: { pins: true, diff: true, charts: true, heatmap: true, matrix: true }
            }
        });
        const { isError, body } = await first.emit([DECK[2]!]);
        expect(isError).toBe(true);
        expect(body.issues[0]).toMatchObject({ path: 'events[0].block.type', message: expect.stringMatching(/predict/) });
    });
});

describe('the kind gate', () => {
    it.each(['plan', 'ask'] as const)(
        'a %s session refuses review events and review-only blocks, naming its kind',
        async (kind) => {
            const { call } = await connect({ kind });
            await call(
                kind === 'plan' ? 'planroom_open' : 'planroom_ask',
                kind === 'plan' ? { changeId: 'add-x' } : { askId: 'q' }
            );
            const publish = await call('planroom_emit', { events: [{ type: 'deck.publish' }] });
            expect(publish.body.issues[0].message).toMatch(
                new RegExp(`^an? ${kind} takes only .*deck.publish belongs to a review`)
            );
            const take = await call('planroom_emit', {
                events: [{ type: 'comment.reply', threadId: 'C-1', text: 'x', blocks: [{ type: 'html', config: {} }] }]
            });
            expect(take.body.issues).toContainEqual({
                path: 'events[0].blocks[0].type',
                message: `a html block belongs to a review; this is a${kind === 'ask' ? 'n ask' : ' plan'}`
            });
        }
    );

    it('a review refuses plan events and page requests', async () => {
        const { emit, page } = await branchReview();
        const { body } = await emit([{ type: 'proposal.ready' }]);
        expect(body.issues[0].message).toMatch(/^a review takes only .*proposal.ready belongs to a plan/);
        expect((await rejection(page({ type: 'phase.complete', path: 'finished' }))).message).toBe(
            'type: A review has no phase.complete'
        );
    });
});

describe('findings', () => {
    it('refuses an anchor outside the diff and a pin on a node the diagram lacks', async () => {
        const { emit } = await branchReview();
        await emit(DECK);
        const outside = await emit([
            { type: 'item.upsert', item: { ...issueItem(), anchor: { file: 'src/api.ts', side: 'new', start: 1 } } }
        ]);
        expect(outside.body.issues[0]).toMatchObject({ path: 'events[0].item.anchor.file' });
        const pin = await emit([
            { type: 'item.upsert', item: { ...issueItem(), diagram: { block: 'how-flow', node: 'cache' } } }
        ]);
        expect(pin.body.issues[0]).toMatchObject({
            path: 'events[0].item.diagram.node',
            message: 'diagram "how-flow" has no node "cache"'
        });
    });

    it("keeps a finding's context blocks and names any whose config fails", async () => {
        const { emit, session } = await branchReview();
        await emit(DECK);
        const code = { type: 'code', config: { mode: 'snippet', source: 'return 1;', lang: 'ts' } };
        const { body } = await emit([
            { type: 'item.upsert', item: { ...issueItem(), blocks: [code, { type: 'flow', config: { nodes: 'none' } }] } }
        ]);
        expect(body.blockProblems.map((problem: { block: string }) => problem.block)).toEqual(['I-1 blocks[1]']);
        expect(session().current.items['I-1']?.blocks?.[0]).toEqual(code);
    });

    it('hides reactions until the walkthrough is done, logs a skip, and sends a rejection with its reason', async () => {
        const { emit, page, call, session } = await branchReview();
        await emit([...DECK, issue(), { type: 'deck.publish' }]);
        expect((await rejection(page({ type: 'item.react', itemId: 'I-1', verdict: 'agree' }))).message).toMatch(
            /Finish or skip the walkthrough/
        );
        await page({ type: 'walkthrough.done', how: 'skipped' });
        await page({ type: 'item.react', itemId: 'I-1', verdict: 'reject', reason: 'handled in the caller' });
        const { body } = await call('planroom_wait', { after: 0, timeoutSec: 1 });
        expect(body.events.map((event: { type: string }) => event.type)).toEqual(['walkthrough.done', 'item.react']);
        expect(body.events[0]).toMatchObject({ how: 'skipped', round: 1 });
        expect(body.events[1]).toMatchObject({ verdict: 'reject', reason: 'handled in the caller' });
        expect(deriveComments(session().current, 1)).toEqual([]);
    });

    it('logs a take answer before the reveal, once', async () => {
        const { emit, page, call } = await branchReview();
        await emit(DECK);
        await rejection(page({ type: 'take.answer', blockId: 'take-1', answer: { kind: 'predict', guess: 'Two' } }));
        await emit([{ type: 'deck.publish' }]);
        await page({ type: 'take.answer', blockId: 'take-1', answer: { kind: 'predict', guess: 'Two' } });
        expect(
            (await rejection(page({ type: 'take.answer', blockId: 'take-1', answer: { kind: 'predict', guess: 'One' } }))).message
        ).toMatch(/already gave your take/);
        const { body } = await call('planroom_wait', { after: 0, timeoutSec: 1 });
        expect(body.events[0]).toMatchObject({ type: 'take.answer', kind: 'predict', summary: 'guessed "Two"' });
    });

    it('moves to the preview once every finding has a reaction, and back to triage when one changes', async () => {
        const { emit, page, session } = await branchReview();
        await emit([...DECK, issue(), issue('I-2', 3), { type: 'deck.publish' }]);
        await finishWalkthrough(emit, page);
        await page({ type: 'item.react', itemId: 'I-1', verdict: 'agree' });
        await page({ type: 'comments.open' });
        expect(reviewStage(session().current)).toBe('triage');
        await page({ type: 'item.react', itemId: 'I-2', verdict: 'agree' });
        await page({ type: 'comments.open' });
        expect(reviewStage(session().current)).toBe('preview');
        await page({ type: 'item.react', itemId: 'I-2', verdict: 'reject', reason: 'not worth it' });
        expect(reviewStage(session().current)).toBe('triage');
        expect(deriveComments(session().current, 1).map((comment) => comment.key)).toEqual(['item:I-1']);
    });
});

/** The issue's item content, to tweak one field. */
function issueItem() {
    const event = issue();
    if (event.type !== 'item.upsert') throw new Error('not an item');
    return event.item;
}

describe('posting', () => {
    it('posts drafts from the previewed bodies, the summary last, then tasks, and links to Bitbucket', async () => {
        const server = await prReview();
        await triaged(server);
        await server.page({
            type: 'note.save',
            anchor: { file: 'src/policy.ts', side: 'new', start: 1 },
            text: 'Name it maxRetries?'
        });
        await server.emit([{ type: 'summary.draft', text: 'Good change once the cap matches the timeout.' }]);
        await server.page({ type: 'comments.open' });
        const previewed = deriveComments(server.session().current, 1);

        await server.page({ type: 'comments.post' });
        await server.session().settled();

        expect(server.fake.created.map((comment) => comment.body)).toEqual(previewed.map((comment) => comment.body));
        expect(server.fake.created.every((comment) => comment.pending)).toBe(true);
        expect(server.fake.created.map((comment) => comment.inline)).toEqual([
            { path: 'src/policy.ts', to: 1 },
            { path: 'src/retry.ts', to: 2 },
            undefined
        ]);
        expect(server.fake.created[2]?.body).toBe('Good change once the cap matches the timeout.\n\n\\- Claude');
        expect(server.fake.tasks).toEqual([
            {
                id: expect.any(Number),
                comment: server.fake.created[1]?.id,
                body: 'Can two retries outlast the caller timeout?',
                pending: true
            }
        ]);
        // Opening read the PR, Post checked its head, then created the comments, the summary last, then the task.
        expect(server.fake.calls).toEqual([
            'pullRequest acme/api#412',
            'pullRequest acme/api#412',
            'createComment',
            'createComment',
            'createComment',
            'createTask'
        ]);
        const round = currentRound(defined(server.session().current.review));
        expect(round.postedAt).toBeDefined();
        expect(reviewStage(server.session().current)).toBe('posted');
    });

    it('records each id as it lands, lists a failure, and a retry sends only that one', async () => {
        const server = await prReview();
        await triaged(server);
        await server.page({ type: 'note.save', anchor: { file: 'src/policy.ts', start: 1 }, text: 'One' });
        await server.page({ type: 'note.save', anchor: { file: 'src/retry.ts', start: 1 }, text: 'Two' });
        server.fake.fail = (attempt) => (attempt === 2 ? new Error('Bitbucket answered 429: rate limited') : undefined);
        await server.page({ type: 'comments.post' });
        await server.session().settled();
        let round = currentRound(defined(server.session().current.review));
        expect(round.posting?.state).toBe('partial');
        expect(Object.values(round.posts).filter((post) => post.id !== undefined)).toHaveLength(2);
        const failed = Object.entries(round.posts).filter(([, post]) => post.error);
        expect(failed.map(([key]) => key)).toEqual(['note:N-2']);

        server.fake.fail = undefined;
        const before = server.fake.created.length;
        await server.page({ type: 'comments.post' });
        await server.session().settled();
        expect(server.fake.created.slice(before).map((comment) => comment.body)).toEqual(['Two']);
        round = currentRound(defined(server.session().current.review));
        expect(round.postedAt).toBeDefined();
    });

    it('stops when the head moved under a comment, then re-anchors, drops or posts each as the reviewer chose', async () => {
        const server = await prReview();
        await triaged(server);
        await server.page({ type: 'note.save', anchor: { file: 'src/retry.ts', start: 1 }, text: 'Export it as default?' });
        // The author adds a line above the function and changes the retry count.
        await server.remote.repo.run(['checkout', '--quiet', 'feature/retry-policy']);
        const pushed = await server.remote.repo.commit({ 'src/retry.ts': `// capped\n${retry(1)}` }, 'retry once');
        server.fake.pr.source.commit = pushed.slice(0, 12);
        await server.page({ type: 'comments.post' });
        await server.session().settled();
        let round = currentRound(defined(server.session().current.review));
        expect(round.posting).toMatchObject({ state: 'moved', moved: { head: pushed, keys: ['note:N-1', 'item:I-1'] } });
        expect(server.fake.created).toEqual([]);

        expect((await rejection(server.page({ type: 'comments.post' }))).message).toMatch(
            /Choose re-anchor, drop or post anyway/
        );
        await server.page({ type: 'comments.post', choices: { 'note:N-1': 'reanchor', 'item:I-1': 'drop' } });
        await server.session().settled();
        expect(server.fake.created.map(({ body, inline }) => ({ body, inline }))).toEqual([
            { body: 'Export it as default?', inline: { path: 'src/retry.ts', to: 2 } }
        ]);
        expect(server.fake.tasks).toEqual([]);
        round = currentRound(defined(server.session().current.review));
        expect(round.posts['item:I-1']).toMatchObject({ dropped: true });
        expect(round.postedAt).toBeDefined();
    });

    it('keeps Post off without credentials, and a local branch has nothing to post to', async () => {
        const missing = await prReview({ problem: 'Set BITBUCKET_API_TOKEN' });
        await triaged(missing);
        expect((await rejection(missing.page({ type: 'comments.post' }))).message).toBe('type: Set BITBUCKET_API_TOKEN');
        expect(missing.session().view().postable).toEqual({ ready: false, problem: 'Set BITBUCKET_API_TOKEN' });

        const branch = await branchReview();
        await triaged(branch);
        expect((await rejection(branch.page({ type: 'comments.post' }))).message).toMatch(/copy the comments as Markdown/);
        expect(branch.fake.calls).toEqual([]);
    });

    it('never lets the token reach the page, the agent, a log or the review folder', async () => {
        const SECRET = 'ATATT-not-a-real-token-5f1e';
        const setup = await prRepo();
        const requests: { url: string; auth: string | null }[] = [];
        const fetchStub: typeof fetch = async (input, init) => {
            const url = String(input);
            requests.push({ url, auth: new Headers(init?.headers).get('authorization') });
            if (url.endsWith('/pullrequests/412'))
                return Response.json({
                    title: 'Cap retries',
                    source: {
                        branch: { name: 'feature/retry-policy' },
                        commit: { hash: setup.head.slice(0, 12) },
                        repository: { full_name: 'acme/api' }
                    },
                    destination: { branch: { name: 'main' }, commit: { hash: setup.main.slice(0, 12) } }
                });
            return Response.json({ id: requests.length });
        };
        const client = httpBitbucket({ email: 'dev@example.com', token: SECRET }, { fetch: fetchStub });
        const logs = [vi.spyOn(console, 'error'), vi.spyOn(console, 'log'), vi.spyOn(console, 'warn')];
        const prefs = join(await tempRepo(), 'review.json');
        const server = await connect({ kind: 'review', repoRoot: setup.dir, reviewHost: reviewHostWith(client, prefs) });
        const opened = await server.call('planroom_review', { target: '412' });
        const session = defined(server.planroom.session);
        const emit = (events: AgentEvent[]) => server.call('planroom_emit', { events });
        await emit([...DECK, issue(), { type: 'deck.publish' }]);
        await finishWalkthrough(emit, (request) => session.handlePage(request));
        await session.handlePage({ type: 'item.react', itemId: 'I-1', verdict: 'agree' });
        await session.handlePage({ type: 'comments.open' });
        await session.handlePage({ type: 'comments.post' });
        await session.settled();
        const state = await server.call('planroom_state');

        expect(
            requests.every((request) => request.auth === `Basic ${Buffer.from(`dev@example.com:${SECRET}`).toString('base64')}`)
        ).toBe(true);
        const seen = [JSON.stringify(opened.body), JSON.stringify(state.body), JSON.stringify(session.view())];
        const folder = join(setup.dir, '.planroom', 'reviews', 'pr-412');
        for (const name of await readdir(folder, { recursive: true }))
            if (!String(name).startsWith('worktree'))
                seen.push(await readFile(join(folder, String(name)), 'utf8').catch(() => ''));
        for (const spy of logs) seen.push(JSON.stringify(spy.mock.calls));
        for (const text of seen) {
            expect(text).not.toContain(SECRET);
            expect(text).not.toContain(Buffer.from(`dev@example.com:${SECRET}`).toString('base64'));
        }
        expect(currentRound(defined(session.current.review)).postedAt).toBeDefined();
    });
});

describe('re-review rounds', () => {
    /** A PR review posted in round 1 with one inline comment, a task on it, and a note. */
    async function posted() {
        const server = await prReview();
        await triaged(server);
        await server.page({ type: 'note.save', anchor: { file: 'src/policy.ts', start: 1 }, text: 'Name it maxRetries?' });
        await server.page({ type: 'comments.post' });
        await server.session().settled();
        return server;
    }

    it('starts no round while the head has not moved', async () => {
        const server = await posted();
        const { body } = await server.call('planroom_review', { target: '412' });
        expect(body).toMatchObject({ round: 1, stage: 'posted' });
    });

    it('starts round 2 from the reviewed head, with the earlier comments, their replies, and outdated ones labelled', async () => {
        const server = await posted();
        const [policy, retryComment] = server.fake.created;
        server.fake.thread = [
            {
                id: 900,
                parent: retryComment!.id,
                author: 'Ana',
                text: 'fixed in 3f2a',
                at: '2026-10-01T00:00:00Z',
                deleted: false
            }
        ];
        const round1 = currentRound(defined(server.session().current.review));
        await server.remote.repo.run(['checkout', '--quiet', 'feature/retry-policy']);
        const pushed = await server.remote.repo.commit({ 'src/retry.ts': retry(1), 'src/policy.ts': null }, 'retry once');
        server.fake.pr.source.commit = pushed;

        const { body } = await server.call('planroom_review', { target: '412' });
        expect(body).toMatchObject({ round: 2, stage: 'next-round', diff: { base: round1.head, head: pushed } });
        const round = currentRound(defined(server.session().current.review));
        expect(round.files.map((file) => file.path)).toEqual(['src/policy.ts', 'src/retry.ts']);
        expect(round.earlier['1/item:I-1']).toMatchObject({
            post: { id: retryComment!.id },
            replies: [{ author: 'Ana', text: 'fixed in 3f2a' }]
        });
        expect(round.earlier['1/item:I-1']?.label).toBeUndefined();
        expect(round.earlier['1/note:N-1']).toMatchObject({ post: { id: policy!.id }, label: 'outdated' });
        expect((await git(defined(body.worktree), ['rev-parse', 'HEAD'])).trim()).toBe(pushed);
    });

    it('resolves an addressed thread and its task on Post only once the reviewer confirms it', async () => {
        const server = await posted();
        const retryComment = server.fake.created[1]!;
        const task = server.fake.tasks[0]!;
        await server.remote.repo.run(['checkout', '--quiet', 'feature/retry-policy']);
        const pushed = await server.remote.repo.commit({ 'src/retry.ts': retry(1) }, 'retry once');
        server.fake.pr.source.commit = pushed;
        await server.call('planroom_review', { target: '412' });
        await server.emit([
            { type: 'doc.block.upsert', block: { id: 'r2-text', type: 'text', config: { body: 'One retry now.' } } },
            { type: 'doc.block.upsert', block: { id: 'r2-how', type: 'text', config: { body: 'Same loop.' } } },
            { type: 'doc.block.upsert', block: { id: 'r2-files', type: 'text', config: { body: 'retry.ts' } } },
            { type: 'doc.block.upsert', block: { id: 'r2-trade', type: 'text', config: { body: 'Faster failure.' } } },
            impactMap('r2-map'),
            slide('r2-why', 'why', ['r2-text']),
            slide('r2-how', 'how', ['r2-how']),
            slide('r2-touches', 'touches', ['r2-files', 'r2-map']),
            slide('r2-tradeoffs', 'tradeoffs', ['r2-trade']),
            { type: 'deck.publish' },
            { type: 'earlier.label', key: '1/item:I-1', label: 'addressed', code: '-    return 2;\n+    return 1;' },
            { type: 'earlier.label', key: '1/note:N-1', label: 'not-addressed' },
            {
                type: 'item.upsert',
                item: {
                    id: 'F-1',
                    kind: 'followup',
                    title: 'Still unnamed',
                    body: 'The constant is still called max.',
                    confidence: 0.9,
                    replyTo: '1/note:N-1',
                    draft: 'Still `max`: rename it?'
                }
            }
        ]);
        await finishWalkthrough(server.emit, server.page);
        await server.page({ type: 'item.react', itemId: 'F-1', verdict: 'agree' });
        await server.page({ type: 'comments.open' });

        await server.page({ type: 'comments.post' });
        await server.session().settled();
        expect(server.fake.resolvedComments).toEqual([]);
        const reply = server.fake.created.at(-1)!;
        expect(reply).toMatchObject({ body: 'Still `max`: rename it?\n\n\\- Claude', parent: server.fake.created[0]!.id });

        // A confirmation after the round posted waits for the next Post; confirm in a fresh round instead.
        const fresh = await posted();
        const first = fresh.fake.created[1]!;
        await fresh.remote.repo.run(['checkout', '--quiet', 'feature/retry-policy']);
        fresh.fake.pr.source.commit = await fresh.remote.repo.commit({ 'src/retry.ts': retry(1) }, 'retry once');
        await fresh.call('planroom_review', { target: '412' });
        await fresh.emit([
            ...DECK.map((event) =>
                event.type === 'doc.block.upsert' ? { ...event, block: { ...event.block, id: `n-${event.block.id}` } } : event
            ).filter((event) => event.type === 'doc.block.upsert'),
            slide('n-why', 'why', ['n-why-text']),
            slide('n-how', 'how', ['n-how-flow']),
            slide('n-touches', 'touches', ['n-touch-files', 'n-impact-map']),
            slide('n-tradeoffs', 'tradeoffs', ['n-trade-text']),
            { type: 'deck.publish' },
            { type: 'earlier.label', key: '1/item:I-1', label: 'addressed' },
            { type: 'summary.draft', text: 'Thanks, all addressed.' }
        ]);
        await finishWalkthrough(fresh.emit, fresh.page);
        await fresh.page({ type: 'earlier.confirm', key: '1/item:I-1', confirmed: true });
        await fresh.page({ type: 'comments.open' });
        await fresh.page({ type: 'comments.post' });
        await fresh.session().settled();
        expect(fresh.fake.resolvedComments).toEqual([first.id]);
        expect(fresh.fake.resolvedTasks).toEqual([fresh.fake.tasks[0]!.id]);
        expect(currentRound(defined(fresh.session().current.review)).earlier['1/item:I-1']?.resolvedAt).toBeDefined();
        expect(task.comment).toBe(retryComment.id);
    });
});

describe('starting the reviewers', () => {
    it('records the round strength the reviewer chose, tells the agent once, and returns it in planroom_state', async () => {
        const { opened, page, call } = await branchReview();
        expect(opened.body.reviewers).toBeUndefined();
        const reviewers = { strength: 'single', model: 'haiku', effort: 'low' };
        await page({ type: 'reviewers.start', reviewers });
        expect((await rejection(page({ type: 'reviewers.start', reviewers }))).message).toMatch(/already started/);
        const { body } = await call('planroom_wait', { after: 0, timeoutSec: 1 });
        expect(body.events).toEqual([expect.objectContaining({ type: 'reviewers.start', round: 1, reviewers })]);
        const state = (await call('planroom_state')).body;
        expect(state.reviewers).toMatchObject(reviewers);
        expect(state.preferences.reviewers).toEqual({ strength: 'standard', model: 'sonnet', effort: 'high' });
    });
});

describe('preferences', () => {
    it('saves them per machine, tells the agent, and hands them to the next review', async () => {
        const prefs = join(await tempRepo(), 'config', 'planroom', 'review.json');
        const first = await branchReview({ prefs });
        const preferences = {
            takes: { predict: true, prosCons: true, risk: false, check: true },
            density: 'light',
            reviewers: { strength: 'single', model: 'haiku', effort: 'low' },
            views: { pins: true, diff: true, charts: true, heatmap: false, matrix: true }
        };
        await first.page({ type: 'preferences.set', preferences });
        expect(JSON.parse(await readFile(prefs, 'utf8'))).toEqual(preferences);
        expect(first.session().view().preferences).toEqual(preferences);
        const { body } = await first.call('planroom_wait', { after: 0, timeoutSec: 1 });
        expect(body.events[0]).toMatchObject({ type: 'preferences.change', preferences });
        await first.planroom.close();

        const next = await branchReview({ prefs });
        expect(next.opened.body.preferences).toEqual(preferences);
        expect((await next.call('planroom_state')).body.preferences).toEqual(preferences);
    });
});
