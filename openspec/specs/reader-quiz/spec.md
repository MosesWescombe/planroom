# reader-quiz Specification

## Purpose
Quiz me, a self-check offered on a plan's write-up and throughout a review: the agent writes multiple-choice questions on what the reader has already seen, and never on anything they have not.

## Requirements

### Requirement: Quiz me is offered on the write-up and throughout a review

The page SHALL show a Quiz me button at the foot of the left rail on a plan's Write-up tab and on every tab of a review, and as an icon in the collapsed rail. It SHALL NOT show on a plan's other tabs, on an ask, or while the session is read-only. The button SHALL show how many questions are still unanswered. With no questions yet, pressing it SHALL ask the agent for them, and the button SHALL show as loading, and take no presses, until the first question comes through.

#### Scenario: Offered on the write-up

- **WHEN** the reader opens a plan's Write-up tab
- **THEN** the rail shows Quiz me, and the Interrogate tab's rail does not

#### Scenario: Loading until the first question

- **WHEN** the reader presses Quiz me with no questions yet, having read part of the write-up
- **THEN** the request reaches the agent, and the button shows as loading until the agent's first questions arrive, then shows how many are unanswered

#### Scenario: Offered in a review

- **WHEN** the reviewer is on any tab of a review
- **THEN** the rail shows Quiz me

### Requirement: Only what has been on screen counts as seen

The page SHALL count a write-up or slide block, a finding, or an unfolded read-through piece as seen once at least half of it, or half the screen for one taller than that, has been on screen for two seconds. What was seen SHALL be kept per change in the browser and sent with each request as refs: `block:<id>`, `item:<id>` and `piece:<round>:<id>`.

#### Scenario: A block read

- **WHEN** a write-up block has been on screen for two seconds
- **THEN** its ref is among what the next quiz request sends

#### Scenario: Nothing read yet

- **WHEN** the reader opens Quiz me before anything has been on screen
- **THEN** no request is sent, and the dialog says there is nothing to quiz on yet

### Requirement: A request tells the agent everything seen so far

A `quiz.request` SHALL reach the agent with every seen ref, its own and earlier requests', that still names a block in a section or on a slide, a finding not withdrawn, or a piece on a page of its round, each described in words, and with the questions already asked. A request SHALL be refused when nothing seen names anything, or while an earlier request is unanswered. An ask SHALL take no quiz request.

#### Scenario: More

- **WHEN** the reader asks for more after answering the first questions
- **THEN** the agent receives everything seen so far, and the questions already asked so it repeats none

### Requirement: Questions are only on what was seen

The agent's `quiz.add` SHALL be refused whole when any question is about a ref no request listed as seen, or names a right answer outside its choices. It MAY carry a `note` with or instead of questions, such as what to read next. An ask SHALL take no `quiz.add`.

#### Scenario: A question on something unseen

- **WHEN** the agent sends a question about a block no request listed as seen
- **THEN** the batch is refused naming the question's `about`, and nothing is added

### Requirement: Each pick shows whether it was right and why

The dialog SHALL list the questions with their choices. Picking one SHALL fix the pick, mark it and the right answer, and show the agent's explanation with a link to where the question's subject was read. The dialog SHALL show the score so far. The picks SHALL be kept per change in the browser and never sent to the agent.

#### Scenario: A wrong pick

- **WHEN** the reader picks a wrong choice
- **THEN** the dialog marks it as their pick and the right choice as the right answer, shows the explanation, and counts it in the score
