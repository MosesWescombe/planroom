## Context

Planroom Review already opens a Bitbucket PR or a local branch, keeps a private worktree at the head commit, previews comments as Bitbucket renders them and posts them as drafts (`src/server/review.ts`, `src/server/posting.ts`, `src/shared/review.ts`). Its code viewer highlights, folds and switches between combined, old and new sides (`src/ui/code/CodeViewer.tsx`), and findings already show as cards under their lines in the diff. The server keeps only the changed files with their line counts, and the page fetches a file's diff when opened. A comment on several lines lands on its last line today, because that is all Bitbucket is sent. Nothing records what has been read, a local branch's comments are only copied, and Bitbucket's documentation does not say how it takes comments on lines outside its diff. See proposal.md for motivation.

## Goals / Non-Goals

**Goals:**

- Add the read-through beside the deck, on the existing session, worktree, thread and posting seams, with no new session kind.
- Make coverage a server guarantee: the agent decides order, grouping and words, the server decides that no changed line is left off a page.
- Derive posted bodies, previews and the task file from one function, so the byte-for-byte rule extends to the file.
- Keep the first page readable in about two minutes on a 3,000-line PR (a target to test against, not a measurement).

**Non-Goals:**

- Exporting the read-through as PDF or HTML (assumption: no export yet).
- Exact go-to-definition: name search is a text search, narrowed to declaration-shaped lines for a definition.
- GitHub PRs.
- Changing the deck, takes or the walkthrough export.

## Decisions

1. **The read-through is a new part of Planroom Review (Q-10).** It adds a technique choice, a tab and events to the existing review session, sharing posting, threads and the worktree. Rejected: a separate tool, which would rebuild opening, the private copy, the preview and posting.
2. **One page per concept, written by the agent (Q-11, Q-6).** The agent lays out pages and pieces; the server only checks them. Rejected: a file-order list with notes, which keeps the alphabetical problem; and a single scrolling page, which does not fit 1,500 to 5,000 changed lines plus tests.
3. **The server builds a line index and refuses an outline with lines left over (Q-4).** The index comes from `git diff -M -U0 base head` plus a `-U3` pass for what Bitbucket shows, and holds the added and removed ranges per file, repeat groups, moves and housekeeping files. `read.outline` is refused, naming the files and lines, until every added and removed line is in a piece. Rejected: trusting the agent's own count, which would let a bad grouping hide a line; and a warning instead of a refusal, which a reviewer can miss.
4. **Repeats and moves are detected by the server and passed to the agent as hints (Q-18, Q-27).** Repeats are matched on normalised text, with a per-place flag for any difference, and a move is a removed and an added block of three or more lines that match. The agent chooses the example and the page. Rejected: leaving detection to the agent, which is unreliable at 5,000 lines and could miss a differing place; and treating any near-identical place as identical, because a near-identical repeat can hide a bug, so any difference flags the place.
5. **Two views of every piece, picked by the agent unless a setting fixes one (Q-12).** As it is now shows changed line numbers highlighted with the old line in a popover; as a diff widens to the whole method. The code viewer gains line selection, the now view and the popover. Rejected: a diff only, which leaves the noisy-diff pain; as it is now only, which hides small tweaks.
6. **Name search is `git grep -n -w -F` in the worktree (Q-13).** `GET /api/review/search?round&q` returns at most 200 tracked-file hits and says when cut short. Rejected: a language server or symbol index, which is a per-language dependency for a feature that only has to find where a name appears, with an exact go-to-definition left out of this change. A plain click narrows the same matches to the lines that read as declaring the name (`definition=1`, `src/server/declarations.ts`); Ctrl- or Cmd-click lists them all.
7. **Read ticks are saved with the review; auto-tick is a setting (Q-15, Q-4).** A piece ticks by hand, after 10 seconds on screen or on a comment. The page sends `read.tick` to the server, which does not forward it to the agent. Rejected: ticking from scroll position alone, which counts skimming as reading; and local storage, which resets between ports and sessions.
8. **Pages start filling in as soon as the first is written (Q-16, Q-26).** The review's agent lays out the pages, then page writers on Sonnet each write a batch, up to four at once, and the agent checks each page before it goes up. Rejected: publishing the whole read-through at once, which makes the reviewer wait for the slowest page; and the review's agent writing every page, which leaves it busy when the reviewer asks a question.
9. **Tests get their own pages after the code pages, with pseudo code written during preparation (Q-19).** One session on the smallest model writes every test's pseudo code through the same subagent file run with a different model, so switching views is instant. Rejected: one subagent per test, which costs tokens per spawn; writing pseudo code on demand, which makes a switch wait; and two agent files, since the same file serves both.
10. **A Housekeeping page at the end counts as read once opened (Q-28).** It holds known lock files, files marked generated in `.gitattributes`, binary files and spacing-only hunks, listed by file. Rejected: hiding these files, which breaks full coverage; and reading them line by line, which is noise.
11. **A thread per page; the agent can add to the page (Q-20).** The thread target `page:<id>` carries the selected file and lines, is answered with `comment.reply`, and additions arrive as `read.page.add`, marked as asked. An addition never changes existing content and unticks a piece it changes. Rejected: reusing the slide thread with no selection, which loses the lines asked about; and letting the agent edit existing blocks, which would change what the reviewer already read.
12. **Technique and strength are chosen as a round opens and remembered (Q-17).** `reviewers.start` gains the technique, `reviewPreferences` gains it and the read-through settings (`view`, `tests`, `autoTick`), and strength gains `none`. The technique starts as the deck the first time. Rejected: a global setting only, which cannot be chosen per review.
13. **With no deck, nothing is locked (Q-3, assumption).** `findingsUnlocked` is true at once when the technique is the read-through alone, since there is no deck to finish, and the review moves from building to triage when the read-through opens. Findings show under their lines only after the Review tab is unlocked. Rejected: forcing a skip click on a deck that does not exist; and showing findings while the reviewer reads, which nudges what they notice.
14. **The strength starts at none unless the technique is the deck alone (Q-3, Q-17).** The write-up gives None for a read-through and standard for the deck, and does not say which applies to both; both takes the read-through default, because the deck is read first and the reviewer can still start a review. Rejected: standard for both, which spends tokens on a review the reviewer chose to do by hand.
15. **Posting rules for ranges, off-diff lines and repeats are tested first (Q-24, Q-25).** The first task posts drafts on a scratch PR for an unchanged line far from any change, a context line and a span, and records what lands where. The shipped rules are the conservative ones: the last line with "Lines a-b" opening, a file comment quoting the line, and one comment on the example listing the others (Q-14). If Bitbucket takes a span, the range rule and its spec requirement are changed to use it. Rejected: building on the documented API alone, which does not say how comments outside the diff are accepted.
16. **A task file and a one-line prompt for the agent handoff (Q-7, Q-8, Q-21).** `POST comments.handoff` writes `handoff-round-<n>.md` from the same derivation as the preview and copies a prompt that has the agent work in the reviewer's own checkout, check the commit, make each change and ask about questions. Rejected: continuing in the review's session, which ties the fixes to it and has no place to edit but the review's temporary worktree; and copying every comment to the clipboard, which gets very long.
17. **A delta read-through in the next round (Q-23).** The line index is built from the posted round's head to the new head, as the delta deck is, and ticks start fresh. Rejected: carrying ticks over, since the code the ticks covered has changed.
18. **One new subagent file, `planroom-page-writer` (assumption).** Sonnet for pages and Haiku for pseudo code, linked by `planroom install`. Rejected: two agent files, which would duplicate one prompt.
19. **Found while building and in review (implementation notes).**
    - *Bitbucket and timing checks move to the live product.* The scratch-PR posting test (1.1, 1.2), the first-page timing on a 3,000-line PR (4.6) and the read of a real PR to Post and Hand to agent (8.2) are dropped from this change, as decision 23 of `add-planroom-review` did for its scratch-PR tasks. The conservative rules of decision 15 ship meanwhile, each naming its lines in the body, and the review-comments spec changes if a real post shows Bitbucket takes a span. The release (8.1) follows this archive. Rejected: holding the archive for a scratch PR, which tests the same flow as the first real review.
    - *A type change is one file.* `git diff` writes a file turned into a symlink as two patches while `--name-status` lists it once as `T`, so the line index merges the two, or every later file would take the wrong hunks.
    - *A renamed file's diff names both paths.* Given only the new path, `git diff -M` cannot pair the rename and shows the file as wholly added, so the read-through's full diff passes the old path too.
    - *Spacing only keeps word breaks.* A hunk goes to Housekeeping when both sides match once whitespace is gone, except one space kept between two word characters, so a change that joins or splits two words (inside a string too) still needs a page.
    - *A hand untick holds.* Auto-tick leaves a piece the reviewer unticked by hand alone for the rest of the page load, and a rewritten page clears its repeats' place ticks as well as its pieces'.

