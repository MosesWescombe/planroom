# Planroom: work in progress

Applying `openspec/changes/add-planroom`, committed on `task/add-planroom`. `tasks.md` boxes are ticked only for work verified by a
passing test or a live check. 66 of 75 are done (2026-10-05).

## Done

- Server, shared contract, MCP tools, HTTP/SSE page server, UI for all three phases, dark mode, narrow layout.
- Staged Phase 1 (task 8.4): align with assumption cards, one directions question, a tab per investigated direction,
  go ahead with one. Checked live with a scratch demo; design.md decision 15.
- 343 Vitest tests (shared, server, e2e through the MCP in-memory client with the real `openspec validate`, and jsdom UI
  suites). Lint, both typechecks, `pnpm check:agent-docs` and `openspec validate add-planroom --strict` pass.
- Checked live in a browser with a seeded demo: every phase, every block type, answering, drafts across reloads,
  comments on prose, question cards and diagram labels, dark mode, 390 px with drawers.
- Root `.mcp.json` has the `planroom` entry (a git-root `sh -c exec node` launcher, because Claude Code spawns
  project servers in the launch directory); `claude mcp get planroom` connects from the root and from subdirectories.
- `.agents/skills/planroom/SKILL.md` and the generated `references/blocks.md` (a test fails when it is stale).
- Subagents `planroom-researcher` (Phase 1 lookups) and `planroom-proposer` (Phase 3 files), both on the `sonnet` alias
  with pinned effort, in `.agents/agents/` behind a tracked `.claude/agents` symlink. Checked headless: both load, run
  on Sonnet and cannot reach `planroom_emit` or `planroom_wait`. The skill also covers stale and lock-holding servers.

- Token-cost fixes from the first real session (2026-10-02): ticks and assumption confirmations no longer wake the
  agent (task 5.6); the researcher can read the web (`WebSearch`, `WebFetch`), so web research stays on Sonnet; the
  skill and tool descriptions drop the 60-second polling waits for "end your turn while subagents run", and send
  `doing`/`subagents` emits in the same message as the calls they describe.

- Block additions (tasks 9.7 to 9.9, 10.5, 10.6; design decisions 11, 16, 17): `schema`, `c4`, `mindmap`, `gantt`
  and `sankey` (on `d3-sankey`), curved graph edges with hover highlighting, `optionMatrix` as a column per option
  with verdict cells, section rows of side-by-side columns, and a Decisions section the page derives from the answers
  (the question `topic` names each row). Checked live with a seeded demo in both themes at 1920 px and 390 px.

- Old plans (task 4.5): the change id under the logo opens a list of every plan in the repo; picking one moves the
  page to it and refuses the agent's next emit or wait until it calls `planroom_state`. Ended and accepted plans open
  read-only with Reopen (`session.reopen`). Checked live on a seeded scratch repo at 1440 px.
- Plan browser (task 4.7): `planroom_open` with no change id serves a browse page; a pick there wakes the agent's
  parked wait as a switch. `planroom open` serves it standalone: plans open in a `PlanViewer`,
  read-only and unlocked. Checked live on this repo with a private build at 1920 px.

## Left

- 13.2: confirm a fresh Claude Code session asked to "plan X" invokes the planroom skill. In the same run, confirm that
  ending the turn while a `planroom-researcher` runs gets the session woken when it reports back.
- 1.1, 1.2: channel spike (needs `claude --dangerously-load-development-channels server:planroom`, which auto mode
  refused). 2.2 waits on 1.1 for the SDK version; 1.30.1 is installed. `planroom_wait` defaults to 300 s until 1.2.
- 14.x, 15.x: after Planroom plans one real change (Migration Plan). 15.1 needs a claude.ai Owner.

Delete this file and the `planroom-apply-in-progress` memory once the change is applied.
