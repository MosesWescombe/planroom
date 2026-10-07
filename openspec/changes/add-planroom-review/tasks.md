# Tasks

Slices are in rollout order; each leaves the earlier ones working and carries its own tests and docs.

## 1. Review session and deck (local branches only)

- [x] 1.1 Add `review` to `SessionKind` with its `TOOLS`, `SERVER_NAMES` and `INSTRUCTIONS` entries in `mcp.ts`, the `--review` flag in `cli.ts`, `Session.openReview`, `reviewDir` and a review event gate beside the ask ones, and verify a Vitest suite opens a review, rejects review events in plan and ask sessions, and still loads saved plan and ask state
- [x] 1.2 Implement `planroom_review({ target, title? })` resolving a local branch against its merge base, and verify a test returns the URL, summary, worktree path and preferences and makes no network call
- [x] 1.3 Implement the worktree manager (`worktree.ts`: add, move, remove) and verify a test on a temporary git repository shows the worktree at the right commit, the working copy untouched and removal on end
- [x] 1.4 Add `slide.upsert` and `deck.publish` with staging in `agentApply.ts` and `state.ts`, and verify tests show staged slides are not visible, publish releases all at once and an edit after publishing is refused
- [x] 1.5 Add the `analogy` and `stepThrough` blocks and widen `compare` in `blocks.ts` and `blockCatalog.ts`, render them in `src/ui/blocks`, and verify zod and render tests in all three session kinds
- [x] 1.6 Add the stage model (building to next round) and the building progress view (outline, slides drafted, pictures drawn, PR title and diff stats), and verify a UI test shows the progress and no slide until publish
- [x] 1.7 Build the deck viewer and overview grid (`Deck.tsx`, `Overview.tsx`), arrow-key and chapter-bar navigation with step-through keys first, CSS and View Transitions motion and `prefers-reduced-motion`, and verify jsdom tests for each, including every step shown at once under reduced motion
- [x] 1.8 Add the `planroom-illustrator` agent and the SVG `image` path under the `sandbox` CSP, and verify a test that a `<script>` in an asset does not run and an `image` block without alt text is refused
- [x] 1.9 Add the `planroom-review` skill with its generated `references/blocks.md`, and verify `pnpm generate:blocks-doc` produces it and the other two skills' docs with the new shared blocks
- [x] 1.10 Export the Walkthrough as one slide per PDF page and as one HTML file with illustrations inlined, and verify tests for page count, final step-through state and an offline HTML open
- [x] 1.11 Register the third server and link the new skill and agents in `install.ts`, with uninstall, and verify an install test lists three servers and uninstall removes them
- [ ] 1.12 Document the walkthrough in a README section, and verify the README commands run as written
- [x] 1.13 Add the `impactMap` block and the What it might impact chapter (areas around the change, an explanation panel per area, the reviewer's concerns saved by `impact.save` and sent once by `impact.send`), and verify UI tests that opening an area shows its blocks and moving on sends every concern
- [x] 1.14 Publish the deck in two parts, Trade-offs only after the reviewer's concerns or a skip, with Trade-offs' place showing the loading bar meanwhile, and verify server tests for each refusal and a UI test that the deck moves on to Trade-offs when it lands

## 2. Your takes and preferences

- [x] 2.1 Add the `yourTake` block with predict, pros and cons, risk rating and understanding check, refused outside a review, and verify zod tests and a refusal test in plan and ask sessions
- [x] 2.2 Log each answer as a page event before revealing the agent's view, with the view held out of the rendered page until then, and verify a UI test per kind that the event precedes the reveal and nothing leaks beforehand
- [x] 2.3 Add the preferences store (`preferences.ts`) for `$XDG_CONFIG_HOME/planroom/review.json` and the Settings Review section, shown only on a review page, and verify tests that preferences persist across sessions and the section is absent on a plan page
- [x] 2.4 Hand the preferences to the agent in `planroom_review` and `planroom_state`, and have the skill follow them, with prompt changes applying to unwritten slides and view changes at once, and verify tests for both timings
- [x] 2.5 Update the skill and the README for takes and preferences, and verify the generated blocks docs include `yourTake`

## 3. Experiment

- [ ] 3.1 Run reviews of three or more real PRs with different prompt mixes and densities, and verify a note per PR records what helped and what did not
- [ ] 3.2 Tune the skill's default prompt kinds and density and the reveal copy from those runs, and verify the new defaults are in the skill and `review.json` defaults and a test pins them
- [ ] 3.3 Judge the illustrator's SVG quality on those PRs and adjust its style brief, and verify a before and after example is kept with the note

## 4. Agent review

- [ ] 4.1 Add the `planroom-reviewer` agent (sonnet, high effort) and the dimension and verify-pass flow in the skill, and verify a run on a local branch produces items for all five dimensions and drops an unconfirmable one
- [x] 4.2 Add `item.upsert` with the issue, design opinion and question shapes, anchors and confidence, and verify zod tests including an invalid anchor refused
- [x] 4.3 Add the Review gate (locked until finished or skipped, skip logged), and verify a UI test that no finding shows on any diagram or in the diff beforehand
- [x] 4.4 Add reactions (Agree, Reword, Reject with a reason sent to the agent) and a thread per item, and verify tests that each reaction queues the right comment text and a rejection reaches the agent
- [x] 4.5 Build the five views: badge pins on `flow`, `sequence` and `architecture` renderers, anchored cards in `CodeViewer`, `bar` charts, a `fileTree` heat map and a `riskMatrix`, each switchable by preference, and verify a UI test per view and per switch
- [x] 4.6 Update the skill, the README and the generated docs for review items, and verify `pnpm generate:blocks-doc` leaves no diff

## 5. Bitbucket and comments

- [ ] 5.1 Spike on a scratch PR: create a comment and a task with `pending: true` through the API, and record whether they appear in the UI's "Finish review", how they are published and what the notification does, then verify the finding is written into design.md under Decisions and the posting task below is adjusted if drafts do not join
- [x] 5.2 Implement the Bitbucket client (`bitbucket.ts`: basic auth, typed responses, retry on 429) and PR targets (link, bare number via `origin`), and verify tests against a fake client for each target form and an unresolved `origin`
- [x] 5.3 Read `BITBUCKET_API_TOKEN` and the git email on the server only, disable Post with instructions when missing, and verify a test that neither appears in a page response, tool result, log or review-folder file
- [x] 5.4 Implement the shared derivation in `src/shared/review.ts` (comments from reactions, own comments and the summary; the word-diff percentage and sign-off rule), and verify unit tests at 50% and 62% and for a from-scratch comment
- [x] 5.5 Build the Comments tab (`CommentsTab.tsx`) with Bitbucket-style cards in the supported Markdown subset, the drafted summary, the task toggle and the sign-off toggle, and verify UI tests for each, including raw HTML shown as text
- [x] 5.6 Implement posting (`posting.ts`) with the head check, drafts (or direct publish, per the spike) with the summary last, tasks, ids recorded at once and retry of failures only, and verify tests with a fake client for head moved, partial failure and retry, and that posted bodies equal previewed bodies byte for byte
- [x] 5.7 Add Copy as Markdown for a local branch in place of Post, and verify a test that it makes no network call
- [ ] 5.8 Compare a posted comment's `content.html` on a scratch PR with the preview, and verify any difference is fixed or documented
- [ ] 5.9 Document the credentials and posting flow in the README and skill, and verify the steps work on a scratch PR

## 6. Re-review rounds

- [x] 6.1 Add rounds to state and the worktree move, starting round n+1 when a posted review is reopened with a moved head, and verify a test that an unmoved head starts no round
- [ ] 6.2 Write the delta deck and rerun the review on the delta in the skill, and verify a round-2 run on a two-file push yields a shorter deck and delta-only items
- [x] 6.3 Label earlier comments (addressed, partly, not, outdated) with their code, fetch the author's replies from the thread and draft follow-ups under the sign-off rule, and verify tests with a fake client for each label and a reply
- [x] 6.4 Resolve threads and tasks on Post only after confirmation, and verify a test that an unconfirmed addressed comment is left open
- [x] 6.5 Add the round switcher keeping earlier rounds readable, and verify a UI test switching between rounds 1 and 2
- [ ] 6.6 Update the skill and the README for rounds, and verify a round 2 on a real PR follows the docs

## 7. html escape hatch

- [x] 7.1 Add the `html` block, refused outside a review, in the sandboxed `iframe` with the CSP meta tag first in the `srcdoc`, and verify a jsdom test of the attributes and tag order, and a refusal test in plan and ask sessions
- [x] 7.2 Add the self-navigation guard that reloads the `srcdoc`, and verify a test that a frame loading anything else is reloaded
- [x] 7.3 Keep the block live in the HTML export with the CSP inside, print its current frame in the PDF and fill the slide when it is the only block, and verify export tests
- [x] 7.4 Add the skill rules (interactive visuals only, no links, the label), and verify the generated docs show them
- [x] 7.5 Confirm in a browser that an interactive visual runs and its `fetch` is blocked, and verify with a screenshot kept with the slice notes

## 8. Ops and rollout

- [ ] 8.1 Release the package with slice 1 and later slices as they land, bumping the version per the repo's release process, and verify `planroom install` on a clean config registers the servers
- [ ] 8.2 Create the scratch PR and a scoped `BITBUCKET_API_TOKEN` used by slices 5 and 6, and verify the token works for a read and a comment
- [ ] 8.3 Add the README Planroom Review section with screenshots, and verify the screenshots match the shipped page

## 9. Tests

- [x] 9.1 Add a cross-slice test that existing plan and ask sessions load and behave as before, and verify it passes
- [x] 9.2 Add an end-to-end test on a temporary git repository and a fake Bitbucket client from open through publish, reactions, preview and Post, and verify it passes
- [x] 9.3 Run a token-leak check over page responses, tool results, logs and the review folder after a full run, and verify none contains the token

## 10. Verify

Run the validation in AGENTS.md, in its order.

- [x] 10.1 Lint, typecheck and test pass per AGENTS.md, and `pnpm build` runs before any browser check
- [x] 10.2 `pnpm exec openspec validate add-planroom-review --strict` passes
