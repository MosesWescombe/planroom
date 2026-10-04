import { mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Runs the `claude` CLI with these arguments, returning its exit status and output. */
export type ClaudeCli = (args: string[]) => { status: number; output: string };

/** What `planroom install` links from and into. */
export interface InstallTarget {
    /** The installed package root, holding `skill/`, `agents/` and `dist/cli.js`. */
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

/** Every link install makes, as `[link, what it points at]`: the skill folder and each agent file. */
function links({ pkgRoot, configDir }: InstallTarget): Array<[string, string]> {
    const agents = readdirSync(join(pkgRoot, 'agents')).filter((name) => name.endsWith('.md'));
    return [
        [join(configDir, 'skills', 'planroom'), join(pkgRoot, 'skill')],
        ...agents.map((name): [string, string] => [join(configDir, 'agents', name), join(pkgRoot, 'agents', name)])
    ];
}

/**
 * Link the skill and agents into the Claude config, replacing earlier copies or links, and register the user-scope
 * `planroom` MCP server. Links rather than copies, so upgrading the package upgrades the skill, the agents and the
 * server together.
 */
export function install(target: InstallTarget, claude: ClaudeCli): void {
    for (const [link, to] of links(target)) {
        mkdirSync(dirname(link), { recursive: true });
        rmSync(link, { recursive: true, force: true });
        symlinkSync(to, link);
    }
    // Absent on a first install, which is fine.
    claude(['mcp', 'remove', 'planroom', '--scope', 'user']);
    const added = claude([
        'mcp',
        'add',
        '--scope',
        'user',
        'planroom',
        '--',
        target.node,
        join(target.pkgRoot, 'dist', 'cli.js'),
        'mcp'
    ]);
    if (added.status !== 0) throw new Error(`claude mcp add failed: ${added.output.trim()}`);
}

/** Remove the links and the MCP server that `install` made. The package itself is left alone. */
export function uninstall(target: InstallTarget, claude: ClaudeCli): void {
    for (const [link] of links(target)) rmSync(link, { recursive: true, force: true });
    claude(['mcp', 'remove', 'planroom', '--scope', 'user']);
}
