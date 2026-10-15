# Spec Delta

## ADDED Requirements

### Requirement: Findings show under their lines in the read-through

When an AI review runs, the read-through SHALL show each finding as a card under the lines it is anchored to, in the piece that holds them, for every finding the reviewer may see. The read-through MUST NOT show a finding before the Review tab is unlocked. With the AI review at none, the read-through SHALL show no findings.

#### Scenario: Finding under its line

- **WHEN** a finding is anchored to lines 40 to 44 of `src/policy.ts` and a piece holds those lines
- **THEN** the finding's card shows under those lines in that piece

#### Scenario: No AI review

- **WHEN** the AI review strength is none
- **THEN** no finding shows anywhere in the read-through

#### Scenario: Both techniques

- **WHEN** the technique is both and the reviewer has not finished the deck
- **THEN** no finding shows in the read-through

## MODIFIED Requirements

### Requirement: Review runs at the reviewer's strength and is then verified

As a round opens, the page SHALL ask the reviewer to start its review, offering a strength of none, single, standard or thorough and the subagents' model and effort, pre-filled from their preferences. The strength SHALL start at none when the technique includes the read-through and at standard for the deck alone, and after that at the reviewer's last choice. The agent SHALL start no `planroom-reviewer` subagent until the reviewer starts the round, then SHALL start them as the chosen strength says, each reading the diff and the worktree and each at the chosen model and effort. The round SHALL record the choice, and `planroom_review` and `planroom_state` SHALL return it. At `none` the agent SHALL start no reviewer and no verify pass, and the round SHALL have no findings. At `single` one reviewer SHALL cover every dimension and verify its own findings. At `standard` one reviewer SHALL cover every dimension and a verify pass SHALL follow. At `thorough` one reviewer SHALL run per dimension (correctness, security, performance, design fit and tests), splitting the files between them for a large diff, and a verify pass SHALL follow. A verify pass, the same agent told to refute rather than find, SHALL drop every item it cannot confirm from the code. Each surviving item SHALL show its confidence. The agent SHALL report when it has sent its last finding, and until then the Review tab SHALL say the review is still running, so a review that found nothing reads as finished.

#### Scenario: Unconfirmed item dropped

- **WHEN** the security reviewer reports an item the verify pass cannot confirm from the code
- **THEN** the item is dropped and does not appear on the page

#### Scenario: Confidence shown

- **WHEN** an item survives the verify pass with confidence 0.8
- **THEN** its card shows that confidence

#### Scenario: Reviewers wait for the reviewer

- **WHEN** a review opens
- **THEN** the page shows the strength, model and effort from the reviewer's preferences with a Start button, and the agent starts no reviewer subagent until it is pressed

#### Scenario: Nothing found

- **WHEN** the agent reports the review done without having sent a finding
- **THEN** the Review tab stops saying the review is still running and says it found nothing to raise

#### Scenario: Single strength

- **WHEN** the reviewer starts the round at `single` with model haiku and effort low
- **THEN** the agent starts one reviewer subagent, on haiku at low effort, and no separate verifier

#### Scenario: None strength

- **WHEN** the reviewer starts the round at `none`
- **THEN** the agent starts no reviewer subagent and no verify pass, and the Review tab says no AI review was run rather than that it is still running

#### Scenario: Default for a read-through

- **WHEN** a review opens with the read-through chosen and no earlier choice of strength
- **THEN** the strength starts at none

### Requirement: Findings stay hidden until the walkthrough is done

The Review tab SHALL stay locked until the reviewer finishes the walkthrough or presses a visible "skip to findings". A skip SHALL be logged as a page event. Findings MUST NOT appear anywhere on the page before then. When the technique is the read-through alone there is no deck to finish, so the Review tab, if an AI review runs, and the Comments tab SHALL be open from the start.

#### Scenario: Locked

- **WHEN** the deck is published and the reviewer has not finished it
- **THEN** the Review tab is locked and no finding shows on any diagram or in the diff

#### Scenario: Finished

- **WHEN** the reviewer reaches the end of the walkthrough and finishes it
- **THEN** the Review tab unlocks showing the verified findings

#### Scenario: Skipped

- **WHEN** the reviewer presses "skip to findings"
- **THEN** the Review tab unlocks and a skip event is logged

#### Scenario: No deck

- **WHEN** the technique is the read-through alone
- **THEN** the Review and Comments tabs are open at once and no skip is needed
