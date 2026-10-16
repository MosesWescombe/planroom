import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../shared/events.js';
import { changedLines, lineCount, readProgress, uncovered } from '../shared/readthrough.js';
import { currentRound, deriveComments, findingsUnlocked, reviewStage } from '../shared/review.js';
import { defined, gitRepo, rejection, reviewServer, tempRepo } from '../test/serverHelpers.js';
import { git } from './worktree.js';

/** `src/send.ts`: the send loop at lines 3 to 11, then constants, `sendAll` at line 49 and the timeout at line 50. */
function sendFile(changed: boolean): string {
    return [
        "import { deliver } from './deliver';",
        '',
        changed ? 'export function send(job, policy: RetryPolicy) {' : 'export function send(job) {',
        '    for (let attempt = 1; ; attempt += 1) {',
        '        try {',
        '            return deliver(job);',
        '        } catch (error) {',
        changed ? '            if (attempt >= policy.maxAttempts) throw error;' : '            if (attempt >= 3) throw error;',
        '        }',
        '    }',
        '}',
        ...Array.from({ length: 37 }, (_, at) => `export const c${at + 12} = ${at + 12};`),
        'export const sendAll = 1;',
        'export const timeout = 1000;',
        ''
    ].join('\n');
}

const job = (name: string, call: string) =>
    `import { send } from '../send';\n\nexport function ${name}(job) {\n    return ${call};\n}\n`;

const TESTS =
    "it('retries up to the policy', () => {\n    expect(send).toBeDefined();\n});\nit('gives up', () => {\n    expect(true).toBe(true);\n});\n";

/** A repo whose `feature/retry-policy` branch makes the retry limit a setting, with main checked out. */
async function readRepo() {
    const repo = await gitRepo();
    const jobs = ['email', 'push', 'sms'];
    await repo.commit(
        {
            'src/send.ts': sendFile(false),
            ...Object.fromEntries(jobs.map((name) => [`src/jobs/${name}.ts`, job(name, 'send(job, { retries: 3 })')])),
            'pnpm-lock.yaml': 'lockfileVersion: 9\n',
            'src/many.ts': `${Array.from({ length: 250 }, () => 'send();').join('\n')}\n`
        },
        'base'
    );
    await repo.run(['checkout', '--quiet', '-b', 'feature/retry-policy']);
    const head = await repo.commit(
        {
            'src/send.ts': sendFile(true),
            ...Object.fromEntries(jobs.map((name) => [`src/jobs/${name}.ts`, job(name, 'send(job, policy)')])),
            'pnpm-lock.yaml': 'lockfileVersion: 10\n',
            'src/send.test.ts': TESTS
        },
        'the retry limit is a setting'
    );
    await repo.run(['checkout', '--quiet', 'main']);
    return { repo, head };
}

type Pieces = Extract<AgentEvent, { type: 'read.outline' }>['pages'];

/** A layout that places every changed line: the send loop and the callers' repeat, then two test cases. */
function outline(sendLines = '3-11'): Pieces {
    return [
        {
            id: 'retry-limit',
            kind: 'concept',
            title: 'The retry limit is a setting',
            group: 'Retry policy',
            order: 1,
            pieces: [
                { id: 'send', file: 'src/send.ts', lines: sendLines, view: 'now' },
                { id: 'callers', file: 'src/jobs/email.ts', lines: '4', repeat: 'R1', view: 'diff' }
            ]
        },
        {
            id: 'send-tests',
            kind: 'tests',
            title: 'Tests of the send loop',
            order: 1,
            pieces: [
                { id: 'test-retries', file: 'src/send.test.ts', lines: '1-3', title: 'retries up to the policy' },
                { id: 'test-gives-up', file: 'src/send.test.ts', lines: '4-6', title: 'gives up' }
            ]
        }
    ];
}

/** A branch review, opened, of the read-through repo. */
async function opened() {
    const { repo, head } = await readRepo();
    const server = await reviewServer(repo.dir);
    const body = (await server.call('planroom_review', { target: 'feature/retry-policy' })).body;
    return { ...server, repo, head, body };
}

const NONE = { strength: 'none', model: 'sonnet', effort: 'high' };

