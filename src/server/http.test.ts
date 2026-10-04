import { request } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Patch, StreamMessage, View } from '../shared/view.js';
import { CHANGE, defined, harness, onCleanup, rejection, tempRepo, textBlock, upsert, section } from '../test/serverHelpers.js';
import { type PageServer, startPageServer } from './http.js';
import { PlanViewer } from './viewer.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

interface Raw {
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: string;
}

/** A request with full control over headers, including Host, which fetch will not set. */
function raw(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Raw> {
    return new Promise((resolve, reject) => {
        const req = request(
            { host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } },
            (res) => {
                let text = '';
                res.setEncoding('utf8');
                res.on('data', (chunk: string) => (text += chunk));
                res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
            }
        );
        req.on('error', reject);
        req.end(body);
    });
}

const isObject = (value: unknown) => typeof value === 'object' && value !== null;

/** A stream frame: its envelope is checked, and the view or patches it carries are taken as the server's own types. */
const streamMessage = z.discriminatedUnion('type', [
    z.object({ type: z.literal('snapshot'), view: z.custom<View>(isObject) }),
    z.object({ type: z.literal('patch'), patches: z.array(z.custom<Patch>(isObject)) }),
    z.object({ type: z.literal('closed') }),
    z.object({ type: z.literal('browse'), readOnly: z.boolean() })
]);

/** Read server-sent messages from a stream until `done` says enough have arrived. */
async function readStream(
    url: string,
    done: (messages: StreamMessage[]) => boolean,
    signal: AbortSignal
): Promise<StreamMessage[]> {
    const response = await fetch(url, { signal });
    const reader = defined(response.body, 'the stream body').getReader();
    const decoder = new TextDecoder();
    const messages: StreamMessage[] = [];
    let buffer = '';
    while (!done(messages)) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const value = chunk.value;
        buffer += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const data = frame.split('\n').find((line) => line.startsWith('data: '));
            if (data) messages.push(streamMessage.parse(JSON.parse(data.slice(6))));
        }
    }
    return messages;
}

async function served() {
    const h = await harness();
    const uiDir = await tempRepo();
    await writeFile(join(uiDir, 'index.html'), '<!doctype html><title>Planroom</title>');
    await mkdir(join(uiDir, 'assets'));
    await writeFile(join(uiDir, 'assets', 'app.js'), 'console.log(1)');
    const pages: PageServer = await startPageServer({
        uiDir,
        repoRoot,
        openPlan: () => Promise.reject(new Error('plan switching is covered in mcp.test.ts'))
    });
    onCleanup(() => pages.close());
    const url = pages.add(h.session);
    const path = new URL(url).pathname;
    const answerBody = JSON.stringify({ type: 'question.suggest', text: 'Should internal keys skip limits?' });
    return { ...h, pages, url, path, port: pages.port, answerBody };
}

const json = { 'content-type': 'application/json' };

