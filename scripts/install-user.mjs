/**
 * Installs Planroom for every repo on this machine, independent of this checkout:
 * - `~/.local/share/planroom/`: the server as one self-contained bundle and the built page,
 * - the skill and both subagents in the user's Claude config (`~/.claude`, or `$CLAUDE_CONFIG_DIR`),
 * - a user-scope `planroom` MCP server. A repo's own `.mcp.json` entry, like this one's, still wins there.
 *
 * Run via `pnpm setup:planroom`, which builds the page first. Re-run it after changing Planroom.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const pkg = fileURLToPath(new URL('..', import.meta.url));
const repo = join(pkg, '..', '..');
const target = join(homedir(), '.local', 'share', 'planroom');
const staging = `${target}.next`;
const config = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');

// Build beside the old install, so a failed build leaves it working.
rmSync(staging, { recursive: true, force: true });
await build({
    configFile: false,
    logLevel: 'warn',
    ssr: { noExternal: true, target: 'node' },
    build: {
        ssr: join(pkg, 'src', 'server', 'main.ts'),
        outDir: join(staging, 'server'),
        target: 'node22',
        rollupOptions: {
            output: { entryFileNames: 'main.js' },
            // zod's misplaced `@__PURE__` comments; Rollup drops them, which changes nothing.
            onwarn: (warning, warn) => warning.code === 'INVALID_ANNOTATION' || warn(warning)
        }
    }
});
cpSync(join(pkg, 'dist', 'ui'), join(staging, 'ui'), { recursive: true, filter: (file) => !file.endsWith('.map') });
writeFileSync(join(staging, 'package.json'), '{ "type": "module" }\n');
rmSync(target, { recursive: true, force: true });
renameSync(staging, target);

const skill = join(config, 'skills', 'planroom');
rmSync(skill, { recursive: true, force: true });
cpSync(join(repo, '.agents', 'skills', 'planroom'), skill, { recursive: true });
mkdirSync(join(config, 'agents'), { recursive: true });
for (const agent of readdirSync(join(repo, '.agents', 'agents')).filter((name) => name.startsWith('planroom-')))
    cpSync(join(repo, '.agents', 'agents', agent), join(config, 'agents', agent));

const server = join(target, 'server', 'main.js');
spawnSync('claude', ['mcp', 'remove', 'planroom', '--scope', 'user'], { stdio: 'ignore' });
execFileSync('claude', ['mcp', 'add', '--scope', 'user', 'planroom', '--', 'node', server], { stdio: 'inherit' });

console.log(`Planroom installed: ${target}, skill and agents in ${config}.`);
console.log('Running Claude Code sessions keep their old server: reconnect planroom in /mcp.');
