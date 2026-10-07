import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { bitbucketAccess } from './server/bitbucket.js';
import { startPageServer } from './server/http.js';
import { type ClaudeCli, claudeConfigDir, type InstallTarget, install, uninstall } from './server/install.js';
import { createPlanroom } from './server/mcp.js';
import { openInBrowser } from './server/opener.js';
import { findOpenSpecRoot, openSpecCli } from './server/openspec.js';
import { listPlans } from './server/plans.js';
import { preferencesFile } from './server/preferences.js';
import { knownRepos, registryFile, rememberRepo } from './server/registry.js';
import { PlanViewer } from './server/viewer.js';

/**
 * The `planroom` command, bundled with the server into `dist/cli.js` beside the built page in `dist/ui`. `mcp` is
 * what Claude Code starts over stdio, as the planning server, with `--ask` the question server or with `--review` the
 * review server; there nothing may write to stdout except the MCP transport. The repo is the nearest directory up from
 * `--dir <path>` (default: the launch directory) with an `openspec/`.
 */

const USAGE = `Usage: planroom <command> [--dir <path>]

Commands:
  mcp [--ask|--review]
                    Run the MCP server that Claude Code starts over stdio: planning, with --ask questions, or with
                    --review reviews
  open [change-id]  Open this repo's plans read-only in the browser, or one plan
  list              List the plans in every repo Planroom has run in
  install           Link the skills and agents into ~/.claude and register the MCP servers
  uninstall         Remove what install added

Options:
  --dir <path>      Use the repo at or above <path> instead of the current directory
  --version         Print the version`;

const pkgRoot = fileURLToPath(new URL('..', import.meta.url));
const uiDir = fileURLToPath(new URL('./ui/', import.meta.url));
const { version }: { version: string } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const registry = registryFile();

const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
        dir: { type: 'string' },
        ask: { type: 'boolean' },
        review: { type: 'boolean' },
        version: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' }
    }
});
const [command, ...rest] = positionals;

/** Print an error and exit non-zero. */
function fail(message: string): never {
    console.error(`planroom: ${message}`);
    process.exit(1);
}

let closeAll: () => Promise<void> = async () => undefined;
let stopping = false;
/** Close Planroom once, however many shutdown signals arrive, then exit with `code`. */
async function stop(code: number): Promise<void> {
    if (stopping) return;
    stopping = true;
    await closeAll().catch((error: unknown) => console.error('planroom: error while closing', error));
    process.exit(code);
}

/** The repo to work in, recorded so pages and `planroom list` elsewhere can find its plans. */
function repo(): { repoRoot: string; openSpecRoot?: string } {
    const startDir = resolve(values.dir ?? process.cwd());
    if (!statSync(startDir, { throwIfNoEntry: false })?.isDirectory()) fail(`--dir ${values.dir} is not a directory`);
    const openSpecRoot = findOpenSpecRoot(startDir);
    // A failure only hides this repo's plans elsewhere.
    if (openSpecRoot) void rememberRepo(registry, openSpecRoot).catch(() => undefined);
    return { repoRoot: openSpecRoot ?? startDir, openSpecRoot };
}

/**
 * Serve the planning server, with `--ask` the question server or with `--review` the review server, over stdio until
 * Claude Code closes it. A review reads its Bitbucket credentials from the environment and git, on the server only.
 */
