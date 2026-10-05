# planning-workspace-ui Specification

## Purpose
The app shell shared by every phase of a planning session: live updates that never disturb the user, honest
connection status, the collapsible side panel, and theming and layout that hold up in dark mode and on narrow screens.

## Requirements

### Requirement: Live updates never disturb the user

Applying an update SHALL re-render only the records whose version increased. It MUST NOT reload the page, move focus,
discard unsaved input in any record, or shift the content the user is looking at when something above it changes size.

#### Scenario: Typing while the agent edits another card

- **WHEN** the user is typing a note in Q-14 and the agent rewords Q-13
- **THEN** Q-13 updates and Q-14's text, caret and focus are unchanged

#### Scenario: Content above the viewport grows

- **WHEN** the agent adds a paragraph to a section above the one the user is reading
- **THEN** the section in view does not move

### Requirement: Connection status is always shown

The top bar SHALL show exactly one of: agent connected and live, agent editing a named target, agent working with what
it is on, reconnecting, or agent offline with the number of events queued. What the agent is on SHALL come from the
events its last wait returned, from the agent's own words when it says, or else from the phase. While the agent says
its subagents are running, it SHALL show as working on them, even with a wait parked, and SHALL NOT show as offline
for up to 30 minutes without a tool call; the side panel SHALL list what each subagent is doing. After a dropped
stream reconnects, the page SHALL catch up with no missed and no duplicated updates.

#### Scenario: Agent replying to a comment

- **WHEN** the agent's wait returns the user's new comment on §4
- **THEN** the bar shows "Agent replying to your comment on §4", and the comment's row shows it in place of "Waiting
  for the agent"

#### Scenario: Agent researching

- **WHEN** the agent sends `doing` "researching how alarms are indexed" and then reads the codebase
- **THEN** the bar shows "Agent researching how alarms are indexed" until the agent waits again

#### Scenario: Agent waiting on its subagents

- **WHEN** the agent says two subagents are running, one reading the billing service and one tracing alarm writes,
  and makes no tool call for ten minutes
- **THEN** the bar shows "Agent waiting on 2 subagents", not "Agent offline", and the side panel lists both tasks

#### Scenario: Stream drops

- **WHEN** the page's event stream drops for ten seconds while the agent upserts two questions
- **THEN** the bar shows "Reconnecting…", then both questions appear once each on reconnect

### Requirement: The side panel collapses

The activity and comments panel SHALL collapse to an icon strip showing activity with a live dot, the open comment
count and a message action, widening the main column. The collapsed state SHALL be remembered in that browser.

#### Scenario: Collapse

- **WHEN** the user collapses the panel and reloads
- **THEN** the panel is still collapsed and the main column is wider

### Requirement: The page layout is adjustable

On a wide screen the navigator rail SHALL collapse to a strip, and the rail and the side panel SHALL each resize by
dragging their inner edge or with the arrow keys on it, a double-click restoring the default. Settings SHALL offer a
narrow, normal or wide main column. Each choice SHALL be remembered in that browser.

#### Scenario: Adjust and reload

- **WHEN** the user collapses the navigator, drags the side panel wider, chooses the wide column and reloads
- **THEN** the navigator is still a strip, the panel keeps its width and the main column is still wide

### Requirement: One top row beside the rail

On a wide screen the navigator rail SHALL run the full height of the page with the Planroom brand and the change id
under it at its top, and one row beside it SHALL hold the four phase tabs, then the connection status, settings and End
session. The Directions tabs SHALL sit in a row under it while Directions is open. When the row is tight, the status
SHALL shorten before the phase tabs do. Below 960 pixels the phase tabs SHALL take a row of their own under the menu,
status and settings, and the change id SHALL show in the navigator drawer.

#### Scenario: Laptop width

- **WHEN** the page is 1280 pixels wide with the navigator open
- **THEN** one row shows Interrogate, Directions, Write-up and Proposal with their subtitles in full, then the status,
  and the brand with the change id under it heads the navigator

### Requirement: Dark mode

The page SHALL follow the operating system's colour scheme by default and offer a light, dark or system choice that is
remembered in that browser. Every block, diagram, chart and highlight SHALL keep at least WCAG AA text contrast in both
themes.

#### Scenario: Dark system preference

- **WHEN** the operating system prefers dark and the user has made no choice
- **THEN** the page renders in the dark theme, including diagrams and chart series

### Requirement: Narrow layout

Below 960 CSS pixels wide the page SHALL switch to a single column with the navigator and the side panel as drawers,
with no horizontal page scroll and touch targets of at least 44 pixels.

#### Scenario: Phone width

- **WHEN** the page is 390 pixels wide
- **THEN** question cards fill the width, the navigator and panel open as drawers, and nothing scrolls sideways
