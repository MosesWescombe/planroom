## Purpose

Phase 3 of a planning session: the agent turns the settled answers into a long-form write-up built from typed blocks
the app renders, and the user reviews it section by section, with history and undo, before submitting.

## ADDED Requirements

### Requirement: Blocks render from typed configs only

The write-up SHALL be a list of titled sections, each listing its blocks in order. The page SHALL render the block
types `text`, `callout`, `checklist`, `table`, `stats`, `flow`, `sequence`, `architecture`, `state`, `schema`, `c4`,
`mindmap`, `compare`, `timeline`, `gantt`, `bar`, `line`, `sankey`, `riskMatrix`, `optionMatrix`, `fileTree`, `code`,
`image` and `mermaid`, each from its config with the app's own component. `text` SHALL carry prose as a markdown subset
rendered as elements. Text in any config MUST render as text, never as markup.
Diagrams SHALL be laid out by the app from nodes and edges, tables and relations, tasks or flows, and chart colours
SHALL come from the app's palette. A `schema` relation that names its columns SHALL join those columns' rows and mark
how many sit at each end. A `gantt` task SHALL start at its own offset, else when every task it waits on ends, else when
the task before it ends. An `optionMatrix` SHALL show one column per option and a row per criterion, each cell a score,
a short text or a text with a verdict shown by an icon as well as colour. A `code` block SHALL show a live repo excerpt,
a unified diff or a snippet in the code viewer, highlighted by its language and foldable by indentation. Every block
SHALL support an optional caption, question references and a full-screen view, and no diagram SHALL require a caption or
label. In full screen, diagrams, charts and images SHALL open fitted to the screen and SHALL zoom and scroll, as SHALL a
pasted image.

#### Scenario: Zooming a diagram

- **WHEN** the user opens an architecture diagram full screen and zooms in with the wheel over one node
- **THEN** that node stays under the pointer, the diagram scrolls in both directions as far as its edges and no
  further, and pressing 0 fits it to the screen again

#### Scenario: Markup in a config

- **WHEN** a callout's body is `<img src=x onerror=alert(1)>`
- **THEN** the page shows that string as literal text and runs nothing

#### Scenario: Folding a snippet

- **WHEN** a `code` block in snippet mode holds a TypeScript function and the user folds its first line
- **THEN** the function body collapses to one line while its closing brace stays in view, and unfolding restores it

#### Scenario: Diagram without coordinates

- **WHEN** a `flow` block gives three nodes and two edges
- **THEN** the page lays them out in the given direction, painting nodes marked `emphasis: "new"` in the accent style

#### Scenario: Schema diagram

- **WHEN** a `schema` block relates `api_keys.plan_id` to `plans.id` with the default many-to-one cardinality
- **THEN** the line leaves the `plan_id` row and reaches the `id` row, with a crow's foot at `api_keys` and a bar at
  `plans`, and columns marked `added` are painted in the accent style

#### Scenario: C4 view

- **WHEN** a `c4` block holds a person, a container, a database and an external system inside one boundary
- **THEN** the page lays them out top to bottom, the person with a head, the database as a cylinder, the external system
  greyed, each with its kind and technology under its label, and the boundary boxed with its label

#### Scenario: Mind map

- **WHEN** a `mindmap` block has four branches
- **THEN** they split between the left and right of the centre, siblings stack without overlapping, each branch keeps
  one colour, and hovering a node lights it and the path to the centre

#### Scenario: Gantt chart

- **WHEN** a `gantt` task waits on two tasks that end on days 5 and 3
- **THEN** it starts on day 5, a curve joins it to each task it waits on, a zero-length task draws as a milestone, and
  with a `start` date the axis and the table view read as dates

#### Scenario: Sankey

- **WHEN** a `sankey` block sends 9,000 requests into three plans that each split into allowed and 429
- **THEN** the source node is as tall as 9,000, columns run left to right, each band is as wide as its value in its
  source's colour, and a flow that would loop back is refused with its path

#### Scenario: Option matrix

- **WHEN** an `optionMatrix` recommends the first of three options and judges uptime as good, bad and good
- **THEN** the options are the columns with the first one marked "Recommended", and each verdict shows its icon and its
  word for screen readers

### Requirement: Diagrams curve their edges and follow the pointer

Graph diagrams SHALL draw their edges as smooth curves through the layout's points. Hovering a node SHALL fade every
node and edge except that node, its neighbours and the edges between them, and leaving it SHALL restore the diagram.

#### Scenario: Curved edges

- **WHEN** a `flow` edge bends around a node
- **THEN** it is drawn as one smooth curve from its first point to its last, and a two-point edge stays straight

#### Scenario: Hover highlight

- **WHEN** the user hovers the first of three nodes in a chain
- **THEN** that node, the next one and the edge between them stay lit while the third node and its edge fade

