## Purpose

Phase 4 of a planning session: a submitted write-up becomes an OpenSpec change folder that is proven to validate
strictly, which the user reviews, comments on and accepts or sends back.

## ADDED Requirements

### Requirement: Submitting requests the change from the agent

Submitting SHALL send the agent the change id, the write-up revision being submitted and whether to validate strictly,
which is on by default. Submitting SHALL unlock and open the Proposal tab, which SHALL show progress as the change's
files appear and as validation runs. Leaving the tab MUST NOT cancel the work.

#### Scenario: Proposing

- **WHEN** the user submits write-up revision 4 for `add-api-rate-limiting`
- **THEN** the Proposal tab opens and ticks off the proposal, design, spec deltas and tasks as each file appears, then
  the validation step

### Requirement: The proposal opens for review on strict validation

When strict validation of the submitted change passes, the Proposal tab SHALL replace its progress with the review, and
the user SHALL be able to accept or request changes. When it fails, the review SHALL stay locked, the page SHALL show
the validation output, and the agent SHALL receive the errors to fix. Submitting again SHALL lock the review until the
new change passes.

#### Scenario: Validation passes

- **WHEN** `openspec validate add-api-rate-limiting --strict` passes after submission
- **THEN** the Proposal tab shows the review with "Accept proposal" and "Request changes"

#### Scenario: Validation fails

- **WHEN** a scenario in the written spec uses three hashes instead of four
- **THEN** the review stays locked, the page shows the failure, and the agent receives it

### Requirement: The change renders as written on disk

The Proposal tab SHALL show the change folder's file tree with each file marked new or by its delta operation, render
the proposal, design and tasks with a raw-markdown toggle, and render each spec delta as its requirements with their
WHEN, THEN and AND scenarios. The view SHALL update when the files change on disk.

#### Scenario: Agent edits a spec from a comment

- **WHEN** the agent updates `specs/rate-limits/spec.md` in response to a comment
- **THEN** the rendered requirement updates without a reload

### Requirement: Requirements trace back to answers

Each rendered requirement SHALL show the question ids the agent traced it to, a requirement with no trace SHALL be
marked untraced, and the summary SHALL show how many answered questions at least one requirement traces.

#### Scenario: Traced requirement

- **WHEN** the agent traces "Fail open when the limit store is unavailable" to Q-12
- **THEN** that requirement shows a Q-12 link that opens the question

### Requirement: Validation can be re-run from the page

The user SHALL be able to re-run strict validation from the page, and the latest result SHALL replace the shown status.

#### Scenario: Re-run after a hand edit

- **WHEN** the user edits `tasks.md` by hand and clicks Re-run
- **THEN** the page shows the new validation result

### Requirement: A Markdown plan is written and checked in place of a change

When the plan's format is Markdown, the submit dialog SHALL name `agent-plans/<change-id>/<change-id>.md` as the file
the agent writes, with no strict validation to choose. The agent SHALL write that file, and the server SHALL check that
it exists and is not empty in place of running `openspec validate`, gating the review on the check exactly as on a
validation. The review SHALL leave out requirement, task and trace counts, and accepting SHALL work as it does for a
change.

#### Scenario: Plan file missing

- **WHEN** the agent marks a Markdown plan ready before writing `add-api-rate-limiting.md`
- **THEN** the check fails naming the missing file, the review stays locked, and `openspec validate` is not run

#### Scenario: Plan written

- **WHEN** `agent-plans/add-api-rate-limiting/add-api-rate-limiting.md` exists with content and the check re-runs
- **THEN** the review unlocks, shows the plan file, and the user can accept it

### Requirement: The user accepts or requests changes

"Accept proposal" SHALL be enabled only when the latest validation passed and no comment on the proposal is open.
Accepting SHALL notify the agent and make the session read-only.
"Request changes" SHALL require at least one open comment or a message and SHALL notify the agent. Accepting MUST NOT
start implementation.

#### Scenario: Accept

- **WHEN** validation passed, no proposal comment is open and the user accepts
- **THEN** the agent is notified and the session becomes read-only

#### Scenario: Accept blocked by a comment

- **WHEN** a comment on the proposal is open
- **THEN** "Accept proposal" is disabled and says the comment needs resolving