## Risks / Trade-offs

- [Agent groups a concept badly] → the coverage check means no line is hidden; the By file view and asking the agent let the reviewer recover.
- [Bitbucket misplaces off-diff or range comments] → the first posts on the live product show where they land, and the file-comment fallback quotes the line.
- [Token cost on a 5,000-line PR] → one outline pass, Sonnet writers and a single small-model pseudo-code session.
- [Auto-tick counts skimming as read] → the 10 second threshold and a setting to turn it off.
- [Name search lists unrelated matches] → it is labelled a text search, whole words only, capped at 200.
- [Task file applied to a moved branch] → the prompt checks the commit first and stops.
- [A near-identical repeat hides a bug] → any difference flags the place, which must be opened.
- [Rules chosen without the posting test] → the conservative rules ship, each naming its lines in the body, and the spec is changed if a real post shows Bitbucket takes a span.

Assumptions the reviewer confirmed in the write-up: a line Bitbucket shows is one inside a hunk with three lines of context either side; test files are recognised by name and folder; Housekeeping holds lock files, generated files, binary files and spacing-only hunks; settings start at pseudo code, auto-tick on, Auto code view and the deck the first time; and there is one page-writer agent and no export yet.

## Migration Plan

It ships in steps, each leaving the earlier ones working. A review that keeps to the deck is unchanged except that the AI review can now be turned off, so there is nothing to migrate. Rollback is to not choose the read-through, or to revert the release, which leaves existing reviews readable: the new events and preferences are additive and an old `review.json` without them loads with the defaults.

## Open Questions

None outstanding.
