import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { countDelta, parseSpecDelta, parseTasks } from './specDelta.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const archived = `${repoRoot}openspec/changes/archive/2026-10-05-add-planroom`;
/** `openspec show` only finds active changes, so the archived change is copied into a throwaway repo. */
const tempRoot = mkdtempSync(join(tmpdir(), 'planroom-spec-'));
const changeDir = join(tempRoot, 'openspec', 'changes', 'add-planroom');
cpSync(archived, changeDir, { recursive: true });
afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

/** The part of `openspec show --json` the reader is checked against. */
const openspecShow = z.object({
    deltas: z.array(z.object({ spec: z.string(), requirement: z.object({ scenarios: z.array(z.unknown()) }) }))
});

describe('spec delta reader', () => {
    it('matches openspec show for every spec in add-planroom', () => {
        const shown = openspecShow.parse(
            JSON.parse(
                execFileSync(`${repoRoot}node_modules/.bin/openspec`, ['show', 'add-planroom', '--json', '--no-interactive'], {
                    cwd: tempRoot,
                    encoding: 'utf8'
                })
            )
        );
        const expected: Record<string, { requirements: number; scenarios: number }> = {};
        for (const delta of shown.deltas) {
            const entry = (expected[delta.spec] ??= { requirements: 0, scenarios: 0 });
            entry.requirements += 1;
            entry.scenarios += delta.requirement.scenarios.length;
        }
        const parsed = Object.fromEntries(
            readdirSync(`${changeDir}/specs`).map((spec) => {
                const counts = countDelta(parseSpecDelta(readFileSync(`${changeDir}/specs/${spec}/spec.md`, 'utf8')));
                return [spec, { requirements: counts.ADDED + counts.MODIFIED + counts.REMOVED, scenarios: counts.scenarios }];
            })
        );
        expect(Object.keys(expected).length).toBeGreaterThan(0);
        expect(parsed).toEqual(expected);
    });

    it('reads names, statements, and WHEN/THEN/AND steps', () => {
        const delta = parseSpecDelta(
            [
                '## Purpose',
                '',
                'Limits.',
                '',
                '## ADDED Requirements',
                '',
                '### Requirement: Fail open when the limit store is unavailable',
                '',
                'The API SHALL serve requests',
                'when Redis is down.',
                '',
                '#### Scenario: Redis down',
                '',
                '- **WHEN** Redis times out',
                '- **THEN** the request is served',
                '  and a metric is emitted',
                '- **AND** on-call is paged',
                '',
                '## RENAMED Requirements',
                '',
                '- FROM: `### Requirement: Old name`',
                '- TO: `### Requirement: New name`'
            ].join('\n')
        );
        expect(delta.purpose).toBe('Limits.');
        const [added, renamed] = delta.sections;
        expect(added?.requirements[0]).toEqual({
            name: 'Fail open when the limit store is unavailable',
            text: 'The API SHALL serve requests\nwhen Redis is down.',
            scenarios: [
                {
                    name: 'Redis down',
                    steps: [
                        { keyword: 'WHEN', text: 'Redis times out' },
                        { keyword: 'THEN', text: 'the request is served and a metric is emitted' },
                        { keyword: 'AND', text: 'on-call is paged' }
                    ]
                }
            ]
        });
        expect(renamed?.renames).toEqual([{ from: 'Old name', to: 'New name' }]);
    });

    it('reads a three-hash scenario as statement text rather than a scenario', () => {
        const delta = parseSpecDelta('## ADDED Requirements\n### Requirement: R\nText\n### Scenario: wrong\n- **WHEN** x');
        expect(countDelta(delta).scenarios).toBe(0);
    });

    it('counts task groups', () => {
        expect(parseTasks('## 1. Scaffold\n- [x] 1.1 a\n- [ ] 1.2 b\n## 2. Tests\n- [ ] 2.1 c')).toEqual([
            { title: 'Scaffold', total: 2, done: 1 },
            { title: 'Tests', total: 1, done: 0 }
        ]);
    });
});
