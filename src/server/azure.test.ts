import { afterEach, describe, expect, it, vi } from 'vitest';
import { defined } from '../test/serverHelpers.js';
import { azureAccess, azureRepo, freshBearer, httpAzure, SIGN_IN } from './azure.js';
import { HostError, type PullRequestRef } from './hosts.js';
import { parseTarget } from './review.js';

const PR: PullRequestRef = { host: 'azure', workspace: 'acme', project: 'My Project', repo: 'api', number: 412 };
const THREADS = 'https://dev.azure.com/acme/My%20Project/_apis/git/repositories/api/pullRequests/412/threads';

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

describe('the Azure DevOps client', () => {
    it('opens active threads on whole lines, on a file or on the PR, replies in a thread and resolves it', async () => {
        const { asked, fetchStub } = scripted([
            Response.json({ id: 7 }),
            Response.json({ id: 8 }),
            Response.json({ id: 9 }),
            Response.json({ id: 2 }),
            Response.json({ id: 7 })
        ]);
        const client = httpAzure(async () => 'Bearer tok', { fetch: fetchStub });
        const anchor = { file: 'src/a.ts', side: 'new' as const, start: 3, end: 5 };
        expect(await client.createComment(PR, { body: 'Hi', anchor, lastLine: '  return x;', pending: false })).toBe(7);
        expect(await client.createComment(PR, { body: 'File', anchor: { file: 'src/a.ts', side: 'old' }, pending: false })).toBe(
            8
        );
        expect(await client.createComment(PR, { body: 'Summary', pending: false })).toBe(9);
        expect(await client.createComment(PR, { body: 'Again', parent: 7, pending: false })).toBe(7);
        await client.resolveComment(PR, 7);

        expect(asked[0]).toEqual({
            url: `${THREADS}?api-version=7.1`,
            method: 'POST',
            body: {
                comments: [{ content: 'Hi', commentType: 1, parentCommentId: 0 }],
                status: 1,
                threadContext: {
                    filePath: '/src/a.ts',
                    rightFileStart: { line: 3, offset: 1 },
                    rightFileEnd: { line: 5, offset: 12 }
                }
            },
            auth: 'Bearer tok'
        });
        expect(asked[1]?.body).toMatchObject({ threadContext: { filePath: '/src/a.ts' } });
        expect(asked[2]?.body).not.toHaveProperty('threadContext');
        expect(asked[3]).toMatchObject({
            url: `${THREADS}/7/comments?api-version=7.1`,
            body: { content: 'Again', commentType: 1, parentCommentId: 1 }
        });
        expect(asked[4]).toMatchObject({ url: `${THREADS}/7?api-version=7.1`, method: 'PATCH', body: { status: 2 } });
        expect(client.createTask).toBeUndefined();
    });

    it('puts removed lines on the left side', async () => {
        const { asked, fetchStub } = scripted([Response.json({ id: 1 })]);
        const anchor = { file: 'src/a.ts', side: 'old' as const, start: 4 };
        await httpAzure(undefined, { fetch: fetchStub }).createComment(PR, { body: 'x', anchor, lastLine: 'ab', pending: false });
        expect(asked[0]?.body).toMatchObject({
            threadContext: { leftFileStart: { line: 4, offset: 1 }, leftFileEnd: { line: 4, offset: 3 } }
        });
        expect(asked[0]?.auth).toBeNull();
    });

    it('reads a pull request: its branches, commits, link and whether it comes from a fork', async () => {
        const raw = {
            title: 'Cap retries',
            description: 'Caps them.',
            createdBy: { displayName: 'Ana' },
            repository: { webUrl: 'https://dev.azure.com/acme/My%20Project/_git/api' },
            sourceRefName: 'refs/heads/feature/retry',
            targetRefName: 'refs/heads/main',
            lastMergeSourceCommit: { commitId: 'abc' },
            lastMergeTargetCommit: { commitId: 'def' }
        };
        const { asked, fetchStub } = scripted([
            Response.json(raw),
            Response.json({ ...raw, forkSource: { repository: { name: 'api', project: { name: 'Forks' } } } })
        ]);
        const client = httpAzure(undefined, { fetch: fetchStub });
        expect(await client.pullRequest(PR)).toEqual({
            title: 'Cap retries',
            description: 'Caps them.',
            author: 'Ana',
            link: 'https://dev.azure.com/acme/My%20Project/_git/api/pullrequest/412',
            source: { branch: 'feature/retry', commit: 'abc' },
            destination: { branch: 'main', commit: 'def' }
        });
        expect((await client.pullRequest(PR)).fork).toBe('Forks/api');
        expect(defined(asked[0]).url).toBe(
            'https://dev.azure.com/acme/My%20Project/_apis/git/repositories/api/pullRequests/412?api-version=7.1'
        );
    });

    it("finds the open PR from a branch of the repo itself, skipping a fork's", async () => {
        const { asked, fetchStub } = scripted([
            Response.json({ value: [{ pullRequestId: 9, forkSource: { repository: { name: 'api' } } }, { pullRequestId: 412 }] }),
            Response.json({ value: [] })
        ]);
        const client = httpAzure(undefined, { fetch: fetchStub });
        expect(await client.openPullRequest(PR, 'feature/x')).toBe(412);
        expect(await client.openPullRequest(PR, 'feature/y')).toBeUndefined();
        const url = new URL(defined(asked[0]).url);
        expect(url.pathname).toBe('/acme/My%20Project/_apis/git/repositories/api/pullrequests');
        expect(Object.fromEntries(url.searchParams)).toEqual({
            'searchCriteria.sourceRefName': 'refs/heads/feature/x',
            'searchCriteria.status': 'active',
            'api-version': '7.1'
        });
    });

    it("reads each thread's comments, its replies under the thread and without the system's", async () => {
        const { fetchStub } = scripted([
            Response.json({
                value: [
                    { id: 1, comments: [{ id: 1, parentCommentId: 0, commentType: 'system', content: 'Ana voted' }] },
                    {
                        id: 7,
                        comments: [
                            { id: 1, parentCommentId: 0, content: 'Top', author: { displayName: 'Rev' }, publishedDate: 't1' },
                            { id: 2, parentCommentId: 1, content: 'Reply', author: { displayName: 'Ana' }, publishedDate: 't2' },
                            { id: 3, parentCommentId: 1, content: '', isDeleted: true, publishedDate: 't3' }
                        ]
                    }
                ]
            })
        ]);
        expect(await httpAzure(undefined, { fetch: fetchStub }).comments(PR)).toEqual([
            { id: 7, author: 'Rev', text: 'Top', at: 't1', deleted: false },
            { id: 2, parent: 7, author: 'Ana', text: 'Reply', at: 't2', deleted: false },
            { id: 3, parent: 7, author: 'Someone', text: '', at: 't3', deleted: true }
        ]);
    });

    it('says how to sign in when it gets the sign-in page or a refusal, and passes on other errors', async () => {
        const { fetchStub } = scripted([
            new Response('<html>Sign in</html>', { status: 203, headers: { 'content-type': 'text/html' } }),
            Response.json({ message: 'TF400813: not authorized.' }, { status: 401 }),
            Response.json({ message: 'TF401180: The requested pull request was not found.' }, { status: 404 })
        ]);
        const client = httpAzure(undefined, { fetch: fetchStub });
        const fail = () => client.pullRequest(PR).catch((caught: unknown) => caught);
        const page = await fail();
        expect(page).toBeInstanceOf(HostError);
        expect(page).toMatchObject({ status: 401, message: expect.stringContaining(SIGN_IN) });
        expect(String(await fail())).toContain('TF400813');
        expect(await fail()).toMatchObject({
            status: 404,
            message: expect.stringMatching(/^Azure DevOps answered 404: TF401180/)
        });
    });
});