describe('the page is private to the local session', () => {
    it('serves the page, its assets and API under the token, on 127.0.0.1', async () => {
        const { url, port, path } = await served();
        expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[\w-]{43}\/$/);
        const page = await raw(port, 'GET', path);
        expect(page.status).toBe(200);
        expect(page.body).toContain('<title>Planroom</title>');
        expect(page.headers['content-security-policy']).toContain("script-src 'self'");
        expect(page.headers['referrer-policy']).toBe('no-referrer');
        expect((await raw(port, 'GET', `${path}assets/app.js`)).status).toBe(200);
        expect((await raw(port, 'GET', path.slice(0, -1))).status).toBe(302);
    });

    it('posts events and acknowledges each with its seq', async () => {
        const { port, path, answerBody, session } = await served();
        const res = await raw(port, 'POST', `${path}api/events`, json, answerBody);
        expect(res.status).toBe(200);
        expect(JSON.parse(res.body)).toEqual({ seq: 1 });
        expect(session.delivery.lastSeq).toBe(1);
    });

    it('missing token: rejected and no event recorded', async () => {
        const { port, answerBody, session } = await served();
        expect((await raw(port, 'POST', '/api/events', json, answerBody)).status).toBe(404);
        expect((await raw(port, 'POST', '/not-the-token/api/events', json, answerBody)).status).toBe(404);
        expect(session.delivery.lastSeq).toBe(0);
    });

    it('cross-site request: rejected on its Origin and no event recorded', async () => {
        const { port, path, answerBody, session } = await served();
        const res = await raw(port, 'POST', `${path}api/events`, { ...json, origin: 'https://evil.example' }, answerBody);
        expect(res.status).toBe(403);
        expect(session.delivery.lastSeq).toBe(0);
        expect(
            (await raw(port, 'POST', `${path}api/events`, { ...json, origin: `http://127.0.0.1:${port}` }, answerBody)).status
        ).toBe(200);
    });

    it('rejects a DNS-rebound Host and a form-encoded post', async () => {
        const { port, path, answerBody, session } = await served();
        expect((await raw(port, 'GET', path, { host: `evil.example:${port}` })).status).toBe(403);
        expect((await raw(port, 'POST', `${path}api/events`, { host: `localhost:${port}`, ...json }, answerBody)).status).toBe(
            403
        );
        expect((await raw(port, 'POST', `${path}api/events`, { 'content-type': 'text/plain' }, answerBody)).status).toBe(415);
        expect(session.delivery.lastSeq).toBe(0);
    });

    it('answers a rejected event with its status and issues', async () => {
        const { port, path } = await served();
        const res = await raw(
            port,
            'POST',
            `${path}api/events`,
            json,
            JSON.stringify({ type: 'question.reopen', questionId: 'Q-1' })
        );
        expect(res.status).toBe(404);
        expect(JSON.parse(res.body)).toMatchObject({ issues: [{ path: 'questionId', message: 'question Q-1 does not exist' }] });
    });

    it('stops serving a removed session', async () => {
        const { pages, session, port, path } = await served();
        pages.remove(session);
        expect((await raw(port, 'GET', path)).status).toBe(404);
    });
});

describe('the event stream', () => {
    it('sends a snapshot, then record patches', async () => {
        const { url, session } = await served();
        const controller = new AbortController();
        onCleanup(async () => controller.abort());
        const questionPatch = (message: StreamMessage) =>
            message.type === 'patch' ? message.patches.find((p) => p.field === 'questions') : undefined;
        const reading = readStream(`${url}api/stream`, (messages) => messages.some(questionPatch), controller.signal);
        await new Promise((resolve) => setTimeout(resolve, 50));
        await session.emit({ events: [upsert('Q-12')] });
        const messages = await reading;
        expect(messages[0]).toMatchObject({ type: 'snapshot', view: { changeId: 'add-api-rate-limiting', questions: {} } });
        expect(messages.map(questionPatch).find(Boolean)).toMatchObject({ id: 'Q-12', value: { version: 1 } });
    });

    it('a reconnect receives a fresh snapshot with everything applied since', async () => {
        const { url, session } = await served();
        await session.emit({ events: [upsert('Q-12'), upsert('Q-13')] });
        const controller = new AbortController();
        onCleanup(async () => controller.abort());
        const [snapshot] = await readStream(`${url}api/stream`, (messages) => messages.length > 0, controller.signal);
        expect(snapshot?.type === 'snapshot' && Object.keys(snapshot.view.questions)).toEqual(['Q-12', 'Q-13']);
    });

    it('tells an open page its session closed when the session stops being served', async () => {
        const { url, pages, session } = await served();
        const controller = new AbortController();
        onCleanup(async () => controller.abort());
        const reading = readStream(`${url}api/stream`, () => false, controller.signal);
        await new Promise((resolve) => setTimeout(resolve, 50));
        pages.remove(session);
        expect((await reading).map((message) => message.type)).toEqual(['snapshot', 'closed']);
    });
});

