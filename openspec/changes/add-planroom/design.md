## Context

See proposal.md - Why. The visual spec is `handoff/` in this change: `HANDOFF.md` fixes the three phases, the
question record, the block envelope, the 18 block types and the live event names, and leaves transport, hosting,
launch, dark mode, narrow layout and version history open. This design closes those. Decisions taken with the user
before writing: the tool lives in this monorepo as `tools/planroom`; Claude Code uses it for any planning request; it
replaces `plan-feature` and `grill`; `decompose` reads the change instead; page events reach the agent by long-poll
**and** by channel push; v1 includes dark mode, the narrow layout and write-up revision history; and a session stops
at an accepted proposal.

Constraints that shape the approach:

- Claude Code (2.1.283 here) talks to tools over MCP. A long-running MCP tool call auto-backgrounds after two minutes
  (`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`). Channels, which let an MCP server push into a running session, are a research
  preview: a custom channel only registers when Claude Code is launched with
  `--dangerously-load-development-channels server:<name>`, needs Anthropic auth, and on claude.ai Team and Enterprise
  needs an Owner to set `channelsEnabled`.
- `openspec` 1.13.1 is the CLI. `openspec validate <id> --strict --json` returns structured issues;
  `openspec show <id> --json` returns delta text and raw scenario text but no requirement or scenario names, so it
  cannot drive the rendered Proposal view on its own.
- The rest of the React tree (`packages/scopious-ui`, `web/*`) is React 17, Vite 5, Vitest 2, Testing Library 12 and
  jsdom 20. `dagre`, `react-markdown` and `express` are already direct dependencies elsewhere.