### Requirement: Sections can set blocks side by side

An entry in a section's block list SHALL be either a block id or a row of two or three ids, which the page SHALL show
side by side as columns, stacking them when a column would be too narrow to read. A block in a row SHALL behave as any
other block in its section for review, undo, history and listing checks.

#### Scenario: Side-by-side columns

- **WHEN** a section lists `["intro", ["before", "after"], "notes"]`
- **THEN** the two diagrams sit next to each other between the intro and the notes, without labels or captions

#### Scenario: Missing block in a row

- **WHEN** a section's row names a block the agent has not sent
- **THEN** the batch is refused with the path of that row and column, e.g. `section.blocks[1][1]`

### Requirement: The page lists the decisions

The write-up SHALL end with a Decisions section the page builds from the answered questions in scope, one row per
question in id order: its topic (else its title), the answer in words with any note, a status while the answer needs
review or conflicts, and a link to the question. The agent SHALL NOT write it, and the section SHALL NOT need review
or count toward the submit gate. `planroom_state` SHALL return the rows as `decisions`.

#### Scenario: Decisions from answers

- **WHEN** Q-1 and Q-2 are answered and Q-3 needs review
- **THEN** the write-up ends with a numbered Decisions section of three rows linking each question, Q-3 marked "Needs
  review", listed last in the contents, with no reviewed tick

#### Scenario: No answers, no decisions

- **WHEN** no question has been answered
- **THEN** the write-up shows no Decisions section and the contents list none

### Requirement: Invalid and unknown blocks degrade visibly

A block whose config is invalid SHALL render as an error card listing each error with the raw config and an "Ask agent
to fix" action that sends a fix request naming the block. A block of an unknown type SHALL render its raw config. A
`compare` side that references a missing block id SHALL show the error on that side only.

#### Scenario: Ask agent to fix

- **WHEN** the user clicks "Ask agent to fix" on an invalid `bar` block
- **THEN** the agent receives a fix request with the block id and its validation errors

### Requirement: Agent changes drop reviewed sections to needs review

Each write-up section SHALL have a reviewed tick the user controls. When the agent changes a block the user had
reviewed, that section SHALL become unreviewed and show "changed by agent". The tick is the user's own record: it SHALL
persist with the session and count toward the submit gate, and ticking or unticking SHALL NOT notify the agent.

#### Scenario: Edited after review

- **WHEN** §4 is reviewed and the agent updates its bar chart
- **THEN** §4 shows "Unticked - changed by agent just now" and counts against the submit gate

### Requirement: Checklists and assumptions are answerable in place

Ticking an item in an interactive checklist SHALL persist and notify the agent. Each assumption the agent records SHALL
offer "Confirm", which notifies the agent, and "Correct it", which opens a comment with a change intent.

#### Scenario: Confirm an assumption

- **WHEN** the user confirms "Limits are per region, not global"
- **THEN** the assumption shows as confirmed and the agent is notified

### Requirement: Agent edits can be undone

Each agent edit to the write-up SHALL offer "Undo edit". Undo SHALL restore the affected blocks to their previous
content as a new revision and notify the agent of what was reverted. Undo SHALL be disabled, with the reason, when any
of those blocks has changed again since.

#### Scenario: Undo

- **WHEN** the user undoes the agent's edit to §4
- **THEN** §4 returns to its prior content and the agent receives which revision and blocks were reverted

#### Scenario: Superseded edit

- **WHEN** the agent edited §4 twice and the user tries to undo the first edit
- **THEN** Undo on the first edit is disabled with "§4 changed again since"

### Requirement: Write-up revisions are browsable and diffable

Every agent batch that changes the write-up SHALL record a revision with its time and the agent's summary. The user SHALL
be able to open any earlier revision read-only and diff any two, seeing added, removed and changed blocks and the text
changes within each changed block.

#### Scenario: Diff two revisions

- **WHEN** the user diffs revision 3 against revision 4
- **THEN** the page lists §4's bar chart as changed, with the Enterprise row's old and new values marked

### Requirement: The submit gate lists what still needs the user

The submit bar SHALL count unreviewed sections, unconfirmed assumptions, open comments and unresolved questions. The
submit dialog SHALL list each outstanding item with a link to it, and submitting with any outstanding SHALL require an
explicit "Submit anyway", which records the outstanding items with the submission.

#### Scenario: Blocked submit

- **WHEN** §4 is unreviewed and two assumptions are unconfirmed
- **THEN** the dialog reads "Not quite ready" with both items and their links, and "Submit anyway" is the only way on

#### Scenario: Ready submit

- **WHEN** nothing is outstanding
- **THEN** the dialog shows the change id, the files the agent will write and the strict-validation option, ready to submit
