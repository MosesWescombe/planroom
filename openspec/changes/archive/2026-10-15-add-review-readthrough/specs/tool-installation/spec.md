# Spec Delta

## MODIFIED Requirements

### Requirement: Install links each tool's skill and agents

`planroom install` SHALL link the `planroom`, `planroom-ask` and `planroom-review` skills and the planning, review, illustration and page-writing subagents (`planroom-researcher`, `planroom-proposer`, `planroom-reviewer`, `planroom-illustrator` and `planroom-page-writer`) into the Claude config directory.

#### Scenario: Review skill and agents linked

- **WHEN** the user runs `planroom install`
- **THEN** `planroom-review` appears among the skills and `planroom-reviewer`, `planroom-illustrator` and `planroom-page-writer` among the agents
