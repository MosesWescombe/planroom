## Purpose

Lets the user comment on any text in any phase with a stated intent and have the agent answer or edit in place, with
anchors that stay attached while the content around them changes.

## ADDED Requirements

### Requirement: Any selected text can be commented on

Selecting text anywhere on the page, including prose, table cells, list items, diagram labels, question cards and the
rendered proposal, SHALL show a toolbar offering Comment, Ask to change and Wrong, also reachable with the `C` key. The
composer SHALL carry the chosen intent, and sending SHALL notify the agent with the comment, its intent and its anchor.

#### Scenario: Comment on a table cell

- **WHEN** the user selects "support can raise one key" and sends "Overrides need an owner and an expiry" as a change
- **THEN** the text is highlighted as commented and the agent receives the comment, the change intent and the anchor

#### Scenario: Keyboard

- **WHEN** the user selects text and presses `C`
- **THEN** the composer opens for that selection

### Requirement: Any write-up block can be commented on whole

Every block in the write-up SHALL offer a comment on the whole block, so images and diagrams with little or no text to
select can be commented on. The anchor SHALL name the block without a quote, and it MUST NOT detach when the block
changes. Every button that opens a comment, including "Ask to clarify" on a question and "Correct it" on an assumption,
SHALL anchor to its whole target the same way and MUST NOT highlight any text, while composing or after; only a comment
on selected text is highlighted.

#### Scenario: Comment on an image

- **WHEN** the user comments "Pin 2 is on the wrong field" on an image block
- **THEN** the agent receives the comment anchored to that block

#### Scenario: Correct an assumption

- **WHEN** the user clicks "Correct it" on an assumption and sends "Limits are per org"
- **THEN** the agent receives the comment anchored to that block without a quote, and none of its text is highlighted

### Requirement: Anchors survive rewrites

A comment anchor SHALL record its target, its character offsets and its quoted text with surrounding context. After the
target changes, the anchor SHALL re-attach to the same quote when it still exists in the target. When it does not, the
comment SHALL show as detached with its original quote and MUST NOT be dropped.

#### Scenario: Neighbouring text rewritten

- **WHEN** the agent rewrites the sentence before a commented phrase
- **THEN** the highlight stays on the same phrase

#### Scenario: Quoted text removed

- **WHEN** the agent removes the commented phrase entirely
- **THEN** the thread shows as detached with its original quote

### Requirement: The agent replies and says what it touched

The agent SHALL reply in the comment's thread, and a reply that edited content SHALL list each section or question it
changed. A reply MAY carry up to six blocks, such as a diagram or a table, rendered under its text and validated like a
question's context blocks. The agent SHALL be able to edit its own reply in place, so a block that failed is fixed
without a second reply. The user SHALL be able to reply and to resolve the thread; resolving SHALL remove its
highlight and notify the agent.

#### Scenario: Reply with edits

- **WHEN** the agent answers the override comment by editing §4 and adding a checklist item to §8
- **THEN** the reply lists "§4 edited" and "§8 1 item added", and both sections show as needing review

#### Scenario: Reply with a diagram

- **WHEN** the agent answers "How does the fallback work?" with a flow block in the reply
- **THEN** the thread shows the flow diagram under the reply text, with its full-screen action

#### Scenario: Fixing a reply's diagram in place

- **WHEN** a reply's flow block fails its schema and the agent re-sends it with `comment.edit` on that reply
- **THEN** the same reply shows the fixed diagram, and the thread gains no new message

### Requirement: A question card shows the comments on it

A question card SHALL list each comment thread anchored to it, open or resolved, as a row with what was asked and
whether the agent has replied. Opening a row SHALL show the whole thread in a dialog, with the agent's replies, their
blocks and a reply box. The list MUST NOT be part of the question's comment target, so it never shifts an anchor.

#### Scenario: Clarification on an answered question

- **WHEN** the user asks to clarify Q-3, answers it, and the agent then replies with a sequence diagram
- **THEN** the one-line Q-3 card lists the comment as replied to, with 1 figure, and opening it shows the reply and
  the diagram in a dialog

### Requirement: The user can message the agent directly

The side panel SHALL offer a message box that sends an unanchored message to the agent, with the agent's replies shown
in the same thread.

#### Scenario: Direct message

- **WHEN** the user sends "Keep the EU edge in mind throughout"
- **THEN** the agent receives the message and its reply appears under it in the panel

### Requirement: The user can paste images and long text into a message

A comment, a reply and a direct message SHALL accept pasted images and pasted text. A pasted image SHALL be saved under
the change's `.planroom/assets/` and sent to the agent with its path. Pasted text over the snippet threshold SHALL be
kept as a snippet rather than in the message text. Each image and snippet SHALL show in the thread as a button that
opens it in full in a modal, where a snippet that reads as code SHALL show in the code viewer and prose as plain text.

#### Scenario: Pasted stack trace

- **WHEN** the user pastes a 40-line stack trace into the message box and sends "Why does this fail?"
- **THEN** the agent receives the message with the trace as a snippet, and the thread shows a "Pasted text, 40 lines"
  button that opens the trace in a modal

#### Scenario: Pasted screenshot

- **WHEN** the user pastes a screenshot into a comment and sends it
- **THEN** the image is saved in the change's assets, the agent receives its path, and the thread shows its thumbnail