/** A read-through-only review with its layout accepted. */
async function readingNow() {
    const server = await opened();
    await server.page({ type: 'reviewers.start', technique: 'readthrough', reviewers: NONE });
    expect((await server.emit([{ type: 'read.outline', pages: outline() }])).isError).toBe(false);
    return server;
}

describe('the read-through layout', () => {
    it('hands the agent the line index with the repeat, and puts the lock file on Housekeeping', async () => {
        const { body } = await opened();
        expect(body.index.repeats).toEqual([
            {
                key: 'R1',
                change: '`{ retries: 3 }` to `policy`',
                places: ['email', 'push', 'sms'].map((name) => ({ file: `src/jobs/${name}.ts`, new: [4, 4], old: [4, 4] }))
            }
        ]);
        expect(body.index.files.find((file: { path: string }) => file.path === 'pnpm-lock.yaml')).toMatchObject({
            housekeeping: 'lock'
        });
        expect(body.index.files.find((file: { path: string }) => file.path === 'src/send.test.ts')).toMatchObject({ test: true });
    });

    it('refuses a layout with lines left over, naming them, and opens once every line is placed', async () => {
        const server = await opened();
        await server.page({ type: 'reviewers.start', technique: 'readthrough', reviewers: NONE });
        const refused = await server.emit([{ type: 'read.outline', pages: outline('3-6') }]);
        expect(refused.isError).toBe(true);
        expect(JSON.stringify(refused)).toContain('src/send.ts line 8; src/send.ts removed line 8');
        expect(server.session().current.review?.rounds[0]?.readthrough).toBeUndefined();
        expect(Object.keys(server.session().current.pages)).toEqual([]);

        expect((await server.emit([{ type: 'read.outline', pages: outline() }])).isError).toBe(false);
        const round = currentRound(defined(server.session().current.review));
        expect(round.readthrough?.openedAt).toBeDefined();
        expect(Object.keys(server.session().current.pages).sort()).toEqual(['1:retry-limit', '1:send-tests']);
        expect(
            uncovered(
                defined(round.index),
                outline().flatMap((page) => page.pieces)
            )
        ).toEqual([]);
    });

    it('refuses a concept page with no group and a test page with one', async () => {
        const server = await opened();
        await server.page({ type: 'reviewers.start', technique: 'readthrough', reviewers: NONE });
        const [concept, tests] = outline();
        const { group: _, ...ungrouped } = defined(concept);
        const refused = JSON.stringify(
            await server.emit([{ type: 'read.outline', pages: [ungrouped, { ...defined(tests), group: 'Retry policy' }] }])
        );
        expect(refused).toContain('concept page retry-limit needs a group');
        expect(refused).toContain('test page send-tests takes no group');
        expect(Object.keys(server.session().current.pages)).toEqual([]);
    });

    it('keeps the lock file off code pages, and refuses a piece on a file not in the diff', async () => {
        const server = await opened();
        await server.page({ type: 'reviewers.start', technique: 'readthrough', reviewers: NONE });
        const pages = outline();
        pages[0]!.pieces.push(
            { id: 'lock', file: 'pnpm-lock.yaml', lines: '1' },
            { id: 'other', file: 'src/many.ts', lines: '1' }
        );
        const refused = JSON.stringify(await server.emit([{ type: 'read.outline', pages }]));
        expect(refused).toContain('pnpm-lock.yaml is on the Housekeeping page');
        expect(refused).toContain("src/many.ts is not in round 1's diff");
    });

    it('builds only what the reviewer chose', async () => {
        const server = await opened();
        expect(JSON.stringify(await server.emit([{ type: 'read.outline', pages: outline() }]))).toContain(
            'has not chosen how to review yet'
        );
        await server.page({ type: 'reviewers.start', technique: 'readthrough', reviewers: NONE });
        const slide = await server.emit([
            { type: 'doc.block.upsert', block: { id: 'why-text', type: 'text', config: { body: 'Why' } } },
            { type: 'slide.upsert', slide: { id: 'why', chapter: 'why', order: 1, title: 'Why', blocks: ['why-text'] } }
        ]);
        expect(JSON.stringify(slide)).toContain('chose the read-through alone');

        const deck = await opened();
        await deck.page({ type: 'reviewers.start', technique: 'deck', reviewers: { ...NONE, strength: 'standard' } });
        expect(JSON.stringify(await deck.emit([{ type: 'read.outline', pages: outline() }]))).toContain(
            'chose the overview deck alone'
        );

        const both = await opened();
        await both.page({ type: 'reviewers.start', technique: 'both', reviewers: NONE });
        expect(JSON.stringify(await both.emit([{ type: 'read.outline', pages: outline() }]))).toContain('publish it, then');
    });

    it('opens the Review and Comments tabs at once with no deck, and never enters the walkthrough', async () => {
        const server = await readingNow();
        const round = currentRound(defined(server.session().current.review));
        expect(round.walkthrough).toBeUndefined();
        expect(findingsUnlocked(round)).toBe(true);
        expect(reviewStage(server.session().current)).toBe('triage');
        await server.page({
            type: 'note.save',
            anchor: { file: 'src/send.ts', side: 'new', start: 8 },
            text: 'Clamp it',
            page: 'retry-limit'
        });
        await server.page({ type: 'comments.open' });
        expect(reviewStage(server.session().current)).toBe('preview');
    });

    it('starts no AI review at none: findings are refused, and the choice is remembered', async () => {
        const server = await readingNow();
        const finding = await server.emit([
            {
                type: 'item.upsert',
                item: {
                    id: 'I-1',
                    kind: 'question',
                    title: 'Why?',
                    body: 'Why?',
                    confidence: 0.9,
                    anchor: { file: 'src/send.ts', side: 'new', start: 8 },
                    draft: 'Why?'
                }
            }
        ]);
        expect(JSON.stringify(finding)).toContain('chose no AI review');
        expect(server.session().view().preferences).toMatchObject({ technique: 'readthrough', reviewers: { strength: 'none' } });
        expect(JSON.parse(await readFile(server.prefs, 'utf8'))).toMatchObject({ technique: 'readthrough' });
    });
});