describe('Azure DevOps credentials', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('signs in with a personal access token, as basic auth with no user name, before the Azure CLI', async () => {
        const { asked, fetchStub } = scripted([Response.json({ id: 1 })]);
        vi.stubGlobal('fetch', fetchStub);
        const access = await azureAccess({ AZURE_DEVOPS_EXT_PAT: ' pat ' }, () => Promise.reject(new Error('unused')));
        expect(access.ready).toBe(true);
        await access.client.resolveComment(PR, 1);
        expect(asked[0]?.auth).toBe(`Basic ${Buffer.from(':pat').toString('base64')}`);
    });

    it("takes the Azure CLI's token, or says what to do without one and reads anonymously", async () => {
        const { asked, fetchStub } = scripted([Response.json({ id: 1 }), Response.json({ id: 1 })]);
        vi.stubGlobal('fetch', fetchStub);
        const signedIn = await azureAccess({}, async () => ({ token: 'cli', expiresAt: Date.now() + 3_600_000 }));
        expect(signedIn.ready).toBe(true);
        await signedIn.client.resolveComment(PR, 1);
        expect(asked[0]?.auth).toBe('Bearer cli');

        const missing = await azureAccess({}, () => Promise.reject(new HostError(`No token. ${SIGN_IN}`, 401)));
        expect(missing).toMatchObject({ ready: false, problem: `No token. ${SIGN_IN}` });
        await missing.client.resolveComment(PR, 1);
        expect(asked[1]?.auth).toBeNull();
    });

    it('keeps a token until five minutes before it expires', async () => {
        let now = 0;
        let fetched = 0;
        const bearer = freshBearer(
            async () => ({ token: `t${(fetched += 1)}`, expiresAt: 60 * 60_000 }),
            () => now
        );
        expect(await bearer()).toBe('Bearer t1');
        now = 54 * 60_000;
        expect(await bearer()).toBe('Bearer t1');
        now = 56 * 60_000;
        expect(await bearer()).toBe('Bearer t2');
    });
});

