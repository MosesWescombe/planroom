import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loggedEvent } from '../shared/events.js';
import { connect } from '../test/serverHelpers.js';
import { openSpecCli } from './openspec.js';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const openspecBin = join(repoRoot, 'node_modules', '.bin', 'openspec');
const CHANGE = 'add-api-rate-limiting';

/**
 * One planning session end to end: the agent side drives the MCP tools through the
 * SDK's in-memory client, the page side posts to the real HTTP server with fetch, and
 * validation runs the real OpenSpec CLI against the change folder the agent writes.
 */
describe('Planroom end to end', () => {
    it('opens, round-trips a question and a comment, submits, validates and accepts', async () => {
        const { call, repo } = await connect({ cli: (dir) => openSpecCli(dir, openspecBin) });

        // Open: the change is scaffolded and the page is served.
        const opened = (await call('planroom_open', { changeId: CHANGE, title: 'API rate limiting' })).body;
        expect(opened).toMatchObject({ resumed: false, phase: 'interrogate', cursor: 0 });
        const page = async (event: Record<string, unknown>) => {
            const res = await fetch(`${opened.url}api/events`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(event)
            });
            const body = await res.json();
            expect(res.status, JSON.stringify(body)).toBe(200);
        };
        let cursor = 0;
        const next = async () => {
            const { body } = await call('planroom_wait', { after: cursor, timeoutSec: 5 });
            cursor = body.cursor;
            return z.array(loggedEvent).parse(body.events);
        };

        // A question round trip.
        await call('planroom_emit', {
            events: [
                {
                    type: 'question.upsert',
                    question: {
                        id: 'Q-12',
                        group: 'deep-dive/failure-modes',
                        title: 'When Redis is unreachable, should the API fail open or fail closed?',
                        impact: 'high',
                        input: 'single',
                        options: [
                            { id: 'open', label: 'Fail open', recommended: true },
                            { id: 'closed', label: 'Fail closed' }
                        ]
                    }
                },
                { type: 'understanding.update', text: 'Per-key limits on the public API.' }
            ]
        });
        await page({ type: 'answer.submit', questionId: 'Q-12', version: 1, answer: { choice: 'open', note: 'Page on-call' } });
        expect(await next()).toMatchObject([
            { type: 'answer.submit', questionId: 'Q-12', summary: 'Fail open', answer: { note: 'Page on-call' } }
        ]);

        // A comment round trip.
        const text = 'When Redis is unreachable, should the API fail open or fail closed?';
        const start = text.indexOf('fail open');
        await page({
            type: 'comment.create',
            anchor: {
                target: 'question:Q-12',
                position: { start, end: start + 9 },
                quote: { exact: 'fail open', prefix: text.slice(0, start), suffix: ' or fail closed?' }
            },
            intent: 'question',
            text: 'Does this cover the EU edge?'
        });
        const [comment] = await next();
        expect(comment).toMatchObject({ type: 'comment.create', threadId: 'C-1', intent: 'question' });
        await call('planroom_emit', {
            events: [{ type: 'comment.reply', threadId: 'C-1', text: 'Yes, every region fails open.', resolve: true }]
        });

        // Phase 1 completes; the agent writes the write-up; the user reviews and submits.
        await page({ type: 'phase.complete', path: 'finished' });
        expect(await next()).toMatchObject([{ type: 'phase.complete', path: 'finished', assumptions: [] }]);
        const emitted = await call('planroom_emit', {
            summary: 'First draft',
            events: [
                {
                    type: 'doc.block.upsert',
                    block: {
                        id: 's1-text',
                        type: 'text',
                        config: { body: 'We **fail open** when Redis is down (Q-12).' },
                        refs: ['Q-12']
                    }
                },
                { type: 'doc.section.upsert', section: { id: 's1', title: 'Summary', order: 1, blocks: ['s1-text'] } }
            ]
        });
        expect(emitted.body.revision).toBe(1);
        await page({ type: 'review.mark', sectionId: 's1', reviewed: true });
        await page({ type: 'phase.submit', changeId: CHANGE, revision: 1, validate: true });
        const submitted = await next();
        expect(submitted.at(-1)).toMatchObject({
            type: 'phase.submit',
            changeId: CHANGE,
            revision: 1,
            validate: true,
            outstanding: []
        });

        // The agent writes the change, traces it, and reports it ready; the server validates.
        const dir = join(repo, 'openspec', 'changes', CHANGE);
        await writeFile(
            join(dir, 'proposal.md'),
            '## Why\n\nNo limits today.\n\n## What Changes\n\n- Add per-key limits.\n\n## Impact\n\n- **api**: limiter.\n'
        );
        await mkdir(join(dir, 'specs', 'rate-limits'), { recursive: true });
        await writeFile(
            join(dir, 'specs', 'rate-limits', 'spec.md'),
            '## ADDED Requirements\n\n### Requirement: Fail open when the limit store is unavailable\n\nThe API SHALL serve requests when Redis is unreachable.\n\n#### Scenario: Redis down\n\n- **WHEN** Redis times out\n- **THEN** the request is served\n'
        );
        await writeFile(join(dir, 'tasks.md'), '## 1. Limiter\n\n- [ ] 1.1 Add the middleware\n');
        const ready = await call('planroom_emit', {
            events: [
                {
                    type: 'proposal.trace',
                    spec: 'rate-limits',
                    requirement: 'Fail open when the limit store is unavailable',
                    questions: ['Q-12']
                },
                { type: 'proposal.ready' }
            ]
        });
        expect(ready.body.validating).toBe(true);
        const validation = await next();
        expect(validation.at(-1)).toMatchObject({ type: 'validation.result', passed: true, trigger: 'proposal.ready' });
        expect((await call('planroom_state')).body).toMatchObject({ phase: 'proposal' });

        // The user accepts; Planroom then closes the session, and resuming it shows the plan read-only.
        await page({ type: 'proposal.accept' });
        expect(await next()).toMatchObject([{ type: 'proposal.accept', changeId: CHANGE }]);
        expect((await call('planroom_open', { changeId: CHANGE })).body).toMatchObject({ resumed: true, phase: 'accepted' });
        const state = (await call('planroom_state')).body;
        expect(state.phase).toBe('accepted');
        expect(state.state.questions['Q-12'].status).toBe('answered');
        expect(state.state.threads['C-1'].status).toBe('resolved');
        expect((await call('planroom_emit', { events: [{ type: 'understanding.update', text: 'x' }] })).isError).toBe(true);
    });
});