describe('reading', () => {
    it('saves ticks with the review without telling the agent, and keeps them across a reopen', async () => {
        const server = await readingNow();
        const before = (await server.call('planroom_wait', { after: 0, timeoutSec: 1 })).body.cursor;
        await server.page({ type: 'read.tick', piece: 'send', read: true, how: 'manual' });
        await server.page({ type: 'read.tick', piece: 'test-retries', read: true, how: 'auto' });
        await server.page({ type: 'read.tick', piece: 'housekeeping', read: true, how: 'auto' });
        expect((await rejection(server.page({ type: 'read.tick', piece: 'nope', read: true, how: 'manual' }))).status).toBe(404);
        const waited = await server.call('planroom_wait', { after: before, timeoutSec: 1 });
        expect(waited.body.events).toEqual([]);
        const progress = () => {
            const state = server.session().current;
            return readProgress(state, currentRound(defined(state.review)).index, 1);
        };
        const read = progress();
        expect(read.pages).toEqual({ 'retry-limit': { read: 1, total: 2 }, 'send-tests': { read: 1, total: 2 } });

        await server.planroom.close();
        const again = await reviewServer(server.repo.dir, { prefs: server.prefs });
        await again.call('planroom_review', { target: 'feature/retry-policy' });
        const state = again.session().current;
        expect(Object.keys(state.ticks).sort()).toEqual(['1:housekeeping', '1:send', '1:test-retries']);
        expect(readProgress(state, currentRound(defined(state.review)).index, 1)).toEqual(read);
    });

    it('reads every identical place of a repeat with its example, and has no other place to open', async () => {
        const server = await readingNow();
        const round = () => currentRound(defined(server.session().current.review));
        expect(
            (await rejection(server.page({ type: 'read.tick', piece: 'callers', place: 0, read: true, how: 'manual' }))).message
        ).toMatch(/no other place 0/);
        await server.page({ type: 'read.tick', piece: 'callers', read: true, how: 'manual' });
        // Every place of the repeat is identical, so ticking the example reads all three.
        const state = server.session().current;
        const index = defined(round().index);
        expect(readProgress(state, index, 1)).toMatchObject({
            pages: { 'retry-limit': { read: 1, total: 2 } },
            lines: { read: 6 }
        });
        expect(lineCount(changedLines(index))).toBe(18);
    });

    it('takes page words and additions marked as asked, changing nothing shown and unticking the piece added to', async () => {
        const server = await readingNow();
        const written = await server.emit([
            {
                type: 'read.page.upsert',
                page: {
                    id: 'retry-limit',
                    summary: 'The limit comes from the policy.',
                    pieces: [
                        {
                            id: 'send',
                            note: 'The loop.',
                            blocks: [
                                { type: 'flow', config: { nodes: [{ id: 'a', label: 'Send' }], edges: [] } },
                                { type: 'bar', config: {} }
                            ],
                            related: [{ file: 'src/many.ts', lines: '1-3' }]
                        }
                    ]
                }
            }
        ]);
        expect(written.isError).toBe(false);
        // A piece's blocks are checked like the page's: the one that fails its schema is named.
        expect(written.body.blockProblems.map((problem: { block: string }) => problem.block)).toEqual([
            'page retry-limit piece send blocks[1]'
        ]);
        await server.page({ type: 'read.tick', piece: 'send', read: true, how: 'manual' });
        await server.page({
            type: 'comment.create',
            anchor: {
                target: 'page:retry-limit',
                lines: { file: 'src/send.ts', side: 'new', start: 4, end: 6, text: 'attempt += 1' }
            },
            intent: 'question',
            text: 'Why loop forever?'
        });
        const waited = await server.call('planroom_wait', { after: 0, timeoutSec: 1 });
        expect(waited.body.events.at(-1)).toMatchObject({
            type: 'comment.create',
            anchor: { target: 'page:retry-limit', lines: { file: 'src/send.ts', start: 4, end: 6, text: 'attempt += 1' } }
        });
        const content = server.session().current.pages['1:retry-limit']?.content;
        await server.emit([{ type: 'comment.reply', threadId: 'C-1', text: 'It stops at the policy limit.' }]);
        await server.page({ type: 'read.tick', piece: 'send', read: true, how: 'manual' });
        const added = await server.emit([
            { type: 'read.page.add', page: 'retry-limit', threadId: 'C-1', piece: 'send', text: 'The caller sets the policy.' }
        ]);
        expect(added.isError).toBe(false);
        const page = defined(server.session().current.pages['1:retry-limit']);
        expect(page.content).toEqual(content);
        expect(page.added).toEqual([
            expect.objectContaining({ thread: 'C-1', piece: 'send', text: 'The caller sets the policy.' })
        ]);
        expect(server.session().current.ticks['1:send']).toBeUndefined();
        expect(
            JSON.stringify(await server.emit([{ type: 'read.page.add', page: 'send-tests', threadId: 'C-1', text: 'x' }]))
        ).toContain('is not a thread on page send-tests');
    });

    it('unticks what a question was about once the agent answers: the piece holding its lines, else the page', async () => {
        const server = await readingNow();
        for (const piece of ['send', 'callers', 'test-retries'])
            await server.page({ type: 'read.tick', piece, read: true, how: 'manual' });
        const ticks = () => Object.keys(server.session().current.ticks).sort();
        // A removed line shows beside the piece's new lines, so a question on it is about that piece.
        await server.page({
            type: 'comment.create',
            anchor: { target: 'page:retry-limit', lines: { file: 'src/send.ts', side: 'old', start: 8, end: 8 } },
            intent: 'question',
            text: 'Where did 3 go?'
        });
        expect((await server.emit([{ type: 'comment.reply', threadId: 'C-1', text: 'Into the policy.' }])).isError).toBe(false);
        expect(ticks()).toEqual(['1:callers', '1:test-retries']);
        await server.page({ type: 'comment.create', anchor: { target: 'page:retry-limit' }, intent: 'question', text: 'Why?' });
        await server.emit([{ type: 'comment.reply', threadId: 'C-2', text: 'Callers differ.' }]);
        expect(ticks()).toEqual(['1:test-retries']);
    });

    it('reads code on two pages the same on both, and unticking it or answering on it unreads it on both', async () => {
        const server = await opened();
        await server.page({ type: 'reviewers.start', technique: 'readthrough', reviewers: NONE });
        const pages = outline();
        pages.push({
            id: 'limit-check',
            kind: 'concept',
            title: 'Where the limit is checked',
            group: 'Retry policy',
            order: 2,
            pieces: [{ id: 'limit', file: 'src/send.ts', lines: '8' }]
        });
        expect((await server.emit([{ type: 'read.outline', pages }])).isError).toBe(false);
        const ticks = () => Object.keys(server.session().current.ticks).sort();
        const progress = () => {
            const state = server.session().current;
            return readProgress(state, currentRound(defined(state.review)).index, 1).pages;
        };
        await server.page({ type: 'read.tick', piece: 'send', read: true, how: 'manual' });
        expect(progress()).toMatchObject({ 'retry-limit': { read: 1 }, 'limit-check': { read: 1, total: 1 } });
        // The limit check is read by the send loop's tick, so unticking it there unticks the loop too.
        await server.page({ type: 'read.tick', piece: 'limit', read: false, how: 'manual' });
        expect(ticks()).toEqual([]);
        expect(progress()).toMatchObject({ 'retry-limit': { read: 0 }, 'limit-check': { read: 0 } });

        for (const piece of ['send', 'limit', 'callers'])
            await server.page({ type: 'read.tick', piece, read: true, how: 'manual' });
        await server.page({
            type: 'comment.create',
            anchor: { target: 'page:limit-check', lines: { file: 'src/send.ts', side: 'new', start: 8, end: 8 } },
            intent: 'question',
            text: 'Why the policy?'
        });
        await server.emit([{ type: 'comment.reply', threadId: 'C-1', text: 'Callers set it.' }]);
        expect(ticks()).toEqual(['1:callers']);
    });

    it('lists whole-word matches of a name in tracked files of the reviewed commit, at most 200', async () => {
        const server = await readingNow();
        await writeFile(join(server.repo.dir, 'notes.txt'), 'send me\n');
        const found = await server.session().reviewSearch(undefined, 'sendAll');
        expect(found).toEqual({
            round: 1,
            query: 'sendAll',
            matches: [{ file: 'src/send.ts', line: 49, text: 'export const sendAll = 1;' }],
            truncated: false
        });
        const many = await server.session().reviewSearch(undefined, 'send');
        expect(many.matches).toHaveLength(200);
        expect(many.truncated).toBe(true);
        expect(many.matches.some((match) => match.file === 'notes.txt' || match.text.includes('sendAll'))).toBe(false);
        expect((await server.session().reviewSearch(undefined, 'nothingLikeThis')).matches).toEqual([]);
    });

    it('narrows a name search to the lines that declare it', async () => {
        const server = await readingNow();
        expect((await server.session().reviewSearch(undefined, 'sendAll', true)).matches).toEqual([
            { file: 'src/send.ts', line: 49, text: 'export const sendAll = 1;' }
        ]);
        // Of the 250 calls in src/many.ts and the jobs' calls, only the declaration.
        expect(await server.session().reviewSearch(undefined, 'send', true)).toEqual({
            round: 1,
            query: 'send',
            matches: [{ file: 'src/send.ts', line: 3, text: 'export function send(job, policy: RetryPolicy) {' }],
            truncated: false
        });
    });
});

