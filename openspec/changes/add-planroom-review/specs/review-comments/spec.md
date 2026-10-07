# Spec Delta

## Purpose

How a review becomes comments on the PR: the Bitbucket-faithful preview, the AI sign-off rule, the summary, tasks, and posting by the Planroom server with a head check, retry safety and credential handling.

## ADDED Requirements

### Requirement: Every comment has one of three sources

Every comment SHALL come from a reaction to a finding, from a comment the reviewer writes on a line or a file, or from the summary. Agree SHALL use the agent's draft, Reword SHALL use the reviewer's text, Reject SHALL produce no comment, and an own comment SHALL use the reviewer's text. Nothing SHALL need to be typed twice.

#### Scenario: Own comment

- **WHEN** the reviewer writes a comment on line 12 of `src/retry.ts`
- **THEN** it appears in the preview anchored to that line with no sign-off

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

When Post is pressed the Planroom server SHALL create the comments from the same records and the same derivation the preview renders, so each posted body equals its previewed body byte for byte. Each comment SHALL be sent as a Bitbucket draft (`pending`) and the summary last, with a task created for each comment whose toggle is on. The reviewer SHALL finish the review in Bitbucket, which sends one notification. If a spike on a scratch PR shows API drafts do not join "Finish review", Post SHALL publish the comments directly, summary last, and the page SHALL say so.

#### Scenario: Drafts

- **WHEN** the reviewer presses Post with 7 comments, a summary and 2 tasks
- **THEN** 7 pending comments are created, then the summary, then 2 tasks, and the page links to Bitbucket to finish the review

#### Scenario: Byte-for-byte

- **WHEN** a comment is posted
- **THEN** its body sent to Bitbucket equals the body the preview showed

#### Scenario: Drafts unavailable

- **WHEN** the spike found API drafts do not appear in Bitbucket's "Finish review"
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

The server SHALL read `BITBUCKET_API_TOKEN` and `git config user.email` for Bitbucket access. It MUST NOT send either to the page or the agent, write either to disk or log either. While either is missing, Post SHALL be disabled with instructions for setting it. If the token's scope does not allow reading the diff, the message SHALL name both `read:pullrequest:bitbucket` and `read:repository:bitbucket`.

#### Scenario: Missing token

- **WHEN** `BITBUCKET_API_TOKEN` is not set
- **THEN** Post is disabled and the page says how to set the token

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
