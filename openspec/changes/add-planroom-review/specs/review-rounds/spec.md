# Spec Delta

## Purpose

Re-reviewing a PR after the author pushes: a new round in the same review that covers what changed and follows up on the reviewer's earlier comments.

## ADDED Requirements

### Requirement: A moved head starts a new round

Reopening a posted review after the PR head has moved SHALL start round n+1 in the same review folder. The server SHALL move the worktree to the new head and compute the diff from the reviewed commit to it. Each round SHALL record its base and head commits and when it was published and posted.

#### Scenario: New round

- **WHEN** a posted round-1 review is reopened and the PR head has moved to a new commit
- **THEN** round 2 starts in the same review folder with the worktree at the new head and a diff from the round-1 head

#### Scenario: Head not moved

- **WHEN** a posted review is reopened and the PR head is unchanged
- **THEN** no new round starts

### Requirement: A delta deck covers only what changed

In a new round the agent SHALL write a short delta deck, the same four chapters compressed to what changed, and the agent review SHALL rerun on the delta.

#### Scenario: Delta deck

- **WHEN** the author's push changed two files
- **THEN** the round-2 deck covers those changes in the four chapters in fewer slides than round 1, and findings are for the delta only

### Requirement: Earlier comments are labelled with the code that shows it

The Comments tab SHALL gain "Your earlier comments", each labelled addressed, partly addressed, not addressed or outdated, with the code that shows it. A comment SHALL be outdated when its lines were removed.

#### Scenario: Addressed

- **WHEN** the delta fixes the issue a comment raised
- **THEN** the comment is labelled addressed and shows the changed lines

#### Scenario: Outdated

- **WHEN** a comment's lines were removed in the push
- **THEN** it is labelled outdated

### Requirement: The author's replies are shown

Each earlier comment SHALL show the author's replies fetched from its Bitbucket thread.

#### Scenario: Reply shown

- **WHEN** the author replied "fixed in 3f2a" to a comment
- **THEN** the reply shows under that comment

### Requirement: Follow-ups are drafted for the reviewer to react to

For comments that are partly or not addressed, the agent SHALL draft a follow-up reply in the earlier comment's thread, which the reviewer agrees with, rewords or rejects as in round one, under the same sign-off rule.

#### Scenario: Follow-up

- **WHEN** a comment is labelled not addressed
- **THEN** a follow-up draft appears in its thread with Agree, Reword and Reject, signed "- Claude"

### Requirement: Threads and tasks resolve only on confirmation

Addressed threads and tasks SHALL be resolved as part of Post, each only after the reviewer has confirmed it.

#### Scenario: Confirmed

- **WHEN** the reviewer confirms an addressed comment and presses Post
- **THEN** its thread and its task are resolved in Bitbucket

#### Scenario: Not confirmed

- **WHEN** a comment is labelled addressed and the reviewer has not confirmed it
- **THEN** Post leaves its thread and task open

### Requirement: Earlier rounds stay readable

A round switcher SHALL keep every earlier round's deck, takes and comments readable.

#### Scenario: Switching

- **WHEN** the reviewer is in round 2 and selects round 1
- **THEN** round 1's deck, takes and comments show as they were
