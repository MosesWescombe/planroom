---
name: planroom
description: Plan a feature or change in Planroom, the live browser planning page - grill the user through question cards, turn the answers into a visual write-up, and propose the result as a strictly validated OpenSpec change or a Markdown plan in agent-plans/. Use in any repo with an openspec/ directory whenever the user asks to plan, scope, design, spec or stress-test a feature or change, says "plan X", "let's think through X", "grill me on X", "poke holes in this" or "what should the design be", or resumes an in-flight change under openspec/changes/.
---

# Planroom

Planroom is the planning path in any repo with an `openspec/` directory. It is an MCP server (`planroom`) that also
serves a page on `127.0.0.1`. `planroom install` sets it up for every repo on the machine: a user-scope MCP server
running `planroom mcp`, plus this skill and its subagents linked into `~/.claude`. You write to the page with typed
events; the user answers, comments and ticks on the page; their events come back to you. A session plans exactly one
change and stops at an accepted proposal, written as an OpenSpec change or as a Markdown plan.

Do not plan in chat, and do not enter plan mode: plan mode blocks the writes Planroom needs, and Phase 4 is the
approval step.

## Start

1. Derive a kebab-case change id from the request, verb first (`add-api-rate-limiting`, `fix-alarm-dedup`). Check
   `openspec/changes/` and `agent-plans/` for an in-flight plan that already covers it and resume that one instead.
2. Pick the format of a new plan. It becomes an **OpenSpec change** in `openspec/changes/<change-id>/` (`openspec`,
   the default) or a **Markdown plan** at `agent-plans/<change-id>/<change-id>.md` (`markdown`). Use the one the user
   asked for ("plan X as markdown"); when they did not say, ask them which before opening, in one question. The format
   is fixed once the plan exists: a resumed plan keeps its own, so leave `format` out when resuming.
3. Call `planroom_open({ changeId, title, format })`. Print the returned `url` for the user every time, even when a
   browser opened. Keep `cursor`: it is your `after` for the first `planroom_wait`. Keep `repoRoot` too: every plan
   path in this skill is relative to it. When it is not your working directory (the server was started with `--dir`),
   read and write the plan there, run `openspec` from there, and tell every subagent you start to work in it.
