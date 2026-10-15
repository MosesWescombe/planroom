# review-readthrough Specification

## Purpose
The line-by-line read-through of a PR or local branch: concept pages in reading order that cover every changed line, test pages, a Housekeeping page, the code views, name search, read tracking, navigation and asking the agent.

## Requirements

### Requirement: The read-through opens only when every changed line is on a page

The agent SHALL lay out the read-through as pages, each holding pieces of code that name a file and a line range. The server SHALL check the layout against the round's diff and SHALL refuse it, naming the files and lines left over, until every added and removed line is in some piece. The read-through MUST NOT open while any such line is on no page. The server SHALL decide which files count as Housekeeping only by the rules in the Housekeeping requirement, and SHALL NOT let the agent drop a line from coverage.

#### Scenario: Lines left over

- **WHEN** the agent submits a layout in which lines 40 to 44 of `src/retry.ts` are on no page
- **THEN** the server refuses it naming `src/retry.ts` lines 40 to 44, and the read-through does not open

#### Scenario: Every line placed

- **WHEN** the agent submits a layout with every added and removed line in some piece
- **THEN** the layout is accepted and the read-through opens

#### Scenario: Refused layout is corrected

- **WHEN** the agent resubmits the layout with the missing lines placed
- **THEN** the second layout is accepted

### Requirement: Pages run concept pages, test pages, then Housekeeping

The read-through SHALL list its pages in this order: concept pages in the reading order the agent chose, then the test pages, then one Housekeeping page last. The agent SHALL put every concept page in a group, an area of the change read in one sitting, and SHALL lay out the groups so each file and changed method sits in as few groups as it can, each group after the groups whose code it uses. A group's pages SHALL read together, where its first page falls in the agent's order. Test pages SHALL take no group. The server SHALL refuse a layout with a concept page outside a group or a test page in one. Page writers SHALL fill the pages in, up to four at once, and the reviewer SHALL be able to read the first page as soon as it is written, while pages not yet written say they are coming. The review's agent SHALL check each page before it goes up. A concept that needs more than 40 blocks SHALL be split into two pages.

#### Scenario: First page before the last

- **WHEN** the first page has been written and the fifth has not
- **THEN** the first page shows and can be read, and the fifth shows as coming

#### Scenario: Order

- **WHEN** a read-through has three concept pages, a test page and a Housekeeping page
- **THEN** the page list shows the concept pages in the agent's order, then the test page, then Housekeeping

#### Scenario: Grouped order

- **WHEN** the agent orders the concept pages A1, B1, A2 with A1 and A2 in group A and B1 in group B
- **THEN** the page list shows A1, A2, then B1

#### Scenario: Concept page without a group

- **WHEN** the agent lays out a concept page with no group
- **THEN** the layout is refused, naming the page

#### Scenario: Page checked before it goes up

- **WHEN** a page writer returns a page
- **THEN** the page appears only after the review's agent has checked it

### Requirement: A concept page explains, then shows the code

A concept page SHALL open with a short, plain summary of the concept and why it exists and the diagrams and tables that explain it, as a slide does, then show each piece of changed code, a whole method or block, then any related code the agent attached, folded until opened. Each piece SHALL say what it is for, and MAY carry up to four diagrams or tables of its own, shown between what it is for and its code. The words SHALL be short and plain and leave the technical detail to the code.

#### Scenario: Page layout

- **WHEN** the reviewer opens a concept page
- **THEN** a plain summary and its diagrams come first, then the pieces of code, then folded related code

#### Scenario: A piece explained before its code

- **WHEN** a piece has a note and a diagram of its own
- **THEN** the note shows first, then the diagram, then the piece's code

#### Scenario: A piece's diagram that fails its shape

- **WHEN** the agent sends a page whose piece carries a block that fails its schema
- **THEN** the page is stored and the agent is told which piece's block failed

### Requirement: Each piece shows as it is now or as a diff

Every piece SHALL be viewable in two ways, with a switch on each piece. *As it is now* SHALL show the code as it stands in the reviewed commit, highlight the line numbers that changed, show a marker where lines were removed, and show what a changed line was before in a popover on hover or click. *As a diff* SHALL show the familiar diff widened to the whole method or block. A code view setting of Auto, as it is now or as a diff SHALL choose the starting view: at Auto the agent picks per piece, a rewrite as it is now and a small tweak as a diff, and otherwise the setting fixes it for every piece. Auto SHALL be the starting setting.

#### Scenario: As it is now

- **WHEN** the reviewer views a rewritten method as it is now
- **THEN** the changed line numbers are highlighted and the old text of a changed line shows in a popover on hover or click

#### Scenario: Removed lines

- **WHEN** a piece, viewed as it is now, had lines removed
- **THEN** a marker shows where they were and opens to show them

#### Scenario: Switch on a piece

- **WHEN** the reviewer switches a piece from as it is now to as a diff
- **THEN** that piece shows as a diff and other pieces keep their views

