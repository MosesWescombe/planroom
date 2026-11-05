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

/** The openers' `newPage`: serve another session under a new URL in a new window, not on the page already open. */
const newPage = z
    .boolean()
    .optional()
    .describe(
        'Open it under a new URL in a new browser window; the page already open then closes. By default another session ' +
            'takes over the page already open, at the same URL: its tab reloads onto it, and no new window opens while a ' +
            'tab shows it. Ignored when it is the session already open'
    );

/** Why a `plansDir` is refused: it must stay inside the repo. */
const PLANS_DIR_MESSAGE = 'must be a folder inside the repo, relative to its root, e.g. docs/plans';

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
            'What a new plan becomes on submit: `openspec`, an OpenSpec change in openspec/changes/<changeId>/ (the default in a repo ' +
                "with an openspec/ directory), or `markdown` (the default in one without), a plan at <changeId>/<changeId>.md in the repo's " +
                'folder for Markdown plans, agent-plans/ by default. A resumed plan keeps the format it was created with.'
        ),
    plansDir: z
        .string()
        .trim()
        .max(400)
        .refine((path) => !path.startsWith('/') && !path.includes('\\'), { message: PLANS_DIR_MESSAGE })
        // Normalised: `./docs//plans/` is `docs/plans`.
        .transform((path) =>
            path
                .split('/')
                .filter((part) => part !== '' && part !== '.')
                .join('/')
        )
        .refine((path) => path !== '' && !path.split('/').includes('..'), { message: PLANS_DIR_MESSAGE })
        .optional()
        .describe(
            'Where this repo keeps its Markdown plans, a folder relative to repoRoot, e.g. docs/plans. Only when planroom_open asked ' +
                'for it, with the folder the user chose: remembered for the repo on this machine and used for every later Markdown plan. ' +
                'Refused for an OpenSpec plan'
        ),
    newPage
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
        ),
    newPage
});

/** `planroom_review`'s input. */
export const reviewInput = z.object({
    target: z
        .string()
        .trim()
        .min(1)
        .max(400)
        .describe(
            'What to review: a Bitbucket Cloud PR link (https://bitbucket.org/<workspace>/<repo>/pull-requests/<n>), an Azure ' +
                'DevOps PR link (https://dev.azure.com/<organization>/<project>/_git/<repo>/pullrequest/<n>), a bare PR ' +
                "number of the checkout's origin repo, whose remote names the host, or a branch name. A branch with an open PR in the origin repo reviews " +
                'that PR; otherwise, or with `local`, the local branch against its merge base with the default branch'
        ),
    local: z
        .boolean()
        .optional()
        .describe('Review a branch target as the local branch even when it has an open PR; nothing is posted for it'),
    title: z.string().max(200).optional().describe('A title for the page; by default the PR title or the branch name'),
    newPage
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
