import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { startPageServer } from './http.js';
import { createPlanroom } from './mcp.js';
import { openInBrowser } from './opener.js';
import { findOpenSpecRoot, openSpecCli } from './openspec.js';
import { registryFile, rememberRepo } from './registry.js';
import { PlanViewer } from './viewer.js';

/**
 * Entry point Claude Code spawns over stdio, in the session's launch directory, from
 * this repo's `.mcp.json` or the user-scope install (`scripts/install-user.mjs`). The
 * repo is the nearest directory up from `--dir <path>` (default: the launch directory)
 * with an `openspec/`; the page comes from beside this file. Nothing may write to
 * stdout except the MCP transport.
 *
 * With `--browse` it is instead the standalone plan browser (`pnpm planroom`): the page
 * server alone, with no MCP and no agent, whose page lists the repo's plans and opens
 * each read-only. It prints its URL and runs until stopped.
 */
const { values } = parseArgs({ options: { dir: { type: 'string' }, browse: { type: 'boolean' } } });
const startDir = resolve(values.dir ?? process.cwd());
if (!statSync(startDir, { throwIfNoEntry: false })?.isDirectory())
    throw new Error(`planroom: --dir ${values.dir} is not a directory`);
const openSpecRoot = findOpenSpecRoot(startDir);
const repoRoot = openSpecRoot ?? startDir;
const uiDir = fileURLToPath(new URL('../ui/', import.meta.url));
const registry = registryFile();

// Recorded so pages in other repos can list this one's plans. A failure only hides them there.
if (openSpecRoot) void rememberRepo(registry, openSpecRoot).catch(() => undefined);

let closeAll: () => Promise<void> = async () => undefined;
let stopping = false;
/** Close Planroom once, however many shutdown signals arrive, then exit with `code`. */
async function stop(code: number): Promise<void> {
    if (stopping) return;
    stopping = true;
    await closeAll().catch((error: unknown) => console.error('planroom: error while closing', error));
    process.exit(code);
}
process.on('SIGINT', () => void stop(0));
process.on('SIGTERM', () => void stop(0));

if (values.browse) {
    if (!openSpecRoot) {
        console.error(`planroom: no openspec/ directory in ${startDir} or above it`);
        process.exit(1);
    }
    const pages = await startPageServer({
        uiDir,
        repoRoot,
        registryFile: registry,
        readOnly: true,
        openPlan: async (changeId) => pages.add(await PlanViewer.open(repoRoot, changeId))
    });
    closeAll = () => pages.close();
    console.log(`Planroom plan browser for ${repoRoot}:\n${pages.browseUrl}\nPress Ctrl+C to stop.`);
    await openInBrowser(pages.browseUrl);
} else {
    const planroom = createPlanroom({
        repoRoot,
        uiDir,
        cli: openSpecCli(repoRoot),
        openBrowser: openInBrowser,
        registryFile: registry
    });
    closeAll = () => planroom.close();
    const transport = new StdioServerTransport();
    transport.onclose = () => void stop(0);
    process.stdin.on('end', () => void stop(0));
    await planroom.server.connect(transport);
}