async function mcp(): Promise<void> {
    const { repoRoot } = repo();
    if (values.ask && values.review) fail('choose --ask or --review, not both');
    const planroom = createPlanroom({
        kind: values.ask ? 'ask' : values.review ? 'review' : 'plan',
        reviewHost: async () => ({ access: await bitbucketAccess(repoRoot), preferencesFile: preferencesFile() }),
        version,
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

/**
 * Serve the plan browser read-only, with no MCP and no agent, until stopped. With a change id, open that plan; when a
 * Claude Code session already has it open, open that session's live page instead.
 */
async function open(changeId: string | undefined): Promise<void> {
    const { repoRoot, openSpecRoot } = repo();
    if (!openSpecRoot) fail(`no openspec/ directory in ${repoRoot} or above it`);
    if (changeId) {
        const plan = (await listPlans(repoRoot)).find((candidate) => candidate.changeId === changeId);
        if (!plan) fail(`${changeId} has no plan in ${repoRoot}`);
        if (plan.liveUrl) {
            console.log(`${changeId} is open in a Claude Code session:\n${plan.liveUrl}`);
            await openInBrowser(plan.liveUrl);
            return;
        }
    }
    const pages = await startPageServer({
        uiDir,
        repoRoot,
        registryFile: registry,
        readOnly: true,
        openPlan: async (id) => pages.add(await PlanViewer.open(repoRoot, id))
    });
    closeAll = () => pages.close();
    const url = changeId ? pages.add(await PlanViewer.open(repoRoot, changeId)) : pages.browseUrl;
    console.log(
        `Planroom ${changeId ? `plan ${changeId}` : 'plan browser'} for ${repoRoot}, read-only:\n${url}\nPress Ctrl+C to stop.`
    );
    await openInBrowser(url);
}

/** Print every known repo's plans, most recently changed first, with the live page of any a session has open. */
async function list(): Promise<void> {
    const repos = await Promise.all((await knownRepos(registry)).map(async (root) => ({ root, plans: await listPlans(root) })));
    const listed = repos.filter((entry) => entry.plans.length > 0);
    if (listed.length === 0) {
        console.log('No plans yet. Planroom lists the repos it has run in.');
        return;
    }
    const idWidth = Math.max(...listed.flatMap((entry) => entry.plans.map((plan) => plan.changeId.length)));
    const statusWidth = Math.max(...listed.flatMap((entry) => entry.plans.map((plan) => plan.status.length)));
    for (const { root, plans } of listed) {
        console.log(root);
        for (const plan of plans) {
            const live = plan.liveUrl ? `  live: ${plan.liveUrl}` : '';
            console.log(
                `  ${plan.changeId.padEnd(idWidth)}  ${plan.status.padEnd(statusWidth)}  ${plan.updatedAt.slice(0, 10)}  ${plan.title}${live}`
            );
        }
    }
}

/** The `claude` CLI, with its output captured so a failure can be reported whole. */
const claude: ClaudeCli = (args) => {
    const result = spawnSync('claude', args, { encoding: 'utf8' });
    return { status: result.status ?? 1, output: `${result.stdout ?? ''}${result.stderr ?? ''}${result.error?.message ?? ''}` };
};

const target: InstallTarget = { pkgRoot, configDir: claudeConfigDir(), node: process.execPath };

process.on('SIGINT', () => void stop(0));
process.on('SIGTERM', () => void stop(0));

if (values.version) {
    console.log(version);
} else if (command === 'mcp') {
    await mcp();
} else if (command === 'open') {
    await open(rest[0]);
} else if (command === 'list') {
    await list();
} else if (command === 'install') {
    install(target, claude);
    console.log(
        `Planroom installed: skills and agents linked into ${target.configDir} from ${pkgRoot}, planroom, planroom-ask and planroom-review MCP servers registered.`
    );
    if (spawnSync('openspec', ['--version']).error)
        console.log(
            'openspec is not on PATH. OpenSpec-format plans need it, pinned in the repo or from npm i -g @fission-ai/openspec.'
        );
    console.log(
        'Running Claude Code sessions keep their old servers: reconnect planroom, planroom-ask and planroom-review in /mcp.'
    );
    console.log('To turn planning, asking or reviewing off, disable its server in /mcp and its skill in /skills.');
    if (!process.env.BITBUCKET_API_TOKEN)
        console.log(
            'To post reviews to Bitbucket, set BITBUCKET_API_TOKEN (scope read:pullrequest:bitbucket) for Claude Code; local branches need none.'
        );
} else if (command === 'uninstall') {
    uninstall(target, claude);
    console.log(`Planroom uninstalled from ${target.configDir}. Plans and their records are left in place.`);
} else {
    console.log(USAGE);
    if (command !== undefined && command !== 'help' && !values.help) process.exit(1);
}
