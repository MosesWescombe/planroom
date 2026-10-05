# plan-interrogation Specification

## Purpose
Phases 1 and 2 of a planning session: the agent stress-tests a change through typed question cards, and the user
answers, corrects, closes or adds questions until every decision that shapes the plan is settled. Phase 1, Interrogate,
agrees the goals and explores the ways to reach them; Phase 2, Directions, questions the chosen directions in depth and
goes ahead with one.

## Requirements

### Requirement: Questions render in their input type

Each question SHALL render as a card with its title, impact, context (why, findings, source references and any
catalog blocks) and one input type: `single` as option cards with detail and trade-off, `multi` as checkbox chips,
`chips` as one row of short answers that always ends with "Write my own", `freeform` as a growing text box,
`assumption` or `directions`. A question that allows other answers SHALL also offer "Your own answer". At most one
option SHALL be marked recommended.

#### Scenario: Recommended option

- **WHEN** Q-12 is a `single` question whose option A is recommended
- **THEN** option A shows "Agent recommends" and the others do not

#### Scenario: Diagram in context

- **WHEN** Q-12's context contains a `flow` block
- **THEN** the diagram renders inside the card's context, above the options

### Requirement: Saved answers go to the agent; unsaved ones stay drafts

Saving an answer SHALL mark the question answered and emit an answer event with the question id, the version answered
and the answer. A selection or note that has not been saved SHALL be kept as a local draft, survive a page reload, and
MUST NOT be sent to the agent.

#### Scenario: Save

- **WHEN** the user picks "Plans table + per-key override", adds a note and clicks "Save answer"
- **THEN** Q-14 shows as answered and the agent receives the answer with its note

#### Scenario: Draft survives reload

- **WHEN** the user selects an option without saving and reloads the page
- **THEN** the selection is still there, marked "Draft kept locally", and the agent has received nothing

### Requirement: Answered questions open read-only

An answered question SHALL show as one line with its answer and a "View" action. Viewing SHALL show the whole question
with the saved answer and every control disabled, without the text boxes the answer left empty, and a double-click on
the card SHALL switch it to editing.

#### Scenario: View then edit

- **WHEN** the user views answered Q-14 and double-clicks the card
- **THEN** the options become editable with the saved answer selected, and the agent has received nothing

### Requirement: An agent change to an answered question needs review

When the agent changes the content of a question that was answered, the question SHALL become `needs-review` with its
previous answer kept and shown. The user SHALL be able to confirm the answer still holds or change it; either sends an
answer event.

A question's `topic`, a few words naming what it decides, SHALL label it in the write-up's Decisions section, and a
change to the topic alone SHALL NOT need review.

#### Scenario: Reworded question

- **WHEN** the agent rewords answered Q-13
- **THEN** Q-13 shows "Needs review · reworded by agent" with the previous answer marked, and "Still right - save" re-submits it

#### Scenario: A topic names the decision

- **WHEN** the agent adds the topic "Redis outage" to answered Q-13
- **THEN** Q-13 stays answered with its answer, and the Decisions section names it "Redis outage"

### Requirement: Conflicting answers are surfaced

The agent SHALL be able to mark a question as in conflict with another, with a reason. The card SHALL show both answers
and offer keeping this answer or changing the other question; the choice SHALL be sent to the agent.

#### Scenario: Availability conflict

- **WHEN** the agent marks Q-12 "Fail closed" as conflicting with Q-03 "availability first"
- **THEN** Q-12 shows "Needs a look" with both answers, and choosing "Change Q-03" reopens Q-03 and notifies the agent

### Requirement: Questions can be closed, merged, reopened and suggested

The agent SHALL be able to close a question with a reason or merge it into another. Closed and merged cards SHALL
collapse to show the reason or the target, and the user SHALL be able to reopen either, which returns it to `open` and
notifies the agent. The user SHALL be able to suggest a new question, which is sent to the agent to add or decline.

#### Scenario: Closed by agent

- **WHEN** the agent closes Q-09 because Q-04 ruled out penalties
- **THEN** Q-09 collapses to "Closed by agent - you ruled out penalties in Q-04" with a Reopen action

#### Scenario: User suggests a question

- **WHEN** the user clicks "Add a question" and submits "Should internal service keys skip limits?"
- **THEN** the agent receives the suggestion and the navigator shows it as pending until the agent upserts or declines it

### Requirement: Progress is shown per group

The navigator SHALL group questions by their group path and show resolved over total per group and overall, where
resolved means answered, closed or merged. Selecting a group SHALL scroll to it.

#### Scenario: Group counts

- **WHEN** the "Failure modes" group has four questions, two answered, one closed and one open
- **THEN** it shows 3/4 and the overall count includes those three

### Requirement: The interrogation runs in stages

The interrogation SHALL move through four stages: align, explore, deep dive and go ahead. Align and explore are
Phase 1, and the Interrogate tab SHALL name the current one; the deep dive and going ahead are Phase 2, the Directions
tab. It SHALL start in align. The goals SHALL be agreed, ending align, when the user chooses
"Goals agreed - explore approaches" or the agent advances to explore; the user's choice SHALL be sent to the agent with
the questions still open, which stay open. The agent SHALL be able to go from align straight to the deep dive only with
a reason, which the page shows, and only while no directions are offered. The deep dive SHALL start when the user picks
directions to investigate, or when the agent skipped exploring.

#### Scenario: User agrees the goals

- **WHEN** the user chooses "Goals agreed - explore approaches" with Q-2 still open
- **THEN** the stage moves to explore, Q-2 stays open, and the agent receives the stage change listing Q-2

#### Scenario: One clear way

