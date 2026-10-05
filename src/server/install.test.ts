import { mkdir, readFile, readlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempRepo } from '../test/serverHelpers.js';
import { type ClaudeCli, type InstallTarget, install, uninstall } from './install.js';

/** A package with a skill and two agents, and a Claude config holding copies from an older install. */
async function setup(): Promise<{ target: InstallTarget; calls: string[][]; claude: ClaudeCli }> {
    const dir = await tempRepo();
    const pkgRoot = join(dir, 'pkg');
    const configDir = join(dir, 'claude');
    await mkdir(join(pkgRoot, 'skill'), { recursive: true });
    await mkdir(join(pkgRoot, 'agents'), { recursive: true });
    await writeFile(join(pkgRoot, 'skill', 'SKILL.md'), 'new skill');
    await writeFile(join(pkgRoot, 'agents', 'planroom-a.md'), 'agent a');
    await writeFile(join(pkgRoot, 'agents', 'planroom-b.md'), 'agent b');
    await mkdir(join(configDir, 'skills', 'planroom'), { recursive: true });
    await writeFile(join(configDir, 'skills', 'planroom', 'SKILL.md'), 'old copy');
    await mkdir(join(configDir, 'agents'), { recursive: true });
    await writeFile(join(configDir, 'agents', 'planroom-a.md'), 'old copy');
    const calls: string[][] = [];
    const claude: ClaudeCli = (args) => {
        calls.push(args);
        return { status: 0, output: '' };
    };
    return { target: { pkgRoot, configDir, node: '/usr/bin/node' }, calls, claude };
}

describe('planroom install', () => {
    it('links the skill and agents over old copies and registers the user-scope server', async () => {
        const { target, calls, claude } = await setup();
        install(target, claude);

        expect(await readlink(join(target.configDir, 'skills', 'planroom'))).toBe(join(target.pkgRoot, 'skill'));
        expect(await readFile(join(target.configDir, 'skills', 'planroom', 'SKILL.md'), 'utf8')).toBe('new skill');
        for (const agent of ['planroom-a.md', 'planroom-b.md'])
            expect(await readlink(join(target.configDir, 'agents', agent))).toBe(join(target.pkgRoot, 'agents', agent));
        expect(calls).toEqual([
            ['mcp', 'remove', 'planroom', '--scope', 'user'],
            ['mcp', 'add', '--scope', 'user', 'planroom', '--', '/usr/bin/node', join(target.pkgRoot, 'dist', 'cli.js'), 'mcp']
        ]);
    });

    it('reports a failed registration', async () => {
        const { target } = await setup();
        const claude: ClaudeCli = (args) =>
            args[1] === 'add' ? { status: 1, output: 'spawnSync claude ENOENT\n' } : { status: 0, output: '' };
        expect(() => install(target, claude)).toThrow('claude mcp add failed: spawnSync claude ENOENT');
    });

    it('uninstall removes the links and the server, and leaves the package alone', async () => {
        const { target, calls, claude } = await setup();
        install(target, claude);
        uninstall(target, claude);

        await expect(readlink(join(target.configDir, 'skills', 'planroom'))).rejects.toThrow();
        await expect(readlink(join(target.configDir, 'agents', 'planroom-a.md'))).rejects.toThrow();
        expect(await readFile(join(target.pkgRoot, 'skill', 'SKILL.md'), 'utf8')).toBe('new skill');
        expect(calls.at(-1)).toEqual(['mcp', 'remove', 'planroom', '--scope', 'user']);
    });
});
