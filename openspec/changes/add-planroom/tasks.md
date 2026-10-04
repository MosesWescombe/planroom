## 1. Prove the platform assumptions

- [ ] 1.1 Spike a minimal stdio server that declares `claude/channel`, register it as `planroom-spike` in a scratch `.mcp.json`, launch `claude --dangerously-load-development-channels server:planroom-spike`, and confirm a pushed notification reaches an idle session; record the working MCP SDK version and protocol revision (design decision 5, risk on 2026-07-28)
- [ ] 1.2 With the same spike, park a tool call for five minutes and record what auto-backgrounding at two minutes does to the pending call and the session; set `planroom_wait`'s default timeout from the result (design decision 5)
- [x] 1.3 Confirm the working directory Claude Code gives a project `.mcp.json` stdio server is the repo root, so `node tools/planroom/dist/server/main.js` resolves (design decision 1)
- [x] 1.4 Add a `.planroom/` folder with sample files to a throwaway change and confirm `openspec validate --strict`, `openspec show` and `openspec archive` all ignore it (design decision 7)

## 2. Workspace scaffold

- [x] 2.1 Create `tools/planroom` with `package.json` (`lint`, `typecheck`, `test`, `build`, `start`), `tsconfig` from `configs/typescript-config`, workspace ESLint and Prettier config, and verify `pnpm install` links it and `pnpm turbo build --filter=@scopious/planroom` produces `dist/server` and `dist/ui`
- [ ] 2.2 Add dependencies at the lockfile's existing versions (React 17 toolchain, `vitest`, `@testing-library/react`, `jsdom`, `express`, `dagre`, `react-markdown`, `diff`, `use-sync-external-store`, `zod` 4) plus `@modelcontextprotocol/sdk` at the version from 1.1 and `mermaid`, and verify `pnpm why` shows no second copy of React 17
- [x] 2.3 Gitignore `openspec/changes/*/.planroom/events.jsonl`, `revisions/` and `lock`, and verify with `git check-ignore` on sample paths

## 3. Shared schemas and derived logic

- [x] 3.1 Write zod schemas for the question record (four inputs, seven statuses, links, context blocks) and verify every handoff sample parses
- [x] 3.2 Write the 18 block config schemas as a discriminated union with the envelope, including cross-field rules (edges reference existing nodes, at most one recommended option), and verify each `handoff/designs/Blocks.dc.html` example parses and a broken variant of each fails with a field path
- [x] 3.3 Write both event unions (agent: design decision 2; page: answer, reopen, conflict resolve, suggest, comment, message, review, checklist tick, assumption confirm, fix request, undo, phase complete, submit, accept, request changes; server: `validation.result`, `edit.undone`) and verify round-trip tests
- [x] 3.4 Write the persisted state schema with a `schemaVersion`, and verify an old-version fixture is rejected with a clear message
- [x] 3.5 Implement the pure derivations - reviewed reset, phase gates, submit gate, Phase 1 completion, group progress - and verify each spec scenario that depends on them as a unit test

## 4. Sessions and persistence

