## Why

Reviewing someone else's PR is mostly reading a diff cold. The reviewer rebuilds the author's intent from the code, misses what the change touches outside the diff, and types comments into Bitbucket with no help judging which concerns are real. Planroom already has the machinery for a rich, live browser surface driven by an agent (typed blocks, SSE, comment threads, export) and planroom-ask showed it can be reused as a second session kind. A third kind, for review, puts that machinery to work on the step that precedes every comment.

## What Changes

- Add **Planroom Review**, a third tool in the package beside planning and asks: a `planroom-review` skill, its own MCP server (`planroom mcp --review`) and its own page, registered by `planroom install`.
- Review a **Bitbucket Cloud PR** or a **local branch** (which posts nothing), reading code from a temporary git worktree at the PR's head so the reviewer's working copy is never touched.
- A **Walkthrough** tab: a cohesive deck (Why, How it works, What it might impact, Trade-offs; about 6 to 15 slides) built by the agent from catalog blocks and agent-drawn SVG illustrations, staged privately and published in two parts around the reviewer's concerns on an impact map of the change's spread, read one slide at a time with an overview grid, and exportable as a paged PDF or one HTML file.
- Add the `analogy`, `stepThrough` and `yourTake` blocks and widen `compare` to code and image sides. `analogy`, `stepThrough` and the wider `compare` join the shared catalog, so planning and asks get them too; `yourTake` and the `html` block are review-only.
- **Your-take** cards (predict then reveal, pros and cons, risk rating, understanding check) record the reviewer's own view before the agent's is shown. A Review section in Settings, saved per machine in `$XDG_CONFIG_HOME/planroom/review.json`, chooses which kinds the agent uses, how often, and which review views show.
- A **Review** tab, locked until the walkthrough is finished or skipped: parallel reviewer subagents by dimension plus a verify pass produce issues, design opinions and questions for the author, each agreed, reworded or rejected, shown on diagrams, beside the diff, in charts, a file heat map and a risk matrix.
- A **Comments** tab: a Bitbucket-faithful preview of inline comments and a drafted summary, agent drafts signed "- Claude" until the reviewer has rewritten most of them, per-comment tasks, and posting by the Planroom server as Bitbucket drafts (a spike confirms this; otherwise it publishes), with a head check first and no double-posting on retry.
- **Re-review rounds**: after the author pushes, a new round in the same review gets a delta deck, labels earlier comments addressed, partly, not or outdated, shows the author's replies, and drafts follow-ups and resolutions the reviewer confirms.
- A sandboxed, no-network `html` block as an escape hatch for interactive visuals.
- Add two subagents, `planroom-reviewer` and `planroom-illustrator`, both on the `sonnet` alias.

## Capabilities

### New Capabilities

- `review-sessions`: opening a review for a PR or branch, its worktree, its folder and the stages it moves through.
- `review-walkthrough`: the staged, published deck, its navigation, illustrations, progress view and export.
- `review-takes`: your-take cards and the per-machine review preferences that govern them.
- `review-findings`: the agent review, its gated reveal, the reviewer's reactions and the views that show findings.
- `review-comments`: the comment preview, the sign-off rule, summary, tasks and posting to Bitbucket.
- `review-rounds`: re-reviewing after the author pushes.
- `review-html-block`: the sandboxed interactive `html` block.
- `tool-installation`: how `planroom install` registers each tool's server, skill and agents.

### Modified Capabilities

- `plan-writeup`: the block catalog gains `analogy` and `stepThrough`, and `compare` takes code and image sides.
- `planning-sessions`: a session has a kind, and `review` joins `plan` and `ask`.

## Impact

- **`src/server`**: `mcp.ts`, `install.ts`, `session.ts`, `store.ts`, `agentApply.ts`, `pageApply.ts` and `http.ts` extended where they are keyed by session kind; new `bitbucket.ts`, `worktree.ts`, `posting.ts` and `preferences.ts`.
- **`src/shared`**: `state.ts`, `events.ts`, `view.ts`, `tools.ts`, `blocks.ts`, `blockCatalog.ts` and `blocksDoc.ts` extended; new `review.ts` for the derivation both the page preview and the server poster run.
- **`src/ui`**: new `review/` (Deck, Overview, ReviewTab, CommentsTab) and `blocks/review.tsx`; changes to the diagram renderers, `CodeViewer`, `Shell`, `PhaseTabs`, `Settings` and `exportHtml`.
- **`src/cli.ts`**: the `--review` flag.
- **`skills/` and `agents/`**: the `planroom-review` skill with a generated `references/blocks.md`, and the `planroom-reviewer` and `planroom-illustrator` agents; `README.md` gains a section.
- **External systems**: Bitbucket Cloud's REST API, with a `BITBUCKET_API_TOKEN` (scope `read:pullrequest:bitbucket`) and the git email; the reviewer's `$XDG_CONFIG_HOME`; `.planroom/reviews/<id>/` inside the checkout, already git-ignored.
- **Dependencies**: none added. The sign-off word diff uses the `diff` package that is already installed.
