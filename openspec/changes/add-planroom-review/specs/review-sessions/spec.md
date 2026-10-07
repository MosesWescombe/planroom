# Spec Delta

## Purpose

Opens and keeps a review of someone else's PR or a local branch: how the target is resolved, where the agent reads the code, where the review lives on disk and which stages it moves through.

## ADDED Requirements

### Requirement: A review opens on a PR or a local branch

The `planroom_review` tool SHALL accept a `target` that is a Bitbucket Cloud PR link, a bare PR number or a local branch name. A PR link SHALL name its workspace, repo and number. A bare number SHALL use the workspace and repo of the checkout's `origin` remote. Any other target SHALL be a local branch, reviewed as the branch against its merge base with the default branch. The call SHALL return the page URL, the PR summary, the worktree path and the reviewer's preferences.

#### Scenario: PR link

- **WHEN** the agent opens a review for `https://bitbucket.org/acme/api/pull-requests/412`
- **THEN** the server fetches that PR's metadata, diff and head commit, and returns the page URL, the summary, the worktree path and the preferences

#### Scenario: Bare PR number

- **WHEN** the agent opens a review for `412` in a checkout whose `origin` is `acme/api`
- **THEN** the review is for pull request 412 of `acme/api`

#### Scenario: Local branch

- **WHEN** the agent opens a review for `feature/retry-policy`, which is not a PR link or a number
- **THEN** the change is that branch against its merge base with the default branch, and the server makes no network call

#### Scenario: PR that cannot be resolved

- **WHEN** the agent opens a review for a PR number and the checkout has no `origin` remote
- **THEN** the call fails saying the workspace and repo could not be determined, and nothing is created

### Requirement: Code is read from a temporary worktree at the PR head

The server SHALL add a temporary git worktree at the PR's head commit under the review's folder and give its path to the agent, so the agent can read the code around the change. The reviewer's working copy MUST NOT be modified. Ending the review SHALL remove the worktree.

#### Scenario: Worktree at the head

- **WHEN** a review opens on a PR whose head is commit `a1b2c3d`
- **THEN** a worktree at `a1b2c3d` exists under `.planroom/reviews/pr-412/worktree/`

#### Scenario: Working copy untouched

- **WHEN** the reviewer has uncommitted changes on another branch and a review opens
- **THEN** the working copy, its branch and its uncommitted changes are unchanged

#### Scenario: Ending the review

- **WHEN** the review ends
- **THEN** the worktree is removed and `git worktree list` no longer shows it

### Requirement: A review lives in its own folder and reopens

A review SHALL be stored at `.planroom/reviews/<id>/`, where the id is `pr-<number>` or `branch-<name>`, holding its state, event log and assets. The folder SHALL stay out of version control, and a review SHALL NOT require an `openspec/` folder. Opening the same target again SHALL restore the review as last persisted. The reviewer SHALL be able to open a thread on any slide or finding to ask the agent a question.

#### Scenario: New review

- **WHEN** the agent opens a review for PR 412 and none exists
- **THEN** `.planroom/reviews/pr-412/` is created with an empty state and `git status` does not list it

#### Scenario: Resume

- **WHEN** a review with a published deck and three reactions is opened again from a new Claude Code session
- **THEN** the deck, the takes, the reactions and the current stage are restored

#### Scenario: Repo without OpenSpec

- **WHEN** a review opens in a repo that has no `openspec/` folder
- **THEN** it opens normally

#### Scenario: Thread on a slide

- **WHEN** the reviewer opens a thread on a slide and asks why a retry was added
- **THEN** the message reaches the agent as a page event and the agent's reply appears in the thread

### Requirement: A review moves through ordered stages

A review SHALL be in one of the stages building, walkthrough, triage, preview, posted or next round. It SHALL move from building to walkthrough when the deck is published, from walkthrough to triage when the walkthrough is finished or skipped, from triage to preview when the Comments tab is opened, and from preview back to triage when a reaction changes. It SHALL move from preview to posted when Post succeeds, and from posted to next round when the author has pushed and the review is reopened.

#### Scenario: Normal run

- **WHEN** the deck is published, the reviewer finishes the walkthrough, opens Comments and Post succeeds
- **THEN** the review passes through walkthrough, triage, preview and posted in that order

#### Scenario: Changing a reaction after previewing

- **WHEN** the reviewer is in preview and changes Agree to Reject on one finding
- **THEN** the review returns to triage and the preview no longer shows that finding's comment

#### Scenario: Reopened after a push

- **WHEN** a posted review is reopened and the PR head has moved
- **THEN** the review is in next round and a new round begins