/** A clone of `remote` whose origin names `acme/api` on Bitbucket, git fetching from the stand-in instead. */
async function cloneAsBitbucket(remote: string): Promise<string> {
    const dir = join(await tempRepo(), 'clone');
    await git(remote, ['clone', '--quiet', remote, dir]);
    await git(dir, ['config', 'remote.origin.url', 'git@bitbucket.org:acme/api.git']);
    await git(dir, ['config', `url.${remote}.insteadOf`, 'git@bitbucket.org:acme/api.git']);
    return dir;
}

/** A PR review of the read-through repo, read through with no AI review. */
async function prReading() {
    const { repo, head } = await readRepo();
    const dir = await cloneAsBitbucket(repo.dir);
    const server = await reviewServer(dir);
    server.fake.pr.source.commit = head.slice(0, 12);
    server.fake.pr.destination.commit = (await repo.run(['rev-parse', 'main'])).trim().slice(0, 12);
    await server.call('planroom_review', { target: '412' });
    await server.page({ type: 'reviewers.start', technique: 'readthrough', reviewers: NONE });
    expect((await server.emit([{ type: 'read.outline', pages: outline() }])).isError).toBe(false);
    return { ...server, repo, head, dir };
}

describe('comments from the read-through', () => {
    it('places a range on its last line, a line off the diff on the file quoting it, and a repeat once with its other places', async () => {
        const server = await prReading();
        const note = (anchor: Record<string, unknown>, text: string, extra: Record<string, unknown> = {}) =>
            server.page({ type: 'note.save', anchor: { side: 'new', ...anchor }, text, page: 'retry-limit', ...extra });
        await note({ file: 'src/send.ts', start: 5, end: 8 }, 'This loop never ends on its own.');
        await note({ file: 'src/send.ts', start: 50 }, 'Make the timeout a setting too.');
        await note({ file: 'src/jobs/email.ts', start: 4 }, 'Pass the default policy.', {
            repeat: { key: 'R1', onlyHere: false }
        });
        await note({ file: 'src/jobs/sms.ts', start: 4 }, 'SMS needs fewer tries.', { repeat: { key: 'R1', onlyHere: true } });
        await server.page({ type: 'comments.open' });
        const previewed = deriveComments(server.session().current, 1);
        const body = (file: string) =>
            defined(previewed.find((comment) => comment.anchor?.file === file && comment.text.length > 0));
        expect(previewed.map((comment) => [comment.key, comment.placed])).toEqual([
            ['note:N-3', { file: 'src/jobs/email.ts', side: 'new', start: 4 }],
            ['note:N-4', { file: 'src/jobs/sms.ts', side: 'new', start: 4 }],
            ['note:N-1', { file: 'src/send.ts', side: 'new', start: 5, end: 8 }],
            ['note:N-2', { file: 'src/send.ts', side: 'new' }]
        ]);
        expect(previewed[2]!.body).toBe('Lines 5-8:\n\nThis loop never ends on its own.');
        expect(previewed[3]!.body).toBe(
            'On line 50:\n\n```\nexport const timeout = 1000;\n```\n\nMake the timeout a setting too.'
        );
        expect(body('src/jobs/email.ts').body).toBe(
            'Pass the default policy.\n\nThe same change is also at:\n\n- src/jobs/push.ts line 4\n- src/jobs/sms.ts line 4'
        );
        expect(body('src/jobs/sms.ts').body).toBe('SMS needs fewer tries.');

        await server.page({ type: 'comments.post' });
        await server.session().settled();
        expect(server.fake.created.map((comment) => [comment.body, comment.inline])).toEqual(
            previewed.map((comment) => [
                comment.body,
                comment.placed?.start === undefined
                    ? { path: comment.placed?.file }
                    : { path: comment.placed.file, to: comment.placed.end ?? comment.placed.start }
            ])
        );
        expect(server.fake.created[2]!.inline).toEqual({ path: 'src/send.ts', to: 8 });
        expect(server.fake.created[3]!.inline).toEqual({ path: 'src/send.ts' });

        // Post, then hand the same comments to an agent.
        const { handoff } = await server.page({ type: 'comments.handoff' });
        const file = defined(handoff).file;
        expect(file).toBe(join(server.dir, '.planroom/reviews/pr-412/handoff-round-1.md'));
        expect(defined(handoff).prompt).toContain(
            `${file} and make the changes it lists in your own checkout of feature/retry-policy`
        );
    });

    it('hands a local branch to an agent as a task file matching the preview, with no network call', async () => {
        const server = await readingNow();
        await server.page({
            type: 'note.save',
            anchor: { file: 'src/send.ts', side: 'new', start: 8 },
            text: 'Clamp maxAttempts to at least 1.',
            page: 'retry-limit'
        });
        await server.page({
            type: 'note.save',
            anchor: { file: 'src/send.ts', side: 'new', start: 3, end: 4 },
            text: 'Is the policy optional?'
        });
        const result = await server.page({ type: 'comments.handoff' });
        const handoff = defined(result.handoff);
        expect(handoff.prompt).toBe(
            `Read ${handoff.file} and make the changes it lists in your own checkout of feature/retry-policy: first check it is at commit ${server.head} ` +
                'and stop and ask me if it is not, then make each change, and ask me about any comment that is a question rather than a request.'
        );
        const text = await readFile(handoff.file, 'utf8');
        expect(text).toContain(`Branch \`feature/retry-policy\`, reviewed at commit \`${server.head}\`.`);
        expect(text).toContain('if it is not, stop and ask the reviewer');
        expect(text).toContain('## 1. src/send.ts lines 3-4\n\n```\nexport function send(job, policy: RetryPolicy) {');
        expect(text).toContain('## 2. src/send.ts line 8 (page: The retry limit is a setting)');
        for (const comment of deriveComments(server.session().current, 1)) expect(text).toContain(comment.body);
        expect(server.fake.calls).toEqual([]);
        expect(existsSync(handoff.file)).toBe(true);
    });
});

