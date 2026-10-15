# review-comments Specification

## Purpose
How a review becomes comments on the PR: the Bitbucket-faithful preview, the AI sign-off rule, the summary, tasks, and posting by the Planroom server with a head check, retry safety and credential handling.

## Requirements

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

### Requirement: The preview shows what Bitbucket will render

Each comment SHALL be drawn as a Bitbucket-style card anchored to its diff lines. The preview SHALL render only the Markdown subset Bitbucket supports: fenced code, tables, emphasis, lists and links, with no raw HTML, no task lists and no suggestion blocks. The agent SHALL draft within that subset and put suggested fixes in fenced code blocks.

#### Scenario: Unsupported syntax

- **WHEN** a draft contains a raw `<b>` tag
- **THEN** the preview shows it as literal text, as Bitbucket would

#### Scenario: Suggested fix

- **WHEN** a finding has a suggested fix
- **THEN** the draft puts it in a fenced code block, and the preview shows a code block

### Requirement: Agent-drafted text carries a sign-off until mostly rewritten

Agent-drafted comments SHALL end with "- Claude". The preview SHALL show how much of each comment is the reviewer's own as a percentage, from a word diff of the reviewer's text against the draft. At 50% or below the sign-off SHALL be locked on. Above 50% a toggle SHALL remove it. A comment the reviewer types from scratch MUST NOT have it. An agreed comment SHALL keep it locked, and the summary and follow-up replies SHALL follow the same rule.

#### Scenario: Locked at 50%

- **WHEN** the reviewer rewords a draft so that 50% of its words are theirs
- **THEN** the preview shows "50% yours" and the sign-off cannot be removed

#### Scenario: Removable above 50%

- **WHEN** the reviewer rewords a draft so that 62% of its words are theirs
- **THEN** the preview shows "62% yours" and a toggle removes the sign-off

#### Scenario: Own comment

- **WHEN** the reviewer writes a comment from scratch
- **THEN** it has no "- Claude" and no toggle

### Requirement: A drafted summary is edited and posted last

The agent SHALL draft a summary comment from the reviewer's pros and cons, risk ratings and triage counts. The reviewer SHALL be able to edit or delete it in the preview. It SHALL be posted after every other comment.

#### Scenario: Summary drafted

- **WHEN** the reviewer has answered a pros and cons card and a risk rating and triaged six findings
- **THEN** the Comments tab shows a summary draft built from them, signed "- Claude"

#### Scenario: Summary deleted

- **WHEN** the reviewer deletes the summary
- **THEN** Post creates no summary comment

### Requirement: A comment can become a task

Each comment SHALL have a "make it a task" toggle, on by default for blocker issues, and a task SHALL be attached to its comment.

#### Scenario: Blocker default

- **WHEN** a blocker issue is agreed
- **THEN** its comment's task toggle is on

#### Scenario: Minor default

- **WHEN** a minor issue is agreed
- **THEN** its comment's task toggle is off, and turning it on creates a task on Post

### Requirement: The server posts what was previewed

When Post is pressed the Planroom server SHALL create the comments from the same records and the same derivation the preview renders, so each posted body equals its previewed body byte for byte. Each comment SHALL be sent as a Bitbucket draft (`pending`) and the summary last, with a task created for each comment whose toggle is on. The reviewer SHALL finish the review in Bitbucket, which sends one notification. If API drafts turn out not to join "Finish review", Post SHALL publish the comments directly, summary last, and the page SHALL say so.

#### Scenario: Drafts

- **WHEN** the reviewer presses Post with 7 comments, a summary and 2 tasks
- **THEN** 7 pending comments are created, then the summary, then 2 tasks, and the page links to Bitbucket to finish the review

#### Scenario: Byte-for-byte

- **WHEN** a comment is posted
- **THEN** its body sent to Bitbucket equals the body the preview showed

#### Scenario: Drafts unavailable

- **WHEN** API drafts are found not to appear in Bitbucket's "Finish review"
- **THEN** Post publishes the comments directly with the summary last and the page says they were published

### Requirement: Post checks that the PR head has not moved

Before creating anything, Post SHALL fetch the PR's current head commit. If it differs from the reviewed commit, the page SHALL list the comments on lines changed since, and the reviewer SHALL choose to re-anchor, drop or post anyway for them.

#### Scenario: Head unchanged

- **WHEN** the PR head equals the reviewed commit
- **THEN** Post proceeds with no prompt

#### Scenario: Head moved

- **WHEN** the author pushed a commit that changed lines 40 to 44 of `src/retry.ts` and a comment is anchored there
- **THEN** Post stops and offers re-anchor, drop or post anyway for that comment, and creates nothing until the reviewer chooses

### Requirement: Posting never double-posts

Each comment SHALL record its Bitbucket id as soon as it is created. A partial failure SHALL list the comments that failed, and a retry SHALL send only those.

#### Scenario: Partial failure

- **WHEN** 7 comments are posted and the fifth fails with a rate limit
- **THEN** the page shows "posted 6 of 7" and lists the failed comment

#### Scenario: Retry

- **WHEN** the reviewer retries after that failure
- **THEN** only the failed comment is sent and no earlier comment is duplicated

### Requirement: Credentials stay on the server

The server SHALL read `BITBUCKET_API_TOKEN` and `git config user.email` for Bitbucket access. It MUST NOT send either to the page or the agent, write either to disk or log either. While either is missing, Post SHALL be disabled with instructions for setting it. When Bitbucket refuses the token, the message SHALL name `read:pullrequest:bitbucket`, `write:pullrequest:bitbucket` and `read:repository:bitbucket`.

#### Scenario: Missing token

- **WHEN** `BITBUCKET_API_TOKEN` is not set
- **THEN** Post is disabled and the page says how to set the token

#### Scenario: Token refused

- **WHEN** Bitbucket answers a request with 403
- **THEN** the error names `read:pullrequest:bitbucket`, `write:pullrequest:bitbucket` and `read:repository:bitbucket`

#### Scenario: No leak

- **WHEN** a review has been opened and posted
- **THEN** the token appears in no page response, agent tool result, log or file under the review folder

### Requirement: A local branch copies instead of posting

A review of a local branch SHALL offer "Copy as Markdown" in place of Post and MUST make no network call.

#### Scenario: Copy

- **WHEN** the reviewer opens Comments on a local-branch review and presses Copy as Markdown
- **THEN** the approved comments and summary are on the clipboard as Markdown and no request is made to Bitbucket

### Requirement: Only approved comments and tasks go to Bitbucket

The only data sent to Bitbucket as a result of a review SHALL be the comments and tasks the reviewer approved, plus read requests for the PR.

#### Scenario: Nothing unapproved

- **WHEN** a review has rejected findings, a deleted summary and unanswered takes
- **THEN** none of that appears in any request to Bitbucket

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
