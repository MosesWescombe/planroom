---
name: planroom-review
description: Review a Bitbucket Cloud pull request or a local branch with the reviewer on Planroom's live page - a walkthrough deck of the change with your-take cards, a line-by-line read-through of every changed line, or both, then verified review findings they agree with, reword or reject, then comments previewed as Bitbucket shows them, posted as drafts or handed to an agent. Use whenever the user asks to review, walk through or explain a PR or a branch ("review PR 412", "walk me through feature/x", "help me review this pull request"), or to follow up a review after the author pushed.
---

# Planroom Review

Planroom Review puts a review on a live page on `127.0.0.1`: a **Walkthrough** deck you build, a **Read-through** of
every changed line you lay out and have written, or both, a **Review** tab of verified findings the reviewer reacts to,
and a **Comments** tab that previews what will be posted and posts it, or writes it to a task file for an agent. It is
the `planroom-review` MCP server, which `planroom install` registers beside this skill, and it needs no `openspec/`.
You write to the page with typed events; the reviewer reads, answers and reacts there; their events come back to you.

Only the Planroom server talks to Bitbucket, with credentials you never see. Never ask the reviewer for a token, and
never post comments yourself.

## Start

1. Call `planroom_review({ target })`. `target` is a Bitbucket PR link, a PR number of this checkout's `origin` repo,
   or a local branch name (reviewed against its merge base with the default branch; nothing is posted for a branch).
   Print the returned `url` every time. Keep `cursor`: it is your `after` for the first `planroom_wait`.
2. Read the code in `worktree`, never in your working directory: it is a temporary checkout of the commit under review,
   and the reviewer's working copy may be on another branch. The change is `git diff <diff.base> <diff.head>`, run in
   the worktree. `files` lists what changed, with line counts.
3. `preferences` say which your-take kinds to use (`takes`), how many (`density`), which views the reviewer keeps on,
   and the read-through's settings. A `preferences.change` event later replaces them for the slides you have not
   written yet. Their `technique` and `reviewers` are only what the page offers: the reviewer picks the round's own
   when they start it.
4. `index` is the round's diff line by line, for a read-through: per file its `hunks` (`oldStart`, `oldCount`,
   `newStart`, `newCount`), a `housekeeping` reason or `spacing` hunks the server puts on the Housekeeping page, and
   `test: true` for a test file by its name; then `repeats` (the same edit in several places, by `key`, each place
   flagged where it `differs`) and `moves` (a block removed in one place and added in another).