describe('the next round', () => {
    it('reads through only what changed since the posted round, with fresh ticks', async () => {
        const server = await prReading();
        await server.page({ type: 'read.tick', piece: 'send', read: true, how: 'manual' });
        await server.page({ type: 'note.save', anchor: { file: 'src/send.ts', side: 'new', start: 8 }, text: 'Clamp it.' });
        await server.page({ type: 'comments.open' });
        await server.page({ type: 'comments.post' });
        await server.session().settled();

        await server.repo.run(['checkout', '--quiet', 'feature/retry-policy']);
        const pushed = await server.repo.commit(
            {
                'src/send.ts': sendFile(true).replace('policy.maxAttempts)', 'Math.max(1, policy.maxAttempts))'),
                'src/jobs/sms.ts': job('sms', 'send(job, policy.sms)')
            },
            'clamp'
        );
        server.fake.pr.source.commit = pushed;
        const { body } = await server.call('planroom_review', { target: '412' });
        expect(body.round).toBe(2);
        const round = currentRound(defined(server.session().current.review));
        const index = defined(round.index);
        expect(index.files.map((file) => file.path)).toEqual(['src/jobs/sms.ts', 'src/send.ts']);
        expect(lineCount(changedLines(index))).toBe(4);

        await server.page({ type: 'reviewers.start', technique: 'readthrough', reviewers: NONE });
        const delta: Pieces = [
            {
                id: 'retry-limit',
                kind: 'concept',
                title: 'The limit is clamped',
                group: 'Retry policy',
                order: 1,
                pieces: [
                    { id: 'send', file: 'src/send.ts', lines: '8' },
                    { id: 'sms', file: 'src/jobs/sms.ts', lines: '4' }
                ]
            }
        ];
        expect((await server.emit([{ type: 'read.outline', pages: delta }])).isError).toBe(false);
        const state = server.session().current;
        expect(readProgress(state, index, 2)).toEqual({
            pages: { 'retry-limit': { read: 0, total: 2 } },
            lines: { read: 0, total: 4 }
        });
        expect(state.ticks['1:send']).toBeDefined();
        expect(state.ticks['2:send']).toBeUndefined();
    });
});

