import { z } from 'zod';
import { planFormat } from './state.js';

/**
 * Inputs of the MCP tools other than `planroom_emit`, whose input is `emitBatch` in `events.ts`. The server
 * generates each tool's JSON Schema from these and parses its arguments with them.
 */

/** `planroom_wait`'s default timeout, below Claude Code's MCP tool timeout. */
export const DEFAULT_WAIT_SEC = 300;

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