#### Scenario: Setting fixes the view

- **WHEN** the code view setting is as a diff
- **THEN** every piece starts as a diff, whatever the agent would have picked

### Requirement: Clicking a name shows its definition, Ctrl-clicking lists where it appears

Clicking any name in a piece of code SHALL list the whole-word matches of that name in the reviewed commit whose line reads as declaring it (a class, type, function or variable, matched by the line's shape rather than by a compiler), each with its line of code. Ctrl-clicking or Cmd-clicking a name, or switching the list, SHALL list every whole-word match of that name instead, as a plain-text search of tracked files only. Either list SHALL show at most 200 matches and SHALL say when it was cut short.

#### Scenario: Definition shown

- **WHEN** the reviewer clicks `RetryPolicy`
- **THEN** the line `export interface RetryPolicy {` is listed and the lines that only use `RetryPolicy` are not

#### Scenario: Matches listed

- **WHEN** the reviewer Ctrl-clicks `RetryPolicy`
- **THEN** every whole-word match of `RetryPolicy` in tracked files at the reviewed commit is listed with its line of code

#### Scenario: Whole words only

- **WHEN** the reviewer Ctrl-clicks `send` and a file holds `sendAll`
- **THEN** the `sendAll` line is not listed

#### Scenario: Cut short

- **WHEN** a name has more than 200 matches
- **THEN** the list shows 200 and says it was cut short

### Requirement: A repeated edit shows one example and one line per other place

When the same edit is made in several places, the page SHALL show one example in full, then one line per other place saying where it is and anything that differs from the example. A place identical to the example SHALL count as read with the example. A place that differs SHALL be flagged and SHALL need to be opened before the repeat counts as read.

#### Scenario: Ten-place rename

- **WHEN** one rename is made in ten places and all are identical
- **THEN** the page shows one example and nine one-line places, and ticking the example counts all ten as read

#### Scenario: A place that differs

- **WHEN** one of the ten places also changes an argument
- **THEN** that place is flagged with what differs and the repeat is not read until it is opened

### Requirement: Moved code shows once

Code moved from one file or place to another SHALL show once as moved, from where to where, with only what changed on the way highlighted, and SHALL count as read in both places when ticked once. A moved block SHALL be a removed block and an added block of three or more lines that match.

#### Scenario: Moved function

- **WHEN** a ten-line function moves from `src/a.ts` to `src/b.ts` with one line changed
- **THEN** it shows once as moved from `src/a.ts` to `src/b.ts` with that one line highlighted

#### Scenario: Counts in both places

- **WHEN** the reviewer ticks the moved block
- **THEN** both its old and new places count as read

### Requirement: Tests have their own pages after the code pages

Tests the PR added or changed SHALL sit on their own pages after all code pages, grouped by what they test, with one entry per test case. A file SHALL count as a test file by its name or folder (`.test.`, `.spec.`, `test/`, `tests/`, `__tests__/`), and the agent MAY move a file in or out of the test pages when the names mislead. Each entry SHALL show as a title, as pseudo code or as real code, switchable per entry, and the starting choice SHALL come from a tests setting that starts at pseudo code. The pseudo code SHALL be written while the read-through is prepared, so switching views is instant. An entry SHALL count as read when ticked, whichever view it is in, including a title only.

#### Scenario: Grouped by what they test

- **WHEN** the PR adds four test cases for the retry policy and two for the sender
- **THEN** the test pages show two groups, each case as its own entry

#### Scenario: Setting and switch

- **WHEN** the tests setting is title and the reviewer switches one entry to real code
- **THEN** that entry shows real code and the others show titles

#### Scenario: Title only counts as read

- **WHEN** the reviewer ticks an entry shown as a title
- **THEN** it counts as read

#### Scenario: Instant switch

- **WHEN** the reviewer switches an entry from title to pseudo code
- **THEN** the pseudo code shows at once without waiting for the agent

### Requirement: Housekeeping lists what needs no line-by-line read

The Housekeeping page SHALL come last and SHALL list by file the known lock files, files marked generated in `.gitattributes`, binary files and hunks that change only spacing. Every such file SHALL count as read once the page is opened.

#### Scenario: Lock file

- **WHEN** the PR changes `pnpm-lock.yaml`
- **THEN** it is listed on the Housekeeping page and on no code page

#### Scenario: Counts once opened

- **WHEN** the reviewer opens the Housekeeping page
- **THEN** every file on it counts as read

#### Scenario: Spacing-only hunk

- **WHEN** a hunk changes only indentation
- **THEN** it is listed on the Housekeeping page by its file

### Requirement: Reading is tracked and survives a reload

The reviewer SHALL be able to tick a piece, or a whole page, as read. With auto-tick on, a piece SHALL tick itself once it has been on screen for 10 seconds or once the reviewer comments on it. Auto-tick SHALL be a setting that starts on. The page list SHALL show how much of each page has been read and the top of the page SHALL show how much of the whole change has been read. Ticks SHALL be saved with the review and SHALL be restored when the page reloads.

#### Scenario: Auto-tick on time

- **WHEN** auto-tick is on and a piece has been on screen for 10 seconds
- **THEN** the piece is ticked

#### Scenario: Auto-tick on comment

- **WHEN** auto-tick is on and the reviewer comments on a piece
- **THEN** the piece is ticked

#### Scenario: Auto-tick off

- **WHEN** auto-tick is off and a piece has been on screen for a minute
- **THEN** the piece is not ticked

#### Scenario: Survives a reload

- **WHEN** the reviewer has ticked three pieces and reloads the page
- **THEN** the three pieces are still ticked and the progress counts match

### Requirement: Every page and file can be found from the side

A list down the side SHALL show every page in order, code pages under their group's heading then test pages under a Tests heading, with how much of each has been read. A concept page SHALL name its group above its title. A By file view SHALL list each changed file and the pages its lines are on.

#### Scenario: Page list

- **WHEN** the read-through is open
- **THEN** the side list shows each page in order under its group's heading, with its read progress

#### Scenario: By file

- **WHEN** the reviewer opens the By file view and picks `src/send.ts`
- **THEN** the view lists the pages that hold lines of `src/send.ts`

### Requirement: The reviewer can comment on a line or a range

The reviewer SHALL be able to select code in a piece, with the mouse or with Shift and the arrow keys, Home or End, and write a comment under it. The comment SHALL be on every whole line the selection touches. On the example of a repeated edit the comment SHALL cover every place of the repeat unless the reviewer ticks "only here", which makes it about that place alone.

#### Scenario: Comment on a line

- **WHEN** the reviewer selects part of line 15 of a piece and writes a comment
- **THEN** a comment anchored to the whole of line 15 is queued

#### Scenario: Select a range

- **WHEN** the reviewer selects from the middle of line 12 to the middle of line 18 and writes a comment
- **THEN** a comment covering lines 12 to 18 is queued

#### Scenario: Comment on a repeat example

- **WHEN** the reviewer comments on the example of a ten-place repeat
- **THEN** the comment covers all ten places

#### Scenario: Only here

- **WHEN** the reviewer ticks "only here" on a comment on that example
- **THEN** the comment is about that place alone

### Requirement: The reviewer can ask the agent about lines

Each page SHALL have a thread with the agent. The reviewer SHALL be able to select code on one or more lines and ask about it, and the thread SHALL carry the selected file, the lines the selection touches and exactly the code selected. The agent SHALL answer in the thread and MAY add an explanation or more code to the page, which SHALL be marked as added at the reviewer's request. An addition MUST NOT change anything the page already showed. When an addition changes a piece the reviewer had ticked, that piece SHALL be unticked.

#### Scenario: Ask and answer

- **WHEN** the reviewer selects `lock.acquire()` on line 14 and asks why a lock is needed
- **THEN** the agent receives the question with that file, line 14 and the code `lock.acquire()`, and its answer appears in the page's thread

#### Scenario: Addition marked

- **WHEN** the agent answers by adding a caller's code to the page
- **THEN** the added code shows on the page marked as added at the reviewer's request

#### Scenario: Existing content unchanged

- **WHEN** the agent adds a block to a page
- **THEN** every block the page showed before is unchanged

#### Scenario: Ticked piece changed

- **WHEN** an addition changes a piece the reviewer had ticked
- **THEN** that piece is unticked

### Requirement: Pages are written by page writers and test pseudo code by one small-model session

The review's agent SHALL lay out the pages, then brief page writers on the Sonnet model to write a batch of pages each. A single session on the smallest model SHALL write the pseudo code for every test, rather than one session per test.

#### Scenario: Writers in parallel

- **WHEN** the layout has eight concept pages
- **THEN** page writers on Sonnet write them in batches, up to four running at once

#### Scenario: One pseudo-code session

- **WHEN** the PR changes thirty test cases
- **THEN** one session on the smallest model writes the pseudo code for all thirty

### Requirement: The read-through settings are saved on the machine

The read-through's code view, tests and auto-tick settings SHALL be saved on the reviewer's machine in the review preferences with the rest of them, and `planroom_review` and `planroom_state` SHALL return them to the agent. A change SHALL apply at once to pieces not individually switched.

#### Scenario: Settings returned

- **WHEN** the reviewer has set tests to title and auto-tick off and a review opens
- **THEN** the preferences returned to the agent show tests as title and auto-tick off

#### Scenario: Applies at once

- **WHEN** the reviewer changes the code view setting while reading
- **THEN** pieces they have not switched themselves change view at once

### Requirement: A read-through opens on a PR or a local branch

The read-through SHALL open on the same two targets as a review: a Bitbucket Cloud PR or a local branch against its merge base with the default branch. Nothing SHALL be posted for a branch.

#### Scenario: Local branch

- **WHEN** the reviewer reads through a local branch
- **THEN** the pages cover the branch against its merge base and nothing is sent to Bitbucket