describe('preferences and the deck alone', () => {
    it('reads an older review.json with the read-through settings at their defaults, and hands them to the agent', async () => {
        const { repo } = await readRepo();
        const prefs = join(await tempRepo(), 'review.json');
        await writeFile(
            prefs,
            JSON.stringify({ density: 'light', reviewers: { strength: 'single', model: 'haiku', effort: 'low' } })
        );
        const server = await reviewServer(repo.dir, { prefs });
        const { body } = await server.call('planroom_review', { target: 'feature/retry-policy' });
        expect(body.preferences).toMatchObject({
            density: 'light',
            technique: 'deck',
            readthrough: { view: 'auto', tests: 'pseudo', autoTick: true }
        });
        expect((await server.call('planroom_state')).body.preferences.readthrough).toEqual({
            view: 'auto',
            tests: 'pseudo',
            autoTick: true
        });
    });

    it('runs a review on the deck alone as before, with the AI review off', async () => {
        const server = await opened();
        await server.page({ type: 'reviewers.start', technique: 'deck', reviewers: NONE });
        const deck: AgentEvent[] = [
            ...['why', 'how', 'touches', 'trade'].map(
                (id): AgentEvent => ({
                    type: 'doc.block.upsert',
                    block: { id: `${id}-text`, type: 'text', config: { body: id } }
                })
            ),
            {
                type: 'doc.block.upsert',
                block: {
                    id: 'map',
                    type: 'impactMap',
                    config: {
                        areas: [
                            { id: 'jobs', title: 'Jobs', summary: 'Every job sends.' },
                            { id: 'alerts', title: 'Alerts', summary: 'Failures page sooner.' }
                        ]
                    }
                }
            },
            { type: 'slide.upsert', slide: { id: 'why', chapter: 'why', order: 1, title: 'Why', blocks: ['why-text'] } },
            { type: 'slide.upsert', slide: { id: 'how', chapter: 'how', order: 1, title: 'How', blocks: ['how-text'] } },
            {
                type: 'slide.upsert',
                slide: { id: 'touches', chapter: 'touches', order: 1, title: 'Touches', blocks: ['touches-text', 'map'] }
            },
            { type: 'deck.publish' }
        ];
        const published = await server.emit(deck);
        expect(published.isError, JSON.stringify(published)).toBe(false);
        expect(reviewStage(server.session().current)).toBe('walkthrough');
        expect(findingsUnlocked(currentRound(defined(server.session().current.review)))).toBe(false);
        expect(JSON.stringify(await server.emit([{ type: 'read.outline', pages: outline() }]))).toContain('overview deck alone');
        await server.page({ type: 'impact.send' });
        await server.emit([
            {
                type: 'slide.upsert',
                slide: { id: 'trade', chapter: 'tradeoffs', order: 1, title: 'Trade', blocks: ['trade-text'] }
            },
            { type: 'deck.publish' }
        ]);
        await server.page({ type: 'walkthrough.done', how: 'finished' });
        expect(reviewStage(server.session().current)).toBe('triage');
        await server.page({ type: 'note.save', anchor: { file: 'src/send.ts', side: 'new', start: 8 }, text: 'Clamp it.' });
        await server.page({ type: 'comments.open' });
        expect(reviewStage(server.session().current)).toBe('preview');
        expect(deriveComments(server.session().current, 1).map((comment) => comment.body)).toEqual(['Clamp it.']);
    });
});