- Planroom has its own design system (the handoff's tokens and type), not Scopious's, so it shares no UI components
  with `packages/scopious-ui`.

## Goals / Non-Goals

**Goals:**

- One process per Claude Code session that is both the MCP server and the page's web server, with nothing to start
  by hand beyond building the workspace once.
- A single source of truth for every record shape (question, block, event, state) shared by the server, the agent's
  tool schemas and the page.
- Server-owned invariants: versions, the reviewed reset, phase gates, the submit gate and validation are computed in
  one place, never trusted from the agent or the page.

**Non-Goals:**

- Multi-user presence, remote hosting, or any access from another machine.
- Planroom calling a model itself. The Claude Code session is the only agent.
- Implementing the accepted change. That stays with `/decompose` and `/implement`.
- Using or replacing Claude Code's built-in plan mode. The skill tells the agent not to enter plan mode during a
  Planroom session, because plan mode blocks the writes Planroom needs and Phase 4 is the approval step.
- Packaging Planroom as a Claude Code plugin or for other repos. It is a workspace of this monorepo.

## Decisions

### 1. One stdio MCP server that also serves the page

Claude Code spawns `tools/planroom/dist/server/main.js` over stdio from a `planroom` entry in the root `.mcp.json`.
The same process starts an HTTP server on `127.0.0.1` on an OS-assigned port when the agent first opens a session,
serving the built SPA, a JSON API for page events, and a Server-Sent Events stream for updates. Separate Claude Code
sessions get separate processes and ports, so parallel planning never collides. The entry runs
`sh -c 'exec node "$(git rev-parse --show-toplevel)/tools/planroom/dist/server/main.js"'`: Claude Code finds the
project `.mcp.json` from a subdirectory but spawns the server in the directory it was launched from (verified on
2.1.284; `${CLAUDE_PROJECT_DIR}` is not set for it), so a relative path only works from the repo root. The launcher is
`exec node`, not `pnpm`, because anything a wrapper prints to stdout corrupts the MCP stream; the server resolves the
repo root from its own file location.

- _Rejected: a long-lived Planroom daemon_ that sessions connect to. It needs its own start, discovery, multi-session
  routing and shutdown story, and still needs an MCP shim per session.
- _Rejected: building on `lavish-axi`_. Lavish reviews agent-written HTML; the handoff's contract is that the agent
  never writes HTML and every record is typed, versioned state.
- _Rejected: plugin packaging_. The development-channels flag accepts `server:<name>` for a project `.mcp.json`
  server, so a plugin would only add a marketplace install step inside a single repo.

### 2. Four MCP tools, with the agent's events batched

- `planroom_open({ changeId, title })` creates or resumes the session and returns `{ url, resumed, phase, cursor }`.
- `planroom_emit({ events, summary? })` applies a batch of agent events: `question.upsert` (optionally
  `fromSuggestion`, which marks a user's suggestion added), `question.close`, `question.merge`,
  `suggestion.decline`, `understanding.update`, `doc.section.upsert`, `doc.block.upsert`, `comment.reply`,
  `comment.edit`, `proposal.trace` and `proposal.ready`. It returns applied versions and per-block config errors.
  `summary` labels the write-up revision.
- The write-up is a list of sections, each `doc.section.upsert { id, title, order, blocks[] }` naming its blocks in
  order; review ticks belong to sections. Prose is a 19th block type, `text`, a markdown subset the page renders as
  React elements, never as raw HTML.
- `planroom_wait({ after, timeoutSec? })` long-polls the page event log (decision 5).
- `planroom_state()` returns the full current state, so the agent can rebuild context after a compaction or resume.

The handoff's agent-side `phase.unlock` is replaced by `proposal.ready`: phase gates are computed by the server
(decision 6), so the agent reports that it finished writing the change and the server validates it.

- _Rejected: one tool per event type_. Ten tools with a duplicated envelope, and no atomic batch, so a reworded
  question and its dependent follow-up could land in two renders.
- _Rejected: prose inside a catalog block_ (a `callout` without a tone, say). Every paragraph would need a tone it
  does not have, and the handoff's write-up is mostly prose between blocks.

Record ids the server assigns: comment threads `C-n`, message threads `M-n`, suggestions `S-n`. The page answers a
thread with `thread.reply`, and `conflict.resolve` carries `keep` or `change-other`. `phase.submit` names the write-up
revision the user reviewed, and is refused when the agent has edited since. Image blocks reference `asset:<file>`
under `.planroom/assets/`. The agent counts as working for 2 minutes after any tool call (30 while it says subagents
are running), so the top bar does not read "offline" while a reasoning model thinks between a wait returning and its
next emit; the first build used 20 seconds, which a model thinking between calls outran. The tools are registered on the SDK's low-level
`Server`, with `tools/list` schemas generated by `z.toJSONSchema`, so a malformed batch is reported in Planroom's own
path format rather than the SDK's.

### 3. Loose block configs at the tool boundary, strict validation behind it

The tool input schema types the envelope (`id`, `type`, `caption`, `refs`) strictly and `config` as an open object.
The server validates each config against its type's schema, stores invalid ones for the error card, and returns their
errors in the tool result. The catalog's shapes and when to use each block live in the skill's
`references/blocks.md`, generated from the same schemas.

- _Rejected: the full catalog in the tool schema_. Eighteen block schemas would load into every session's context
  whether or not it reaches the write-up, and the handoff's error-card path is needed anyway.

### 4. Shared zod schemas as the single source of truth

`src/shared/` holds zod schemas for questions, the 18 block configs (a discriminated union on `type`), both event
directions, and persisted state, plus the pure functions derived from them: phase gates, the submit gate and the
reviewed reset. The server validates with them, the MCP tool schemas are generated from them, and the page imports
them for types and renderer registration. Planroom uses zod 4, already in the lockfile, because the MCP SDK builds its
tool schemas from zod and the repo's pinned 3.22.4 predates the SDK's supported range.

- _Rejected: JSON Schema files with generated types_. A second toolchain for the same contract, and the derived gate
  functions would still need a TypeScript home.

### 5. Page events are an append-only log, delivered by wait or by push

Every page event (and each server-originated one, such as a validation result) is appended to
`.planroom/events.jsonl` with a strictly increasing `seq` and fsynced before the page gets its acknowledgement. The
agent always consumes by cursor, so delivery is at-least-once and handling is idempotent by `seq`, the standard
log-and-offset pattern.

Delivery rule, applied per event: if a `planroom_wait` is pending, resolve it; otherwise, if the server declared the
`claude/channel` capability, push `notifications/claude/channel` with `meta: { seq, kind, change_id }` (meta keys
must be identifiers, so no hyphens). The server's MCP `instructions` tell the agent that channel events are the same
events `planroom_wait` returns and to discard any `seq` it has already handled. When the agent's next `after` cursor
passes a pushed `seq`, the server records the channel as confirmed; until then an agent that is not waiting shows as
offline on the page.

Checklist ticks and assumption confirmations are quiet: the agent only notes them, and each wake is a whole model turn
over the session's context, so they ride along instead of waking it. A wait returns at once only when an event that is
not quiet is waiting, and returns every event after its cursor when it resolves or times out; a push sends held quiet
events just ahead of the next event that is not, since the agent passes the highest `seq` it handled as its cursor and
would otherwise skip them. A first real session spent 16 of its 92 waits on a lone tick or confirmation.

`planroom_wait` defaults to a 300-second timeout, below Claude Code's MCP tool timeout, and the skill re-arms it after a
timeout. The agent leaves the timeout unset, and does not wait at all while its subagents run: their results reach it
only between tool calls, so it ends its turn and Claude Code wakes it as each one reports back, and the page events
that arrived meanwhile are in the log for its next wait. The first real session polled with 60-second waits instead,
and 45 of its 92 waits returned nothing.

- _Rejected: channels only_. Research preview, a launch flag every session, and org gating; without them the page
  could never reach the agent.
- _Rejected: long-poll only_. An agent that ended its turn could not be woken. The user chose both.
- _Rejected: pushing every event through both paths_. Every event would arrive twice whenever channels are on.
- _Rejected: debouncing a wait for a few seconds after its first event_. Answers and comments arrive tens of seconds
  apart, so a short window batches little beyond tick bursts, which quiet events already cover, and it delays every
  reply.

### 6. Field ownership decides who writes what

The agent owns content fields (question text, options, context, status transitions it initiates, block configs,
replies). The page owns answers, drafts, reviewed ticks, checklist ticks, assumption confirmations and comments. The
server owns `version`, the reviewed reset (an agent content change to an answered question or reviewed block sets
`needs-review` or `reviewed: false`), phase state, the submit gate and validation status. Because no field has two
writers, there are no write conflicts to merge and no optimistic-concurrency retries for the agent to handle.

- _Rejected: agent-supplied versions with compare-and-set_. The agent is the only content writer, so a stale-version
  rejection could only ever be the agent racing itself.
- _Rejected: the page computing needs-review_. It would disagree with the agent's view of state whenever a page was
  closed during an edit.

### 7. State lives in the change folder

`openspec new change <id>` scaffolds the change on first open, and Planroom keeps its files in
`openspec/changes/<id>/.planroom/`: `state.json` (the current snapshot, written temp-then-rename so a crash leaves the
old or new file, never a torn one), `events.jsonl` (decision 5), `revisions/<n>.json` (decision 8) and `lock`
(`{ pid, url }`, taken over when the pid is gone). `state.json` is the planning record and travels with the change;
`events.jsonl`, `revisions/` and `lock` are delivery and local-history mechanics and are gitignored.

- _Rejected: a repo-root `.planroom/<id>/`_. It separates the planning record from the change it produced and needs a
  move at submit time.
- _Rejected: user-level storage under `~/.local/share`_. The record would be unreviewable and lost with the machine.

### 8. One revision log serves undo and history

Every `planroom_emit` batch that touches write-up blocks writes a revision: the before and after of each touched block,
the agent's `summary` and a timestamp. "Undo edit" applies a revision's before-images as a new revision, disabled when
any touched block has a later revision, and appends an `edit.undone` event for the agent. History opens any revision
read-only, and the diff view compares two revisions block by block, using `diffWords` from `diff` inside changed text.

- _Rejected: agent-cut named versions_. Undo still needs per-edit granularity, so this would be two versioning
  concepts for one write-up.
- _Rejected: asking the agent to perform the undo_. It is slower and not guaranteed to restore the exact prior content.

### 9. Comment anchors follow the W3C Web Annotation selectors

An anchor is `{ target, position: { start, end }, quote: { exact, prefix, suffix } }`, the Web Annotation
`TextPositionSelector` plus `TextQuoteSelector`, over the plain text of the target element (a question, a block, or a
proposal file section, marked with `data-anchor-target`). Resolution tries the position, checks it against `exact`,
then searches the target for `prefix + exact + suffix`, then `exact` alone, and otherwise marks the thread detached.

- _Rejected: offsets only_. The handoff's own requirement is that anchors survive nearby rewrites.

### 10. The page: React 17 with per-record subscriptions over SSE

The SPA matches the rest of the tree's React toolchain (React 17, Vite 5, Vitest 2, Testing Library 12, jsdom 20).
A normalized store keyed by record id receives snapshots and record upserts over SSE; components subscribe to one
record through `use-sync-external-store` and are memoized on `version`, so an update re-renders exactly the changed
card or block. A reconnect receives a fresh snapshot, and version comparison makes that idempotent. Page events are
`POST`ed and acknowledged with their `seq`. Drafts and panel or theme preferences are per-browser conveniences in
`localStorage`. Scroll stability uses native CSS scroll anchoring, with a measure-and-restore fallback where the
browser lacks `overflow-anchor`.

- _Rejected: React 19_. It would add a second testing toolchain (Testing Library 16, React 19 types) for no feature
  Planroom needs.
- _Rejected: WebSockets_. The page only needs a server-to-page stream plus request/response posts, which SSE and
  `fetch` cover natively with built-in reconnect.

### 11. Renderers from a registry; diagrams laid out by dagre

A `type -> component` registry mirrors the block union; an unknown type renders the raw-config card. `flow`, `state`,
`architecture` (compound groups), `schema` (tables as record nodes, relations moved to the rows they name, with crow's
foot and bar end marks) and `c4` (top to bottom, boundaries as groups) are laid out with `dagre` and drawn as SVG in the
handoff's diagram vocabulary. Their edges are drawn as a uniform B-spline through dagre's points, the curve dagre's own
renderer uses, and hovering a node fades all but it and its neighbours. `sequence`, `timeline`, `bar`, `line`,
`riskMatrix`, `optionMatrix`, `gantt` (one pass in list order, since a task may only wait on earlier ones) and
`mindmap` (a two-sided tidy tree, split where the leaf counts come closest) are laid out directly; `sankey` is laid out
by `d3-sankey`. All are drawn as SVG with a fixed palette defined per theme, each chart with a "view as table" toggle.
`mermaid` is imported lazily, only when a `mermaid` block renders, with `securityLevel: 'strict'`. Proposal markdown renders with `react-markdown` without raw
HTML. Spec deltas are parsed by a small reader of the OpenSpec delta grammar (`## <OP> Requirements`,
`### Requirement:`, `#### Scenario:`, `- **WHEN/THEN/AND**`), and the page trusts `openspec validate` for correctness.

- _Rejected: `reactflow`_ (already in `web/internal-tools-ui`). It is an interactive graph editor; these diagrams are
  read-only and must match the handoff's vocabulary.
- _Rejected: `elkjs`_. A new dependency where `dagre` handles every graph layout the catalog needs.
- _Rejected: a charting library_. Small chart types whose colours must come from the app's palette.
- _Rejected: a hand-written sankey layout, or rendering sankeys through Mermaid_. `d3-sankey@0.12.3` was already in the
  lockfile through Mermaid, so depending on it adds no new code; Mermaid's own sankey would load its large chunk, take
  Mermaid's colours and lose hover.
- _Rejected: C4 and mind maps through Mermaid_. Mermaid's C4 layout is experimental and places elements poorly; both fit
  the dagre and tree layouts the page already owns, and stay commentable and themed.
- _Rejected: `openspec show --json` for the rendered view_. It has no requirement or scenario names.

### 12. The server, not the agent, validates and gates Phase 4

On `proposal.ready` and on the page's Re-run, the server runs `openspec validate <id> --strict --json` in the repo
root, stores the result, unlocks the review (accept and request changes) on a pass, and appends a `validation.result`
event either way so the agent sees failures. The Proposal tab itself unlocks on submit: a file watcher on the change
folder drives its progress steps while the agent writes, then the live view of the files. Traceability arrives as
`proposal.trace` events (`requirement name -> question ids`) stored in state.

- _Rejected: trusting an agent-reported validation_. The gate would then be only as reliable as the agent's reading of
  CLI output.
- _Rejected: trace markers inside the spec files_. They would ship in the committed specs forever.

### 13. The page is private to its session

The HTTP server binds `127.0.0.1` only. Every URL carries a 256-bit random token in its path, and the server rejects
any request whose `Host` is not its own `127.0.0.1:<port>` (DNS rebinding) or whose `Origin`, when present, is not
its own origin (cross-site posts). No agent string is ever inserted as HTML. This matters because page events become
agent input: an unauthenticated local endpoint would let any web page inject instructions into the Claude Code
session.

- _Rejected: loopback binding alone_. Any page open in the browser can post to loopback.

### 14. The skill carries the loop; grill's rules move into it

`.agents/skills/planroom/SKILL.md` is model-invocable for any request to plan, scope, design or stress-test a feature
or change. It carries `grill`'s load-bearing rules (look facts up rather than asking, recommend an answer, stop when the
decisions that would change the design are resolved), the phase loop, the wait and channel handling, and how Phase 4
writes the change: `openspec instructions <artifact> --change <id>` per artifact, `openspec/config.yaml`'s rules, then
`proposal.ready`. `decompose` keeps its ticket format and reads the change instead of a plan file. The page opens with
the platform opener (`xdg-open`, `open` or `start`); failure is non-fatal because the URL is always returned.

- _Rejected: keeping `plan-feature` and pointing it at Planroom_. It would be a second planning entry point with a
  different output format, which the user chose to retire.

### 15. The interrogation is staged on the question record, not a second record type

The interrogation runs align, explore, deep dive, go ahead. Assumption cards, info cards and the directions question are more
input types on the question record (`assumption`, `info`, `directions`; an info card takes no answer and the gates
skip it), and a question joins a direction through an optional
`direction` field naming an option of the directions question. They share the `Q-<n>` id space, so links, conflicts,
needs-review, comments and traces work unchanged. The stage is derived from `phases.phase1` (`aligned`,
`exploreSkipped`, `direction`) and the directions question's answer, never stored as its own field. The server
enforces the stage rules over each batch's end state, like block ownership: one directions question, only after the
goals are agreed; a question's direction must be offered, and a new one must be picked; completing names a direction
once any is investigated, and scopes the gate and the submit gate's questions to it.

On the page the stages are the phase tabs, not cards inside a phase: align and explore are Phase 1, Interrogate, and
the deep dive and going ahead are Phase 2, Directions, which unlocks with the first direction tab and keeps its tabs in
a row under the top row. The split is the page's alone (`pagePhase` in `shared/derive.ts`): the agent's
`currentPhase`, the events and `planroom_state` keep one interrogate phase, so the contract is unchanged. The
Directions overview compares the directions and lists the shared questions still open, since going ahead needs them
resolved.

- _Rejected: stage cards and the direction tabs at the top of Phase 1_. Both scrolled away with the questions, and the
  direction tabs are what the user switches between while answering.
- _Rejected: separate assumption and direction records_. Each would need its own versions, review reset, anchors and
  page events for behaviour questions already have.
- _Rejected: a stage field on each question_. The group path already places a question in the page; the stage is a
  property of the session.

### 16. The page builds the decisions table; the agent never writes one

Every write-up had a hand-written "Decision | Choice | From" table restating the answers, which cost tokens and could
drift from them. The page derives it instead (`decisionRows` in `shared/derive.ts`): one row per answered question in
scope, in id order, named by the question's optional `topic` (else its title), with the answer in words, any note, a
status while the answer needs review or conflicts, and a link. It renders as a Decisions section after the agent's
sections, outside the revision log and the review gate, since it is the user's own record; `planroom_state` returns
the rows so the proposer carries them into `design.md`. A `topic` change alone never needs review.

- _Rejected: a `decisions` block the agent places_. It would still need the agent to remember it, and placement is not
  a decision worth asking for.
- _Rejected: deriving short names from question titles_. Titles are full questions or assumption statements; a few
  words from the agent when it asks are cheaper and better.

### 17. Columns are rows inside a section's block list

A section's `blocks` entry is a block id or a row of two or three ids, shown side by side in a CSS grid that stacks
below about 240 px a column. The row lives where the order already does, so the agent writes the layout once, and
`blockIdsOf` gives every other reader (listing checks, review reset, undo, history, gates) the flat list it had.
Persisted sections need no migration: a plain id list is still valid.

- _Rejected: a `width: "half"` on each block_. Pairing consecutive halves is implicit and breaks silently when one
  moves.
- _Rejected: a separate `columns` field naming ids already in `blocks`_. Two places to keep in step.

### 18. One top row beside a full-height rail

The navigator rail runs the page's full height under the brand and the change id, and one row beside it holds the phase
tabs, the status, settings and End session, which saves the 56 px top bar. The shell is a CSS grid whose `.body` is
`display: contents`, so each phase still renders its own rail and main column. The colour scheme and page width moved
into the Settings dialog so the row fits a 1280 px screen with the rail open. The tabs never shrink while the status
can, and a container query lets them shrink only in a row under 880 px: flexbox shrinks in 1/64 px steps, and any shrink
ellipsizes a subtitle sized to its own text.

- _Rejected: keeping the colour scheme and width selects in the row_. They pushed the phase subtitles into truncation
  on a laptop screen with the rail open.

### 19. A plan is an OpenSpec change or a Markdown plan, fixed when it is opened

Not every change earns an OpenSpec change, so `planroom_open` takes a `format`: `openspec` (the default) or
`markdown`, a plan at `agent-plans/<id>/<id>.md` in the layout `/decompose` already reads. The format is stored in
`state.json` (a file without it reads as `openspec`) and decides the plan's folder, so it is fixed once the plan exists:
a Markdown plan keeps its whole session in `agent-plans/<id>/.planroom/`, scaffolds nothing under `openspec/`, and
resumes there when opened without a format. Opening it in the other format, or an id with a plan in both folders, is
refused. Phases 1 to 3 are the same. On `proposal.ready` the server checks that `<id>.md` exists and is not empty in
place of `openspec validate`, behind the same validation record and accept gate, and the proposer writes the plan from
a template in its agent file. The page words the submit dialog, progress and review for the format, and drops the
requirement, task and trace counts a Markdown plan does not have.

- _Rejected: choosing the format at submit_. The session already lives in its folder by then, and a plan left in
  `openspec/changes/` with no proposal fails `openspec validate --all` and shows in `openspec list`.
- _Rejected: a format-neutral `.planroom/<id>/` at the repo root_. Decision 7's reasons hold, and every existing plan
  would have to move.
- _Rejected: checking the Markdown plan's headings_. `/decompose` reads the plan whole, so any check stricter than
  "written" would only reject plans it can use.

### 20. Planroom is its own package with a `planroom` command (supersedes decision 1's launcher)

Planroom moved out of scopious-platform's `tools/planroom` into its own repo, published privately to GitHub Packages as
`@moseswescombe/planroom` from `v*` tags. `src/cli.ts` is the `planroom` command: `mcp` is decision 1's stdio server,
`open [change-id]` the standalone plan browser, `list` the plans of every repo in the registry, and `install` links
`skill/` and `agents/` into `~/.claude` and registers a user-scope `planroom` MCP server running `<node> dist/cli.js mcp`
with absolute paths. Vite bundles the command, server and all, into one `dist/cli.js` beside `dist/ui`, so the package
installs no dependencies. Decision 1's process model is unchanged; only its launcher and the repo-root `.mcp.json` entry
are gone.

- _Rejected: the `npx skills` installer for the skill_. It installs skill folders only, not the subagents or the MCP
  server, and fetches the skill from the repo's latest commit rather than the installed version, so the three drift.
- _Rejected: a Claude Code plugin_. It gives no shell command, needs the built files committed, and renames the MCP
  tools the agent files name.
- _Rejected: installing from git_. Every install would download the build toolchain and build without the lockfile.

## Risks / Trade-offs

- [Channels are research preview and org-gated; Scopious's claude.ai org may not have `channelsEnabled`] → Long-poll is
  the baseline that always works; channel push is additive and its absence only shows as "offline" while the agent is
  not waiting.
- [Claude Code does not register a channel server that negotiates MCP protocol revision 2026-07-28 when
  `MCP_PROTOCOL_NEGOTIATION=auto`] → Pin the SDK version and verify registration as a task; long-poll is unaffected.
- [Auto-backgrounding changes how a parked `planroom_wait` behaves after two minutes] → Verify on 2.1.283 as a task and
  set the default timeout from what is observed; correctness does not depend on it because delivery is by cursor.
- [The server needs a build before Claude Code can start it] → `planroom_open` never runs without a build, so the
  failure shows as a failed `planroom` server in `/mcp`; the skill names `pnpm build:tools` as the fix, and the
  workspace builds under the existing `pnpm build`.
- [An in-progress Planroom change fails `openspec validate --all --strict` until its proposal exists] → Accurate while
  planning; noted in the skill so a failing in-flight change is not "fixed" by hand.
- [`.planroom/` inside the change folder might trip OpenSpec validation or archiving] → Verified on 1.13.1:
  `validate --strict` and `show` ignore it, even a stray `spec.md` inside it, and `archive` moves it along into
  `changes/archive/<date>-<id>/`, so the gitignore globs use `openspec/changes/**/.planroom/`.
- [The handoff has light tokens only] → The dark palette is new design work, held to WCAG AA in both themes by a
  contrast check over the token pairs.
- [Repointing `decompose` strands any `agent-plans/<feature>/<feature>.md` that was never decomposed] → Tickets already
  written keep working, because `implement` is unchanged; an undecomposed plan file can be handed to Planroom as the
  opening context of a new session. Listed in the implementing PR's handoff.

## Migration Plan

1. Land `tools/planroom`, the `.mcp.json` entry and the `planroom` skill together; `plan-feature` and `grill` remain
   until Planroom has planned one real change end to end.
2. Remove `plan-feature` and `grill` and repoint `decompose` in the same PR as that first real use, so the repo never
   has no planning path.
3. Rollback: revert the PR. The skill and the two subagents are plain files, the `.claude/agents` symlink and its
   `.gitignore` line go with the revert, the `.mcp.json` entry is one key, and change folders written by Planroom stay
   valid OpenSpec changes without it.

## Open Questions

- The dark palette's exact values. Design work inside the tasks; it cannot change the specs.
- Whether Scopious's claude.ai org has `channelsEnabled`. It decides whether the push path is usable here, not whether
  it is built.
- No Jira ticket is linked yet. Add the key here once one exists.
