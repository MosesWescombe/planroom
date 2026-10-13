# Spec Delta

## Purpose

How `planroom install` makes each Planroom tool available to Claude Code: one MCP server per tool, plus its skill and agents, and how uninstalling removes them.

## ADDED Requirements

### Requirement: Install registers one MCP server per tool

`planroom install` SHALL register one user-scope MCP server for each tool: `planroom` for planning, `planroom-ask` for asks and `planroom-review` for reviews. The review server SHALL run as `planroom mcp --review` and offer `planroom_review({ target, title? })` beside the shared emit, wait and state tools.

#### Scenario: Three servers

- **WHEN** the user runs `planroom install`
- **THEN** user-scope MCP servers `planroom`, `planroom-ask` and `planroom-review` are registered

#### Scenario: Review tools

- **WHEN** Claude Code starts the `planroom-review` server
- **THEN** it offers `planroom_review` and the shared emit, wait and state tools and no plan-only tools

### Requirement: Install links each tool's skill and agents

`planroom install` SHALL link the `planroom`, `planroom-ask` and `planroom-review` skills and the planning, review and illustration subagents (`planroom-researcher`, `planroom-proposer`, `planroom-reviewer` and `planroom-illustrator`) into the Claude config directory.

#### Scenario: Review skill and agents linked

- **WHEN** the user runs `planroom install`
- **THEN** `planroom-review` appears among the skills and `planroom-reviewer` and `planroom-illustrator` among the agents

### Requirement: Uninstall removes what install added

`planroom uninstall` SHALL remove the servers, skills and agents that install added, including the review ones, and leave anything else in the Claude config directory alone.

#### Scenario: Uninstall

- **WHEN** the user runs `planroom uninstall`
- **THEN** `planroom-review` and its skill and agents are gone and unrelated skills are untouched