describe('end to end', () => {
    it('opens a PR, reads it through with ticks and comments, posts them, and hands the same comments to an agent', async () => {
        const server = await prReading();
        const pages = await server.emit([
            {
                type: 'read.page.upsert',
                page: {
                    id: 'retry-limit',
                    summary: 'The limit is the policy’s.',
                    pieces: [
                        { id: 'send', note: 'The loop.' },
                        { id: 'callers', note: 'Jobs.' }
                    ]
                }
            },
            {
                type: 'read.page.upsert',
                page: {
                    id: 'send-tests',
                    summary: 'Two cases.',
                    pieces: [],
                    tests: [
                        { piece: 'test-retries', title: 'retries up to the policy', pseudo: 'fails twice, then works' },
                        { piece: 'test-gives-up', title: 'gives up', pseudo: 'always fails: throws' }
                    ]
                }
            }
        ]);
        expect(pages.isError).toBe(false);
        for (const piece of ['send', 'callers', 'test-retries', 'test-gives-up', 'housekeeping'])
            await server.page({ type: 'read.tick', piece, read: true, how: 'manual' });
        const state = () => server.session().current;
        const index = defined(currentRound(defined(state().review)).index);
        expect(readProgress(state(), index, 1).lines).toEqual({ read: 18, total: 18 });

        await server.page({
            type: 'note.save',
            anchor: { file: 'src/send.ts', side: 'new', start: 8 },
            text: 'Clamp it.',
            page: 'retry-limit'
        });
        await server.page({
            type: 'note.save',
            anchor: { file: 'src/jobs/email.ts', side: 'new', start: 4 },
            text: 'Use the default policy.',
            page: 'retry-limit',
            repeat: { key: 'R1', onlyHere: false }
        });
        await server.page({ type: 'comments.open' });
        await server.page({ type: 'comments.post' });
        await server.session().settled();
        const previewed = deriveComments(state(), 1);
        expect(server.fake.created.map((comment) => comment.body)).toEqual(previewed.map((comment) => comment.body));
        expect(currentRound(defined(state().review)).postedAt).toBeDefined();

        const handoff = defined((await server.page({ type: 'comments.handoff' })).handoff);
        const text = await readFile(handoff.file, 'utf8');
        for (const comment of previewed) expect(text).toContain(comment.body);
        expect(text).toContain('(page: The retry limit is a setting)');
        expect(text).toContain('- src/jobs/push.ts line 4\n- src/jobs/sms.ts line 4');
    });
});