describe('page data', () => {
    it('returns a full write-up revision', async () => {
        const { session, port, path } = await served();
        await session.emit({ events: [textBlock('b1', 'Hi'), section('s1', 1, ['b1'])] });
        expect(JSON.parse((await raw(port, 'GET', `${path}api/revisions/1`)).body)).toMatchObject({
            n: 1,
            changes: [{ id: 'b1' }, { id: 's1' }]
        });
        expect((await raw(port, 'GET', `${path}api/revisions/9`)).status).toBe(404);
    });

    it('reads code excerpts only from git-tracked files', async () => {
        const { port, path } = await served();
        const excerpt = JSON.parse((await raw(port, 'GET', `${path}api/code?file=package.json&lines=1-2`)).body);
        expect(excerpt).toMatchObject({
            file: 'package.json',
            start: 1,
            end: 2,
            lines: ['{', expect.stringContaining('"name"')]
        });
        expect((await raw(port, 'GET', `${path}api/code?file=../../etc/passwd&lines=1`)).status).toBe(400);
        expect((await raw(port, 'GET', `${path}api/code?file=node_modules/.modules.yaml&lines=1`)).status).toBe(404);
    });

    it('serves change assets sandboxed', async () => {
        const { session, port, path } = await served();
        await mkdir(session.store.assetsDir, { recursive: true });
        await writeFile(
            join(session.store.assetsDir, 'shot.svg'),
            '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
        );
        const asset = await raw(port, 'GET', `${path}api/assets/shot.svg`);
        expect(asset.status).toBe(200);
        expect(asset.headers['content-security-policy']).toContain('sandbox');
        expect((await raw(port, 'GET', `${path}api/assets/..%2Fstate.json`)).status).toBe(400);
        expect((await raw(port, 'GET', `${path}api/assets/missing.png`)).status).toBe(404);
    });

    it('pasted screenshot: saved as a new asset, and anything but a raster image is refused', async () => {
        const { port, path } = await served();
        const saved = await raw(port, 'POST', `${path}api/assets`, { 'content-type': 'image/png' }, 'PNGDATA');
        expect(saved.status).toBe(200);
        const { asset } = z.object({ asset: z.string() }).parse(JSON.parse(saved.body));
        expect(asset).toMatch(/^paste-[0-9a-f]{16}\.png$/);
        expect((await raw(port, 'GET', `${path}api/assets/${asset}`)).body).toBe('PNGDATA');
        const svg = await raw(port, 'POST', `${path}api/assets`, { 'content-type': 'image/svg+xml' }, '<svg/>');
        expect(svg.status).toBe(415);
        expect((await raw(port, 'POST', `${path}api/assets`, { 'content-type': 'image/png' }, '')).status).toBe(415);
    });
});

describe('a plan shown read-only', () => {
    it('shows the plan as it was saved, takes no lock, and refuses every write', async () => {
        const { session, repo, pages, answerBody } = await served();
        await session.emit({ events: [upsert('Q-12'), textBlock('b1', 'Hi'), section('s1', 1, ['b1'])] });
        await session.close();
        const viewer = await PlanViewer.open(repo, CHANGE);
        expect(existsSync(session.store.lockFile)).toBe(false);
        const url = pages.add(viewer);
        const { port } = pages;
        const path = new URL(url).pathname;

        const controller = new AbortController();
        const [snapshot] = await readStream(`${url}api/stream`, (messages) => messages.length > 0, controller.signal);
        controller.abort();
        expect(snapshot).toMatchObject({
            type: 'snapshot',
            view: { changeId: CHANGE, viewOnly: true, agent: { mode: 'offline' } }
        });
        expect(snapshot?.type === 'snapshot' && Object.keys(snapshot.view.questions)).toEqual(['Q-12']);
        expect(JSON.parse((await raw(port, 'GET', `${path}api/revisions/1`)).body)).toMatchObject({ n: 1 });

        const saved = await readFile(session.store.stateFile, 'utf8');
        expect((await raw(port, 'POST', `${path}api/events`, json, answerBody)).status).toBe(409);
        expect((await raw(port, 'POST', `${path}api/assets`, { 'content-type': 'image/png' }, 'PNGDATA')).status).toBe(409);
        expect(await readFile(session.store.stateFile, 'utf8')).toBe(saved);
    });

    it('opens only a change that has a plan', async () => {
        const repo = await tempRepo();
        expect((await rejection(PlanViewer.open(repo, 'add-unknown'))).status).toBe(404);
        expect(existsSync(join(repo, 'openspec', 'changes', 'add-unknown'))).toBe(false);
    });
});
