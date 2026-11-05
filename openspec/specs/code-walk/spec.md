# code-walk Specification

## Purpose
A code walk follows a path through the code a step at a time, jumping through the functions it calls, so the reader can follow it like a debugger: each step says what happens to the data in plain words, pseudo code or both, with the real code a switch away. It is a block any plan, ask or review can show, and every read-through page can ask the agent for one.

## Requirements

### Requirement: A code walk is a block every session kind takes

The block catalog SHALL hold a `codeWalk` block of 2 to 40 steps under an optional title. Each step SHALL have a title, and MAY name the function it is in (`fn`), its call depth (0 at the walk's entry point), a Markdown note, pseudo code, and the real code by repo-relative `file` and `lines`. A step SHALL be refused naming its path when it has none of a note, pseudo code or real code, or names a file without lines or lines without a file. A plan, an ask and a review SHALL all take it.

#### Scenario: A step that says nothing

- **WHEN** the agent sends a code walk whose first step has only a title
- **THEN** the block's problems name `steps[0].note`

### Requirement: The walk shows the steps on the left and the step on show large on the right

The page SHALL list the steps on the left, numbered, each indented by its call depth and showing its function where it jumps into a new one, the step on show marked current and the steps already seen ticked. The step on show SHALL fill the right: the call stack from its walk so far, its title, its note, and its code. The walk SHALL show its place as "Step n of m" with how many steps were seen, and a progress bar of one segment per step, filled from the left up to the step on show, so the last step fills it. When the block is narrow the list SHALL stack above the step. In print every step SHALL show in order.

#### Scenario: Into a function and back

- **WHEN** the reader moves from a step in `send()` at depth 0 to a step in `shouldRetry()` at depth 1, then to a step in `send()` at depth 0
- **THEN** the call stack reads `send()`, `shouldRetry()`, then `send()` again

### Requirement: The reader moves the walk by buttons, the list and the keys

Back, Next step, a click on a listed step and the left and right arrow keys SHALL move the walk; an arrow key past either end SHALL be left to the page. On a slide the deck SHALL hand it the arrow keys first.

#### Scenario: Past the last step

- **WHEN** the reader presses the right arrow key on the last step
- **THEN** the walk stays put and the key does what it does on the page

### Requirement: Pseudo code switches to the real code

Pseudo code SHALL be coloured as code: control words, literals, numbers, double-quoted and backticked strings, `->` arrows, calls, properties, and `#` or `//` comments, its text left as written. A step with both pseudo code and real code SHALL offer Pseudo code and Real code; the real code SHALL be read live from the repo, in a review from the commit under review. The reader's choice SHALL hold from step to step. A step with only one of them SHALL show it with no switch.

#### Scenario: Real code from step to step

- **WHEN** the reader switches a step to Real code and moves to the next step, which has both
- **THEN** the next step shows its real code too

### Requirement: Each step can be asked about

Where the walk sits in a place that takes comments (a write-up section, a slide or a read-through page) and the session takes changes, the step on show SHALL offer Ask about this step, which SHALL open the comment composer anchored to that place, quoting the step's title. In a reply, history or anywhere else that takes no comments, it SHALL NOT be offered. Selecting any of the walk's words SHALL comment on them as anywhere else.

#### Scenario: A question on a read-through page's walk

- **WHEN** the reviewer asks about a step of a page's code walk
- **THEN** the agent receives a question on `page:<id>` whose quote is the step's title

### Requirement: Every read-through page can ask for a code walk

A read-through page with its words up and no code walk SHALL offer Walk me through the code while the round takes changes. Pressing it SHALL send `read.walk`, refused while the read-through is not open, for a page the round does not have, for a page with a walk, or while one is being written; the agent SHALL receive the round, page and page title. Until the agent answers, the page SHALL show that the walk is coming.

#### Scenario: Asked twice

- **WHEN** the reviewer asks for a page's code walk while the agent is still writing it
- **THEN** the request is refused, saying the agent is still writing it

### Requirement: The agent puts a code walk on a page, asked or unasked

The agent's `read.page.walk { page, walk }`, asked for or not, SHALL put the walk on the page above its code, replace any walk it had, and settle the request. It SHALL NOT change the page's words or untick anything. A restructure SHALL keep a kept page's walk and a walk still asked for.

#### Scenario: Asked for, then written

- **WHEN** the reviewer presses Walk me through the code and the agent answers with `read.page.walk`
- **THEN** the page shows the walk in place of the button, and what the reviewer had ticked stays ticked

#### Scenario: Written unasked

- **WHEN** the agent sends `read.page.walk` for a page the reviewer has not asked about
- **THEN** the page shows the walk from the start, with no button to ask for one
