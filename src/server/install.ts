import { mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { SERVER_NAMES } from './mcp.js';

/** Runs the `claude` CLI with these arguments, returning its exit status and output. */
export type ClaudeCli = (args: string[]) => { status: number; output: string };

/** What `planroom install` links from and into. */
export interface InstallTarget {
    /** The installed package root, holding `skills/`, `agents/` and `dist/cli.js`. */
    pkgRoot: string;
    /** The Claude Code config directory: `$CLAUDE_CONFIG_DIR`, by default `~/.claude`. */
    configDir: string;
    /** The node binary the MCP server runs on, as an absolute path so it does not depend on Claude Code's PATH. */
    node: string;
}

/** The Claude Code config directory, as Claude Code itself resolves it. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
    return env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

/**
 * The three Planrooms install sets up, each its skill from `skills/<name>` plus a user-scope MCP server of the same name
 * running `planroom <args>`, so a user can turn planning, asking or reviewing off on its own in `/skills` and `/mcp`.
 */
const PLANROOMS = [
    { name: SERVER_NAMES.plan, args: ['mcp'] },
    { name: SERVER_NAMES.ask, args: ['mcp', '--ask'] },
    { name: SERVER_NAMES.review, args: ['mcp', '--review'] }
];

/** Every link install makes, as `[link, what it points at]`: each skill folder and each agent file. */
function links({ pkgRoot, configDir }: InstallTarget): Array<[string, string]> {
    const agents = readdirSync(join(pkgRoot, 'agents')).filter((name) => name.endsWith('.md'));
    return [
        ...PLANROOMS.map(({ name }): [string, string] => [join(configDir, 'skills', name), join(pkgRoot, 'skills', name)]),
        ...agents.map((name): [string, string] => [join(configDir, 'agents', name), join(pkgRoot, 'agents', name)])
    ];
}

/**
 * Link the skills and agents into the Claude config, replacing earlier copies or links, and register the user-scope
 * `planroom`, `planroom-ask` and `planroom-review` MCP servers. Links rather than copies, so upgrading the package upgrades the skills,
 * the agents and the servers together.
 */
export function install(target: InstallTarget, claude: ClaudeCli): void {
    for (const [link, to] of links(target)) {
        mkdirSync(dirname(link), { recursive: true });
        rmSync(link, { recursive: true, force: true });
        symlinkSync(to, link);
    }
    for (const { name, args } of PLANROOMS) {
        // Absent on a first install, which is fine.
        claude(['mcp', 'remove', name, '--scope', 'user']);
        const added = claude([
            'mcp',
            'add',
            '--scope',
            'user',
            name,
            '--',
            target.node,
            join(target.pkgRoot, 'dist', 'cli.js'),
            ...args
        ]);
        if (added.status !== 0) throw new Error(`claude mcp add ${name} failed: ${added.output.trim()}`);
    }
}

/** Remove the links and the MCP servers that `install` made. The package itself is left alone. */
export function uninstall(target: InstallTarget, claude: ClaudeCli): void {
    for (const [link] of links(target)) rmSync(link, { recursive: true, force: true });
    for (const { name } of PLANROOMS) claude(['mcp', 'remove', name, '--scope', 'user']);
}
