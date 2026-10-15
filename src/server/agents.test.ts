import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const AGENTS = join(import.meta.dirname, '..', '..', 'agents');

/** An agent file's front matter, as `key: value` lines between its two `---` lines. */
function frontMatter(name: string): Record<string, string> {
    const text = readFileSync(join(AGENTS, name), 'utf8');
    const block = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1];
    if (!block) throw new Error(`${name} has no front matter`);
    return Object.fromEntries(
        block.split('\n').map((line) => {
            const at = line.indexOf(':');
            return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
        })
    );
}

describe('the subagents', () => {
    it('each name themselves by their file, say when to use them, and name their tools and model', () => {
        for (const file of readdirSync(AGENTS).filter((name) => name.endsWith('.md'))) {
            const fields = frontMatter(file);
            expect(fields.name).toBe(file.replace(/\.md$/, ''));
            expect(fields.description?.length).toBeGreaterThan(40);
            expect(fields.tools).toBeTruthy();
            expect(['haiku', 'sonnet', 'opus', 'inherit']).toContain(fields.model);
        }
    });

    it('include the page writer: Sonnet, read only, for the planroom-review skill alone', () => {
        expect(frontMatter('planroom-page-writer.md')).toMatchObject({
            name: 'planroom-page-writer',
            tools: 'Read, Bash',
            model: 'sonnet',
            description: expect.stringContaining('Only the planroom-review skill delegates to it')
        });
    });
});