describe('Azure DevOps repos and links', () => {
    const repo = (workspace: string, project: string, name: string) => ({ host: 'azure', workspace, project, repo: name });
    it.each([
        ['https://dev.azure.com/acme/Platform/_git/api', repo('acme', 'Platform', 'api')],
        ['https://acme@dev.azure.com/acme/Agora%20App/_git/Agora%20App', repo('acme', 'Agora App', 'Agora App')],
        ['https://dev.azure.com/acme/_git/Platform', repo('acme', 'Platform', 'Platform')],
        ['git@ssh.dev.azure.com:v3/acme/Platform/api', repo('acme', 'Platform', 'api')],
        ['ssh://git@ssh.dev.azure.com:22/v3/acme/Platform/api', repo('acme', 'Platform', 'api')],
        ['https://acme.visualstudio.com/Platform/_git/api', repo('acme', 'Platform', 'api')],
        ['https://acme.visualstudio.com/DefaultCollection/Platform/_git/api', repo('acme', 'Platform', 'api')],
        ['acme@vs-ssh.visualstudio.com:v3/acme/Platform/api', repo('acme', 'Platform', 'api')],
        ['git@bitbucket.org:acme/api.git', undefined],
        ['https://github.com/acme/_git/api', undefined]
    ])('finds the organization, project and repo of %s', (url, expected) => {
        expect(azureRepo(url)).toEqual(expected);
    });

    it.each([
        [
            'https://dev.azure.com/acme/Platform/_git/api/pullrequest/412?_a=files',
            { kind: 'pr', number: 412, repo: repo('acme', 'Platform', 'api') }
        ],
        [
            'https://acme.visualstudio.com/Platform/_git/api/pullrequest/7',
            { kind: 'pr', number: 7, repo: repo('acme', 'Platform', 'api') }
        ],
        ['!412', { kind: 'pr', number: 412 }],
        [
            'https://dev.azure.com/acme/Platform/_git/api',
            { kind: 'branch', branch: 'https://dev.azure.com/acme/Platform/_git/api' }
        ]
    ])('reads the target %s', (target, parsed) => {
        expect(parseTarget(target)).toEqual(parsed);
    });
});
