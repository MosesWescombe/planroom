## Why

Planning in this repo happens in the terminal. `/grill` asks one question at a time in chat, `/plan-feature` folds the
answers into `agent-plans/<feature>/<feature>.md`, and `/decompose` slices that file into tickets. Nothing in that loop
is structured: an answer given twenty messages ago is only as findable as the scrollback, a decision the agent quietly
changes later is not flagged, a diagram is prose or ASCII, and the output is a free-form markdown file rather than the
OpenSpec change the repo now uses for non-trivial work. Reviewing a plan means reading a transcript.

The Planroom handoff (copied into this change as `handoff/`: `HANDOFF.md` plus eight screen mockups) designs a browser
surface for exactly this loop: the agent grills the user through typed question cards, turns the answers into a
write-up built from typed blocks, and proposes the result as an OpenSpec change, with every answer, comment and
review tick flowing live between the page and the agent. It leaves transport, hosting and launch open. This change
builds it as a tool Claude Code drives, and makes it the repo's planning path.

## What Changes

- Add `tools/planroom`, a new workspace that is both an MCP server (spawned by Claude Code over stdio) and a local
  web app (served on `127.0.0.1`). The agent writes to the page through typed MCP tools; the page's events reach the
  agent through a long-poll tool and, when the session was launched with channels enabled, as channel pushes.
- Implement the handoff's phases, with the interrogation split in two: **Interrogate** (question cards in four input
  types and nine states), **Directions** (a tab per direction the user picks to dig into, and going ahead with one),
  **Write-up** (the 18-type block catalog, rendered by the app from validated configs, never agent HTML) and
  **Proposal** (the change folder the agent wrote, rendered, validated with `openspec validate --strict`, with
  traceability back to question ids).
- Make agent edits apply directly: anything the user had answered or reviewed that the agent changes drops back to
  **Needs review**, a submit gate counts what is left, and a single Undo reverts the agent's last edit.
- Comment on any text in any phase; anchors survive the agent rewriting neighbouring content.
- Persist every session under `openspec/changes/<change-id>/.planroom/`, so a session resumes in a new Claude Code
  session and the planning record travels with the change.
- Let a plan become either an OpenSpec change or a Markdown plan at `agent-plans/<change-id>/<change-id>.md`, chosen
  when the plan is opened. A Markdown plan keeps its session in
  `agent-plans/<change-id>/.planroom/` and is checked for that file in place of `openspec validate`.
- Beyond the handoff: dark mode, a narrow single-column layout, and write-up revision history with diffs.
- Register the server in the root `.mcp.json` and add a model-invocable `planroom` skill, so Claude Code opens a
  Planroom session whenever it is asked to plan a feature or change.
- Planroom stops at an accepted proposal; implementation stays a separate, user-started step. Retiring a repo's
  `plan-feature` and `grill` skills and repointing its `decompose` belong to that repo's own change (design decision 20).

## Capabilities

### New Capabilities

- `planning-sessions`: opening, resuming, persisting and locking a planning session tied to one OpenSpec change,
  local-only access to it, and the phase gates that move it from Interrogate to Proposal.
- `agent-page-sync`: the contract between the agent and the page - typed, validated, versioned upserts from the agent,
  and an ordered, replayable event stream from the page, delivered by long-poll or channel push without loss or
  double handling.
- `plan-interrogation`: question records, their input types and states, answering, conflicts, closing and merging,
  and completing the interrogation across the Interrogate and Directions phases.
- `plan-writeup`: the typed block catalog and its rendering, assumptions, review ticks, undo, revision history, and
  the submit gate.
- `plan-comments`: commenting on any selected text with an intent, anchors that survive rewrites, and agent replies.
- `change-proposal-review`: turning a submitted write-up into a strictly validated OpenSpec change and reviewing it,
  up to accept or request changes.
- `planning-workspace-ui`: the app shell - per-record rendering that never disturbs scroll, focus or drafts,
  connection states, the collapsible side panel, dark mode and the narrow layout.
- `planning-workflow`: how Claude Code enters, runs and leaves a Planroom session, and how the repo's other planning
  skills hand off to and from it.

### Modified Capabilities

<!-- None: openspec/specs/ holds no baseline specs, so every requirement here is ADDED. -->

## Impact

- **tools/planroom**: new workspace - MCP server, HTTP/SSE server, shared zod schemas for questions, blocks, events and
  state, the React SPA, and its unit tests.
- **.mcp.json**: new `planroom` stdio server entry alongside `atlassian`.
- **.agents/skills/planroom**: new skill, plus a block-catalog reference the agent reads before emitting blocks.
- **.agents/agents**, **.claude/agents**: new `planroom-researcher` and `planroom-proposer` subagents, reached by
  Claude Code through a tracked `.claude/agents` symlink, as the skills are through `.claude/skills`.
- **.gitignore**: ignore `.planroom/events.jsonl`, `revisions/`, `lock` and in-flight temp files inside change
  folders, and un-ignore the `.claude/agents` symlink.
- **Dependencies**: adds `@modelcontextprotocol/sdk` (the MCP server, which brings `express` 5 alongside the repo's
  `express` 4), `mermaid` (lazy-loaded, for the `mermaid` fallback block only) and `lowlight` (code highlighting, with
  `highlight.js` under it). Everything else is already in the lockfile at the versions `packages/scopious-ui` and
  `web/*` use: `react` 17, `vite`, `vitest`, `@testing-library/react`, `jsdom`, `zod`, `express`, `dagre` and
  `react-markdown` as direct dependencies elsewhere, and `diff` and `use-sync-external-store` as transitive ones now
  declared directly.
