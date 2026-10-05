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

On an accept event the agent SHALL end the session and report the change id, and MUST NOT start implementing the
change.

#### Scenario: Proposal accepted

- **WHEN** the user accepts the proposal for `add-api-rate-limiting`
- **THEN** the agent reports the change id and makes no code changes

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
