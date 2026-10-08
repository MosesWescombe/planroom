import { z } from 'zod';
import { type Issue, toIssues } from './issues.js';

/**
 * The block catalog: every renderable block type, as a zod schema for its config.
 * The agent never sends markup - it sends one of these configs and the page renders
 * it with its own component. `text` is the only type that carries prose, as a small
 * markdown subset the page renders as React elements, never as raw HTML.
 */

/**
 * Record ids (questions, blocks, sections, threads): a leading alphanumeric, then word characters, `.`, `:` or `-`.
 * Records live in plain objects keyed by id, so an id naming an `Object.prototype` member such as `constructor` is
 * refused: looking it up would find the inherited function.
 */
export const recordId = z
    .string()
    .min(1)
    .max(120)
    .regex(/^[A-Za-z0-9][\w.:-]*$/, 'must start with a letter or digit and use only letters, digits, _ . : -')
    .refine((id) => !(id in Object.prototype), 'must not name a built-in object property such as "constructor"');

const label = z.string().min(1).max(400);
const text = z.string().max(20000);

/** Report each duplicate among `ids` at its index under `path`. */
function checkUnique(ids: readonly string[], path: string, ctx: z.RefinementCtx): void {
    const seen = new Set<string>();
    ids.forEach((id, index) => {
        if (seen.has(id)) ctx.addIssue({ code: 'custom', path: [path, index, 'id'], message: `duplicate id "${id}"` });
        seen.add(id);
    });
}

/** Report each member of `groups` that is undefined or already in an earlier group: a member joins one group at most. */
function checkGroups(
    groups: readonly { label: string; members: readonly string[] }[],
    known: ReadonlySet<string>,
    paths: { groups: string; members: string; noun: string },
    ctx: z.RefinementCtx
): void {
    const grouped = new Map<string, number>();
    groups.forEach((group, groupIndex) => {
        group.members.forEach((id, index) => {
            const path = [paths.groups, groupIndex, paths.members, index];
            if (!known.has(id)) {
                ctx.addIssue({ code: 'custom', path, message: `${paths.noun} "${id}" is not defined` });
            } else if (grouped.has(id)) {
                ctx.addIssue({ code: 'custom', path, message: `${paths.noun} "${id}" is already in group ${grouped.get(id)}` });
            }
            grouped.set(id, groupIndex);
        });
    });
}

/** Report each endpoint in `edges` that names an id missing from `known`. */
function checkEndpoints(
    edges: readonly { from: string; to: string }[],
    known: ReadonlySet<string>,
    path: string,
    ctx: z.RefinementCtx,
    noun = 'node'
): void {
    edges.forEach((edge, index) => {
        for (const end of ['from', 'to'] as const) {
            if (!known.has(edge[end])) {
                ctx.addIssue({ code: 'custom', path: [path, index, end], message: `${noun} "${edge[end]}" is not defined` });
            }
        }
    });
}

/** `callout`: a toned note, decision, assumption or risk, with a title, a body or both. */
export const calloutConfig = z
    .object({
        tone: z.enum(['note', 'decision', 'assumption', 'risk']),
        title: label.optional(),
        body: text.optional()
    })
    .refine((config) => config.title !== undefined || config.body !== undefined, {
        message: 'needs a title or a body',
        path: ['title']
    });

/** `checklist`: items with optional ids, never bare numbers, unique within the list; `interactive` lets the user tick them. */
export const checklistConfig = z.object({
    interactive: z.boolean().default(false),
    items: z
        .array(z.object({ id: recordId.optional(), text: label, done: z.boolean().optional() }))
        .min(1)
        .max(100)
        .superRefine((items, ctx) => {
            const seen = new Set<string>();
            items.forEach((item, index) => {
                if (!item.id) return;
                // Bare numbers are the position keys of items without an id, so an id never takes one.
                if (/^\d+$/.test(item.id))
                    ctx.addIssue({ code: 'custom', path: [index, 'id'], message: 'must not be a bare number; use e.g. "i1"' });
                else if (seen.has(item.id))
                    ctx.addIssue({ code: 'custom', path: [index, 'id'], message: `duplicate id "${item.id}"` });
                seen.add(item.id);
            });
        })
});

/**
 * The key a checklist item's tick is stored under: its id, or its position when it has none. Ids are never bare
 * numbers, so the two never meet.
 */
export function checklistItemKey(item: { id?: string }, index: number): string {
    return item.id ?? String(index);
}

/** A table cell: inline markdown, a number, empty, or a badge in one of the stat tones. */
const cell = z.union([
    z.string().max(2000),
    z.number(),
    z.null(),
    z.object({ text: label, tone: z.enum(['neutral', 'accent', 'attention']).default('neutral') })
]);

