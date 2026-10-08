---
name: planroom-ask
description: Ask the user a series of questions on Planroom's live page of question cards instead of in chat, and get every answer back as context. Use in any repo, at any point in your work, whenever you have more than one question for the user - before starting a task, at a fork in an implementation, or to confirm what you are assuming. Not for planning a change, which has question cards of its own.
---

# Planroom Ask

Planroom Ask puts your questions for the user on a live page on `127.0.0.1` rather than in chat: question and info
cards, comments and messages both ways, and no phases or write-up. It is the `planroom-ask` MCP server, which
`planroom install` registers beside this skill, and it needs no `openspec/`. You write to the page with typed events;
the user answers and comments there; their events come back to you. When they send their answers, you get every
question, answer and thread back as Markdown.

While a Planroom plan is open, ask on its page with question cards instead.

## Start

1. Call `planroom_ask({ askId, title, output })`. `askId` is kebab-case and names the topic
   (`auth-migration-questions`). `output` is optional: a repo-relative `.md` file to also write the answers to, when
   they should be kept or handed on. Print the returned `url` for the user every time, even when a browser opened. Keep
   `cursor`: it is your `after` for the first `planroom_wait`.
2. If the `planroom-ask` tools are missing, the user turned the server off in `/mcp` or never installed it: ask in chat
   instead. If they ask why, `planroom install` (after `npm i -g @moses-wescombe/planroom` if the command is missing),
   then reconnecting `planroom-ask` in `/mcp`, sets it up.
3. A running server keeps the code it started with, so after a reinstall its tools can lack what this skill documents.
   You cannot restart it yourself: ask the user to reconnect `planroom-ask` in `/mcp`, then call `planroom_ask` again.
   It resumes from disk under a new URL, so print it.
4. On `resumed: true`, call `planroom_state`: its `context` is the questions, answers and threads so far. Do the same
   after a compaction. On `sent: true` as well, the user already sent answers you have not had: `planroom_wait` from
   `cursor` for the `ask.done` before anything else.

## The loop

Every turn is: emit what changed with `planroom_emit`, then `planroom_wait({ after })` for the user's next events.

- Handle events strictly in `seq` order and remember the highest `seq` you handled; pass it as `after`.
- A wait that times out returns `{ events: [], timedOut: true }`: wait again. When `more` is true, wait again at once.
  Leave `timeoutSec` unset: every early return is a whole turn spent on nothing.
- When this session was launched with channels
  (`claude --dangerously-load-development-channels server:planroom-ask`), events that arrive while you are not waiting
  are pushed to you as `<channel source="planroom-ask" seq="…" kind="…">` messages. They are the same events
  `planroom_wait` returns: skip any `seq` you already handled, then carry on from the highest one.
- Batch related events in one `planroom_emit`: a reworded question and its follow-up land together. A malformed batch
  applies nothing and lists every problem by path; fix and re-send it.
- A block whose config fails is still stored, shown as an error card and listed in `blockProblems`. Fix it in place,
  never by sending a second one: re-send the question with `question.upsert`, or a reply with
  `comment.edit { messageId, blocks }`, the message id the problem names (`C-1.2 blocks[0]`). `comment.edit` also
  rewrites a reply's `text`; `comment.reply` returns the new message's id as its `ref`.
- Before work the page cannot see, like reading the codebase, say so with `doing`, words that follow "Agent":
  `planroom_emit({ events: [], doing: "checking how sessions expire" })`. Send it in the same message as the first
  tool call of that work: an emit made on its own costs a whole turn. It shows until your next `planroom_wait`.
- Hand a fact that takes more than a couple of reads to the `planroom-researcher` subagent, one per question, and check
  a finding yourself before a recommendation rests on it. While it runs, list it in `subagents`
  (`planroom_emit({ events: [], subagents: ["tracing session expiry"] })`, then `[]` once it reports back) and end your
  turn instead of waiting: Claude Code wakes you when it reports back, and your next wait returns what arrived meanwhile.

## Writing the cards

Each card is a `question.upsert`.

