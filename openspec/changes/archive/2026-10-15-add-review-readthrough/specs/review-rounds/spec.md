# Spec Delta

## RENAMED Requirements

- FROM: `### Requirement: A delta deck covers only what changed`
- TO: `### Requirement: A delta deck and read-through cover only what changed`

## MODIFIED Requirements

### Requirement: A delta deck and read-through cover only what changed

In a new round the agent SHALL write a short delta deck, the same four chapters compressed to what changed, when the round's technique includes the deck, and a read-through whose pages cover only the lines changed since the posted round, when it includes the read-through. The agent review SHALL rerun on the delta at the chosen strength. Read ticks from an earlier round SHALL NOT carry into the new round.

#### Scenario: Delta deck

- **WHEN** the author's push changed two files
- **THEN** the round-2 deck covers those changes in the four chapters in fewer slides than round 1, and findings are for the delta only

#### Scenario: Delta read-through

- **WHEN** the author's push changed two files and the round's technique is the read-through
- **THEN** the round-2 read-through's pages cover only the lines changed since the posted round and every one of those lines is on a page

#### Scenario: Ticks start fresh

- **WHEN** the reviewer had read every piece in round 1 and round 2 begins
- **THEN** no piece in round 2's read-through is ticked
