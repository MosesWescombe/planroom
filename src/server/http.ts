import { execFile } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { repoPath } from '../shared/blocks.js';
import type { Revision } from '../shared/revisions.js';
import type { Patch, StreamMessage, View } from '../shared/view.js';
import { RejectedError } from './draft.js';
import { isErrno } from './fsutil.js';
import { ChangeLockedError } from './lock.js';
import { listPlans, listPlansElsewhere } from './plans.js';
import { PlanViewer } from './viewer.js';

/** The most lines one code excerpt returns. */
const MAX_EXCERPT_LINES = 400;
const HEARTBEAT_MS = 15_000;
const ASSET_NAME = /^[\w.-]+\.(png|jpe?g|gif|webp|svg)$/i;
/** The image types the page can paste, by the extension each is saved under. SVG is left out: it can carry script. */
const PASTE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

/** A code excerpt for a `code` block, read from a git-tracked file. */
export interface CodeExcerpt {
    file: string;
    start: number;
    end: number;
    lines: string[];
}

/** What a plan's page shows and acts on: a live `Session`, or a `PlanViewer` that refuses every write. */
export interface ServedPlan {
    view(): View;
    subscribe(listener: (patches: Patch[]) => void): () => void;
    handlePage(input: unknown): Promise<{ seq?: number }>;
    revision(n: number): Revision | undefined;
    readonly store: { readonly assetsDir: string };
}

export interface PageServer {
    readonly port: number;
    readonly origin: string;
    /** The plan browser's page URL, which shows no plan: it lists them, and opens one through `openPlan`. */
    readonly browseUrl: string;
    /** Serve a plan under a fresh token and return its page URL. */
    add(plan: ServedPlan): string;
    /** Stop serving a plan: its token stops working and its open streams end. */
    remove(plan: ServedPlan): void;
    close(): Promise<void>;
}

export interface PageServerOptions {
    /** The built SPA (`dist/ui`). */
    uiDir: string;
    /** Code excerpts are read from git-tracked files under this root, and plans from its `openspec/changes/`. */
    repoRoot: string;
    /** Switch the page to another plan by change id, resolving with its page URL. */
    openPlan: (changeId: string) => Promise<string>;
    /** The list of repos Planroom has run in, whose plans the switcher also shows. Unset: this repo's only. */
    registryFile?: string;
    /** Whether `openPlan` shows plans read-only, as the standalone browser does; the browse page says so. */
    readOnly?: boolean;
}

/** One token's page: a plan, or the plan browser when `plan` is unset. */
interface Served {
    token: Buffer;
    plan?: ServedPlan;
    streams: Set<Response>;
}

/** The plan a request's page shows; the routes that need one are behind `needsPlan`. */
function planOf(res: Response): ServedPlan {
    const { plan } = res.locals.served as Served;
    if (!plan) throw new Error('planOf outside needsPlan');
    return plan;
}

/** Refuse a plan's API on the plan browser's page, which shows none. */
function needsPlan<P>(_req: Request<P>, res: Response, next: NextFunction): void {
    if ((res.locals.served as Served).plan) next();
    else res.status(404).json({ error: 'the plan browser shows no plan' });
}

/** Compare a request's token with the session's in constant time. */
function sameToken(given: string, expected: Buffer): boolean {
    const buffer = Buffer.from(given);
    return buffer.length === expected.length && timingSafeEqual(buffer, expected);
}

/** Whether git tracks `file` under `repoRoot`. */
function isTracked(repoRoot: string, file: string): Promise<boolean> {
    return new Promise((resolve) => {
        execFile('git', ['ls-files', '--error-unmatch', '--', file], { cwd: repoRoot }, (error) => resolve(!error));
    });
}

/** Read lines `start`-`end` (1-based, inclusive) of a git-tracked file, or reject why not. */
export async function readExcerpt(repoRoot: string, file: string, lines: string): Promise<CodeExcerpt> {
    if (!repoPath.safeParse(file).success)
        throw new RejectedError([{ path: 'file', message: 'must be a repo-relative path' }], 400);
    const range = /^(\d+)(?:-(\d+))?$/.exec(lines);
    if (!range) throw new RejectedError([{ path: 'lines', message: 'must be a line number or a range such as "12-15"' }], 400);
    const start = Math.max(1, Number(range[1]));
    const end = Math.min(Number(range[2] ?? range[1]), start + MAX_EXCERPT_LINES - 1);
    if (end < start) throw new RejectedError([{ path: 'lines', message: 'the range ends before it starts' }], 400);
    if (!(await isTracked(repoRoot, file)))
        throw new RejectedError([{ path: 'file', message: `${file} is not a file git tracks` }], 404);
    const text = await fs.readFile(join(repoRoot, file), 'utf8');
    return { file, start, end, lines: text.split('\n').slice(start - 1, end) };
}

