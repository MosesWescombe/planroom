# AGENTS.md

Guidance for coding agents working on Planroom.

## Goal

Make minimal, correct, reviewable changes that match the existing patterns. Note design improvements you find, but do
not implement them unless asked.

## Layout

- `src/server`: the MCP server, the page server and everything they run. `src/cli.ts` is the `planroom` command.
- `src/shared`: the zod contract the server and the page share.
- `src/ui`: the React 19 page, built by Vite into `dist/ui`.
- `skill/`, `agents/`: the planroom skill and its two subagents, shipped in the package and linked into `~/.claude` by
  `planroom install`. `skill/references/blocks.md` is generated: run `pnpm generate:blocks-doc`, never edit it.
- `openspec/`: this repo's own OpenSpec changes. The CLI is a pinned devDependency, so run it as `pnpm exec openspec`.

## Rules

- Do not use em dashes.
- Prefer lodash and the standard library over new dependencies; ask before adding one.
- Document methods and classes with concise JSDoc.
- Mark a deliberate shortcut with a known ceiling with a `ponytail:` comment naming the ceiling and the upgrade path.
- Biome formats and lints; `pnpm format` applies its fixes and `pnpm lint` checks them.
- Tests are Vitest, colocated as `*.test.ts(x)`; UI suites run in jsdom. Run one file with `pnpm test <path>`. Avoid
  casts in tests: prefer proper typing and injected fakes.

## Validation

1. `pnpm lint`
2. `pnpm typecheck`
3. `pnpm test`

`pnpm build` before checking anything in a browser or through `claude mcp`.
