# Spec Delta

## Purpose

The agent's own review of the PR: how findings are produced and verified, when the reviewer first sees them, how the reviewer reacts to each and which views show them.

## ADDED Requirements

### Requirement: Review runs at the reviewer's strength and is then verified

As a round opens, the page SHALL ask the reviewer to start its review, offering a strength of single, standard or thorough and the subagents' model and effort, pre-filled from their preferences. The agent SHALL start no `planroom-reviewer` subagent until the reviewer starts the round, then SHALL start them as the chosen strength says, each reading the diff and the worktree and each at the chosen model and effort. The round SHALL record the choice, and `planroom_review` and `planroom_state` SHALL return it. At `single` one reviewer SHALL cover every dimension and verify its own findings. At `standard` one reviewer SHALL cover every dimension and a verify pass SHALL follow. At `thorough` one reviewer SHALL run per dimension (correctness, security, performance, design fit and tests), splitting the files between them for a large diff, and a verify pass SHALL follow. A verify pass, the same agent told to refute rather than find, SHALL drop every item it cannot confirm from the code. Each surviving item SHALL show its confidence.

#### Scenario: Unconfirmed item dropped

- **WHEN** the security reviewer reports an item the verify pass cannot confirm from the code
- **THEN** the item is dropped and does not appear on the page

#### Scenario: Confidence shown

- **WHEN** an item survives the verify pass with confidence 0.8
- **THEN** its card shows that confidence

#### Scenario: Reviewers wait for the reviewer

- **WHEN** a review opens
- **THEN** the page shows the strength, model and effort from the reviewer's preferences with a Start button, and the agent starts no reviewer subagent until it is pressed

#### Scenario: Single strength

- **WHEN** the reviewer starts the round at `single` with model haiku and effort low
- **THEN** the agent starts one reviewer subagent, on haiku at low effort, and no separate verifier

### Requirement: A finding is an issue, a design opinion or a question

Every finding SHALL be one of three kinds. An issue SHALL carry a severity of blocker, important or minor, evidence, a suggested fix, and a likelihood and impact for the risk matrix. A design opinion SHALL carry the agent's reasoning and the alternative it weighed. A question for the author SHALL be something the code does not explain. Every finding SHALL have an anchor of a file plus a new-file or old-file line range, an optional link to a node in the deck's diagrams, up to four context blocks from the block catalog that show what a reader needs to judge it, and a drafted comment in Bitbucket's Markdown subset. Context blocks SHALL show on the finding's card and SHALL never be posted.

#### Scenario: Issue fields

- **WHEN** the agent upserts an issue with severity blocker, likelihood 3 and impact 3
- **THEN** its card shows the severity, evidence and suggested fix, and it appears on the risk matrix at that cell

#### Scenario: Context blocks

- **WHEN** the agent upserts a finding with a code block of its lines and a before-and-after compare
- **THEN** its card shows both under its claim, and the comment it drafts carries neither

#### Scenario: Invalid anchor

- **WHEN** the agent upserts a finding whose anchor names a file not in the diff
- **THEN** the call is refused naming the anchor

### Requirement: Findings stay hidden until the walkthrough is done

The Review tab SHALL stay locked until the reviewer finishes the walkthrough or presses a visible "skip to findings". A skip SHALL be logged as a page event. Findings MUST NOT appear anywhere on the page before then.

#### Scenario: Locked

- **WHEN** the deck is published and the reviewer has not finished it
- **THEN** the Review tab is locked and no finding shows on any diagram or in the diff

#### Scenario: Finished

- **WHEN** the reviewer reaches the end of the walkthrough and finishes it
- **THEN** the Review tab unlocks showing the verified findings

#### Scenario: Skipped

- **WHEN** the reviewer presses "skip to findings"
- **THEN** the Review tab unlocks and a skip event is logged

### Requirement: Each finding is agreed, reworded or rejected

Every finding SHALL take Agree, Reword or Reject, and the reviewer SHALL be able to open a thread to argue with the agent first. Agree SHALL queue the agent's drafted comment. Reword SHALL queue the reviewer's text. Reject SHALL queue nothing, keep the reviewer's reason on the page and send it to the agent, which MAY withdraw or soften related findings before the reviewer reaches them. Every finding SHALL need an explicit reaction before comments are previewed.

#### Scenario: Agree

- **WHEN** the reviewer agrees with a finding
- **THEN** the agent's draft is queued as a comment

#### Scenario: Reject with a reason

- **WHEN** the reviewer rejects a finding with the reason "handled in the caller"
- **THEN** no comment is queued, the reason shows on the card and the agent receives it

#### Scenario: Agent softens related findings

- **WHEN** the agent receives a rejection that undermines two related findings it had not yet shown
- **THEN** it may withdraw or reword them before the reviewer reaches them

#### Scenario: Unreacted finding

- **WHEN** one finding has no reaction and the reviewer opens Comments
- **THEN** the page lists that finding as still needing a reaction

### Requirement: Findings show in five views, each can be turned off

The page SHALL show findings as badge pins on the deck's flow, sequence and architecture diagrams at each finding's linked node, as cards beside their lines in the code viewer's diff mode for each changed file, as severity and kind charts, as a file heat map with a finding count on each changed file's row, and as a risk matrix from each issue's likelihood and impact. Each view SHALL be turned off by its preference.

#### Scenario: Diagram pin

- **WHEN** a finding links to node `cache` of an architecture diagram
- **THEN** a badge shows on that node

#### Scenario: Beside the diff

- **WHEN** a finding is anchored to lines 40 to 44 of `src/retry.ts`
- **THEN** its card shows beside those lines in the diff view of that file

#### Scenario: View off

- **WHEN** the risk matrix preference is off
- **THEN** the matrix does not render and the other four views still do
