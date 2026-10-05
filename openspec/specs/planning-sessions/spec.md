# planning-sessions Specification

## Purpose
Ties each live planning session to exactly one change, proposed as an OpenSpec change or a Markdown plan, so its planning record, its phase and its access
rules persist across agent sessions and stay private to the machine running it.

## Requirements

### Requirement: Opening a session creates or resumes its change

Opening a session for a change id SHALL create `openspec/changes/<change-id>/` as an OpenSpec change when it does not
exist and start it in Phase 1 with no questions, or restore the session exactly as last persisted when it does. It
SHALL return the page URL to the agent either way. A change id that is not kebab-case MUST be rejected with nothing
created. Opening a new plan in the Markdown format SHALL keep it in `agent-plans/<change-id>/` and create no OpenSpec
change. A plan's format SHALL be fixed once it exists: resuming it SHALL keep its format without being told, and
opening it in the other format MUST be refused with nothing created.

#### Scenario: New change

- **WHEN** the agent opens a session for `add-api-rate-limiting` and no such change exists
- **THEN** the change folder is created, the session starts in Phase 1 with no questions, and the page URL is returned

#### Scenario: Resume in a new agent session

- **WHEN** a session with 22 questions and a write-up is reopened from a new Claude Code session
- **THEN** every question, answer, block, comment, review tick and the current phase are restored, and a new page URL is returned

#### Scenario: New Markdown plan

- **WHEN** the agent opens `add-api-rate-limiting` in the Markdown format and no plan exists for it
- **THEN** its session is persisted under `agent-plans/add-api-rate-limiting/.planroom/`, and no folder is created
  under `openspec/changes/`

#### Scenario: Format fixed once created

- **WHEN** the agent opens a Markdown plan again as an OpenSpec change
- **THEN** the call fails naming the plan's format and folder, and nothing is created

#### Scenario: Invalid change id

- **WHEN** the agent opens a session for `Add Rate Limiting`
- **THEN** the call fails with an error naming the kebab-case rule and nothing is written

### Requirement: Session state is durable

The system SHALL persist every accepted agent write and page event before acknowledging it, under
`openspec/changes/<change-id>/.planroom/`, or a Markdown plan's `agent-plans/<change-id>/.planroom/`. A crash at any point MUST leave the last complete state readable, never a
partial one.

#### Scenario: Crash after an acknowledged answer

- **WHEN** the server process is killed immediately after the page receives acknowledgement of an answer
- **THEN** reopening the session shows that answer

#### Scenario: Crash during a write

- **WHEN** the server process is killed while persisting state
- **THEN** reopening the session loads either the state before or the state after that write, and never fails to parse

### Requirement: One live session per change

A change SHALL have at most one live session. Opening a change that another running agent session holds MUST fail with
an error naming the live page URL. A hold left by a process that is no longer running SHALL be taken over.

#### Scenario: Change already open

- **WHEN** a second Claude Code session opens `add-api-rate-limiting` while the first is still running it
- **THEN** the call fails and the error includes the first session's page URL

#### Scenario: Stale hold

- **WHEN** the session holding a change was killed and a new agent session opens the change
- **THEN** the new session takes over and opens normally

### Requirement: Old plans can be reopened from the page

The page SHALL list every plan in the repo, meaning each folder under `openspec/changes/` or `agent-plans/` with a
persisted session (archived changes excluded), naming the Markdown ones, and SHALL mark the one it shows. Picking another plan SHALL switch the page to that plan
under a new URL, without creating a change. After a switch, the agent's next write or wait MUST be refused, with
nothing applied, until the agent reads the new plan. An accepted or ended plan SHALL open read-only with a Reopen
action, which makes it editable again in the phase it had reached and notifies the agent. The list SHALL also show
the plans of other repos Planroom has run in on the machine, grouped by repo, which the page MUST NOT open in this
session: it SHALL link to a plan's live page when another session holds it.

#### Scenario: Switch to an old plan

- **WHEN** the user picks `add-audit-log` from the plan list while the agent is planning `add-api-rate-limiting`
- **THEN** the page shows `add-audit-log` under a new URL, the old URL stops working, and the agent's next emit is
  refused naming `add-audit-log` until it calls `planroom_state`

#### Scenario: Only existing plans

- **WHEN** the page asks to open a change id that has no persisted session
- **THEN** the request is rejected and no change folder is created

#### Scenario: A plan in another repo

- **WHEN** the user opens the plan list while `agora-processor-app` has a plan another Claude session holds
- **THEN** that plan is listed under `agora-processor-app` with a link to its live page, and offers no switch here

#### Scenario: Reopen a finished plan

- **WHEN** the user opens a plan they finished and chooses Reopen
- **THEN** the plan takes edits again and the agent receives `session.reopen` with `from: finished`

### Requirement: Plans can be browsed without opening one

`planroom_open` without a change id SHALL serve and open a plan browser page that lists the plans as the plan list
does, marking none. While no plan is open, the agent's `planroom_wait` MUST wait until the user picks a plan there,
which then opens as a switch does. A standalone browser, started with `planroom open` and no agent, SHALL serve the same
page. A plan picked there, or from that plan's own list, SHALL open read-only without taking the change's lock, and
every write from its page MUST be refused.

#### Scenario: Agent opens the browser

- **WHEN** the agent calls `planroom_open` with no change id, waits, and the user picks `add-audit-log` on the page
- **THEN** the page shows `add-audit-log`, and the agent's wait is refused naming `add-audit-log` until it calls
  `planroom_state`

#### Scenario: Standalone browser

- **WHEN** the user runs `planroom open` and opens `add-audit-log` from the list
- **THEN** the plan shows read-only, no lock is taken so a Claude session can still open it, and an answer posted from
  the page is refused

### Requirement: The page is private to the local session

The page and its event stream SHALL be served only on the loopback interface. Every page, API and stream request MUST
carry the session's unguessable token, and a request whose `Host` is not the session's own loopback address, or whose
`Origin` is present and does not match it, MUST be rejected without changing state.

#### Scenario: Missing token

- **WHEN** a request to post an answer arrives without the session token
- **THEN** it is rejected and no event is recorded

#### Scenario: Cross-site request

- **WHEN** a page on another origin posts an answer to the session with a valid-looking body
- **THEN** it is rejected on its `Origin` and no event is recorded

### Requirement: Phases unlock in order

The Directions tab SHALL stay locked until the user picks directions to investigate, and SHALL say it was skipped when
the agent skipped explore or Phase 1 finished without directions. The Write-up tab SHALL stay locked until the
interrogation completes, and the Proposal tab SHALL stay locked until the write-up is submitted. A locked tab SHALL say
what unlocks it. An unlocked earlier phase SHALL stay readable.

#### Scenario: Write-up locked

- **WHEN** Phase 1 has open questions and the user has not chosen to draft with assumptions
- **THEN** the Write-up tab is disabled and reads "After phase 2", or "After phase 1" when the agent skipped explore

#### Scenario: Back to an earlier phase

- **WHEN** the user opens the Interrogate tab during Phase 4
- **THEN** every shared question and its answer is shown, and each direction's own on its Directions tab

### Requirement: The page opens in the user's browser

On opening a session the system SHALL try to open the page in the user's default browser, and SHALL return the URL
whether or not a browser opened.

#### Scenario: No browser available

- **WHEN** a session opens on a machine where no browser can be launched
- **THEN** the call still succeeds and returns the URL for the agent to print
