import { z } from 'zod';
import { repoPath } from './blocks.js';
import { planFormat } from './state.js';

/**
 * Inputs of the MCP tools other than `planroom_emit`, whose input is `emitBatch` in `events.ts`. The server
 * generates each tool's JSON Schema from these and parses its arguments with them.
 */

/**
 * `planroom_wait`'s default timeout, the schema's maximum. Claude Code backgrounds a call after two minutes and wakes the
 * session when it completes, so each timeout costs an empty turn; 600 s was verified on Claude Code 2.1.289.
 */
export const DEFAULT_WAIT_SEC = 600;

/** `planroom_open`'s input. */
export const openInput = z.object({
    changeId: z
        .string()
        .optional()
        .describe(
            'The change id, kebab-case, e.g. add-api-rate-limiting. Leave it out to open the plan browser, where the user ' +
                'picks a plan in the repo instead'
        ),
    title: z.string().max(200).optional().describe('A human title for a new change; ignored when resuming'),
    format: planFormat
        .optional()
        .describe(
            'What a new plan becomes on submit: `openspec` (the default), an OpenSpec change in openspec/changes/<changeId>/, ' +
                'or `markdown`, a plan at agent-plans/<changeId>/<changeId>.md. A resumed plan keeps the format it was created with.'
        )
});

/** `planroom_ask`'s input. */
export const askInput = z.object({
    askId: z
        .string()
        .describe(
            'A kebab-case id for this set of questions, e.g. auth-migration-questions. The same id resumes it with its ' +
                'earlier questions and answers, also after the user sent them'
        ),
    title: z.string().max(200).optional().describe('What the questions are about, the page heading; ignored when resuming'),
    output: repoPath
        .refine((path) => path.endsWith('.md'), { message: 'must be a .md file' })
        .optional()
        .describe(
            'A repo-relative .md file to also write the questions and answers to when the user sends them, e.g. ' +
                'docs/decisions/auth-migration.md. Given when resuming, it replaces the earlier one'
        )
});

/** `planroom_review`'s input. */
export const reviewInput = z.object({
    target: z
        .string()
        .trim()
        .min(1)
        .max(400)
        .describe(
            'What to review: a Bitbucket Cloud PR link (https://bitbucket.org/<workspace>/<repo>/pull-requests/<n>), a bare PR ' +
                "number of the checkout's origin repo, or a local branch name, reviewed against its merge base with the default branch"
        ),
    title: z.string().max(200).optional().describe('A title for the page; by default the PR title or the branch name')
});

/** `planroom_wait`'s input. */
export const waitInput = z.object({
    after: z.number().int().min(0).describe('The highest event seq you have handled; 0 to start from the beginning'),
    timeoutSec: z
        .number()
        .int()
        .min(1)
        .max(600)
        .optional()
        .describe(`Seconds to wait for an event (default ${DEFAULT_WAIT_SEC}); leave it unset`)
});

/** `planroom_state`'s input: none. */
export const stateInput = z.object({});