/** End a page's event stream, telling it first that the session is closed so it stops reconnecting. */
function endStream(stream: Response): void {
    const closed: StreamMessage = { type: 'closed' };
    stream.end(`data: ${JSON.stringify(closed)}\n\n`);
}

/** Answer with a rejection's status and issues, or a 500 for anything else. */
function sendError(res: Response, error: unknown): void {
    if (error instanceof RejectedError) {
        res.status(error.status).json({ error: error.message, issues: error.issues });
        return;
    }
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
}

/**
 * The page's web server: `127.0.0.1` on an OS-assigned port, one unguessable token
 * per session in every path, and `Host` and `Origin` checks so neither another site
 * nor a DNS-rebound name can read the page or post events into the agent session.
 */
export async function startPageServer(options: PageServerOptions): Promise<PageServer> {
    const served = new Set<Served>();
    const app = express();
    app.disable('x-powered-by');
    app.set('etag', false);
    let port = 0;
    const originOf = () => `http://127.0.0.1:${port}`;

    app.use((req: Request, res: Response, next: NextFunction) => {
        if (req.headers.host !== `127.0.0.1:${port}`) {
            res.status(403).json({ error: 'wrong Host' });
            return;
        }
        const origin = req.headers.origin;
        if (origin !== undefined && origin !== originOf()) {
            res.status(403).json({ error: 'cross-origin request refused' });
            return;
        }
        res.setHeader('X-Content-Type-Options', 'nosniff');
        // The token is in every path, so no request may carry it elsewhere as a referrer.
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Cache-Control', 'no-store');
        next();
    });

    const router = express.Router({ mergeParams: true });

    router.get('/', (_req, res) => {
        res.setHeader(
            'Content-Security-Policy',
            [
                "default-src 'self'",
                "script-src 'self'",
                "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
                'font-src https://fonts.gstatic.com',
                "img-src 'self' data: blob:",
                "connect-src 'self'",
                "object-src 'none'",
                "base-uri 'none'",
                "frame-ancestors 'none'"
            ].join('; ')
        );
        // `root`, so a dot directory above it (`~/.nvm`, `~/.npm/_npx`) is not taken for a hidden file.
        res.sendFile('index.html', { root: options.uiDir }, (error) => {
            if (error && !res.headersSent)
                res.status(503).type('text').send('The Planroom page is not built. Run pnpm build in the Planroom checkout.');
        });
    });

    router.get('/api/stream', (req, res) => {
        const entry = res.locals.served as Served;
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        const send = (message: StreamMessage) => res.write(`data: ${JSON.stringify(message)}\n\n`);
        res.write('retry: 1000\n\n');
        send(
            entry.plan ? { type: 'snapshot', view: entry.plan.view() } : { type: 'browse', readOnly: options.readOnly ?? false }
        );
        const unsubscribe = entry.plan?.subscribe((patches) => send({ type: 'patch', patches }));
        const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
        heartbeat.unref();
        entry.streams.add(res);
        req.on('close', () => {
            clearInterval(heartbeat);
            unsubscribe?.();
            entry.streams.delete(res);
        });
    });

    // Room for a message's ten attachments, each a text snippet of up to MAX_SNIPPET characters.
    router.post('/api/events', needsPlan, express.json({ limit: '1mb' }), async (req, res) => {
        if (!req.is('application/json')) {
            res.status(415).json({ error: 'send application/json' });
            return;
        }
        try {
            res.json(await planOf(res).handlePage(req.body));
        } catch (error) {
            sendError(res, error);
        }
    });

    router.get('/api/plans', async (_req, res) => {
        try {
            const [plans, elsewhere] = await Promise.all([
                listPlans(options.repoRoot),
                options.registryFile ? listPlansElsewhere(options.registryFile, options.repoRoot) : []
            ]);
            res.json({ plans, elsewhere });
        } catch (error) {
            sendError(res, error);
        }
    });

    router.post('/api/plans/open', express.json(), async (req, res) => {
        const changeId: unknown = req.body?.changeId;
        if (typeof changeId !== 'string') {
            res.status(400).json({ error: 'send { changeId }' });
            return;
        }
        try {
            res.json({ url: await options.openPlan(changeId) });
        } catch (error) {
            sendError(
                res,
                error instanceof ChangeLockedError
                    ? new RejectedError([{ path: 'changeId', message: error.message }], 409)
                    : error
            );
        }
    });

    router.get('/api/revisions/:n', needsPlan, (req, res) => {
        const revision = planOf(res).revision(Number(req.params.n));
        if (!revision) res.status(404).json({ error: `revision ${req.params.n} does not exist` });
        else res.json(revision);
    });

    router.get('/api/code', async (req, res) => {
        try {
            res.json(await readExcerpt(options.repoRoot, String(req.query.file ?? ''), String(req.query.lines ?? '')));
        } catch (error) {
            sendError(
                res,
                isErrno(error, 'ENOENT') ? new RejectedError([{ path: 'file', message: 'file not found' }], 404) : error
            );
        }
    });

    router.post('/api/assets', needsPlan, express.raw({ type: Object.keys(PASTE_TYPES), limit: '10mb' }), async (req, res) => {
        const plan = planOf(res);
        if (plan instanceof PlanViewer) {
            res.status(409).json({ error: 'this plan is open read-only' });
            return;
        }
        const extension = PASTE_TYPES[(req.headers['content-type'] ?? '').split(';')[0]!.trim()];
        if (!extension || !Buffer.isBuffer(req.body) || req.body.length === 0) {
            res.status(415).json({ error: `paste a ${Object.values(PASTE_TYPES).join(', ')} image` });
            return;
        }
        const { assetsDir } = plan.store;
        const name = `paste-${randomBytes(8).toString('hex')}.${extension}`;
        try {
            await fs.mkdir(assetsDir, { recursive: true });
            await fs.writeFile(join(assetsDir, name), req.body, { flag: 'wx' });
            res.json({ asset: name });
        } catch (error) {
            sendError(res, error);
        }
    });

    router.get('/api/assets/:name', needsPlan, (req, res) => {
        const name = req.params.name ?? '';
        if (!ASSET_NAME.test(name)) {
            res.status(400).json({ error: 'not an asset name' });
            return;
        }
        // An SVG opened directly must not run script in the page's origin.
        res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
        // `root`, as assets live under `.planroom/`, which a rootless `sendFile` refuses as a dotfile.
        res.sendFile(name, { root: planOf(res).store.assetsDir }, (error) => {
            if (error && !res.headersSent) res.status(404).json({ error: `asset ${name} not found` });
        });
    });

    router.use(
        express.static(options.uiDir, {
            index: false,
            fallthrough: true,
            setHeaders: (res) => res.setHeader('Cache-Control', 'no-store')
        })
    );

    app.use(
        '/:token',
        (req: Request<{ token: string }>, res: Response, next: NextFunction) => {
            const token = req.params.token ?? '';
            const entry = [...served].find((candidate) => sameToken(token, candidate.token));
            if (!entry) {
                res.status(404).json({ error: 'no such session' });
                return;
            }
            if (req.method === 'GET' && req.originalUrl === `/${token}`) {
                res.redirect(`/${token}/`);
                return;
            }
            res.locals.served = entry;
            next();
        },
        router
    );

    app.use((_req, res) => {
        res.status(404).json({ error: 'not found' });
    });

    const http: HttpServer = await new Promise((resolve, reject) => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
        listening.once('error', reject);
    });
    port = (http.address() as AddressInfo).port;

    /** Serve a page under a fresh token and return its URL. */
    const serve = (plan?: ServedPlan): string => {
        const token = randomBytes(32).toString('base64url');
        served.add({ token: Buffer.from(token), ...(plan ? { plan } : {}), streams: new Set() });
        return `${originOf()}/${token}/`;
    };
    const browseUrl = serve();

    return {
        port,
        origin: originOf(),
        browseUrl,
        add: serve,
        remove(plan) {
            for (const entry of [...served]) {
                if (entry.plan !== plan) continue;
                served.delete(entry);
                for (const stream of entry.streams) endStream(stream);
            }
        },
        async close() {
            for (const entry of served) for (const stream of entry.streams) endStream(stream);
            served.clear();
            await new Promise<void>((resolve) => http.close(() => resolve()));
        }
    };
}