- **Look facts up; ask for decisions.** If the codebase can answer it, read the code and put what you found in the
  question's `context.findings` and `context.refs` (repo paths). Only ask what is the user's to decide.
- **Recommend.** When you have a view, mark one option `recommended` and say why in its `detail` or `tradeoff`.
- **One decision per question.** Ids are `Q-<n>`, shared by questions, assumption and info cards, and never reused.
  `group` is a path, and the navigator groups and counts by it.
- **Pick the input.** `single` for mutually exclusive options (set `allowOther` when a written answer makes sense),
  `multi` for "which apply", `chips` for short low-stakes answers, `freeform` for open questions, `assumption` for
  something you believe and want confirmed (a one-line statement as the `title`, no options; the user confirms it with
  `answer.choice` `"holds"` or corrects it in `answer.text`), and `info` for context. An ask has no `directions` input
  and no `direction` field: the server refuses them.
- **Write for a non-technical reader.** Titles, options, `why`, info cards and replies use everyday words, with no
  jargon, file names or code. Put internals the user may want in a block with `technical: true`, which the page folds
  behind a "Technical detail" toggle. When an idea is new to them, compare it to something everyday with an `analogy`
  block, and always say in `breaks` where the comparison stops holding.
- **Show, don't describe.** Put a diagram, table or option matrix in `context.blocks` when the choice turns on a flow
  or trade-off, shaped as in [the block catalog](references/blocks.md). An ask has no write-up, so a block goes only in
  a question's `context.blocks` or a reply's `blocks`, with no `id`. Compare options in an `optionMatrix`, never a
  table.
- **Give context with info cards.** When the reader needs to understand something before the questions around it make
  sense, make an info card: `input: "info"`, no options, the topic as its `title` and the explanation in `context`.
  Place it first in the group it explains. It asks nothing, but the user can comment on it.
- Send `status: "streaming"` for a question you are still writing, then the full question.
- `context.why`, `context.findings` and an option's `detail` render a markdown subset (`code`, **bold**, _italic_,
  lists, links). A `comment.reply`'s `text` is markdown too, and may also use headings, fenced code and rules. Every
  other field is plain text.

Ask only what your work needs, and stop when you have it. Do not manufacture questions to keep going.

## Handling events

| Event                                            | Do                                                                                                                                                                                                                                                         |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `answer.submit`                                  | Add follow-ups the answer opens (`links.dependsOn`), close questions it makes moot (`question.close` with the reason), merge duplicates (`question.merge`). `stale: true` means they answered an older wording: check it still fits.                       |
| `question.reopen`                                | Treat it as open again; the old answer, if any, is kept for reference.                                                                                                                                                                                     |
| `conflict.resolve`                               | `keep`: this answer stands, rethink the other question. `change-other`: the other question was reopened; ask again or reword it.                                                                                                                           |
| `question.suggest`                               | Add it as a question with `fromSuggestion: "<suggestionId>"`, or `suggestion.decline` with a reason.                                                                                                                                                       |
| `comment.create`, `thread.reply`, `message.send` | Reply with `comment.reply`. `intent: "question"` wants an answer, `"change"` wants an edit, `"wrong"` means something you said is false: fix it. `attachments` holds what the user pasted: Read each image at its `path`; a text snippet is inline.        |
| `ask.done`                                       | The user sent their answers. See [Done](#done).                                                                                                                                                                                                            |

When two answers contradict, upsert the later question with `status: "conflict"` and `conflict: { with, reason }`.

## Done

When the user is done they send their answers, and `planroom_wait` returns `ask.done`. Its `context` is every
question, answer and thread as Markdown; `file` is the `output` it was written to, or `fileError` says why it could not
be. The ask is read-only and its page closes: carry on with your work from the answers, without waiting again.

To ask more on the same topic later, call `planroom_ask` with the same `askId`. It reopens with the earlier questions
and answers, and its `cursor` is past them. If it returns `sent: true` instead, you never had that `ask.done`: the ask
stays read-only, so `planroom_wait` from `cursor` for it, then call `planroom_ask` again to ask more.
