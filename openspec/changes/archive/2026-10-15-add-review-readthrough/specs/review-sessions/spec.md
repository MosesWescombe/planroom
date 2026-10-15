# Spec Delta

## ADDED Requirements

### Requirement: The technique is chosen as a round opens and remembered

As a round opens, the page SHALL ask how to review: the overview deck, the line-by-line read-through, or both with the deck first. The choice SHALL be pre-filled from the reviewer's preferences, the deck the first time, and SHALL be saved as the next default. The round SHALL record the choice, and `planroom_review` and `planroom_state` SHALL return it. The agent SHALL build only what was chosen: no deck for a read-through, and no read-through before the deck is published for both.

#### Scenario: First time

- **WHEN** a review opens for the first time on a machine
- **THEN** the page offers deck, read-through and both, with the deck selected

#### Scenario: Remembered

- **WHEN** the reviewer chose read-through for the last review and opens another
- **THEN** read-through is selected as the page asks

#### Scenario: Read-through only

- **WHEN** the reviewer starts the round with the read-through
- **THEN** the agent writes the read-through pages and no deck

#### Scenario: Both

- **WHEN** the reviewer starts the round with both
- **THEN** the deck is published first and the read-through follows it

## MODIFIED Requirements

### Requirement: A review moves through ordered stages

A review SHALL be in one of the stages building, walkthrough, triage, preview, posted or next round. It SHALL move from building to walkthrough when the deck is published, from walkthrough to triage when the walkthrough is finished or skipped, from triage to preview when the Comments tab is opened, and from preview back to triage when a reaction changes. It SHALL move from preview to posted when Post succeeds, and from posted to next round when the author has pushed and the review is reopened. A review whose technique has no deck SHALL skip the walkthrough stage and move from building to triage when the read-through opens.

#### Scenario: Normal run

- **WHEN** the deck is published, the reviewer finishes the walkthrough, opens Comments and Post succeeds
- **THEN** the review passes through walkthrough, triage, preview and posted in that order

#### Scenario: Changing a reaction after previewing

- **WHEN** the reviewer is in preview and changes Agree to Reject on one finding
- **THEN** the review returns to triage and the preview no longer shows that finding's comment

#### Scenario: Reopened after a push

- **WHEN** a posted review is reopened and the PR head has moved
- **THEN** the review is in next round and a new round begins

#### Scenario: Read-through only

- **WHEN** a review whose technique is the read-through alone has its read-through open
- **THEN** the review is in triage and was never in walkthrough
