## Why

Reading a large PR in Bitbucket means files in alphabetical order, repeated mechanical edits burying the ones that matter, no sign of why a line changed, and no record of what has been read. Planroom Review already opens the PR or branch, keeps a private copy of the code, previews comments as Bitbucket shows them and posts them, but its overview deck stops short of a line-by-line read. PRs of 1,500 to 5,000 changed lines, more with tests, need a guided read that covers every changed line, and comments that can go to the author, to an agent or to both.

## What Changes

- Add a **read-through** to Planroom Review: the change split into concept pages in reading order, then test pages, then a Housekeeping page. The server refuses to open it until every added and removed line is on some page, so a bad grouping never hides a line.
- Ask **how to review** when a round opens: the overview deck, the read-through, or both with the deck first, remembered for next time. The AI review gains a **None** strength, the default for a read-through.
- Show each piece of code **as it is now** (changed line numbers highlighted, the old line in a popover) or **as a diff**, chosen per piece by the agent unless a setting fixes it. Click any name to search for it in the reviewed commit.
- Fold **repeated edits** into one example and one line per other place, flag the places that differ, and show **moved code** once, from where to where.
- Put tests the PR added or changed on their own pages, one entry per test case, shown as a title, pseudo code or real code.
- Track what has been **read**, by hand or by auto-tick after 10 seconds on screen or a comment, saved with the review, with a page list and a By file view for getting around.
- Let the reviewer **ask the agent** about selected lines in a per-page thread. Answers can add explanation or code to the page, marked as added at the reviewer's request.
- Show the AI's findings **under the lines they are about** when an AI review runs, and open the Review and Comments tabs at once when there is no deck.
- Comment by clicking a line or dragging a range. Post places ranges, comments off the diff and repeat comments by fixed rules, and **Hand to agent** writes a task file and copies a one-line prompt, for a PR or a branch.
- Start a new round's read-through on only what changed since the posted round.
- Add one subagent, `planroom-page-writer`, linked by `planroom install`: Sonnet for pages, the smallest model for every test's pseudo code.

## Capabilities

### New Capabilities

- `review-readthrough`: the line-by-line read-through: pages, the coverage check, code views, repeats, moves, tests, Housekeeping, name search, read tracking, navigation and asking the agent.

### Modified Capabilities

- `review-sessions`: the technique is chosen when a round opens and remembered, and a read-through-only review skips the walkthrough stage.
- `review-findings`: the AI review strength gains None, findings are not locked when there is no deck, and findings show under their lines in the read-through.
- `review-comments`: comments can cover a dragged range, Post places ranges, off-diff and repeat comments by fixed rules, and Hand to agent writes a task file.
- `review-rounds`: a new round's read-through covers only what changed.
- `tool-installation`: install links the page-writer subagent.

## Impact

- **`src/shared`**: a line index and the read-through events, tick and thread targets in the zod contract; the comment anchor gains an end line and a repeat flag, `reviewers.start` gains the technique and the `none` strength, and the review preferences gain the technique and the read-through settings.
- **`src/server`**: the line index (hunks, repeats, moves, housekeeping), the outline coverage check, `GET /api/review/search`, the task file writer, and range, off-diff and repeat handling in posting.
- **`src/ui`**: the read-through tab with its page list, concept pages, test pages and Housekeeping page; the code viewer gains line selection, the as-it-is-now view, the old-line popover and clickable names; read ticks and auto-tick; a technique choice at round start; findings under their lines.
- **`skills/planroom-review`**: read-through steps in the skill, which delegates pages to the new subagent; `references/blocks.md` is regenerated, never edited.
- **`agents/planroom-page-writer.md`**: one new subagent, linked and unlinked by `planroom install` and `planroom uninstall`.
- **Not in this change**: exporting the read-through as PDF or HTML, exact go-to-definition, and GitHub PRs.
- **Dependencies**: none added; name search uses `git grep` in the existing worktree.
