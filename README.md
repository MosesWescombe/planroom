# Planroom

A live browser planning page for Claude Code. Claude grills you through question cards, turns the answers into a
visual write-up, and proposes the result as a strictly validated OpenSpec change or a Markdown plan.

Claude can also put any series of questions on a simpler page of question cards, in any repo and outside a plan, and
take the answers back as context.

One package holds the `planroom` command, the page, two MCP servers with a skill each (`planroom` for planning,
`planroom-ask` for questions) and two subagents.

## Why Planroom

Planning a change in a terminal chat is a wall of text: the agent writes a long plan, you scroll it, then accept it or
write a long reply. Planroom turns that into a working session with Claude, closer to planning at a whiteboard with
another developer than to reviewing a document.

**You stay in the loop.** Claude asks one decision at a time on question cards, each with what it already found in the
code and the option it would pick. You answer, correct its assumptions or comment on any line, and it reacts while you
are still on the page. It shows what it is working on, so you never wonder whether it is stuck.

![A question card with the agent's findings, an option matrix and its recommended answer](docs/screenshots/question.png)

**It explains with pictures.** When a choice turns on a flow or a trade-off, Claude draws it: architecture and sequence
diagrams, option matrices, Gantt charts and risk matrices, among 24 block types. A hard idea lands faster as a diagram
than as three paragraphs.

**It makes you look wide before you go deep.** A plan starts by agreeing the goals and confirming what Claude is
assuming. Then it lays out the different ways to make the change side by side, each with its own diagrams and
trade-offs, and you pick which to investigate before any of them gets detailed. Failure modes, rollout and impact are
asked as explicit decisions, and every assumption that reaches the write-up waits for you to confirm it.

![The directions card: three ways to enforce rate limits, each on its own tab with its diagrams](docs/screenshots/directions.png)

**It is a conversation.** Select any text and ask about it, the way you would lean over to a colleague: "what stops a
single key hammering us?" Claude answers in the thread, with a diagram when that says it better, and edits the plan
when you agree. It feels like pair programming on the design.

![A comment thread: a question about a failure window, answered with a sequence diagram](docs/screenshots/conversation.png)

**It costs fewer tokens and less waiting than having Claude write HTML.** Claude never writes markup. It sends small
typed events, such as a diagram as its nodes and edges, and the page lays them out and draws them. A change updates one
card or block rather than regenerating a page, and your answers come back as short structured events rather than a
page to read again. Less output means less to pay for and less time watching it stream.

The answers become a write-up you review section by section, then a validated OpenSpec change or Markdown plan.

![The write-up: a rollout Gantt chart, a risk matrix and an assumption waiting for confirmation](docs/screenshots/write-up.png)

## Install

Needs Node 24 or newer and Claude Code.

```sh
npm i -g @moses-wescombe/planroom
planroom install
```

`planroom install` links the `planroom` and `planroom-ask` skills and the agents into `~/.claude` (or
`$CLAUDE_CONFIG_DIR`) and registers user-scope `planroom` and `planroom-ask` MCP servers. OpenSpec-format plans also
need the OpenSpec CLI, pinned in the repo or from `npm i -g @fission-ai/openspec`.

Upgrade with `npm i -g @moses-wescombe/planroom@latest`, then reconnect `planroom` and `planroom-ask` in `/mcp` in any
running session. The skills and agents are links into the package, so they upgrade with it. Run `planroom install`
again after switching your default Node version, since it records absolute paths, and once after upgrading from 1.0,
whose skill link points at a folder that has moved and which had no `planroom-ask`.

To turn planning or asking off, disable its server in `/mcp` and its skill in `/skills`. Turn off both, or Claude may
reach for tools that are gone, or skip the guidance for the ones that are left.

## Use

In Claude Code, ask it to plan something ("plan adding rate limiting") in a repo with an `openspec/` directory. Once
it has more than one question for you mid-task, in any repo, it puts them on a page of question cards instead of in
chat.

Claude polls the page for you: it calls `planroom_wait`, which returns as soon as you act on the page, or after 10
minutes with nothing. Each return is a model turn, so a session left open on an idle page still spends tokens, about
one turn every 10 minutes. Accept the plan or end the session to stop it.

Channels are optional. Launch Claude Code with
`claude --dangerously-load-development-channels server:planroom server:planroom-ask` and what you do on the page also
reaches Claude while it is busy rather than waiting. Without them, those events wait for
its next poll. Channels are a research preview; on claude.ai Team and Enterprise an Owner must allow them.

| Command                               | Does                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------ |
| `planroom open [change-id]`           | Open this repo's plans read-only in the browser, or one plan             |
| `planroom list`                       | List the plans in every repo Planroom has run in                         |
| `planroom install` / `uninstall`      | Wire Planroom into Claude Code, or remove it                             |
| `planroom mcp [--ask] [--dir <path>]` | An MCP server Claude Code starts, `--ask` for questions; not run by hand |

## Develop

```sh
pnpm install
pnpm build
npm link             # the global `planroom` now runs this checkout
planroom install     # links ~/.claude at this checkout's skills/ and agents/
```

Rebuild, then reconnect `planroom` and `planroom-ask` in `/mcp` to pick up changes. See `AGENTS.md` for the rules and checks.

## Release

Bump `version` in `package.json`, commit, and push a matching `v<version>` tag. CI checks, builds and publishes it.