/** A cell's text as the user reads it, for sorting: badge text, or the string without markdown's `*` and backticks. */
export function cellText(value: z.output<typeof cell>): string | number {
    if (value === null) return '';
    if (typeof value === 'number') return value;
    return typeof value === 'string' ? value.replace(/[*`]/g, '') : value.text;
}

/** `table`: columns and rows of cells, every row as wide as the columns. Question ids in `refColumn` render as links. */
export const tableConfig = z
    .object({
        columns: z.array(label).min(1).max(12),
        rows: z.array(z.array(cell)).max(500),
        refColumn: z.number().int().min(0).optional()
    })
    .superRefine((config, ctx) => {
        config.rows.forEach((row, index) => {
            if (row.length !== config.columns.length) {
                ctx.addIssue({
                    code: 'custom',
                    path: ['rows', index],
                    message: `expected ${config.columns.length} cells, got ${row.length}`
                });
            }
        });
        if (config.refColumn !== undefined && config.refColumn >= config.columns.length) {
            ctx.addIssue({ code: 'custom', path: ['refColumn'], message: `must be below ${config.columns.length}` });
        }
    });

/** `stats`: one to four toned figures. */
export const statsConfig = z.object({
    items: z
        .array(
            z.object({
                label,
                value: z.union([z.string().max(40), z.number()]),
                tone: z.enum(['neutral', 'accent', 'attention']).default('neutral')
            })
        )
        .min(1)
        .max(4)
});

const emphasis = z.enum(['new', 'changed']);
const diagramNode = z.object({ id: recordId, label, emphasis: emphasis.optional() });
const diagramEdge = z.object({
    from: recordId,
    to: recordId,
    label: label.optional(),
    style: z.enum(['solid', 'dashed']).default('solid')
});

/** `flow`: a directed graph of boxes and decisions whose edges name defined nodes. */
export const flowConfig = z
    .object({
        direction: z.enum(['LR', 'RL', 'TB', 'BT']).default('LR'),
        nodes: z
            .array(diagramNode.extend({ shape: z.enum(['box', 'decision']).default('box') }))
            .min(1)
            .max(60),
        edges: z.array(diagramEdge).max(120)
    })
    .superRefine((config, ctx) => {
        checkUnique(
            config.nodes.map((node) => node.id),
            'nodes',
            ctx
        );
        checkEndpoints(config.edges, new Set(config.nodes.map((node) => node.id)), 'edges', ctx);
    });

/** `sequence`: messages between two to eight actors, each end an actor's index. */
export const sequenceConfig = z
    .object({
        actors: z.array(label).min(2).max(8),
        messages: z
            .array(
                z.object({
                    from: z.number().int().min(0),
                    to: z.number().int().min(0),
                    text: label,
                    reply: z.boolean().optional()
                })
            )
            .max(60)
    })
    .superRefine((config, ctx) => {
        config.messages.forEach((message, index) => {
            for (const end of ['from', 'to'] as const) {
                if (message[end] >= config.actors.length) {
                    ctx.addIssue({
                        code: 'custom',
                        path: ['messages', index, end],
                        message: `actor ${message[end]} does not exist (${config.actors.length} actors)`
                    });
                }
            }
        });
    });

/** `architecture`: nodes, optional groups that each node joins at most once, and links between defined nodes. */
export const architectureConfig = z
    .object({
        groups: z
            .array(z.object({ label, nodes: z.array(recordId).min(1) }))
            .max(12)
            .default([]),
        nodes: z.array(diagramNode).min(1).max(60),
        links: z.array(diagramEdge).max(120)
    })
    .superRefine((config, ctx) => {
        checkUnique(
            config.nodes.map((node) => node.id),
            'nodes',
            ctx
        );
        const known = new Set(config.nodes.map((node) => node.id));
        checkGroups(
            config.groups.map((group) => ({ label: group.label, members: group.nodes })),
            known,
            { groups: 'groups', members: 'nodes', noun: 'node' },
            ctx
        );
        checkEndpoints(config.links, known, 'links', ctx);
    });

/** `state`: a state machine whose initial state, transitions and emphasis name unique, defined states. */
export const stateConfig = z
    .object({
        initial: z.string().min(1).optional(),
        states: z.array(z.string().min(1).max(80)).min(1).max(40),
        transitions: z.array(z.object({ from: z.string(), to: z.string(), on: label.optional() })).max(80),
        emphasis: z.array(z.string()).default([])
    })
    .superRefine((config, ctx) => {
        const known = new Set(config.states);
        config.states.forEach((state, index) => {
            if (config.states.indexOf(state) !== index) {
                ctx.addIssue({ code: 'custom', path: ['states', index], message: `duplicate state "${state}"` });
            }
        });
        if (config.initial !== undefined && !known.has(config.initial)) {
            ctx.addIssue({ code: 'custom', path: ['initial'], message: `state "${config.initial}" is not defined` });
        }
        checkEndpoints(config.transitions, known, 'transitions', ctx, 'state');
        config.emphasis.forEach((state, index) => {
            if (!known.has(state))
                ctx.addIssue({ code: 'custom', path: ['emphasis', index], message: `state "${state}" is not defined` });
        });
    });

/** What a change does to a schema table, column or relation. */
const change = z.enum(['added', 'changed', 'removed']);

const schemaColumn = z.object({
    name: z.string().min(1).max(120),
    type: z.string().max(80).optional(),
    /** Primary, foreign and unique keys, as an ER diagram marks them. */
    keys: z
        .array(z.enum(['pk', 'fk', 'uk']))
        .max(3)
        .optional(),
    change: change.optional()
});

/**
 * `schema`: database tables with their columns, and relations between tables. A relation's `cardinality` reads from
 * `from` to `to`: the default `many-to-one` is a foreign key on `from` pointing at `to`.
 */
export const schemaConfig = z
    .object({
        tables: z
            .array(
                z.object({
                    id: recordId,
                    /** Shown as the table's heading; the id when unset. */
                    name: label.optional(),
                    columns: z.array(schemaColumn).max(40),
                    change: change.optional()
                })
            )
            .min(1)
            .max(30),
        relations: z
            .array(
                z.object({
                    from: recordId,
                    fromColumn: z.string().min(1).max(120).optional(),
                    to: recordId,
                    toColumn: z.string().min(1).max(120).optional(),
                    cardinality: z.enum(['many-to-one', 'one-to-one', 'one-to-many', 'many-to-many']).default('many-to-one'),
                    label: label.optional(),
                    change: change.optional()
                })
            )
            .max(60)
            .default([])
    })
    .superRefine((config, ctx) => {
        checkUnique(
            config.tables.map((table) => table.id),
            'tables',
            ctx
        );
        const columns = new Map<string, Set<string>>();
        config.tables.forEach((table, tableIndex) => {
            const names = new Set<string>();
            table.columns.forEach((column, index) => {
                if (names.has(column.name)) {
                    ctx.addIssue({
                        code: 'custom',
                        path: ['tables', tableIndex, 'columns', index, 'name'],
                        message: `duplicate column "${column.name}"`
                    });
                }
                names.add(column.name);
            });
            columns.set(table.id, names);
        });
        checkEndpoints(config.relations, new Set(columns.keys()), 'relations', ctx, 'table');
        config.relations.forEach((relation, index) => {
            for (const [end, column] of [
                ['from', relation.fromColumn],
                ['to', relation.toColumn]
            ] as const) {
                const names = columns.get(relation[end]);
                if (column !== undefined && names && !names.has(column)) {
                    ctx.addIssue({
                        code: 'custom',
                        path: ['relations', index, `${end}Column`],
                        message: `table "${relation[end]}" has no column "${column}"`
                    });
                }
            }
        });
    });

/**
 * `c4`: a C4 context, container or component view: people and software elements, optional boundaries that each
 * element joins at most once, and relations between defined elements.
 */
export const c4Config = z
    .object({
        elements: z
            .array(
                z.object({
                    id: recordId,
                    kind: z.enum(['person', 'system', 'container', 'component', 'database', 'queue']),
                    label,
                    technology: z.string().max(80).optional(),
                    description: z.string().max(300).optional(),
                    /** Outside the system being described, e.g. a third-party service. */
                    external: z.boolean().optional(),
                    emphasis: emphasis.optional()
                })
            )
            .min(1)
            .max(40),
        boundaries: z
            .array(z.object({ label, elements: z.array(recordId).min(1) }))
            .max(10)
            .default([]),
        relations: z.array(diagramEdge.omit({ style: true }).extend({ technology: z.string().max(80).optional() })).max(80)
    })
    .superRefine((config, ctx) => {
        checkUnique(
            config.elements.map((element) => element.id),
            'elements',
            ctx
        );
        const known = new Set(config.elements.map((element) => element.id));
        checkGroups(
            config.boundaries.map((boundary) => ({ label: boundary.label, members: boundary.elements })),
            known,
            { groups: 'boundaries', members: 'elements', noun: 'element' },
            ctx
        );
        checkEndpoints(config.relations, known, 'relations', ctx, 'element');
    });

/** One mind map node: its label and the branches under it. */
export interface MindmapBranch {
    label: string;
    emphasis?: z.infer<typeof emphasis>;
    children?: MindmapBranch[];
}

const mindmapBranch: z.ZodType<MindmapBranch> = z.object({
    label: z.string().min(1).max(200),
    emphasis: emphasis.optional(),
    get children() {
        return z.array(mindmapBranch).max(12).optional();
    }
});

/** How many levels a mind map shows below its centre, and how many nodes in all. */
const MINDMAP_DEPTH = 4;
const MINDMAP_NODES = 80;

/** `mindmap`: a central topic and the branches around it, nested up to four levels. */
export const mindmapConfig = z
    .object({ label: z.string().min(1).max(200), children: z.array(mindmapBranch).min(1).max(12) })
    .superRefine((config, ctx) => {
        let count = 1;
        const walk = (branches: readonly MindmapBranch[], depth: number, path: (string | number)[]) => {
            branches.forEach((branch, index) => {
                count += 1;
                const here = [...path, index];
                if (depth > MINDMAP_DEPTH) {
                    ctx.addIssue({ code: 'custom', path: here, message: `goes deeper than ${MINDMAP_DEPTH} levels` });
                    return;
                }
                if (branch.children) walk(branch.children, depth + 1, [...here, 'children']);
            });
        };
        walk(config.children, 1, ['children']);
        if (count > MINDMAP_NODES) {
            ctx.addIssue({ code: 'custom', path: ['children'], message: `has ${count} nodes; at most ${MINDMAP_NODES}` });
        }
    });

/** Diagram types a `compare` side can hold inline. */
export const diagramTypes = ['flow', 'sequence', 'architecture', 'state'] as const;
export type DiagramType = (typeof diagramTypes)[number];

const inlineDiagram = z.discriminatedUnion('type', [
    z.object({ type: z.literal('flow'), config: flowConfig }),
    z.object({ type: z.literal('sequence'), config: sequenceConfig }),
    z.object({ type: z.literal('architecture'), config: architectureConfig }),
    z.object({ type: z.literal('state'), config: stateConfig })
]);

/** `timeline`: ordered steps, with `current` marking the step in progress. */
export const timelineConfig = z
    .object({
        current: z.number().int().min(0).optional(),
        steps: z
            .array(z.object({ label, detail: text.optional(), duration: label.optional(), exit: label.optional() }))
            .min(1)
            .max(20)
    })
    .superRefine((config, ctx) => {
        if (config.current !== undefined && config.current >= config.steps.length) {
            ctx.addIssue({ code: 'custom', path: ['current'], message: `must be below ${config.steps.length}` });
        }
    });

/** A calendar date, `YYYY-MM-DD`, that exists. */
const isoDate = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'must be a date such as "2026-10-05"', abort: true })
    .refine((value) => {
        const date = new Date(`${value}T00:00:00Z`);
        return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
    }, 'is not a real date');

/**
 * `gantt`: tasks on a time axis in days. A task starts at `at`, else when every task in `after` ends, else when the
 * task before it ends. `after` names earlier tasks only, so the schedule never loops.
 */
export const ganttConfig = z
    .object({
        /** The date of day 0. Without it the axis counts days and weeks from the start. */
        start: isoDate.optional(),
        tasks: z
            .array(
                z.object({
                    id: recordId,
                    label,
                    group: label.optional(),
                    /** Days. 0 is a milestone. */
                    duration: z.number().min(0).max(3650),
                    at: z.number().min(0).max(3650).optional(),
                    after: z.array(recordId).min(1).max(10).optional(),
                    status: z.enum(['done', 'active']).optional()
                })
            )
            .min(1)
            .max(40)
    })
    .superRefine((config, ctx) => {
        checkUnique(
            config.tasks.map((task) => task.id),
            'tasks',
            ctx
        );
        const earlier = new Set<string>();
        config.tasks.forEach((task, index) => {
            if (task.at !== undefined && task.after) {
                ctx.addIssue({ code: 'custom', path: ['tasks', index, 'after'], message: 'give `at` or `after`, not both' });
            }
            task.after?.forEach((id, position) => {
                if (!earlier.has(id)) {
                    ctx.addIssue({
                        code: 'custom',
                        path: ['tasks', index, 'after', position],
                        message: config.tasks.some((other) => other.id === id)
                            ? `task "${id}" comes later in the list; list it first`
                            : `task "${id}" is not defined`
                    });
                }
            });
            earlier.add(task.id);
        });
    });

/** `bar`: rows of a category label then one non-negative value (or null) per series. */
export const barConfig = z
    .object({
        orientation: z.enum(['horizontal', 'vertical']).default('horizontal'),
        unit: label.optional(),
        stacked: z.boolean().default(false),
        series: z.array(label).min(1).max(6),
        data: z
            .array(z.array(z.union([z.string(), z.number(), z.null()])))
            .min(1)
            .max(40)
    })
    .superRefine((config, ctx) => {
        const width = config.series.length + 1;
        config.data.forEach((row, index) => {
            if (row.length !== width) {
                ctx.addIssue({ code: 'custom', path: ['data', index], message: `expected ${width} values, got ${row.length}` });
                return;
            }
            if (typeof row[0] !== 'string') {
                ctx.addIssue({ code: 'custom', path: ['data', index, 0], message: 'first value must be the category label' });
            }
            row.slice(1).forEach((value, offset) => {
                if (value !== null && (typeof value !== 'number' || value < 0)) {
                    ctx.addIssue({
                        code: 'custom',
                        path: ['data', index, offset + 1],
                        message: 'must be a non-negative number or null'
                    });
                }
            });
        });
    });

/** `line`: series with one value (or null) per x value, and annotations at x values on the axis. */
export const lineConfig = z
    .object({
        unit: label.optional(),
        x: z
            .array(z.union([z.string().max(40), z.number()]))
            .min(2)
            .max(200),
        series: z
            .array(z.object({ name: label, values: z.array(z.union([z.number(), z.null()])) }))
            .min(1)
            .max(6),
        annotations: z
            .array(z.object({ x: z.union([z.string(), z.number()]), text: label }))
            .max(20)
            .default([]),
        sample: z.boolean().default(false)
    })
    .superRefine((config, ctx) => {
        config.series.forEach((series, index) => {
            if (series.values.length !== config.x.length) {
                ctx.addIssue({
                    code: 'custom',
                    path: ['series', index, 'values'],
                    message: `expected ${config.x.length} values, got ${series.values.length}`
                });
            }
        });
        config.annotations.forEach((annotation, index) => {
            if (!config.x.includes(annotation.x)) {
                ctx.addIssue({
                    code: 'custom',
                    path: ['annotations', index, 'x'],
                    message: `"${annotation.x}" is not on the x axis`
                });
            }
        });
    });

const SANKEY_NODES = 40;

/**
 * `sankey`: positive flows between named nodes. Each pair flows once, and flows never loop back, since a sankey
 * reads in one direction.
 */
export const sankeyConfig = z
    .object({
        unit: label.optional(),
        flows: z
            .array(
                z.object({
                    from: z.string().min(1).max(80),
                    to: z.string().min(1).max(80),
                    value: z.number().positive()
                })
            )
            .min(1)
            .max(60)
    })
    .superRefine((config, ctx) => {
        const pairs = new Set<string>();
        const next = new Map<string, Set<string>>();
        config.flows.forEach((flow, index) => {
            const pair = JSON.stringify([flow.from, flow.to]);
            if (flow.from === flow.to) {
                ctx.addIssue({ code: 'custom', path: ['flows', index, 'to'], message: 'a flow cannot return to its own node' });
                return;
            }
            if (pairs.has(pair)) {
                ctx.addIssue({
                    code: 'custom',
                    path: ['flows', index],
                    message: `"${flow.from}" to "${flow.to}" already flows; add the values together`
                });
                return;
            }
            // Whether `to` already reaches `from`: if so, this flow closes a loop.
            const reaches = (node: string, seen: Set<string>): boolean => {
                if (node === flow.from) return true;
                seen.add(node);
                return [...(next.get(node) ?? [])].some((target) => !seen.has(target) && reaches(target, seen));
            };
            if (reaches(flow.to, new Set())) {
                ctx.addIssue({
                    code: 'custom',
                    path: ['flows', index],
                    message: `"${flow.from}" to "${flow.to}" closes a loop; a sankey only flows one way`
                });
                return;
            }
            pairs.add(pair);
            next.set(flow.from, (next.get(flow.from) ?? new Set()).add(flow.to));
        });
        const nodes = new Set(config.flows.flatMap((flow) => [flow.from, flow.to]));
        if (nodes.size > SANKEY_NODES) {
            ctx.addIssue({ code: 'custom', path: ['flows'], message: `has ${nodes.size} nodes; at most ${SANKEY_NODES}` });
        }
    });

const level = z.number().int().min(1).max(3);

/** `riskMatrix`: risks placed by likelihood and impact, each 1 to 3. */
export const riskMatrixConfig = z.object({
    items: z
        .array(z.object({ label, likelihood: level, impact: level, mitigation: label.optional() }))
        .min(1)
        .max(20)
});

/** An option matrix cell: a 0 to 3 score, short text, or short text with a verdict on it. */
const optionCell = z.union([
    z.number().int().min(0).max(3),
    z.string().min(1).max(300),
    z.object({ text: z.string().min(1).max(300), verdict: z.enum(['good', 'mixed', 'bad']) })
]);

/**
 * `optionMatrix`: options side by side, one column each, judged on a row per criterion, with an optional recommended
 * option. Every row has one cell per option.
 */
export const optionMatrixConfig = z
    .object({
        options: z.array(label).min(1).max(6),
        rows: z
            .array(z.object({ criterion: label, cells: z.array(optionCell) }))
            .min(1)
            .max(30),
        recommended: z.number().int().min(0).optional()
    })
    .superRefine((config, ctx) => {
        config.rows.forEach((row, index) => {
            if (row.cells.length !== config.options.length) {
                ctx.addIssue({
                    code: 'custom',
                    path: ['rows', index, 'cells'],
                    message: `expected ${config.options.length} cells, one per option, got ${row.cells.length}`
                });
            }
        });
        if (config.recommended !== undefined && config.recommended >= config.options.length) {
            ctx.addIssue({ code: 'custom', path: ['recommended'], message: `must be below ${config.options.length}` });
        }
    });

/** A repo-relative path: no leading slash, no `..` segment, no backslashes. */
export const repoPath = z
    .string()
    .min(1)
    .max(400)
    .refine((path) => !path.startsWith('/') && !path.includes('\\') && !path.split('/').includes('..'), {
        message: 'must be a repo-relative path without ".." segments'
    });

/** `fileTree`: file paths, each with an optional change kind and note. */
export const fileTreeConfig = z.object({
    root: z.string().max(400).optional(),
    files: z
        .array(
            z.object({
                path: z.string().min(1).max(400),
                change: z.enum(['added', 'modified', 'removed', 'renamed']).optional(),
                note: label.optional()
            })
        )
        .min(1)
        .max(200)
});

/** `code`: an excerpt of a tracked file by line range, a diff patch, or a snippet, with the fields each mode needs. */
export const codeConfig = z
    .object({
        mode: z.enum(['excerpt', 'diff', 'snippet']),
        file: repoPath.optional(),
        lines: z
            .string()
            .regex(/^\d+(-\d+)?$/, 'must be a line number or a range such as "12-15"')
            .optional(),
        lang: z.string().max(20).optional(),
        patch: text.optional(),
        source: text.optional()
    })
    .superRefine((config, ctx) => {
        if (config.mode === 'diff' && !config.patch) {
            ctx.addIssue({ code: 'custom', path: ['patch'], message: 'a diff needs a patch' });
        }
        if (config.mode === 'snippet' && !config.source) {
            ctx.addIssue({ code: 'custom', path: ['source'], message: 'a snippet needs a source' });
        }
        if (config.mode === 'excerpt' && (!config.file || !config.lines)) {
            ctx.addIssue({
                code: 'custom',
                path: [config.file ? 'lines' : 'file'],
                message: 'an excerpt needs a file and lines'
            });
        }
    });

/** `image`: an `asset:` image with alt text and pins placed at fractions of its width and height. */
export const imageConfig = z.object({
    src: z.string().regex(/^asset:[\w.-]+\.(png|jpe?g|gif|webp|svg)$/i, 'must be "asset:<name>.<png|jpg|gif|webp|svg>"'),
    alt: label,
    pins: z
        .array(z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), text: label }))
        .max(20)
        .default([])
});

/** Block types a `compare` side can hold besides diagrams: code or an image, inline or by id. */
export const compareTypes = [...diagramTypes, 'code', 'image'] as const;
export type CompareType = (typeof compareTypes)[number];

/** A `compare` side: the id of a diagram, `code` or `image` block, or one of those inline as `{ type, config }`. */
const compareSide = z.object({
    label: label.optional(),
    block: z.union([
        recordId,
        z.discriminatedUnion('type', [
            ...inlineDiagram.options,
            z.object({ type: z.literal('code'), config: codeConfig }),
            z.object({ type: z.literal('image'), config: imageConfig })
        ])
    ])
});

/**
 * `compare`: two sides, each a block id or an inline diagram, code or image under an optional label, with which
 * differences to highlight. Highlighting matches diagram nodes by id, so it only applies when both sides are diagrams.
 */
export const compareConfig = z.object({
    left: compareSide,
    right: compareSide,
    highlight: z.enum(['added', 'removed', 'both', 'none']).default('added')
});

/** `mermaid`: Mermaid source, rendered as the agent wrote it. */
export const mermaidConfig = z.object({ source: z.string().min(1).max(20000) });

/** `text`: prose in the markdown subset the page renders. */
export const textConfig = z.object({ body: z.string().min(1).max(40000) });

/**
 * `analogy`: "this change is like X", each real part of the change mapped to its counterpart in the analogy, with an
 * optional illustration and where the analogy breaks down.
 */
export const analogyConfig = z.object({
    /** The analogy itself, e.g. "A ticket counter". */
    title: label,
    pairs: z
        .array(z.object({ real: label, like: label, note: label.optional() }))
        .min(1)
        .max(12),
    illustration: imageConfig.optional(),
    /** Where the analogy stops holding. */
    breaks: text.optional()
});

/** The diagram a step-through walks: a flow, whose steps light nodes, or a sequence, whose steps light messages. */
const stepDiagram = z.discriminatedUnion('type', [
    z.object({ type: z.literal('flow'), config: flowConfig }),
    z.object({ type: z.literal('sequence'), config: sequenceConfig })
]);

/**
 * `stepThrough`: a flow or sequence diagram and ordered steps, each lighting flow nodes by id or sequence messages by
 * index under a caption.
 */
export const stepThroughConfig = z
    .object({
        diagram: stepDiagram,
        steps: z
            .array(
                z.object({
                    caption: label,
                    nodes: z.array(recordId).max(60).default([]),
                    messages: z.array(z.number().int().min(0)).max(60).default([])
                })
            )
            .min(1)
            .max(20)
    })
    .superRefine((config, ctx) => {
        const { diagram } = config;
        config.steps.forEach((step, index) => {
            if (diagram.type === 'flow') {
                const known = new Set(diagram.config.nodes.map((node) => node.id));
                step.nodes.forEach((id, position) => {
                    if (!known.has(id))
                        ctx.addIssue({
                            code: 'custom',
                            path: ['steps', index, 'nodes', position],
                            message: `node "${id}" is not in the flow`
                        });
                });
                if (step.messages.length)
                    ctx.addIssue({
                        code: 'custom',
                        path: ['steps', index, 'messages'],
                        message: 'a flow lights nodes; use `nodes`'
                    });
            } else {
                const count = diagram.config.messages.length;
                step.messages.forEach((message, position) => {
                    if (message >= count)
                        ctx.addIssue({
                            code: 'custom',
                            path: ['steps', index, 'messages', position],
                            message: `message ${message} does not exist (${count} messages)`
                        });
                });
                if (step.nodes.length)
                    ctx.addIssue({
                        code: 'custom',
                        path: ['steps', index, 'nodes'],
                        message: 'a sequence lights messages by index; use `messages`'
                    });
            }
        });
    });

/** The four areas a risk-rating take rates, 1 (low risk) to 5 (high). */
export const RISK_AREAS = ['correctness', 'performance', 'security', 'maintainability'] as const;
export type RiskArea = (typeof RISK_AREAS)[number];
const rating = z.number().int().min(1).max(5);

/**
 * `yourTake`: a card that asks the reviewer for their own view before showing the agent's. The agent's view (`answer`,
 * `pros` and `cons`, `ratings`, `correct`) is written with the card and shown only once the reviewer has answered.
 */
export const yourTakeConfig = z
    .discriminatedUnion('kind', [
        z.object({
            kind: z.literal('predict'),
            prompt: label,
            /** Guesses to pick from; without them the reviewer writes one. */
            options: z.array(label).min(2).max(6).optional(),
            answer: label,
            explanation: text
        }),
        z.object({
            kind: z.literal('prosCons'),
            prompt: label.optional(),
            pros: z.array(label).max(12),
            cons: z.array(label).max(12)
        }),
        z.object({
            kind: z.literal('risk'),
            prompt: label.optional(),
            ratings: z.object({ correctness: rating, performance: rating, security: rating, maintainability: rating }),
            why: text.optional()
        }),
        z.object({
            kind: z.literal('check'),
            question: label,
            options: z.array(label).min(2).max(6),
            /** The index of the right option. */
            correct: z.number().int().min(0),
            explanation: text.optional(),
            /** The slide that explains the answer, linked when the reviewer answers wrongly. */
            slide: recordId.optional()
        })
    ])
    .superRefine((config, ctx) => {
        if (config.kind === 'predict' && config.options && !config.options.includes(config.answer))
            ctx.addIssue({ code: 'custom', path: ['answer'], message: 'must be one of the options' });
        if (config.kind === 'check' && config.correct >= config.options.length)
            ctx.addIssue({ code: 'custom', path: ['correct'], message: `must be below ${config.options.length}` });
    });
export type YourTakeConfig = z.output<typeof yourTakeConfig>;
export type TakeKind = YourTakeConfig['kind'];
export const TAKE_KINDS: readonly TakeKind[] = ['predict', 'prosCons', 'risk', 'check'];

/**
 * `html`: an interactive visual no other block can show, run in a sandboxed frame with no network. `html` is the body
 * of a document the page builds, with its CSS and script inline.
 */
export const htmlConfig = z.object({
    title: label,
    alt: label,
    /** The frame's height in pixels. */
    height: z.number().int().min(80).max(1200).default(360),
    html: z.string().min(1).max(100_000)
});

/**
 * `impactMap`: the areas a change might reach beyond its diff, drawn around it. Each area names the blocks that explain
 * it, sent with `doc.block.upsert`; the reviewer opens one to read them and add their questions and concerns under it.
 */
export const impactMapConfig = z
    .object({
        areas: z
            .array(
                z.object({
                    id: z
                        .string()
                        .min(1)
                        .max(40)
                        .regex(/^[a-z0-9][a-z0-9-]*$/, 'must be lowercase letters, digits and hyphens'),
                    title: z.string().min(1).max(80),
                    /** One line on how the change reaches it. */
                    summary: z.string().min(1).max(400),
                    /** The blocks that explain it, by id: a diagram, a step-through, code, an interactive visual. */
                    blocks: z.array(recordId).max(4).default([])
                })
            )
            .min(2)
            .max(8)
    })
    .superRefine((config, ctx) =>
        checkUnique(
            config.areas.map((area) => area.id),
            'areas',
            ctx
        )
    );
export type ImpactMapConfig = z.output<typeof impactMapConfig>;

/** Every config schema, keyed by block type. The order is the catalog order. */
export const blockConfigSchemas = {
    text: textConfig,
    callout: calloutConfig,
    checklist: checklistConfig,
    table: tableConfig,
    stats: statsConfig,
    flow: flowConfig,
    sequence: sequenceConfig,
    architecture: architectureConfig,
    state: stateConfig,
    schema: schemaConfig,
    c4: c4Config,
    mindmap: mindmapConfig,
    compare: compareConfig,
    timeline: timelineConfig,
    gantt: ganttConfig,
    bar: barConfig,
    line: lineConfig,
    sankey: sankeyConfig,
    riskMatrix: riskMatrixConfig,
    optionMatrix: optionMatrixConfig,
    fileTree: fileTreeConfig,
    code: codeConfig,
    image: imageConfig,
    mermaid: mermaidConfig,
    analogy: analogyConfig,
    stepThrough: stepThroughConfig,
    yourTake: yourTakeConfig,
    impactMap: impactMapConfig,
    html: htmlConfig
} as const;

export type BlockType = keyof typeof blockConfigSchemas;
/** Every block type, in catalog order. */
export const blockTypes = Object.keys(blockConfigSchemas) as BlockType[];

/** Block types only a review takes: a plan or an ask refuses a batch that sends one. */
export const REVIEW_BLOCK_TYPES: ReadonlySet<string> = new Set<BlockType>(['yourTake', 'impactMap', 'html']);

/** Parsed config for each block type. */
export type BlockConfigs = { [K in BlockType]: z.output<(typeof blockConfigSchemas)[K]> };

/** Whether `type` is a registered block type. An inherited name such as `constructor` is not. */
export function isBlockType(type: string): type is BlockType {
    return Object.hasOwn(blockConfigSchemas, type);
}

/**
 * The block envelope the agent sends. `config` is deliberately open here: each
 * type's schema is applied behind the tool boundary, so an invalid config is still
 * stored and shown as an error card instead of failing the whole batch.
 */
export const blockEnvelope = z.object({
    id: recordId,
    type: z.string().min(1).max(40),
    config: z.record(z.string(), z.unknown()),
    caption: z.string().max(1000).optional(),
    refs: z.array(recordId).max(40).optional(),
    /** Detail a non-technical reader can skip: the page folds the block behind a "Technical detail" toggle. */
    technical: z.boolean().optional()
});
export type BlockEnvelope = z.infer<typeof blockEnvelope>;

/** The strict block union: an envelope whose config matches its type. */
export const block = z.discriminatedUnion('type', [
    blockEnvelope.extend({ type: z.literal('text'), config: textConfig }),
    blockEnvelope.extend({ type: z.literal('callout'), config: calloutConfig }),
    blockEnvelope.extend({ type: z.literal('checklist'), config: checklistConfig }),
    blockEnvelope.extend({ type: z.literal('table'), config: tableConfig }),
    blockEnvelope.extend({ type: z.literal('stats'), config: statsConfig }),
    blockEnvelope.extend({ type: z.literal('flow'), config: flowConfig }),
    blockEnvelope.extend({ type: z.literal('sequence'), config: sequenceConfig }),
    blockEnvelope.extend({ type: z.literal('architecture'), config: architectureConfig }),
    blockEnvelope.extend({ type: z.literal('state'), config: stateConfig }),
    blockEnvelope.extend({ type: z.literal('schema'), config: schemaConfig }),
    blockEnvelope.extend({ type: z.literal('c4'), config: c4Config }),
    blockEnvelope.extend({ type: z.literal('mindmap'), config: mindmapConfig }),
    blockEnvelope.extend({ type: z.literal('compare'), config: compareConfig }),
    blockEnvelope.extend({ type: z.literal('timeline'), config: timelineConfig }),
    blockEnvelope.extend({ type: z.literal('gantt'), config: ganttConfig }),
    blockEnvelope.extend({ type: z.literal('bar'), config: barConfig }),
    blockEnvelope.extend({ type: z.literal('line'), config: lineConfig }),
    blockEnvelope.extend({ type: z.literal('sankey'), config: sankeyConfig }),
    blockEnvelope.extend({ type: z.literal('riskMatrix'), config: riskMatrixConfig }),
    blockEnvelope.extend({ type: z.literal('optionMatrix'), config: optionMatrixConfig }),
    blockEnvelope.extend({ type: z.literal('fileTree'), config: fileTreeConfig }),
    blockEnvelope.extend({ type: z.literal('code'), config: codeConfig }),
    blockEnvelope.extend({ type: z.literal('image'), config: imageConfig }),
    blockEnvelope.extend({ type: z.literal('mermaid'), config: mermaidConfig }),
    blockEnvelope.extend({ type: z.literal('analogy'), config: analogyConfig }),
    blockEnvelope.extend({ type: z.literal('stepThrough'), config: stepThroughConfig }),
    blockEnvelope.extend({ type: z.literal('yourTake'), config: yourTakeConfig }),
    blockEnvelope.extend({ type: z.literal('impactMap'), config: impactMapConfig }),
    blockEnvelope.extend({ type: z.literal('html'), config: htmlConfig })
]);
export type Block = z.output<typeof block>;

/** The outcome of checking one block's config against its type. */
export type ConfigCheck =
    | { ok: true; type: BlockType; config: BlockConfigs[BlockType] }
    | { ok: false; reason: 'unknown-type' | 'invalid'; issues: Issue[] };

/** Validate a block's config against its type's schema, reporting paths relative to `config`. */
export function checkBlockConfig(type: string, config: unknown): ConfigCheck {
    if (!isBlockType(type)) {
        return {
            ok: false,
            reason: 'unknown-type',
            issues: [{ path: 'type', message: `"${type}" is not a registered block type` }]
        };
    }
    const result = blockConfigSchemas[type].safeParse(config);
    if (!result.success) return { ok: false, reason: 'invalid', issues: toIssues(result.error) };
    return { ok: true, type, config: result.data };
}
