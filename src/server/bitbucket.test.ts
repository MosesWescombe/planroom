import { describe, expect, it } from 'vitest';
import { BitbucketError, bitbucketRepo, httpBitbucket, parseTarget } from './bitbucket.js';

const PR = { workspace: 'acme', repo: 'api', number: 412 };

/** A fetch that answers each request in turn from `answers`, recording what was asked. */
function scripted(answers: Response[]) {
    const asked: { url: string; method: string; body?: unknown; auth: string | null }[] = [];
    const fetchStub: typeof fetch = async (input, init) => {
        asked.push({
            url: String(input),
            method: init?.method ?? 'GET',
            ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
            auth: new Headers(init?.headers).get('authorization')
        });
        const next = answers.shift();
        if (!next) throw new Error('no answer left');
        return next;
    };
    return { asked, fetchStub };
}

describe('the Bitbucket client', () => {
    it('signs in with the email and token, and creates draft comments, replies and tasks', async () => {
        const { asked, fetchStub } = scripted([Response.json({ id: 7 }), Response.json({ id: 8 }), Response.json({ id: 9 })]);
        const client = httpBitbucket({ email: 'dev@example.com', token: 'tok' }, { fetch: fetchStub });
        expect(await client.createComment(PR, { body: 'Hi', inline: { path: 'a.ts', to: 3 }, pending: true })).toBe(7);
        expect(await client.createComment(PR, { body: 'Again', parent: 7, pending: true })).toBe(8);
        expect(await client.createTask(PR, { comment: 7, body: 'Fix it', pending: true })).toBe(9);
        expect(asked[0]).toEqual({
            url: 'https://api.bitbucket.org/2.0/repositories/acme/api/pullrequests/412/comments',
            method: 'POST',
            body: { content: { raw: 'Hi' }, inline: { path: 'a.ts', to: 3 }, pending: true },
            auth: `Basic ${Buffer.from('dev@example.com:tok').toString('base64')}`
        });
        expect(asked[1]?.body).toEqual({ content: { raw: 'Again' }, parent: { id: 7 }, pending: true });
        expect(asked[2]).toMatchObject({
            url: expect.stringMatching(/\/tasks$/),
            body: { content: { raw: 'Fix it' }, comment: { id: 7 }, pending: true }
        });
    });

    it('waits out a rate limit and tries again', async () => {
        const waits: number[] = [];
        const { asked, fetchStub } = scripted([
            new Response('{}', { status: 429, headers: { 'retry-after': '2' } }),
            new Response('{}', { status: 429 }),
            Response.json({ id: 5 })
        ]);
        const client = httpBitbucket(undefined, { fetch: fetchStub, sleep: async (ms) => void waits.push(ms) });
        expect(await client.createComment(PR, { body: 'x', pending: false })).toBe(5);
        expect(waits).toEqual([2000, 2000]);
        expect(asked.every((request) => request.auth === null)).toBe(true);
    });

    it('names the scopes a refused token needs', async () => {
        const { fetchStub } = scripted([Response.json({ error: { message: 'Forbidden' } }, { status: 403 })]);
        const error = await httpBitbucket({ email: 'a', token: 'b' }, { fetch: fetchStub })
            .pullRequest(PR)
            .catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(BitbucketError);
        expect(String(error)).toMatch(/read:pullrequest:bitbucket.*read:repository:bitbucket/);
    });

    it('reads every page of comments with their parents', async () => {
        const { fetchStub } = scripted([
            Response.json({
                values: [{ id: 1, content: { raw: 'Top' }, user: { display_name: 'Rev' }, created_on: 't1' }],
                next: 'https://api.bitbucket.org/2.0/next-page'
            }),
            Response.json({
                values: [{ id: 2, parent: { id: 1 }, content: { raw: 'Reply' }, user: { display_name: 'Ana' }, created_on: 't2' }]
            })
        ]);
        expect(await httpBitbucket(undefined, { fetch: fetchStub }).comments(PR)).toEqual([
            { id: 1, author: 'Rev', text: 'Top', at: 't1', deleted: false },
            { id: 2, parent: 1, author: 'Ana', text: 'Reply', at: 't2', deleted: false }
        ]);
    });
});

describe('review targets', () => {
    it.each([
        [
            'https://bitbucket.org/acme/api/pull-requests/412',
            { kind: 'pr', number: 412, repo: { workspace: 'acme', repo: 'api' } }
        ],
        [
            'https://bitbucket.org/acme/api/pull-requests/412/overview',
            { kind: 'pr', number: 412, repo: { workspace: 'acme', repo: 'api' } }
        ],
        ['412', { kind: 'pr', number: 412 }],
        ['#7', { kind: 'pr', number: 7 }],
        ['feature/retry-policy', { kind: 'branch', branch: 'feature/retry-policy' }]
    ])('reads %s', (target, parsed) => {
        expect(parseTarget(target)).toEqual(parsed);
    });

    it.each([
        ['git@bitbucket.org:acme/api.git', { workspace: 'acme', repo: 'api' }],
        ['https://dev@bitbucket.org/acme/api.git', { workspace: 'acme', repo: 'api' }],
        ['ssh://git@bitbucket.org/acme/api', { workspace: 'acme', repo: 'api' }],
        ['git@github.com:acme/api.git', undefined]
    ])('finds the workspace and repo of %s', (url, repo) => {
        expect(bitbucketRepo(url)).toEqual(repo);
    });
});
