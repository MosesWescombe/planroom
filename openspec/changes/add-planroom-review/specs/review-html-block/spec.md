# Spec Delta

## Purpose

An `html` block for the rare interactive visual that no block or SVG can show, run in a sandbox that cannot reach the page or the network.

## ADDED Requirements

### Requirement: The html block is sandboxed

An `html` block SHALL take a title, an alt description, a height and a string of HTML with its CSS and script inline, treated as the body of a document the page builds. The page SHALL show it in an `iframe` with `sandbox="allow-scripts"`, so it has an opaque origin with no access to the page, its storage or its cookies, and no top navigation, popups or forms. Because a `srcdoc` frame inherits the page's own `script-src 'self'`, the live page SHALL load the document from the page server, which serves it under the block's policy as a header with `sandbox allow-scripts`. Script SHALL run.

#### Scenario: Script runs

- **WHEN** an `html` block's script updates a slider's label
- **THEN** the label updates in the frame

#### Scenario: No page access

- **WHEN** the block's script reads `window.parent.document` or `localStorage`
- **THEN** the access is refused and the page is unchanged

### Requirement: The html block cannot use the network

The page SHALL write a CSP meta tag as the first element of the document's head, ahead of the agent's HTML, with `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:` and no `connect-src`. The tag SHALL be part of the document wherever it is loaded from, the served frame or an exported `srcdoc`.

#### Scenario: Fetch blocked

- **WHEN** the block's script calls `fetch('https://example.com')`
- **THEN** the request is blocked and nothing is sent

#### Scenario: Agent cannot loosen the policy

- **WHEN** the agent's HTML includes its own CSP meta tag that allows `connect-src *`
- **THEN** the page's earlier tag still applies and the request is blocked

### Requirement: A frame that navigates away is reloaded

CSP cannot stop a frame navigating itself, so the page SHALL reload the block's document if the frame ever loads anything else. The skill SHALL forbid links in the block.

#### Scenario: Self-navigation

- **WHEN** the block's script sets `location` to another URL
- **THEN** the page reloads the block's own document

### Requirement: The html block is for interactive visuals only

The skill SHALL allow an `html` block only for an interactive visual no other block or SVG can show, such as a slider, a simulation or a playable state. The page SHALL label each one "interactive, sandboxed". As the only block of a slide it SHALL fill the slide, and it MAY also sit among other blocks. An `html` block SHALL be accepted only in a review session.

#### Scenario: Label

- **WHEN** a slide shows an `html` block
- **THEN** it is labelled "interactive, sandboxed"

#### Scenario: Fills the slide

- **WHEN** an `html` block is the only block of a slide
- **THEN** it fills the slide

#### Scenario: Refused outside a review

- **WHEN** the agent sends an `html` block in a planning session
- **THEN** the batch is refused naming the block type and the session kind

### Requirement: Exports keep the html block live under the same sandbox

The HTML export SHALL keep an `html` block live under the same sandbox, with its CSP tag inside the `srcdoc`, and the PDF SHALL print its current frame.

#### Scenario: HTML export

- **WHEN** the walkthrough with an `html` block is exported as HTML and opened offline
- **THEN** the block runs its script and still cannot make a network request

#### Scenario: PDF export

- **WHEN** the reviewer sets a slider and exports the PDF
- **THEN** the page prints the frame as it currently looks
