import type { BlockType } from './blocks.js';

/** One catalog entry: what the block is for and a config that renders it, taken from the handoff's block catalog. */
export interface CatalogEntry {
    title: string;
    /** When to reach for this block. */
    use: string;
    /** Field notes the schema alone does not make obvious. */
    notes?: string[];
    example: Record<string, unknown>;
}

/** The catalog, in the order the handoff presents it. Every example must parse against its type's schema. */
export const blockCatalog: Record<BlockType, CatalogEntry> = {
    text: {
        title: 'Text',
        use: 'Prose: a paragraph, a bullet list, a short summary. The only block that carries free text.',
        notes: [
            'A markdown subset: paragraphs, `-` and `1.` lists, **bold**, *italic*, `inline code` and links. HTML is shown as literal text.',
            'Mention question ids (`Q-12`) in the text and the page links them.'
        ],
        example: {
            body: '- A new **limiter middleware** checks a per-key token bucket in Redis before any handler runs.\n- Over-limit calls get `429 rate_limited` with `Retry-After`.\n- If Redis is unreachable we **fail open** and page on-call (Q-12).'
        }
    },
    callout: {
        title: 'Callout',
        use: 'A decision, assumption, note or risk worth pulling out. A write-up `assumption` callout gets Confirm and Correct buttons and counts against the submit gate until confirmed.',
        notes: ['tone: note | decision | assumption | risk', 'Put the question ids it came from in the envelope `refs`.'],
        example: { tone: 'decision', title: 'Fail open on timeout', body: 'Availability wins over strictness.' }
    },
    checklist: {
        title: 'Checklist',
        use: 'Acceptance criteria or agreements. With `interactive: true` the user ticks items and every tick reaches you.',
        notes: ['Give items a stable `id` if you will reorder them; ticks are stored by id, or by position without one.'],
        example: {
            interactive: true,
            items: [
                { text: '429 has Retry-After', done: true },
                { text: 'Fail-open metric', done: true },
                { text: 'Per-IP on anon routes' }
            ]
        }
    },
    table: {
        title: 'Table',
        use: 'Mappings, inventories, figures: anything row-shaped. The user can sort by any column. Compare options with `optionMatrix` instead, and never write a decisions table: the page lists the decisions itself.',
        notes: [
            'Every row has one cell per column. A cell is a string, a number, `null` or a badge.',
            'A string cell takes inline markdown: **bold**, *italic*, `inline code` and links. Block syntax stays literal, so `> 5 ms` or `1. Draft` reads as written.',
            'A badge cell is `{ "text": "To confirm", "tone": "attention" }`. tone: neutral | accent | attention. Use it for a status or verdict column.',
            '`refColumn` names the column holding question ids, which render as links.'
        ],
        example: {
            columns: ['Plan', 'Sustained', 'Burst', 'From'],
            rows: [
                ['Free', '60 / min', 60, 'Q-08'],
                ['Team', '600 / min', 300, 'Q-08'],
                ['Business', '3,000 / min', { text: 'To confirm', tone: 'attention' }, 'Q-10']
            ],
            refColumn: 3
        }
    },
    stats: {
        title: 'Stat tiles',
        use: 'One to four headline numbers. No decoration.',
        notes: ['tone: neutral | accent | attention'],
        example: {
            items: [
                { label: 'Requirements', value: 3 },
                { label: 'Tasks', value: 12 },
                { label: 'To confirm', value: 2, tone: 'attention' }
            ]
        }
    },
    flow: {
        title: 'Flow',
        use: 'Request paths, pipelines, decision branches. You give nodes and edges; the page lays them out.',
        notes: [
            'direction: LR | RL | TB | BT',
            'A node with `emphasis: "new"` or `"changed"` is painted in the accent style: use it for the part the decision hinges on.',
            '`shape: "decision"` draws a diamond. An edge with `style: "dashed"` is a fallback path; label it.'
        ],
        example: {
            direction: 'LR',
            nodes: [
                { id: 'c', label: 'Client' },
                { id: 'l', label: 'Limiter', emphasis: 'new' },
                { id: 'h', label: 'Handler' }
            ],
            edges: [
                { from: 'c', to: 'l' },
                { from: 'l', to: 'h', label: 'has tokens' }
            ]
        }
    },
    sequence: {
        title: 'Sequence',
        use: 'Who calls whom, in what order.',
        notes: ['`from` and `to` are indexes into `actors`. `reply: true` draws a dashed return arrow.'],
        example: {
            actors: ['Client', 'API', 'Redis'],
            messages: [
                { from: 0, to: 1, text: 'GET /orders' },
                { from: 1, to: 2, text: 'take token' },
                { from: 2, to: 1, text: '0 left', reply: true },
                { from: 1, to: 0, text: '429', reply: true }
            ]
        }
    },
    architecture: {
        title: 'Architecture',
        use: 'Components inside boundaries, with labelled links.',
        notes: ['A node belongs to at most one group.'],
        example: {
            groups: [
                { label: 'API cluster', nodes: ['gw', 'lim'] },
                { label: 'Data', nodes: ['redis'] }
            ],
            nodes: [
                { id: 'gw', label: 'Gateway' },
                { id: 'lim', label: 'Limiter', emphasis: 'new' },
                { id: 'redis', label: 'Redis' }
            ],
            links: [
                { from: 'gw', to: 'lim' },
                { from: 'lim', to: 'redis', label: 'Lua' }
            ]
        }
    },
    state: {
        title: 'State machine',
        use: 'The states something moves through, and why.',
        notes: [
            '`initial` is drawn with a heavier outline. States listed in `emphasis` are painted as the fallback or failure states.'
        ],
        example: {
            initial: 'allowed',
            states: ['allowed', 'limited', 'failed_open'],
            transitions: [
                { from: 'allowed', to: 'limited', on: 'empty' },
                { from: 'limited', to: 'allowed', on: 'refill' },
                { from: 'allowed', to: 'failed_open', on: 'timeout' }
            ],
            emphasis: ['failed_open']
        }
    },
    schema: {
        title: 'Schema',
        use: 'Database tables, their columns and the relations between them: what a migration adds, alters or drops.',
        notes: [
            'A table has an `id` (its heading unless you give a `name`) and its columns in order. A column has a `name`, an optional `type` and `keys` (pk | fk | uk).',
            '`change: "added" | "changed" | "removed"` on a table, a column or a relation paints what the change does to it.',
            'A relation reads from `from` to `to`. Name the columns with `fromColumn` and `toColumn` and the line joins those rows. cardinality: many-to-one (the default: a foreign key on `from`) | one-to-one | one-to-many | many-to-many.'
        ],
        example: {
            tables: [
                {
                    id: 'plans',
                    columns: [
                        { name: 'id', type: 'uuid', keys: ['pk'] },
                        { name: 'name', type: 'text' },
                        { name: 'rpm', type: 'int', change: 'added' }
                    ]
                },
                {
                    id: 'api_keys',
                    columns: [
                        { name: 'id', type: 'uuid', keys: ['pk'] },
                        { name: 'plan_id', type: 'uuid', keys: ['fk'] },
                        { name: 'rpm_override', type: 'int', change: 'added' }
                    ]
                },
                {
                    id: 'limit_events',
                    change: 'added',
                    columns: [
                        { name: 'id', type: 'bigint', keys: ['pk'] },
                        { name: 'key_id', type: 'uuid', keys: ['fk'] },
                        { name: 'at', type: 'timestamptz' }
                    ]
                }
            ],
            relations: [
                { from: 'api_keys', fromColumn: 'plan_id', to: 'plans', toColumn: 'id' },
                { from: 'limit_events', fromColumn: 'key_id', to: 'api_keys', toColumn: 'id', change: 'added' }
            ]
        }
    },
    c4: {
        title: 'C4 view',
        use: 'A C4 context, container or component view: who uses the system, what it is made of, and what it talks to.',
        notes: [
            'kind: person | system | container | component | database | queue. `technology` and `description` are short lines under the label.',
            '`external: true` greys out an element outside the system being described. `emphasis: "new" | "changed"` paints it in the accent style.',
            'A boundary draws a box around the elements it lists; an element sits in one boundary at most. A relation can name its `technology` ("HTTPS").'
        ],
        example: {
            elements: [
                { id: 'dev', kind: 'person', label: 'API customer', description: 'Calls the public API' },
                { id: 'gw', kind: 'container', label: 'Gateway', technology: 'Node, Express' },
                {
                    id: 'lim',
                    kind: 'component',
                    label: 'Limiter',
                    technology: 'middleware',
                    description: 'A token bucket per key',
                    emphasis: 'new'
                },
                { id: 'redis', kind: 'database', label: 'Redis', technology: 'Redis 7' },
                { id: 'pager', kind: 'system', label: 'PagerDuty', external: true }
            ],
            boundaries: [{ label: 'API platform', elements: ['gw', 'lim', 'redis'] }],
            relations: [
                { from: 'dev', to: 'gw', label: 'calls', technology: 'HTTPS' },
                { from: 'gw', to: 'lim', label: 'checks each request' },
                { from: 'lim', to: 'redis', label: 'takes a token', technology: 'Lua' },
                { from: 'lim', to: 'pager', label: 'pages on fail-open' }
            ]
        }
    },
    mindmap: {
        title: 'Mind map',
        use: 'A topic broken into its parts: the scope of a change, the areas it touches, the open threads.',
        notes: [
            'The config is the centre node: a `label` and its `children`. Each child has a `label` and its own `children`, four levels deep at most, 80 nodes in all.',
            'Each top-level branch gets its own colour. `emphasis: "new" | "changed"` marks a node.'
        ],
        example: {
            label: 'Rate limiting',
            children: [
                { label: 'Limits', children: [{ label: 'Per plan' }, { label: 'Per-key override' }] },
                { label: 'Storage', children: [{ label: 'Redis bucket', emphasis: 'new' }] },
                { label: 'Failure', children: [{ label: 'Fail open' }, { label: 'Page on-call' }] },
                { label: 'Rollout', children: [{ label: 'Shadow mode' }, { label: 'Free tier first' }] }
            ]
        }
    },
    compare: {
        title: 'Before / after',
        use: 'Two diagrams side by side, with the difference painted.',
        notes: [
            'Each side is the id of a flow, sequence, architecture or state block in the write-up, or an inline `{ type, config }` for one of those types. Its `label` is optional.',
            'highlight: added | removed | both | none. Nodes are matched by id.'
        ],
        example: {
            left: {
                label: 'Today',
                block: {
                    type: 'flow',
                    config: {
                        nodes: [
                            { id: 'c', label: 'Client' },
                            { id: 'h', label: 'Handler' }
                        ],
                        edges: [{ from: 'c', to: 'h' }]
                    }
                }
            },
            right: { label: 'After', block: 'flow-proposed' },
            highlight: 'added'
        }
    },
    timeline: {
        title: 'Timeline',
        use: 'Rollout steps, milestones, migration order.',
        notes: ['`current` is the index of the step in progress.'],
        example: {
            current: 0,
            steps: [
                { label: 'Shadow mode', detail: 'log only' },
                { label: 'Free tier', detail: 'enforce' },
                { label: 'All tiers', detail: 'flag removed' }
            ]
        }
    },
    gantt: {
        title: 'Gantt chart',
        use: 'A schedule: tasks with durations and dependencies on a time axis. For an ordered list of steps without dates or lengths, use `timeline`.',
        notes: [
            '`duration` is in days; 0 is a milestone. `start` is the date of day 0; without it the axis counts days and weeks.',
            'A task starts at `at` (days from the start), else when every task in `after` ends, else when the task before it ends. `after` names earlier tasks only.',
            '`group` puts tasks under a heading. status: done | active.'
        ],
        example: {
            start: '2026-10-05',
            tasks: [
                { id: 'build', label: 'Build the limiter', group: 'Build', duration: 10, status: 'done' },
                { id: 'shadow', label: 'Shadow mode', group: 'Rollout', duration: 14, after: ['build'], status: 'active' },
                { id: 'free', label: 'Enforce on Free', group: 'Rollout', duration: 7, after: ['shadow'] },
                { id: 'all', label: 'All tiers', group: 'Rollout', duration: 7, after: ['free'] },
                { id: 'flag', label: 'Flag removed', group: 'Rollout', duration: 0, after: ['all'] }
            ]
        }
    },
    bar: {
        title: 'Bar chart',
        use: 'Compare magnitudes across a few categories. Colours come from the page, never from you.',
        notes: ['Each `data` row is the category label followed by one value per series.'],
        example: {
            orientation: 'horizontal',
            unit: 'req/min',
            stacked: true,
            series: ['Sustained', 'Burst'],
            data: [
                ['Free', 60, 60],
                ['Team', 600, 300],
                ['Business', 3000, 1000]
            ]
        }
    },
    line: {
        title: 'Line chart',
        use: 'A trend over time, with optional annotations.',
        notes: ['Every series has one value per `x`. Set `sample: true` when the numbers are illustrative, not measured.'],
        example: {
            unit: '429s per hour',
            x: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
            series: [{ name: 'Would-be 429s', values: [12, 18, 15, 22, 19] }],
            annotations: [{ x: 'Wed', text: 'Limits tuned' }],
            sample: true
        }
    },
    sankey: {
        title: 'Sankey',
        use: 'How a quantity splits and merges as it moves: traffic through a pipeline, volume by destination, cost by service.',
        notes: [
            'Each flow names its two nodes by label and carries a positive `value`. A pair flows once, and flows never loop back.',
            'Columns follow the flows from left to right. Colours come from the page.'
        ],
        example: {
            unit: 'req/min',
            flows: [
                { from: 'Requests', to: 'Free', value: 1200 },
                { from: 'Requests', to: 'Team', value: 3000 },
                { from: 'Requests', to: 'Business', value: 4800 },
                { from: 'Free', to: 'Allowed', value: 900 },
                { from: 'Free', to: '429', value: 300 },
                { from: 'Team', to: 'Allowed', value: 2900 },
                { from: 'Team', to: '429', value: 100 },
                { from: 'Business', to: 'Allowed', value: 4800 }
            ]
        }
    },
    riskMatrix: {
        title: 'Risk matrix',
        use: 'Likelihood against impact, 3 x 3.',
        notes: ['likelihood and impact: 1 (low) to 3 (high).'],
        example: {
            items: [
                { label: 'Limits too tight', likelihood: 3, impact: 2 },
                { label: 'Retry storms', likelihood: 2, impact: 2 },
                { label: 'Silent fail-open', likelihood: 1, impact: 3 }
            ]
        }
    },
    optionMatrix: {
        title: 'Option matrix',
        use: 'Options compared side by side against criteria. Use it, not a table, whenever you compare options: products, approaches, directions. Good in question context.',
        notes: [
            'One column per option, one row per criterion, and every row has one cell per option.',
            'A cell is a score from 0 to 3 (drawn as dots; more is better), short text, or `{ "text": "Auto-refresh only", "verdict": "bad" }`. verdict: good | mixed | bad.',
            '`recommended` is the index of the option you recommend; its column is highlighted.'
        ],
        example: {
            options: ['Fail open', 'Fail closed', 'Local bucket'],
            rows: [
                {
                    criterion: 'Uptime',
                    cells: [
                        { text: 'Unaffected', verdict: 'good' },
                        { text: 'Redis down is an outage', verdict: 'bad' },
                        { text: 'Unaffected', verdict: 'good' }
                    ]
                },
                {
                    criterion: 'Protection',
                    cells: [
                        { text: 'None while Redis is down', verdict: 'bad' },
                        { text: 'Full', verdict: 'good' },
                        { text: 'Per instance only', verdict: 'mixed' }
                    ]
                },
                { criterion: 'Effort', cells: [3, 3, 1] },
                { criterion: 'Moving parts', cells: ['None', 'None', 'A bucket per instance'] }
            ],
            recommended: 0
        }
    },
    fileTree: {
        title: 'File tree',
        use: 'Files the change will add or touch.',
        notes: ['change: added | modified | removed | renamed'],
        example: {
            root: 'src/',
            files: [
                { path: 'middleware/limiter.ts', change: 'added' },
                { path: 'lib/redis.ts', change: 'modified' },
                { path: 'config/plans.yaml', change: 'modified' }
            ]
        }
    },
    code: {
        title: 'Code / diff',
        use: 'A real excerpt from the repo, a proposed diff, or a snippet of code that is not in the repo yet: a new file, a config, a payload.',
        notes: [
            'mode: excerpt | diff | snippet. An excerpt names a tracked repo file and `lines` ("12-15"); the page reads the file itself, so it is never stale.',
            'A diff carries a unified `patch`. A snippet carries its code as `source`; `file` is optional and only titles it.',
            'The page highlights by `lang` (a highlight.js name such as `ts`, `json`, `yaml`, `sql`), else the file extension, else a guess, and folds by indentation, so indent code properly.'
        ],
        example: {
            file: 'src/lib/redis.ts',
            lines: '12-15',
            mode: 'diff',
            lang: 'ts',
            patch: '@@ -12,3 +12,4 @@\n export const redis = new Redis({\n-  maxRetries: 3,\n+  maxRetries: 1,\n+  commandTimeout: 50,\n });'
        }
    },
    image: {
        title: 'Annotated image',
        use: 'A screenshot or mockup with numbered pins.',
        notes: [
            "`src` is `asset:<file>`, a file you saved under the change folder's `.planroom/assets/`.",
            'Pin x and y run from 0 to 1 across the image.'
        ],
        example: {
            src: 'asset:errors.png',
            alt: 'Error-rate dashboard',
            pins: [{ x: 0.64, y: 0.42, text: '429s appear in this panel' }]
        }
    },
    mermaid: {
        title: 'Mermaid fallback',
        use: 'Escape hatch for a diagram no native block covers (a git graph, a quadrant chart). Prefer a native block when one fits.',
        example: {
            source: 'gitGraph\n  commit\n  branch limiter\n  commit\n  commit\n  checkout main\n  merge limiter'
        }
    }
};