- [x] 4.1 Implement open and resume: kebab-case check, `openspec new change` when absent, restore from `state.json` when present, and verify the planning-sessions scenarios against temp directories
- [x] 4.2 Implement temp-then-rename snapshot writes and the fsynced `events.jsonl` append, and verify a test that kills a child process mid-write always reloads a parseable before or after state
- [x] 4.3 Implement the `lock` file with pid liveness takeover, and verify the "already open" and "stale hold" scenarios
- [x] 4.4 Implement the write-up revision log (before/after per touched block, summary, time) and undo-as-revision with the superseded check, and verify the undo scenarios
- [x] 4.5 Implement the plan switcher (list plans, switch the page, refuse the agent's next write or wait until it reads the new plan) and Reopen for read-only plans (`session.reopen`), and verify the "Old plans can be reopened from the page" scenarios

- [x] 4.6 Add the plan format (`openspec` or `markdown`) to `planroom_open` and the persisted state, keep a Markdown plan in `agent-plans/<id>/` with no OpenSpec scaffold, check its `<id>.md` in place of `openspec validate`, list both folders in the plan switcher, and word the page, skill and proposer for it (design decision 19); verify the new-Markdown-plan, format-fixed, plan-file-missing, plan-written and plan-as-markdown scenarios

## 5. Agent-page sync

- [x] 5.1 Implement the batch apply: envelope validation that rejects the whole batch, per-block config errors that store and report, server-assigned versions with no-op detection, and the reviewed reset; verify the agent-page-sync scenarios
- [x] 5.2 Implement the event log with cursors, `planroom_wait` and the per-event delivery rule (pending wait first, channel push otherwise, channel confirmed once the cursor passes a pushed seq), and verify with a fake channel notifier that no event is delivered twice while a wait is pending
- [x] 5.3 Register the four MCP tools with schemas generated from `src/shared/` and the channel capability and `instructions`, and verify with the SDK's in-memory client transport
- [x] 5.4 Implement the HTTP server: `127.0.0.1` on an ephemeral port, token in the path, `Host` and `Origin` checks, static SPA, `POST` events acknowledged with `seq`, SSE snapshot then record upserts; verify the access-control scenarios with `fetch` against a real instance
- [x] 5.5 Open the page with the platform opener, and verify `planroom_open` still returns the URL when the opener is missing
- [x] 5.6 Hold quiet events (checklist ticks, assumption confirmations) so they never end a wait or push on their own, and push held ones just ahead of the next event that is not; verify the "Tick while waiting" and "Tick while idle with channels" scenarios

## 6. OpenSpec integration

- [x] 6.1 Run `openspec validate <id> --strict --json` on `proposal.ready` and on Re-run, store the result, unlock the Phase 4 review on a pass and append `validation.result` either way; verify with a valid and a deliberately broken fixture change
- [x] 6.2 Watch the change folder and push file-tree and content updates, and verify an edit on disk reaches a connected page without a reload
- [x] 6.3 Implement the spec delta reader, and verify it parses every spec in this change with the same requirement and scenario counts `openspec show add-planroom --json` reports
- [x] 6.4 Store `proposal.trace` and compute the traced-answers count, and verify the traceability scenario

## 7. App shell

- [x] 7.1 Implement the normalized store, the SSE client with reconnect-and-snapshot, and per-record subscriptions memoized on `version`; verify with a render-count test that one upsert re-renders one card
- [x] 7.2 Build the top bar, phase tabs with locked-state copy, and the four connection states; verify the "stream drops" scenario
- [x] 7.3 Build the collapsible side panel with its icon strip, remembered per browser; verify the collapse scenario
- [x] 7.4 Implement the handoff's light tokens and type, design the dark token set, add the light/dark/system switch, and verify a contrast check over every text/background token pair passes WCAG AA in both themes
- [x] 7.5 Implement the narrow layout below 960 px with drawers and 44 px targets, and verify at 390 px that nothing scrolls sideways
- [x] 7.6 Implement scroll anchoring with the measure-and-restore fallback, and verify the "content above the viewport grows" scenario

## 8. Phases 1 and 2 - Interrogate and Directions

- [x] 8.1 Build the question card for all four input types and all nine visual states in `handoff/designs/QuestionStates.dc.html`, and verify each state against the mockup
- [x] 8.2 Implement save versus local drafts, needs-review with "Still right", conflict resolution, reopen, and "Add a question"; verify the plan-interrogation scenarios
- [x] 8.3 Build the navigator with group progress, the understanding summary, and the Finish and Draft-with-assumptions bar; verify the Phase 1 completion scenarios
- [x] 8.4 Stage Phase 1 (align, explore, deep dive, go ahead): `stage.advance` from the agent and the page, assumption cards, the one directions question with a tab per direction, a Phase 1 tab per investigated direction with scoped progress, and going ahead with a direction; verify the stage, assumption, directions and completion scenarios
- [x] 8.5 Make Directions its own phase tab (Phase 2 of 4) with the direction tabs in a row under the top row and an overview comparing the directions, and put the phase tabs, status and settings in one top row beside a full-height rail headed by the brand and change id (design decisions 15 and 18); verify the directions-phase, unlock and top-row scenarios

## 9. Blocks

- [x] 9.1 Build the renderer registry with the error card ("Ask agent to fix"), the raw-config card, caption, refs, full-screen and whole-block comment; verify the invalid and unknown block scenarios
- [x] 9.2 Build `callout`, `checklist`, `table` (sortable, ref column), `stats`, `timeline`, `fileTree`, `code` and `image`, and verify each against `Blocks.dc.html`
- [x] 9.3 Build `flow`, `state` and `architecture` on `dagre`, `sequence` directly, and `compare` over any of them, in the handoff's diagram vocabulary; verify layouts for the catalog examples in both themes
- [x] 9.4 Build `bar`, `line`, `riskMatrix` and `optionMatrix` with the fixed per-theme palette, hover tooltips and "view as table"; verify against `Blocks.dc.html`
- [x] 9.5 Build the lazy `mermaid` block with `securityLevel: 'strict'`, and verify the bundle only loads it when such a block renders
- [x] 9.6 Build the code viewer (highlight.js via `lowlight`, indentation folding, copy) for `code` excerpts, diffs and snippets and for code pastes; verify folding, both diff sides and the syntax colours' contrast in both themes
- [x] 9.7 Build `schema` and `c4` on `dagre`, `mindmap` and `gantt` laid out directly, and `sankey` on `d3-sankey` (design decision 11); verify the schema, C4, mind map, gantt and sankey scenarios and each catalog example in both themes
- [x] 9.8 Draw graph edges as curves through dagre's points and fade all but a hovered node and its neighbours; verify the curved-edges and hover-highlight scenarios
- [x] 9.9 Rework `optionMatrix` to a column per option and a row per criterion with score, text and verdict cells, make `compare` labels optional, and steer comparisons to it in the catalog and skill; verify the option matrix scenario

## 10. Phase 3 - Write-up

- [x] 10.1 Build the write-up document with contents, section review ticks and "changed by agent" markers; verify the needs-review scenario
- [x] 10.2 Wire interactive checklists and assumption Confirm and Correct, and verify both notify the agent
- [x] 10.3 Build Undo edit and the revision history with block and word diffs, and verify the undo and diff scenarios
- [x] 10.4 Build the submit bar and the blocked and ready dialog states from `Submit.dc.html`, and the proposing progress (on the Proposal tab, which unlocks on submit) driven by the folder watcher; verify the submit gate and proposing scenarios

- [x] 10.5 Let a section's `blocks` hold rows of two or three ids shown side by side (design decision 17); verify the side-by-side-columns and missing-block-in-a-row scenarios, and undo restoring a row
- [x] 10.6 Derive the Decisions section from the answers, add the question `topic`, return the rows from `planroom_state`, and drop the agent's decisions table from the skill (design decision 16); verify the decisions-from-answers, no-answers and topic scenarios

## 11. Comments

- [x] 11.1 Build the selection toolbar (Comment, Ask to change, Wrong, `C` key) over every `data-anchor-target`, and the intent composer; verify on prose, a table cell, a diagram label and a question card
- [x] 11.2 Implement anchor capture and resolution (position, quote with context, quote alone, detached), and verify the rewrite and removal scenarios
- [x] 11.3 Build threads with agent replies that list what they touched, resolve, and the direct message box; verify the plan-comments scenarios
- [x] 11.4 Let agent replies carry blocks, and list a question's comments on its card, each opening its thread in a dialog; verify the reply-with-a-diagram and clarification-on-an-answered-question scenarios

## 12. Phase 4 - Proposal

- [x] 12.1 Build the file tree, rendered and raw markdown views, and spec deltas as requirements and scenarios from `Proposal.dc.html`; verify the live-update scenario
- [x] 12.2 Build trace links, the change-at-a-glance summary, and validation status with Re-run; verify the traceability and re-run scenarios
- [x] 12.3 Build Accept and Request changes with their gates, the read-only accepted state and the `/decompose <change-id>` next step; verify the accept scenarios

## 13. Claude Code integration

- [x] 13.1 Add the `planroom` stdio entry to the root `.mcp.json`, and verify `claude mcp get planroom` connects after `pnpm build:tools`
- [ ] 13.2 Write `.agents/skills/planroom/SKILL.md` (triggers, grill's rules, the phase loop, wait and channel handling, the Phase 4 `openspec instructions` flow, the channels launch command, no plan mode), and verify a fresh session asked to "plan X" invokes it
- [x] 13.3 Generate `.agents/skills/planroom/references/blocks.md` from the block schemas with a script, and verify a test fails when a schema changes without regenerating it

## 14. Retire plan-feature and grill

- [ ] 14.1 Repoint `.agents/skills/decompose/SKILL.md` to read `openspec/changes/<change-id>/` as well as a Markdown plan's `agent-plans/<change-id>/<change-id>.md`, keeping its ticket and INDEX format, and verify on the change from 15.2
- [ ] 14.2 Delete `.agents/skills/plan-feature` and `.agents/skills/grill`, remove every reference to them, and verify `pnpm check:agent-docs` passes and a grep for both names under `.agents` and `AGENTS.md` files is empty

## 15. Rollout

- [ ] 15.1 Ask a claude.ai Owner whether `channelsEnabled` is on for the Scopious org, and record the answer in design.md's Open Questions
- [ ] 15.2 Plan one real change end to end with Planroom, with channels on and off, and record what diverged from this design in this file
- [ ] 15.3 Tell the team the launch command for push mode and that `/plan-feature` and `/grill` are gone

## 16. Tests

- [x] 16.1 Vitest suites for `src/shared` (every schema, every derivation) and `src/server` (sessions, persistence, sync, delivery, HTTP access control, OpenSpec integration), each scenario in `specs/` traceable to at least one test name
    - Diverged: nine scenarios cannot be traced to a unit test, because what they check is the agent following the
      skill, or real layout, rather than code. `planning-workflow`'s "Plan a feature", "Plan as markdown", "Answer spawns
      a follow-up", "Submission" and "Proposal accepted" are the skill's phase loop, checked by 13.2 and 15.2; "Server not built" is
      the skill's stale-server guidance; "Decompose an accepted change", "Unknown change" and "Agent docs check" wait on
      14.1 and 14.2. `planning-workspace-ui`'s "Phone width" needs layout jsdom does not do, and was checked live under
      7.5. Every other scenario title appears in a test name.
- [x] 16.2 Testing Library suites for render isolation, drafts, anchors, the submit gate and each block's render and error states, in jsdom
- [x] 16.3 One end-to-end test that drives the MCP tools through the SDK's in-memory client while `fetch` posts page events to the real HTTP server, covering open, a question round trip, a comment round trip, submit, validation and accept

## 17. Verify

- [x] 17.1 Run `tools/planroom` lint, typecheck and test in the order `AGENTS.md` sets, and `pnpm check:agent-docs`
- [x] 17.2 Run `pnpm exec openspec validate add-planroom --strict` and confirm it passes
