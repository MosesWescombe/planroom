## Purpose

The two-way contract between the agent and the page: agent writes are typed, validated and versioned, and page events
form an ordered, replayable stream the agent receives by waiting or by push, with every event handled once.

## ADDED Requirements

### Requirement: Agent writes are typed batches

The agent SHALL write to the page only through typed events sent in batches: question upsert, close and merge;
suggestion decline; understanding update; section upsert; block upsert; comment reply and reply edit; proposal trace;
and proposal ready. A batch with an unknown event type
or an event missing its target id MUST be rejected whole, with nothing applied and every error reported with its field
path. The agent MUST NOT be able to send HTML for the page to render.

#### Scenario: Valid batch

- **WHEN** the agent sends a batch upserting Q-12 and Q-13 and updating the understanding summary
- **THEN** all three apply together and the page shows them without a reload

#### Scenario: Malformed batch

- **WHEN** a batch contains a valid question upsert and an event of type `question.delete`
- **THEN** neither applies and the result names `question.delete` as unknown at its index in the batch

### Requirement: Invalid block configs are stored and reported

A block upsert whose config fails its type's schema SHALL still be stored, SHALL render as an error card, and SHALL be
reported in the batch result with the block id and each config error. A block of an unknown type SHALL be stored and
render its raw config.

#### Scenario: Flow block with an edge to a missing node

- **WHEN** the agent upserts a `flow` block whose edge targets node `x` that is not in `nodes`
- **THEN** the result reports the block id and the edge's path, and the page shows an error card with the raw config

### Requirement: The server owns record versions

Each question and block SHALL carry a version that the system increments by one whenever an upsert changes its content.
An upsert identical to the current content MUST NOT change the version or re-render the record. The agent SHALL NOT set
versions.

#### Scenario: Content change

- **WHEN** the agent rewords Q-13 at version 2
- **THEN** Q-13 becomes version 3 and only its card re-renders

#### Scenario: No-op upsert

- **WHEN** the agent re-sends Q-13 with identical content
- **THEN** Q-13 stays at version 3 and nothing re-renders

### Requirement: Page events form an ordered, replayable log

Every page event SHALL receive a strictly increasing sequence number and be persisted with the session. The agent SHALL
read events after a cursor, and reading with the same cursor SHALL return the same events in the same order. Every
delivered event SHALL carry its sequence number.

#### Scenario: Read after a cursor

- **WHEN** events 1 to 5 exist and the agent reads after 3
- **THEN** it receives events 4 and 5, in order, each with its sequence number

#### Scenario: Resume after an agent restart

- **WHEN** the agent last read up to event 7 and a new Claude Code session reopens the change
- **THEN** reading after 7 returns every event recorded since, including those sent while no agent was connected

### Requirement: The agent can wait for events

A wait SHALL return immediately when an event that is not quiet exists after the cursor, otherwise block until one
arrives or its timeout elapses, and SHALL return every event after the cursor either way. Checklist ticks and
assumption confirmations are quiet: they need no reply, so they SHALL NOT end a wait on their own. A wait that times
out with no events SHALL return an empty list marked as timed out.

#### Scenario: Wait with nothing pending

- **WHEN** the agent waits after the latest event and the user answers Q-14 a minute later
- **THEN** the wait returns the answer event as soon as it is recorded

#### Scenario: Timeout

- **WHEN** no event arrives before the wait's timeout
- **THEN** the wait returns an empty list marked as timed out

#### Scenario: Tick while waiting

- **WHEN** a wait is pending and the user ticks an acceptance criterion, then posts a comment
- **THEN** the wait stays pending through the tick, and returns the tick and the comment together, in order

### Requirement: Events are pushed when no wait is pending

When the agent session accepts channel pushes, the system SHALL push each new event to it only while no wait is
pending; while a wait is pending, the event SHALL be delivered through the wait alone. A quiet event SHALL be pushed
just ahead of the next event that is not. Either way the agent SHALL be able to discard an event it has already
handled by its sequence number.

#### Scenario: Agent idle with channels

- **WHEN** the agent has ended its turn without waiting and the user posts a comment
- **THEN** the comment is pushed into the agent session carrying its sequence number, and the agent handles it

#### Scenario: Agent waiting

- **WHEN** a wait is pending and the user saves an answer
- **THEN** the answer is returned by the wait and is not also pushed

#### Scenario: Tick while idle with channels

- **WHEN** the agent has ended its turn without waiting and the user ticks an acceptance criterion, then posts a comment
- **THEN** nothing is pushed for the tick until the comment arrives, and then both are pushed, in order

### Requirement: Events queue while the agent is away

When no wait is pending and no channel push has been confirmed, the page SHALL keep accepting events, queue them in the
log, and show the agent as offline with the number of events queued.

#### Scenario: Answer while offline

- **WHEN** the user saves two answers while the agent is neither waiting nor reachable by push
- **THEN** both are recorded, the page shows "Agent offline · 2 queued", and the agent's next read returns both