4. If the `planroom` tools are missing or the call fails because the server is not running, say so and name the fix:
   `planroom install` (after `npm i -g @moses-wescombe/planroom` if the `planroom` command is missing too), then `/mcp`
   to reconnect. If the repo has no `openspec/` directory, `planroom_open` refuses: say the repo needs `openspec init`
   first and do not run it yourself. Do not fall back to planning in chat. For a stale server or a change held by
   another session, see [The server](#the-server).
5. On `resumed: true`, call `planroom_state` and rebuild your picture of the session before acting. Do the same after a
   compaction.

An old plan that was never implemented, such as `agent-plans/<feature>/<feature>.md`, is good
opening context: read it and turn its open decisions into questions.

## The server

Each Claude Code session runs its own Planroom server, a child process started from its MCP config, in the repo it
was launched in, or the one a `--dir <path>` argument in that config names (`planroom mcp --dir ../other-repo`). It lives until the session exits or the user reconnects it in `/mcp`: `/clear` and invoking this
skill again keep the old process.

- **Stale after a rebuild.** A running server keeps the code it started with. After a rebuild or reinstall, its tools
  can lack what this skill documents (`doing`, `subagents`, `input: "info"`) or reject a batch shaped as described here.
  You cannot restart it yourself: ask the user to open `/mcp`, pick `planroom` and reconnect, which stops the old
  process and starts the built one. Then call `planroom_open` again: it resumes from disk under a new URL, so print it.
- **"Already open in another Claude Code session (pid N)".** Another server holds the change's lock. Give the user the
  returned `url` and ask whether to carry on there instead. Before anything else, see what the pid is:
  `ps -o pid,ppid,lstart,args -p <N>`.
    - A Planroom server (its command ends `planroom/dist/cli.js mcp`) whose session is
      gone or unwanted: with the user's go-ahead, `kill <N>`. SIGTERM makes it release the lock and close its page. It
      ends that session's planning, so never kill one unasked.
    - Any other process: the pid was reused and the lock is stale. Delete `openspec/changes/<change-id>/.planroom/lock`.
    - A lock whose pid has exited, including after a `kill -9`, is taken over by the next `planroom_open` without help.
- **Finding servers.** `pgrep -af 'planroom/dist/cli.js mcp'` lists every running one; its parent pid is the
  Claude Code session that owns it. State is written crash-safe, so killing a server loses nothing it had saved.

## The loop

Every turn is: emit what changed with `planroom_emit`, then `planroom_wait({ after })` for the user's next events.
While subagents run, end the turn instead (see [Subagents](#subagents)).

- Handle events strictly in `seq` order and remember the highest `seq` you handled; pass it as `after`.
- A wait that times out returns `{ events: [], timedOut: true }`: wait again. When `more` is true, wait again at once.
  Leave `timeoutSec` unset: every early return is a whole turn spent on nothing.
- Checklist ticks and assumption confirmations need nothing from you, so they never end a wait on their own: they
  arrive with the next event, or when the wait times out.
- When this session was launched with channels, events that arrive while you are not waiting are pushed to you as
  `<channel source="planroom" seq="…" kind="…">` messages. They are the same events `planroom_wait` returns: skip any
  `seq` you already handled, then carry on from the highest one.
- Batch related events in one `planroom_emit`: a reworded question and its follow-up land together. A malformed batch
  applies nothing and lists every problem by path; fix and re-send it.
- A block whose config fails is still stored, shown as an error card and listed in `blockProblems`. Fix it in place,
  never by sending a second one: re-send a write-up block with the same `id`, a question with `question.upsert`, and a
  reply with `comment.edit { messageId, blocks }`, the message id the problem names (`C-1.2 blocks[0]`). `comment.edit`
  also rewrites a reply's `text`; `comment.reply` returns the new message's id as its `ref`.
- `planroom_emit`'s `summary` labels a write-up revision in the page's history. Say what changed, in a few words.
- The page tells the user what you are on, from the events your last wait returned ("replying to your comment on §4",
  "drafting the write-up"). Before work it cannot see, like reading the codebase, say so with `doing`, words that
  follow "Agent": `planroom_emit({ events: [], doing: "researching how alarms are indexed" })`. Send it in the same
  message as the first tool call of that work, or add it to a batch you are sending anyway: an emit made on its own
  costs a whole turn. It shows until your next `planroom_wait`.
- While subagents run, tell the page with `subagents` (see [Subagents](#subagents)).

Channels need Claude Code launched with `claude --dangerously-load-development-channels server:planroom` (and
`channelsEnabled` on the claude.ai org). Without them, waiting is the only way events reach you, and the page shows
"Agent offline" while you are not waiting.

## Subagents

Two subagents take the work that does not need the whole session. Their model and effort are pinned in their agent
files (`~/.claude/agents/`, linked there by `planroom install`):

- **`planroom-researcher`** (read-only, medium effort). Hand it any fact that takes more than a couple of reads, in
  this codebase or about an outside product: a question's `context.findings`, an info card, what each direction
  touches, a fact a comment asks about, what a product's docs, release notes or pricing say. Send one per question, in
  parallel, and never two on the same question or product. Put its `path:line` evidence in `findings` and `refs`, and
  its web sources as links in `findings`. Check a finding yourself before a recommendation rests on it.
- **`planroom-proposer`** (high effort) writes the Phase 4 files; see [Phase 4](#phase-4-proposal).

Keep every question, recommendation, direction, write-up section and comment reply for yourself. They need the whole
session, and they are what the user reads.

Rules:

- **Never below the latest Sonnet.** Both run on the `sonnet` alias, which tracks the latest Sonnet. Pass `model` to a
  subagent only to go higher; never `haiku` or an older model id.
- **Only you talk to the page.** Neither agent can call `planroom_emit` or `planroom_wait`. Use them rather than
  `Explore` or a general-purpose agent, which run on your model and can reach the page tools. That holds for web
  research too: `planroom-researcher` has `WebSearch` and `WebFetch`.
- **Show them on the page.** Say what each one is doing with `subagents`, in the same message as the calls that start
  them: `planroom_emit({ events: [], subagents: ["reading the billing service", "tracing alarm writes"] })`. The list
  lasts across waits, so send it again as they report back, in the batch that uses their findings, and
  `subagents: []` once the last one has. Until then the page shows "Agent waiting on 2 subagents" and keeps you shown
  as working, not offline, for up to 30 minutes.
- **Do not wait while they run.** Their results reach you only between tool calls, so end your turn instead of calling
  `planroom_wait`: Claude Code wakes you as each one reports back. Page events that arrive meanwhile stay in the log,
  and your next `planroom_wait` returns them at once.
- When the two agents are not available, do their work yourself.

## Phases 1 and 2: Interrogate and Directions

Stress-test the change through question cards until every decision that would change the design is settled. This runs
in stages. Align and explore are Phase 1, the Interrogate tab, which names the stage; once the user picks directions,
the deep dive and going ahead are Phase 2, the Directions tab:

1. **Align.** Agree what the change is for before asking how. Ask about purpose, goals, users and what done looks like
   (`align/<topic>` groups), and state what you are assuming as **assumption cards** (`input: "assumption"`, no
   options): a one-line statement as the `title`, your evidence in `context`. The user confirms each (`answer.choice`
   is `"holds"`) or corrects it (`answer.text`); a correction is new information, so reword or close what it
   affects. When you are happy the goals are clear, emit `stage.advance { to: "explore" }`. The user can agree them
   first, which reaches you as a `stage.advance` event.
2. **Explore.** A shallow pass over the ways to achieve the goals, then one question with `input: "directions"` (group
   `explore/<topic>`). Each option is a direction: `label`, a good markdown `detail` (how it works, what it touches,
   why it might win or lose), `tradeoff`, `recommended` on your pick, and `blocks` for its supporting diagrams and
   tables. The page shows a tab per direction and the user picks which to investigate. There is one directions
   question per session: add or reword its options rather than asking another. The server refuses it before the
   goals are agreed.
    - **Skip it** when one way is clearly right or the others are not possible: emit
      `stage.advance { to: "deep-dive", reason }` naming the way and why the others fall away, and state the approach
      as an assumption card so the user can push back.
3. **Deep dive.** Question each direction the user picked in depth: design, failure modes, impacts, rollout
   (`deep-dive/<topic>`, `impacts/<topic>`). A question that only matters for one direction sets `direction` to its
   option id and appears on that direction's tab in Directions. A question that matters whichever way is chosen has no
   `direction` and appears on Interrogate, and on the Directions overview while it is open. The server refuses a new
   question for a direction the user did not pick.
4. **Go ahead.** The user goes ahead with one direction (or, with no directions, finishes Phase 1). That ends the
   interrogation, and the `phase.complete` event names the chosen `direction`.

Throughout:

- **Look facts up; ask for decisions.** If the codebase can answer it, read the code (through `planroom-researcher`
  when it takes more than a couple of reads) and put what you found in the question's `context.findings` and
  `context.refs` (repo paths). Only ask what is the user's to decide.
- **Recommend.** When you have a view, mark one option `recommended` and say why in its `detail` or `tradeoff`.
- **One decision per question.** Ids are `Q-<n>`, shared by questions, assumption and info cards, and never reused.
  `group` is a path, and the navigator groups and counts by it.
- **Name the decision.** Give each question and assumption card a `topic`, a few words naming what it decides
  ("Redis outage", "Token sync"). The write-up's Decisions table lists it beside the answer, and falls back to the
  title without one. Adding or changing a topic never asks the user to answer again.
- **Pick the input.** `single` for mutually exclusive options (set `allowOther` when a written answer makes sense),
  `multi` for "which apply", `chips` for short low-stakes answers, `freeform` for open questions, `assumption` for
  something you believe and want confirmed, `directions` for the one explore question, `info` for context.
- **Write for a non-technical reader.** Titles, options, `why`, a direction's `detail`, info cards and comment replies
  say what happens and why it matters in everyday words, with no jargon, file names or code. When the user needs the
  internals (a code path, a schema, a config), put them in a block with `technical: true`: the page folds it behind a
  "Technical detail" toggle, under the plain-words version.
- **Reach for analogies.** Whenever an idea is new to the user (a flow, a trade-off, why one direction beats another),
  compare it to something everyday with an `analogy` block in `context.blocks`, a direction's `blocks` or a reply's
  `blocks`, and always say in `breaks` where the comparison stops holding. Pick one the user would know without
  thinking: a queue at a counter, a library card, a spare key.
- **Show, don't describe.** Put a diagram, table or option matrix in `context.blocks` when the choice turns on a flow
  or trade-off (see [the block catalog](references/blocks.md)). Compare options in an `optionMatrix`, never a table:
  one column per option, a row per criterion, each cell a score, a short text or a text with a verdict.
- **Give context with info cards.** When the reader needs to understand something before the questions around it make
  sense (how a flow works today, what a service owns, the numbers), make an info card: `input: "info"`, no options. The
  `title` names the topic, and `context` carries it, with the same `why`, `findings`, `refs` and `blocks` as a
  question. Place it first in the group it explains. It asks nothing, so the user cannot answer it and it never counts
  toward progress or the completion gate, but they can comment on it. Close or reword it like any card; an info card
  cannot be in conflict.
- Send `status: "streaming"` for a question you are still writing, then the full question.
- Keep `understanding.update` current: a short paragraph or two of what you believe the change is, in plain words for
  the user rather than a code walk-through. The user comments on it.
- `understanding.update`, `context.why`, `context.findings` and a direction's `detail` render a markdown subset
  (`code`, **bold**, _italic_, lists, links). A `comment.reply`'s `text` is markdown too, and may also use headings,
  fenced code and rules. Every other field is plain text, so backticks there show literally.

Handling interrogation events:

| Event                                            | Do                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `answer.submit`                                  | Add follow-ups the answer opens (`links.dependsOn`), close questions it makes moot (`question.close` with the reason), merge duplicates (`question.merge`). `stale: true` means they answered an older wording: check it still fits.                                                                                                                                                 |
| `answer.submit` on the directions question       | `answer.choices` are the directions to investigate: start the deep dive on each. `answer.text` suggests one you missed: add it as an option.                                                                                                                                                                                                                                         |
| `stage.advance`                                  | The user agreed the goals: move to explore. `open` lists questions still unanswered; they stay open, so fold them in or close them.                                                                                                                                                                                                                                                  |
| `question.reopen`                                | Treat it as open again; the old answer, if any, is kept for reference.                                                                                                                                                                                                                                                                                                               |
| `conflict.resolve`                               | `keep`: this answer stands, rethink the other question. `change-other`: the other question was reopened; ask again or reword it.                                                                                                                                                                                                                                                     |
| `question.suggest`                               | Add it as a question with `fromSuggestion: "<suggestionId>"`, or `suggestion.decline` with a reason.                                                                                                                                                                                                                                                                                 |
| `comment.create`, `thread.reply`, `message.send` | Reply with `comment.reply`. `intent: "question"` wants an answer, `"change"` wants an edit, `"wrong"` means something you said is false: fix it. When a diagram or table explains it better than words, put it in the reply's `blocks` (up to six, shaped like `context.blocks`). `attachments` holds what the user pasted: Read each image at its `path`; a text snippet is inline. |
| `phase.complete`                                 | The interrogation is over; write the write-up for the chosen `direction`, if any, and drop the others. With `path: "assumptions"`, each unresolved question in the event becomes an assumption callout.                                                                                                                                                                              |

When two answers contradict, upsert the later question with `status: "conflict"` and `conflict: { with, reason }`.
Stop asking when only low-stakes detail is left, and tell the user in a message that they can go ahead (or finish
Phase 1). Do not manufacture questions to keep going.

The user can finish or go ahead while you are still working. From then on a batch that adds a question is rejected: drop
the new questions, call `planroom_wait` for the `phase.complete` event, and write the write-up.

## Phase 3: Write-up

Turn the answers into a document the user can review section by section. It becomes the OpenSpec change, so cover:
an ELI5 section, summary, how it works (a diagram), the numbers, rollout, impact, risks, acceptance criteria (an
interactive checklist), and assumptions.

- **ELI5 first.** The first section, titled "ELI5", explains the whole change as you would to a five-year-old: a
  `text` block of three or four short sentences with no jargon, then an `analogy` block for the change as a whole.
- **Every section starts plain.** Open each later section with its own one- or two-sentence ELI5 in a `text` block,
  and an `analogy` where the idea is new. The detail follows; code, schemas, config and internals only an engineer
  needs go in `technical: true` blocks.

- **The page writes the decisions.** It ends the write-up with a Decisions section built from the answered questions:
  each one's `topic`, the answer and a link to it, kept in step with every answer. Never write a decisions table or
  section yourself. `planroom_state` returns the rows as `decisions`.
- Every block is a typed config; read [references/blocks.md](references/blocks.md) before emitting one. Prose is a
  `text` block. Never send HTML. Pick the diagram that fits: `flow`, `sequence`, `architecture`, `state`, `schema`
  for tables and migrations, `c4` for a system's context or containers, `mindmap` for scope, `gantt` for a dated or
  sized schedule (`timeline` for plain ordered steps), `sankey` for volumes that split and merge.
- Sections are `doc.section.upsert { id, title, order, blocks }`; send each block before or with the section listing it.
- To set two or three blocks side by side, list their ids as a row inside `blocks`:
  `["how-text", ["how-before", "how-after"], "how-seq"]`. The row stacks on a narrow screen. Columns need no labels,
  and a caption is optional on any block: leave it off when the diagram speaks for itself.
- Put the question ids a block came from in its `refs`.
- Every assumption, and every decision the user did not make, is a `callout` with `tone: "assumption"`: the user must
  confirm each one before submitting cleanly.
- Any change you make to a section the user reviewed unticks it. That is intended: say what you changed in your reply.

Handling Phase 3 events: the user's reviewed ticks are theirs alone and never reach you. `checklist.tick` is
information. `assumption.confirm` settles one. `block.fix` names a block and its schema errors: re-send it fixed.
`edit.undone` means the user reverted revision `revision`; do not re-apply it. A comment reply that edited content lists
what it changed in `touched`, or the server fills it in.

## Phase 4: Proposal

On `phase.submit`, write the plan from write-up revision `revision`: an OpenSpec change into
`openspec/changes/<change-id>/`, or a Markdown plan into `agent-plans/<change-id>/<change-id>.md` (the `format` from
`planroom_open` and `planroom_state`):

1. Hand the files to `planroom-proposer` with the change id, the `revision`, the event's `validate` flag (the page's
   "Validate strictly" box, on by default) and its `outstanding` items (what the user submitted with anyway), and list
   it in `subagents`. It reads the write-up itself through `planroom_state`. For an OpenSpec change it writes
   proposal, specs, design and tasks from `openspec instructions`, and returns once `openspec validate` passes (with
   `--strict` when `validate` is true), with one `{ spec, requirement, questions }` per requirement. For a Markdown plan
   it writes the one plan file and returns no requirements. Its steps are in its agent file, `planroom-proposer.md`:
   follow them yourself when it is not available.
2. Emit one `proposal.trace { spec, requirement, questions }` per requirement it returned (none for a Markdown plan),
   then `proposal.ready`. Planroom runs the same validation itself, or for a Markdown plan checks that
   `<change-id>.md` exists and is not empty, and sends you a `validation.result`; on a failure, send the report to the
   proposer with `SendMessage` (it keeps its context) or fix a small one yourself, then emit `proposal.ready` again.
   The Proposal tab opens on submit and shows your progress; the user can accept once it passes.

While planning an OpenSpec change, the in-flight change fails `openspec validate --all --strict` until its proposal
exists; that is expected, do not "fix" it by hand. A Markdown plan never touches `openspec/`.

In Phase 4, comments are anchored to files (`file:<path>`): edit the file (or send it to the proposer), reply, and the
page updates live. `validation.result` from a re-run reports hand edits too. `proposal.requestChanges` carries a
message and the open comment threads: address them the same way, then `proposal.ready` again.

## Stop

On `proposal.accept`, the session is read-only. Report the change id and where the accepted plan is, and stop. Do not
implement the change unless the user asks.

On `session.end`, the user ended the session from the page and it is read-only: `how` is `cancelled` (before the
proposal validated) or `finished` (after). Stop waiting, say what the change folder holds, and stop.

Once your wait returns either event, Planroom closes the session and stops serving its page, so every Planroom tool
then answers that no session is open. Do not call them again unless the user asks you to open a plan.

## Old plans

The change id under the page's logo opens a list of every plan in the repo: each folder under `openspec/changes/` or
`agent-plans/` with a `.planroom/` folder, archived changes left out. Under it are the plans of other repos Planroom has run in on this
machine (`~/.local/state/planroom/repos.json`). Those open only from a Claude session in their own repo, or by link
while one has them open: never plan another repo's change from here. Two page actions reach you from the list:

- **The user switched plans.** Picking another plan moves the page to it at once. Your next `planroom_emit` or
  `planroom_wait` is refused with "The user switched the page to the plan for <change-id>", and nothing is applied.
  Call `planroom_state`, rebuild your picture of that plan as on a resume, and wait from its `cursor`.
- **`session.reopen`.** An accepted or ended plan opens read-only, with a Reopen button. Reopening makes it editable
  again in the phase it had reached (an accepted proposal goes back to awaiting acceptance) and logs `session.reopen`
  with `from`: `accepted`, `finished` or `cancelled`. Call `planroom_state` and carry on from where the plan stands.

When the user asks you to reopen an old plan, call `planroom_open` with its change id, print the URL, and wait: it
opens read-only, and their Reopen arrives as `session.reopen`.

When the user wants to pick a plan rather than name one ("show me my plans", "open the plan browser"), call
`planroom_open` with no `changeId`. It returns `{ url, browsing: true, repoRoot }` and opens the plan browser, a page
that lists the plans as above. Print the url and call `planroom_wait({ after: 0 })`, again after each empty timeout.
Once the user picks a plan it is refused like a switch: call `planroom_state` and carry on as on a resume. Outside
Claude, `planroom open` serves the same browser on its own: every plan opens read-only there, takes no lock, and
refuses every write.