5. On `resumed: true`, call `planroom_state` and carry on from its `stage`, `technique`, `deck`, `readthrough`,
   `findings` and `comments`. On `round` above 1 the author pushed since the last posted round: see [Rounds](#rounds).
6. If the tools are missing, the server is off in `/mcp` or not installed: say so, and offer to review in chat. A running
   server keeps the code it started with: after a reinstall, ask the reviewer to reconnect `planroom-review` in `/mcp`.

## The loop

Every turn is: emit what changed with `planroom_emit`, then `planroom_wait({ after })` for the reviewer's next events.
Handle events strictly in `seq` order and pass the highest `seq` you handled as `after`. A timed-out wait returns
`{ events: [], timedOut: true }`: wait again; when `more` is true, wait again at once. Leave `timeoutSec` unset. Channel
pushes (`<channel source="planroom-review" …>`) are the same events: skip any `seq` you already handled.

Before work the page cannot see, say so with `doing` in the same message as the first tool call of it:
`planroom_emit({ events: [], doing: "reading the retry policy" })`. While subagents run, list them in `subagents` and
end your turn rather than wait: you are woken as each reports back.

## Start the round as the reviewer chose

As the page opens it asks the reviewer how to review the round and how strong an AI review to run. **Read the change**
in the worktree meanwhile: the diff, then the code around it, its callers and its tests. Unless `planroom_review` or
`planroom_state` already returned `technique` and `reviewers`, `planroom_wait({ after })` for `reviewers.start`,
handling any other events as usual; it has usually arrived while you read. Build nothing and start no reviewer before
it. Then build only what its `technique` names:

- `deck`: the overview deck, below.
- `readthrough`: the [read-through](#the-read-through) and no deck; the server refuses slides.
- `both`: the deck first; once its first part is published, the read-through.

## Build the deck and run the review together

Start both at once: the review subagents and the illustrator work while you write. With the read-through alone, run
only the review (step 2) beside it.

1. **Plan the deck** and send the outline: `deck.progress { outline: [{ chapter, title }, …] }`.
2. **Start the review** as `reviewers.start`'s `reviewers.strength` says: start `planroom-reviewer` subagents, each
   given the worktree and the commit range, and each with the Agent tool's `model` and `effort` set to its
   `reviewers.model` and `reviewers.effort`:
   - `none`: no reviewer and no verifier. Send no findings: the server refuses them, and the page says no AI review
     was run.
   - `single`: one reviewer, dimension `all`, told to verify its own findings. Keep what it returns.
   - `standard`: one reviewer, dimension `all`, then one in **verify** mode with every item it found.
   - `thorough`: one per dimension (`correctness`, `security`, `performance`, `design`, `tests`); for a large diff,
     split the files between them. Then one in **verify** mode with every item they found.

   A verifier is told to refute rather than find: keep only what it confirms, with its confidence. Report progress:
   `deck.progress { review: "3 of 5 reviewers done" }`. When the last finding is sent, or the review found none, send
   `deck.progress { reviewed: true }` so the page stops saying you are reviewing.
3. **Brief the pictures**: one `planroom-illustrator` subagent per illustration, each with a brief (what it shows, what
   must be labelled, the analogy if any, the size) and the file to write: `<repoRoot>/.planroom/reviews/<reviewId>/assets/<name>.svg`.
   Report `deck.progress { pictures: { drawn, total } }` as they land.
4. **Write the slides** in one voice: `doc.block.upsert` each block, then `slide.upsert { id, chapter, order, title,
   blocks }` listing it. Slides stay off the page until you publish.
5. **Publish the first part**, Why to What it might impact, once those slides are written and their pictures drawn:
   `deck.publish`. It is then fixed for the round. Trade-offs is written after the reviewer's concerns, so stage none
   yet.
6. **On `impact.send`**, investigate every area and every concern the reviewer wrote, theirs and the areas they added:
   hand each area to a `planroom-researcher` subagent with the worktree path, the area, how the change reaches it and
   the concerns under it, and check what it reports before you rely on it. A concern that holds up as a real problem also becomes a finding
   (`item.upsert`, anchored to the code).
7. **Write and publish Trade-offs**: `slide.upsert` its slides, then `deck.publish` again. That fixes the whole deck.

### The deck

- **Four chapters, in order**: `why` (the problem and the goal), `how` (how the change works), `touches` (What it
  might impact: the areas it reaches beyond the diff) and `tradeoffs` (what it costs, the risks, what was not done, and
  the reviewer's concerns answered). Each chapter needs at least one slide; size the deck to the change at about 6 to
  15 slides. For a large diff, keep that size and group slides by area rather than file by file.
- **What it might impact** is one slide holding one `impactMap` block: 2 to 8 areas the change might reach beyond its
  diff (callers, data, config, deploys, other teams' services, on-call), each with a one-line `summary` of how the
  change reaches it and up to four `blocks` that explain it: a `flow` or `sequence` of the path from the change, a
  `stepThrough` or an `html` visual to animate it, `code` for the caller or config it meets. Send those blocks with
  `doc.block.upsert`; they sit behind the map, not on a slide. The reviewer opens each area, reads it, and writes
  their questions and concerns under it, or adds an area you missed; moving on sends them to you. The aim is to help
  them think about the change's spread, so pick areas a reviewer might not think of, not only the obvious ones.
- **Trade-offs** brings the reviewer's concerns up alongside your own trade-offs: answer every concern under its area
  with what you found and the evidence (`path:line`), say plainly whether it holds, and point to the finding a real
  problem became. They sent nothing? Say what you checked in each area anyway.
- **A slide** is a title and blocks, laid out like a write-up section: a row of two or three ids sits side by side.
  Slide titles say the point ("Retries now stop at two"), not the topic.
- **Show, don't tell**: a `flow`, `sequence` or `architecture` diagram for how it works, a `stepThrough` to walk a flow
  or sequence one step at a time, a `compare` for before and after (diagrams, code or images), `code` in diff mode for
  the lines that matter, an `analogy` when a familiar comparison helps, always with where it breaks down. Block shapes:
  [the block catalog](references/blocks.md).
- **Pictures** are `image` blocks of the illustrator's SVG (`src: "asset:<name>.svg"`) with alt text, which is
  required. No image service is ever called.
- **`html`** is only for an interactive visual no block or SVG can show: a slider over a retry policy, a state machine
  to play. No links, no forms, no network. The page labels it "interactive, sandboxed".

### Your-take cards

A `yourTake` block makes the reviewer commit to their own view before seeing yours. Write your view into the card when
you make the slide (`answer` and `explanation`, your `pros` and `cons`, your `ratings`, the `correct` option and the
`slide` that explains it); the page keeps it hidden until they answer.

- Use only the kinds `preferences.takes` enables; the server refuses the others.
- `density`: `light` is about two cards in the deck, `normal` about one per chapter, `heavy` about two per chapter.
- `predict` goes before the slide that explains it; `check` is one question per chapter at its end; `prosCons` and
  `risk` fit the Trade-offs chapter.

## The read-through

Every changed line, one concept to a page, in the order a reader needs: concept pages first, then the test pages, then
a Housekeeping page the server adds for lock, generated and binary files and hunks that change only spacing. Pages go
up one by one as they are written, so the reviewer starts reading the first while you write the rest.

1. **Lay it out** from the diff and `index`: `read.outline { pages: [{ id, kind, title, group, order, pieces }] }`.
   - **Plan the groups first**: split the change into 2 to 8 areas a reader takes in one sitting (a module, a feature
     slice, a layer), each with a short plain `group` title ("Retry policy"). Minimise crossover: give each file, and
     each changed method, to one group where you can, so a reader finishes an area without jumping to another; when a
     file serves two areas, split it by method, not by hunk. Order the groups so each comes after the groups whose
     code it uses, the core first; a small change can be one group.
   - A **concept page** (`kind: "concept"`) holds one idea of the change, titled with its point ("Retries stop at the
     policy limit"), and names its `group`. Order them as a reader needs them: the page list keeps each group's pages
     together, where its first page falls.
   - A **piece** is a whole method or block: `{ id, file, lines: "40-72", oldLines?: "38-66", view? }`. `lines` are on
     the new side, `oldLines` on the old side for removed code; give whole methods, not hunks. `view: "now"` for a
     rewrite, `"diff"` for a small tweak; the reviewer's setting can fix one for every piece.
   - A **repeat** is one piece on its example's lines with `repeat: <key>` from `index.repeats`: it covers every place,
     and the page lists the others, flagging those that differ.
   - **Moved code** is one piece on its new place with `from: { file, oldLines }`, from `index.moves`.
   - **Tests** go on test pages (`kind: "tests"`, no `group`) after the code pages, grouped by what they test and
     ordered like the groups they test, one piece per test case with its `title`. `index` marks test files by name and folder; move one on or off the test pages when the
     name misleads.
   - Leave lock, generated and binary files and spacing-only hunks off: they are on Housekeeping. At most 40 pieces a
     page; split a bigger concept in two.
   The server refuses a layout that leaves any added or removed line off every page, naming the lines; place them and
   send it again. Once it is accepted the read-through opens with every page coming, and you can lay it out again
   until a page is written.
2. **Have the pages written**: brief `planroom-page-writer` subagents, a batch of pages each, up to four at once, each
   given the worktree, the commit range and its pages' layout with any repeat and move they hold. List them in
   `subagents`. At the same time, run one more `planroom-page-writer` with the Agent tool's `model` set to `haiku` and
   every test case (its piece id, file, lines and name), for their pseudo code. Write the first page first.
3. **Check each page and put it up** as its writer returns: every page explains its concept before the code, with at
   least one diagram on a concept page, as a slide would; every piece has a short note; the words are short and plain
   and leave the detail to the code; related code names real lines; no code is pasted into the words; and the blocks
   are valid. Then `read.page.upsert { page: { id, summary, blocks?, pieces: [{ id, note, blocks?, related? }],
   tests? } }`: a piece's `blocks`, up to four, show between its note and its code. For a test page, `tests` is the
   pseudo-code writer's `[{ piece, title, pseudo }]`. Re-sending a page rewrites it and unticks what the reviewer read
   on it, so get it right first.
4. **Answer questions on lines.** A `comment.create` on `page:<id>` carries the lines the reviewer selected in
   `anchor.lines`, and in `anchor.lines.text` the code they highlighted, which can start and end partway through a
   line: answer about that code, using the whole lines as context. One on the page's words instead carries what they
   selected of the title, summary, a note, pseudo code or an addition in `anchor.quote`. Reply with `comment.reply`. To show more code or explain on the page itself, add to it with
   `read.page.add { page, threadId, piece?, text?, blocks? }`, under the piece it is about: it is marked as added at
   their request, never changes what the page showed, and unticks that piece.

The reviewer's ticks, auto-ticks and Hand to agent never reach you. Their comments on lines and ranges arrive with the
rest when they post.

## Findings

Every finding is an `item.upsert`, one of three kinds:

- **`issue`**: a bug, risk or missing test, with `severity` (`blocker`, `important`, `minor`), `evidence`, a
  `suggestion`, and a `likelihood` and `impact` from 1 to 3 for the risk matrix.
- **`opinion`**: a design judgement, with your `reasoning` and the `alternative` you weighed.
- **`question`**: something the code does not explain, for the author.

Each has an `anchor` (`{ file, side: "new" | "old", start, end? }`, a file of the round's diff), its `dimension`, the
verify pass's `confidence` from 0 to 1, optionally the `diagram` node it is about (`{ block, node }`: a flow or
architecture node id, or a sequence actor), and a `draft`: the comment to post.

- Give each finding the context a reader needs to judge it without opening the code in `blocks`: up to four inline
  blocks (`{ type, config, caption? }`, shapes in [the block catalog](references/blocks.md)). At least the lines it is
  about in a `code` block: an `excerpt`, which reads the worktree, or `diff` mode with the hunk where they changed. Add a
  `compare` for a before and after, a `flow` or `sequence` for the path it breaks, or a `table` of the cases it misses,
  when the text alone would not carry it. They show on the finding's card and are never posted.

- Write `draft` in the Markdown Bitbucket renders: fenced code, tables, emphasis, lists and links. No raw HTML, no task
  lists, no suggestion blocks: put a suggested fix in a fenced code block. Never sign it; the page adds "- Claude".
- Send findings while the deck or read-through builds. With a deck, the reviewer sees none, anywhere, until they finish
  or skip the walkthrough; with the read-through alone they show at once, under their lines.
- Withdraw one with `item.withdraw { id, reason }` before the reviewer reacts to it.

## Handling events

| Event | Do |
| ----- | -- |
| `reviewers.start` | The reviewer started the round: build what its `technique` names, and start the reviewers it names, as in step 2; none at `none`. |
| `take.answer` | Note what the reviewer saw differently. No reply is needed; it feeds the summary. |
| `impact.send` | The reviewer's concerns, under each of your areas (by `id`) and areas they added (no `id`). Investigate them, write Trade-offs, and publish it: see steps 6 and 7. |
| `walkthrough.done` | The findings now show. Make sure every verified finding is sent. `how: "skipped"` means they knew the change; if Trade-offs is not published yet, still write and publish it. |
| `item.react` | `agree` and `reword` need nothing. On `reject`, read the `reason`: withdraw or soften any finding it undermines that the reviewer has not reacted to yet. |
| `comment.create`, `thread.reply`, `message.send` | Reply with `comment.reply`. A thread on `slide:<id>` or `item:<id>` is about that slide or finding; one on `page:<id>` is about a read-through page, with the selected lines in `anchor.lines` and the code highlighted in `anchor.lines.text`, or the words selected in `anchor.quote` (see step 4 of the read-through); one on `comment:<key>` is about a comment the round will post, by its key (`comment:item:<id>`, `comment:note:<id>` or `comment:summary`). |
| `preferences.change` | Follow the new preferences for slides you have not written yet. |
| `review.posted` | Say what was posted. With `failed` non-empty, the reviewer retries from the page. |
| `session.end` | The reviewer ended the review: stop. |

## The summary

Once the reviewer has triaged most findings, draft the summary comment with `summary.draft { text }`: what the change
does well and what must change, built from their pros and cons, their risk ratings and the triage (how many agreed,
reworded and rejected). It is posted last; the reviewer edits or deletes it, and the page signs it. Re-send it when the
triage moves on.

## Rounds

When the author pushed after a posted round, `planroom_review` starts the next round: `diff` runs from the reviewed head
to the new one, and `earlier` lists the reviewer's earlier comments with the author's replies.

1. Wait for the round's `reviewers.start`, then build what its technique names, for the delta only: a short **delta
   deck**, the same four chapters compressed to what changed, with new slide and block ids; and a **delta
   read-through**, whose `index` covers only the lines changed since the posted round, the reviewer's ticks starting
   fresh.
2. Label every earlier comment with `earlier.label { key, label, note, code }`: `addressed`, `partly`, `not-addressed`
   or `outdated` (the server labels one whose lines were removed), with `code` the diff hunk that shows it.
3. For each partly or not addressed one, draft a follow-up: `item.upsert` with `kind: "followup"`, `replyTo` its key and
   the reply as `draft`. The reviewer reacts to it like any finding.
4. Rerun the review on the delta only, once the round's `reviewers.start` arrives (the page asks again each round),
   and publish. The reviewer confirms each addressed comment before Post resolves
   its thread and task.
