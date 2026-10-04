# Planroom

A live browser planning page for Claude Code. Claude grills you through question cards, turns the answers into a
visual write-up, and proposes the result as a strictly validated OpenSpec change or a Markdown plan.

One package holds the `planroom` command, the MCP server, the page, the `planroom` skill and its two subagents.

## Install

Needs Node 22.18 or newer and Claude Code. The package is private on GitHub Packages, so each machine needs a classic
GitHub token with only the `read:packages` scope (GitHub Packages accepts only classic tokens):

```sh
cat >> ~/.npmrc <<'EOF'
@moseswescombe:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=<classic token, read:packages>
EOF
npm i -g @moseswescombe/planroom
planroom install
```

`planroom install` links the skill and agents into `~/.claude` (or `$CLAUDE_CONFIG_DIR`) and registers a user-scope
`planroom` MCP server. OpenSpec-format plans also need the OpenSpec CLI, pinned in the repo or from
`npm i -g @fission-ai/openspec`.

Upgrade with `npm i -g @moseswescombe/planroom@latest`, then reconnect `planroom` in `/mcp` in any running session. The
skill and agents are links into the package, so they upgrade with it. After switching your default Node version, run
`planroom install` again: it records absolute paths.

## Use

In Claude Code, ask it to plan something ("plan adding rate limiting") in a repo with an `openspec/` directory.

| Command                          | Does                                                         |
| -------------------------------- | ------------------------------------------------------------ |
| `planroom open [change-id]`      | Open this repo's plans read-only in the browser, or one plan |
| `planroom list`                  | List the plans in every repo Planroom has run in             |
| `planroom install` / `uninstall` | Wire Planroom into Claude Code, or remove it                 |
| `planroom mcp [--dir <path>]`    | The MCP server Claude Code starts; not run by hand           |

## Develop

```sh
pnpm install
pnpm build
pnpm link --global   # the global `planroom` now runs this checkout
planroom install     # links ~/.claude at this checkout's skill/ and agents/
```

Rebuild, then reconnect `planroom` in `/mcp` to pick up changes. See `AGENTS.md` for the rules and checks.

## Release

Bump `version` in `package.json`, commit, and push a matching `v<version>` tag. CI checks, builds and publishes it.
