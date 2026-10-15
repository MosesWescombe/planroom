# Spec Delta

## ADDED Requirements

### Requirement: Comments on ranges, off-diff lines and repeats are placed by fixed rules

A comment on several lines SHALL be sent to Bitbucket on the last of those lines, its text opening with the line range, for example "Lines 12-18", unless a test on a scratch PR shows Bitbucket's API takes a span, in which case the span SHALL be used. A comment on a line that Bitbucket's diff does not show, meaning a line outside a diff hunk with three lines of context either side, SHALL become a comment on the file, quoting the line number and its code. A comment on the example of a repeated edit SHALL be sent once, on the example, ending with the list of the other places it applies to, unless the reviewer ticked "only here", in which case it is about that place alone and lists none. The preview SHALL show each such comment exactly as it will land, and the posted body SHALL equal the previewed body.

#### Scenario: Range

- **WHEN** a comment covers lines 12 to 18 of `src/send.ts`
- **THEN** it is posted on line 18 and its text opens with "Lines 12-18"

#### Scenario: Line off the diff

- **WHEN** a comment is on line 80 of `src/send.ts` and Bitbucket's diff does not show line 80
- **THEN** it is posted as a comment on the file `src/send.ts`, quoting "line 80" and the code on it

#### Scenario: Repeat comment

- **WHEN** a comment is on the example of a three-place repeat
- **THEN** it is posted once on the example and ends with the list of the two other places

#### Scenario: Only here

- **WHEN** a comment on a repeat example has "only here" ticked
- **THEN** it is posted on that place and lists no other places

#### Scenario: Preview matches

- **WHEN** a range comment is previewed and then posted
- **THEN** the posted body equals the previewed body, including its "Lines 12-18" opening

### Requirement: Hand to agent writes a task file

The Comments tab SHALL offer Hand to agent beside Post, so the reviewer can post the comments, hand them to an agent, or do both. Hand to agent SHALL write `handoff-round-<n>.md` into the review's folder from the same derivation the preview renders, and SHALL copy a one-line prompt for the reviewer to paste into any Claude session. The file SHALL hold, for each comment, its file, lines, the code it sits on and the page it came from, and for each AI finding the reviewer agreed with, its suggested fix, and SHALL name the branch and the commit reviewed. The prompt SHALL tell the agent to work in the reviewer's own checkout of that branch, to check it is still at that commit and stop and ask if it is not, to make each requested change, and to ask the reviewer about any comment that is a question rather than a request. Hand to agent SHALL work for a PR and for a local branch and SHALL make no network call.

#### Scenario: Task file

- **WHEN** the reviewer presses Hand to agent with two comments and one agreed finding
- **THEN** `handoff-round-1.md` holds all three with their files, lines, code and pages, the finding with its suggested fix, and the branch and commit reviewed

#### Scenario: Matches the preview

- **WHEN** the task file is written
- **THEN** each comment's text in it equals the text the preview shows

#### Scenario: Prompt copied

- **WHEN** the reviewer presses Hand to agent
- **THEN** a one-line prompt naming the task file's path and the branch is on the clipboard

#### Scenario: Wrong commit

- **WHEN** the agent runs the prompt in a checkout that is not at the reviewed commit
- **THEN** the task file tells it to stop and ask the reviewer

#### Scenario: Local branch

- **WHEN** the review is of a local branch and the reviewer presses Hand to agent
- **THEN** the task file is written and no request is made to Bitbucket

#### Scenario: Post and hand off

- **WHEN** the reviewer presses Post and then Hand to agent on the same comments
- **THEN** both succeed and the comments are posted and in the task file

## MODIFIED Requirements

### Requirement: Every comment has one of three sources

Every comment SHALL come from a reaction to a finding, from a comment the reviewer writes on a line, a range of lines or a file, or from the summary. Agree SHALL use the agent's draft, Reword SHALL use the reviewer's text, Reject SHALL produce no comment, and an own comment SHALL use the reviewer's text. Nothing SHALL need to be typed twice.

#### Scenario: Own comment

- **WHEN** the reviewer writes a comment on line 12 of `src/retry.ts`
- **THEN** it appears in the preview anchored to that line with no sign-off

#### Scenario: Own comment on a range

- **WHEN** the reviewer writes a comment on lines 12 to 18 of `src/retry.ts`
- **THEN** it appears in the preview anchored to that range with no sign-off

#### Scenario: Rejected finding

- **WHEN** a finding is rejected
- **THEN** the preview has no comment for it
