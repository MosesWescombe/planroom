# Spec Delta

## MODIFIED Requirements

### Requirement: Blocks render from typed configs only

The write-up SHALL be a list of titled sections, each listing its blocks in order. The page SHALL render the block
types `text`, `callout`, `checklist`, `table`, `stats`, `flow`, `sequence`, `architecture`, `state`, `schema`, `c4`,
`mindmap`, `compare`, `timeline`, `gantt`, `bar`, `line`, `sankey`, `riskMatrix`, `optionMatrix`, `fileTree`, `code`,
`image`, `mermaid`, `analogy` and `stepThrough`, each from its config with the app's own component. A review session
SHALL also render `yourTake` and `html`, which MUST be refused in any other session. A `compare` side SHALL be a diagram,
a `code` block or an `image` block, whether inline or by block id. An `analogy` SHALL map each real part of the change to
its counterpart in the analogy, with an optional illustration and where the analogy breaks down. A `stepThrough` SHALL
pair a `flow` or `sequence` diagram with ordered steps, each lighting up nodes or messages under a caption, advanced by
the arrow keys or buttons. `text` SHALL carry prose as a markdown subset
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

#### Scenario: Analogy

- **WHEN** an `analogy` block maps a queue to a ticket counter, three parts to three counterparts, and names one place
  the analogy breaks down
- **THEN** each pair shows side by side with the break-down shown after them, in any session kind

#### Scenario: Step-through

- **WHEN** a `stepThrough` has a sequence diagram and three steps, each lighting one message under a caption
- **THEN** the first step shows its caption with that message lit, and the arrow keys or the buttons move to the next

#### Scenario: Compare with code and image sides

- **WHEN** a `compare` block has a `code` block on its left side and an `image` block on its right
- **THEN** both sides show next to each other under their labels

#### Scenario: Review-only block in a plan

- **WHEN** the agent sends a `yourTake` or `html` block in a planning or ask session
- **THEN** the batch is refused naming the block type and the session kind
