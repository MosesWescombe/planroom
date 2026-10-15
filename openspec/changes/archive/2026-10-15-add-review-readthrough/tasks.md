# Tasks

Steps follow the write-up's rollout order, each leaving the earlier ones working and carrying its own tests and docs.

## 1. Bitbucket posting test

Removed 2026-10-15: the scratch-PR posting test (1.1, and 1.2's spec change if Bitbucket takes a span) moves to the
live product (design decision 19). The conservative rules in 7.1 ship until a real post shows otherwise.

## 2. Line index and coverage check

- [x] 2.1 Build the line index in `src/shared` and `src/server` (per-file added, removed and shown ranges, repeats, moves, housekeeping) from `git diff -M -U0` plus a `-U3` pass, and verify unit tests on a temporary git repository cover renames, a repeated edit, a move of three or more lines, a lock file, a binary file and a spacing-only hunk
- [x] 2.2 Add `read.outline` to the zod contract and `agentApply.ts` with the coverage check, and verify a test that an outline missing one line is refused naming the file and line, and that a complete outline is accepted
- [x] 2.3 Pass repeat and move hints in the `planroom_review` tool result, and verify a test that a ten-place rename arrives as one repeat group
- [x] 2.4 Group concept pages: a required `group` on each concept page (none on a test page), the page list and page head showing it, groups read together where their first page falls, and skill guidance to minimise crossover between groups; verify a test that a concept page with no group is refused, that grouped pages sort together, and a UI test of the group headings

## 3. Read-through tab

- [x] 3.1 Add the read-through tab with the page list, concept pages and `read.page.upsert`, and verify a UI test that a hand-written outline reads end to end
- [x] 3.2 Add line selection, the as-it-is-now view with highlighted changed line numbers, the old-line popover and removed-line markers to `CodeViewer`, plus the per-piece switch, and verify jsdom tests for each
- [x] 3.3 Add read ticks, auto-tick after 10 seconds on screen or a comment, per-page and whole-change progress and `read.tick`, saved with the review, and verify tests for each trigger, auto-tick off and a reload that keeps the ticks
- [x] 3.4 Add click or drag to comment on a piece, and verify a UI test that a click opens a comment on one line and a drag on a range
- [x] 3.5 Add the By file view, and verify a UI test that a file lists the pages its lines are on
- [x] 3.6 Add the read-through settings (`view`, `tests`, `autoTick`) to `reviewPreferences` with their defaults, saved in `review.json`, and verify tests that an old `review.json` loads with the defaults and the agent receives them
- [x] 3.7 Let each piece carry up to four blocks shown between its note and its code, checked like the page's, and have the page writer explain each concept with diagrams before the code in short, plain words; verify a UI test of the order and a server test that names a piece's failing block

## 4. Agent pipeline

- [x] 4.1 Add `technique` to `reviewers.start` and `reviewPreferences` and `none` to the strength, with the technique choice and the strength default on the start card, and verify tests for the first-time default, a remembered choice and the strength starting at none when the read-through is chosen
- [x] 4.2 Open the Review and Comments tabs at once when the technique is the read-through alone and move the review from building to triage, and verify tests that no skip is needed and the walkthrough stage is never entered
- [x] 4.3 Add `agents/planroom-page-writer.md` (Sonnet, Read and Bash, returns one page's blocks as JSON, also run on the smallest model for every test's pseudo code), and verify a test that its front matter parses
- [x] 4.4 Update `skills/planroom-review` with the read-through steps, up to four writers at once, the page check and pages appearing as written, then run `pnpm generate:blocks-doc`, and verify it leaves no hand edit to `references/blocks.md`
- [x] 4.5 Link and unlink the page-writer agent in `install.ts`, and verify an install test lists it and uninstall removes it

4.6 (the timing run on a 3,000-line PR) removed 2026-10-15: it happens on the live product (design decision 19).

## 5. Repeats, moves, housekeeping

- [x] 5.1 Render repeat pages (one example, one line per other place, differing places flagged and needing to be opened), and verify a UI test that a ten-place rename reads as one page and a differing place blocks the repeat from counting as read
- [x] 5.2 Render moved code once, from where to where with only changes highlighted, counting as read in both places, and verify a UI test for a moved function
- [x] 5.3 Add test pages (one entry per test case, grouped by what they test, title, pseudo code or real code per entry, recognised by name and folder) and the Housekeeping page, and verify UI tests for the tests setting, a per-entry switch, a title-only tick and counting Housekeeping read once opened

## 6. Search, asking, findings on lines

- [x] 6.1 Add `GET /api/review/search?round&q` with `git grep -n -w -F` on tracked files, capped at 200 and saying when cut short, with clickable names in the code view, and verify tests for whole words only, tracked files only and the cap
- [x] 6.2 Add the `page:<id>` thread target carrying the selected file and lines, with `read.page.add` marked as asked, never changing existing blocks and unticking what it changes, and verify a test that an answer's code lands on the page and a ticked piece is unticked
- [x] 6.3 Show findings as cards under their lines in the read-through only once the Review tab is unlocked, and verify UI tests for a finding under its line, none with strength none and none while the deck is unfinished

## 7. Outputs and rounds

- [x] 7.1 Apply the posting rules (range on the last line opening with "Lines a-b", off-diff line as a file comment quoting the line, repeat comments once on the example listing the others, "only here") in `posting.ts` and the shared preview, as confirmed by task 1.1, and verify tests that the posted body equals the previewed body for each
    - Diverged: shipped with the conservative rules ahead of task 1.1, which moves to the live product (design
      decision 19).
- [x] 7.2 Add `POST comments.handoff` writing `handoff-round-<n>.md` from the preview derivation and copying the one-line prompt, for a PR and for a branch, and verify tests that the file matches the preview, holds the branch and commit, agreed findings and their fixes, and that a branch makes no network call
- [x] 7.3 Start a new round's read-through on only what changed since the posted round, with fresh ticks, and verify a test that two changed files give pages covering exactly those lines
- [x] 7.4 Add a README section for the read-through, and verify the README commands run as written

## 8. Ops and rollout

Removed 2026-10-15: the release (8.1) is the next version's, after this archive, with its `planroom install` check;
the read of a real PR through to Post and Hand to agent (8.2) happens on the live product (design decision 19).

## 9. Tests

- [x] 9.1 Add a cross-slice test that a review on the deck alone behaves as before except that the AI review can be turned off, and verify it passes
- [x] 9.2 Add an end-to-end test on a temporary git repository and a fake Bitbucket client from open through read-through, ticks, comments, Post and Hand to agent, and verify it passes
- [x] 9.3 Run a token-leak check over page responses, tool results, logs and the review folder, including the task file, and verify none contains the token

## 10. Verify

Run the validation in AGENTS.md, in its order.

- [x] 10.1 `pnpm exec openspec validate add-review-readthrough --strict` passes
- [x] 10.2 `pnpm lint`
- [x] 10.3 `pnpm typecheck`
- [x] 10.4 `pnpm test`