- **WHEN** the agent advances from align to the deep dive because only the gateway sees every request
- **THEN** Interrogate shows that the agent went straight to the deep dive, with that reason, the Directions tab reads
  "Skipped: one clear way", and "Finish phase 1" completes the interrogation

#### Scenario: Deep dive without a reason

- **WHEN** the agent advances to the deep dive without a reason, or after offering directions
- **THEN** the batch is rejected and nothing applies

### Requirement: Assumption cards

The agent SHALL be able to state an assumption as a card of its own, marked as an assumption and without options. The
user SHALL answer it by confirming it holds or by writing a correction, never both; either is saved and sent to the
agent like any answer, and an agent change to an answered assumption SHALL need review like a question.

#### Scenario: Correct an assumption

- **WHEN** the user chooses "Not quite…" on "Only the public API needs limits", writes "Internal keys too" and saves
- **THEN** the card shows as answered and the agent receives the correction as the answer's text

### Requirement: Info cards

The agent SHALL be able to give the reader context as an info card: a card marked as info, without options, whose
context carries the same why, findings, source references and catalog blocks as a question. An info card SHALL take
no answer and MUST NOT count toward a group's progress, the overall progress or the completion gate. The user SHALL be
able to comment on it like any card.

#### Scenario: Context before the questions

- **WHEN** the agent adds an info card "How a request reaches the limiter" with a `flow` block to a group of three
  answered questions
- **THEN** the card shows its diagram and "Ask to clarify" with no answer controls, the group still shows 3/3, and
  "Finish phase 1" stays enabled

### Requirement: Directions are offered in one question

The agent SHALL offer the ways to achieve the change in a single `directions` question, asked only once the goals are
agreed. Each direction SHALL render as a tab with its label, a markdown description, its trade-off and its supporting
blocks, and the recommended one SHALL open first. The user SHALL pick one or more directions to investigate and save
them as the answer. A second directions question MUST be rejected.

#### Scenario: Pick directions

- **WHEN** the user ticks "Investigate this direction" on the Redis and gateway tabs and saves
- **THEN** the agent receives both direction ids as the answer's choices

#### Scenario: Directions before the goals are agreed

- **WHEN** the agent offers directions while Phase 1 is still in align
- **THEN** the batch is rejected with an error telling it to agree the goals first

### Requirement: Each investigated direction has its own tab

Once directions are picked, the Directions tab SHALL open, with a row under the top row holding an overview tab and one
tab per direction that is investigated or has questions, each with its own resolved-over-total progress. The overview
SHALL show the directions side by side, each with its description, its progress and whether it is recommended, chosen
or dropped, then the shared questions still open until the interrogation completes. A question that names a direction
SHALL appear on that direction's tab; a question that names none SHALL appear on Interrogate. A link to a question
SHALL open the tab it is on. A new question MUST name only a direction the user picked, and every question's direction MUST be one the
directions question offers.

#### Scenario: Shared and direction questions

- **WHEN** Q-5 names the Redis direction and Q-6 names none
- **THEN** Q-6 shows on Interrogate and among the overview's open questions, Q-5 on the Redis tab, and the Redis tab
  shows its own progress

#### Scenario: Picking directions opens Directions

- **WHEN** the agent offered three directions and the user saves Redis and gateway to investigate
- **THEN** the page opens the Directions tab on its overview, Interrogate reads "2 directions picked" and Directions
  reads "Investigating 2 of 3"

#### Scenario: Direction the user did not pick

- **WHEN** the agent adds a question for the gateway direction, which the user did not pick
- **THEN** the batch is rejected and nothing applies

### Requirement: Completing the interrogation

Phases 1 and 2 SHALL share one control floating at the bottom right of the question column, available once the agent
has asked a question, doing what the stage needs next: in align it agrees the goals; once directions are investigated
it reads "Go ahead with <direction>" on a direction's tab and is shown neither on the Directions overview nor on
Interrogate; otherwise it reads "Finish phase 1". Going ahead with a direction SHALL count only the shared questions and that
direction's own. When every counted question is resolved and none is `needs-review`, `conflict` or being written, it
SHALL complete the phase at once; otherwise it SHALL first ask to carry the unresolved ones into the write-up as
assumptions. Either SHALL emit a phase-complete event naming which path was taken and the chosen direction, and the
server MUST refuse to complete without a direction once directions are investigated. While the agent is working, the
button SHALL show what it is doing and offer to interrupt. Once the interrogation is complete, the agent SHALL NOT add
questions:
a batch that adds one SHALL be rejected with an error telling the agent to read the phase-complete event.

#### Scenario: Go ahead with a direction

- **WHEN** the Redis and gateway directions are investigated, one Redis question and one shared question are open,
  and the user chooses "Go ahead with Redis token bucket" and confirms
- **THEN** the phase completes with the Redis direction, the agent receives those two questions as assumptions, and
  the gateway questions are not carried

#### Scenario: All resolved

- **WHEN** all 22 questions are resolved and the user chooses "Finish phase 1"
- **THEN** the phase completes, the Write-up tab unlocks and the agent is notified

#### Scenario: Finish early

- **WHEN** 8 questions are open and the user chooses "Finish phase 1" and confirms
- **THEN** the phase completes and the agent receives the 8 open questions as assumptions to carry into the write-up

#### Scenario: Interrupt the agent

- **WHEN** the agent is writing Q-9 with 3 questions open and the user chooses "Interrupt and finish" and confirms
- **THEN** the phase completes with Q-9 and the 3 open questions as assumptions, and the agent's next batch adding a
  question is rejected with an error pointing it to the phase-complete event
