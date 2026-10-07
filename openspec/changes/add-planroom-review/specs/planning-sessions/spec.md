# Spec Delta

## ADDED Requirements

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
