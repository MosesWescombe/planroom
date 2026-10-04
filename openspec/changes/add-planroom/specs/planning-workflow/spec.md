## Purpose

Defines how Claude Code uses Planroom in this repo: when it opens a session, how it drives each phase, where it
stops, and how the repo's other planning skills hand off to and from it.

## ADDED Requirements

### Requirement: Planning requests open a Planroom session

When the user asks Claude Code to plan a feature or change in this repo, the agent SHALL open or resume a Planroom
session for a kebab-case change id derived from the request, and SHALL show the page URL in the terminal. A new plan
SHALL be opened in the format the user asked for, an OpenSpec change or a Markdown plan, and the agent SHALL ask the
user which when they did not say. When the
Planroom server is unavailable, the agent MUST report the failure and how to fix it instead of planning in chat.

#### Scenario: Plan a feature

- **WHEN** the user asks "plan rate limiting for the public API"
- **THEN** the agent opens a session for a change id such as `add-api-rate-limiting` and prints its URL

#### Scenario: Plan as markdown

- **WHEN** the user asks "plan rate limiting for the public API as a markdown plan"
- **THEN** the agent opens the session in the Markdown format, and the accepted plan is written to
  `agent-plans/add-api-rate-limiting/add-api-rate-limiting.md`

#### Scenario: Server not built

- **WHEN** the Planroom server fails to start because it has not been built
- **THEN** the agent says so, names the build command, and does not fall back to planning in chat

### Requirement: The agent grounds and runs the phase loop

The agent SHALL look up any fact the codebase can answer instead of asking it, SHALL attach its findings and source
references to each question, and SHALL recommend an option whenever it has a view. It SHALL handle page events in
sequence order: answers by adding follow-ups, closing or merging questions; comments by replying and editing;
phase completion by writing the write-up; and submission by writing the change and running strict validation.

#### Scenario: Answer spawns a follow-up

- **WHEN** the user answers "Plans table + per-key override" to Q-14
- **THEN** the agent upserts a follow-up question about override expiry linked to Q-14

#### Scenario: Submission

- **WHEN** the agent receives a submit event for `add-api-rate-limiting`
- **THEN** it writes the change's proposal, design, spec deltas and tasks from the submitted write-up revision, runs strict validation, and reports the result to the page

### Requirement: The agent stops at an accepted proposal

On an accept event the agent SHALL end the session, report the change id and the next step `/decompose <change-id>`,
and MUST NOT start implementing the change.

#### Scenario: Proposal accepted

- **WHEN** the user accepts the proposal for `add-api-rate-limiting`
- **THEN** the agent reports the change id and `/decompose add-api-rate-limiting`, and makes no code changes

### Requirement: Planroom shuts down when the session ends

Once the agent has received an accept or end-session event logged during the current run, Planroom SHALL close the
session, release the change's lock and stop serving the page, while staying connected to the agent session. The open
page SHALL show that Planroom closed instead of trying to reconnect. An accept or end logged by an earlier run MUST NOT
shut a resumed session down.

#### Scenario: Shut down after accepting

- **WHEN** the user accepts the proposal and the agent's wait returns the accept event
- **THEN** the change's lock is released, the page URL stops answering, and the page shows "Planroom closed"

#### Scenario: Resuming an ended session

- **WHEN** the agent opens a change whose session was finished in an earlier run and its wait returns that end event
- **THEN** the page stays served

### Requirement: Decompose reads an OpenSpec change or a Markdown plan

`/decompose <change-id>` SHALL read the change's proposal, design, spec deltas and tasks from
`openspec/changes/<change-id>/`, or for a Markdown plan `agent-plans/<change-id>/<change-id>.md`, and write tickets to `agent-plans/<change-id>/<change-id>-tickets/` in the existing
ticket and INDEX format. With no argument it SHALL list the in-flight changes and ask which one; with a name that is not
a change it SHALL say so and point at Planroom.

#### Scenario: Decompose an accepted change

- **WHEN** the user runs `/decompose add-api-rate-limiting`
- **THEN** tickets and an INDEX are written under `agent-plans/add-api-rate-limiting/add-api-rate-limiting-tickets/`

#### Scenario: Unknown change

- **WHEN** the user runs `/decompose not-a-change`
- **THEN** the agent says no such change exists and points at planning it with Planroom

### Requirement: Planroom replaces plan-feature and grill

The repo SHALL NOT provide the `plan-feature` or `grill` skills, and no agent documentation in the repo SHALL reference
them.

#### Scenario: Agent docs check

- **WHEN** `pnpm check:agent-docs` runs after this change
- **THEN** it passes and no file under `.agents/` or any `AGENTS.md` names `plan-feature` or `grill`
