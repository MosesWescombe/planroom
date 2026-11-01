# planning-sessions Specification

## Purpose
Ties each live planning session to exactly one change, proposed as an OpenSpec change or a Markdown plan, so its planning record, its phase and its access
rules persist across agent sessions and stay private to the machine running it.

## Requirements

### Requirement: Opening a session creates or resumes its change

Opening a session for a change id SHALL create `openspec/changes/<change-id>/` as an OpenSpec change when it does not
exist and start it in Phase 1 with no questions, or restore the session exactly as last persisted when it does. It
SHALL return the page URL to the agent either way. A change id that is not kebab-case MUST be rejected with nothing
created. Opening a new plan in the Markdown format SHALL keep it in `<change-id>/` in the repo's Markdown plans folder
and create no OpenSpec change. A new plan opened without a format SHALL be an OpenSpec change in a repo with an `openspec/` directory and a
Markdown plan in one without, and an OpenSpec plan in a repo without one MUST be refused with nothing created. A plan's
format SHALL be fixed once it exists: resuming it SHALL keep its format without being told, and
opening it in the other format MUST be refused with nothing created.

#### Scenario: New change

- **WHEN** the agent opens a session for `add-api-rate-limiting` and no such change exists
- **THEN** the change folder is created, the session starts in Phase 1 with no questions, and the page URL is returned

#### Scenario: Resume in a new agent session

- **WHEN** a session with 22 questions and a write-up is reopened from a new Claude Code session
- **THEN** every question, answer, block, comment, review tick and the current phase are restored, and a new page URL is returned

#### Scenario: New Markdown plan

- **WHEN** the agent opens `add-api-rate-limiting` in the Markdown format and no plan exists for it
- **THEN** its session is persisted under `agent-plans/add-api-rate-limiting/.planroom/` (in a repo that keeps its
  Markdown plans in `agent-plans/`), and no folder is created under `openspec/changes/`

#### Scenario: No openspec/ directory

- **WHEN** the agent opens `add-api-rate-limiting` without a format in a repo with no `openspec/` directory and an
  `agent-plans/` one
- **THEN** it opens as a Markdown plan under `agent-plans/add-api-rate-limiting/`, and no `openspec/` directory is created

#### Scenario: Format fixed once created

- **WHEN** the agent opens a Markdown plan again as an OpenSpec change
- **THEN** the call fails naming the plan's format and folder, and nothing is created

#### Scenario: Invalid change id

- **WHEN** the agent opens a session for `Add Rate Limiting`
- **THEN** the call fails with an error naming the kebab-case rule and nothing is written

### Requirement: Each repo has its own folder for Markdown plans

Markdown plans SHALL live in the repo's Markdown plans folder: the folder remembered for the repo on this machine, in
the registry beside the list of repos, or `agent-plans/` when none is. Opening a new Markdown plan when no folder is
remembered and the repo, or the plain folder Planroom runs in, has no `agent-plans/` MUST be refused at `plansDir`
with nothing created, telling the agent to ask the user where its Markdown plans go. A `plansDir` given to
`planroom_open` SHALL be a folder relative to the repo root, normalised; an absolute one, one outside the repo, and
one given for an OpenSpec plan MUST be refused with nothing created. A given folder SHALL be used for that plan and
remembered for every later Markdown plan in the repo, a remembered folder SHALL be used without asking, and resuming
an existing plan SHALL need neither. `planroom_open` and `planroom_state` SHALL return the plan's folder, and every
place that lists, opens or names Markdown plans, in this repo or another, SHALL use the repo's folder.

#### Scenario: No folder for Markdown plans yet

- **WHEN** the agent opens a new Markdown plan in a folder with no `agent-plans/` and no folder remembered for it
- **THEN** the call fails at `plansDir`, telling the agent to ask the user where Markdown plans go, and nothing is created

#### Scenario: The chosen folder is remembered

- **WHEN** the agent opens it again with `plansDir: "docs/plans"`, then opens a second new Markdown plan without one
- **THEN** both plans live under `docs/plans/<change-id>/`, the registry remembers `docs/plans` for the repo, and the
  page and the plan list name each plan's path there

#### Scenario: A folder outside the repo

- **WHEN** the agent opens a Markdown plan with `plansDir` set to `../plans` or `/tmp/plans`
- **THEN** the call fails at `plansDir` and nothing is created

### Requirement: Session state is durable

The system SHALL persist every accepted agent write and page event before acknowledging it, under
`openspec/changes/<change-id>/.planroom/`, or a Markdown plan's `<change-id>/.planroom/` in the repo's Markdown plans folder. A crash at any point MUST leave the last complete state readable, never a
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

The page SHALL list every plan in the repo, meaning each folder under `openspec/changes/` or the repo's Markdown plans
folder with a persisted session (archived changes excluded), naming the Markdown ones, and SHALL mark the one it shows. Picking another plan SHALL switch the page to that plan
under a new URL, without creating a change. After a switch, the agent's next write or wait MUST be refused, with
nothing applied, until the agent reads the new plan. An accepted or ended plan SHALL open read-only with a Reopen
action, which makes it editable again in the phase it had reached and notifies the agent. The list SHALL also show
the plans of other repos Planroom has run in on the machine, grouped by repo, which the page MUST NOT open in this
session: it SHALL link to a plan's live page when another session holds it, and otherwise open it read-only, as the
standalone browser does, for a repo the registry lists only.

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

#### Scenario: An idle plan in another repo

- **WHEN** the user picks a plan under `agora-processor-app` that no session holds
- **THEN** it shows read-only under a new URL, quoting code from `agora-processor-app`, and the agent's plan is
  unchanged

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
whether or not a browser opened. When the agent opens another session than the open one, of any kind, the new session
SHALL take over the open page at the same URL by default: the page's open tabs SHALL reload onto it, and the browser
SHALL open only when no tab shows the page. When the agent asks for a new page, the session SHALL be served under a new
URL that opens in the browser, and the previous page SHALL stop working. Picking a plan from the page SHALL still
switch under a new URL.

#### Scenario: No browser available

- **WHEN** a session opens on a machine where no browser can be launched
- **THEN** the call still succeeds and returns the URL for the agent to print

#### Scenario: Another session takes over the page

- **WHEN** the agent opens `add-audit-log` while `add-api-rate-limiting` is open in a browser tab
- **THEN** `add-audit-log` is served at the same URL, the tab reloads onto it, and no new browser window opens

#### Scenario: A separate page on request

- **WHEN** the agent opens `add-audit-log` asking for a new page
- **THEN** it is served under a new URL that opens in the browser, and the old URL stops working

### Requirement: A session has a kind and review is a third kind

Every session SHALL have a kind of plan, ask or review, fixed at creation. Events and block types that belong to one kind MUST be refused in the others. Sessions persisted before `review` existed MUST load and behave as before.

#### Scenario: Review kind

- **WHEN** the agent opens a review for PR 412
- **THEN** the session's kind is review and review events are accepted

#### Scenario: Review event in a plan

- **WHEN** a review-only event such as `deck.publish` is sent to a planning session
- **THEN** it is refused naming the event and the session kind

#### Scenario: Existing sessions

- **WHEN** a plan and an ask session saved before this change are opened
- **THEN** both load with every question, block and answer intact and behave as before
