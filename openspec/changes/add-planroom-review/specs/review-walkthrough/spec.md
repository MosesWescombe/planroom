# Spec Delta

## Purpose

The Walkthrough tab of a review: a cohesive deck of slides the agent builds privately and publishes at once, how the reviewer reads it, how its pictures are drawn and how it is exported.

## ADDED Requirements

### Requirement: Slides are staged and published in two parts

The agent SHALL send each slide with `slide.upsert { id, chapter, order, title, blocks }` after the blocks it lists. Slides SHALL stay staged and invisible on the page until the agent publishes their part. The first `deck.publish` SHALL release Why, How it works and What it might impact at once. Trade-offs SHALL stay staged until the reviewer has sent their concerns on the impact map or skipped the walkthrough, and a second `deck.publish` SHALL then release it. A published part MUST NOT change within the same round.

#### Scenario: Staged slides are not shown

- **WHEN** the agent has upserted nine of twelve slides
- **THEN** the Walkthrough tab shows no slide

#### Scenario: Publishing the first part

- **WHEN** the agent sends `deck.publish` with Why, How it works and What it might impact staged
- **THEN** those slides appear together, the review enters the walkthrough stage, and Trade-offs holds its place in the deck

#### Scenario: Trade-offs before the reviewer's concerns

- **WHEN** the agent sends `deck.publish` a second time before the reviewer sent their concerns or skipped
- **THEN** the call is refused and Trade-offs stays staged

#### Scenario: Edit after publishing

- **WHEN** the agent sends `slide.upsert` for a How it works slide after the first part was published
- **THEN** the call is refused and the deck is unchanged

### Requirement: Progress is shown while the deck builds

While slides are staged, the Walkthrough tab SHALL show an animated loading bar, what the agent and its subagents are doing, the number of slides drafted of those planned, the number of illustrations drawn and the review's progress.

#### Scenario: Building

- **WHEN** nine slides are planned, five are drafted, two of four illustrations are drawn and the agent is writing slides
- **THEN** the tab shows the loading bar, "Writing slides", "5 of 9 slides drafted", "2 of 4 pictures drawn" and the review's progress, and no slide

### Requirement: Every deck follows the same four chapters

A deck SHALL be organised into the chapters Why, How it works, What it might impact and Trade-offs, in that order, sized to the change at about 6 to 15 slides. For a large diff the agent SHALL keep that size and group slides by area.

#### Scenario: Chapter order

- **WHEN** a deck is published
- **THEN** its slides are ordered by chapter as Why, How it works, What it might impact, Trade-offs, and each chapter has at least one slide

#### Scenario: Large PR

- **WHEN** a PR changes 140 files
- **THEN** the deck still has about 6 to 15 slides, grouped by area, and no hard size limit stops the review

### Requirement: What it might impact maps the change's spread and takes the reviewer's concerns

What it might impact SHALL be one slide holding one impact map: 2 to 8 areas the change might reach beyond its diff, drawn around it, each with a line on how the change reaches it and up to four blocks that explain it, such as diagrams, step-throughs and interactive visuals. Opening an area SHALL show its explanation and a box for the reviewer's questions and concerns under it. The reviewer SHALL be able to add areas of their own. Their concerns SHALL be saved as they write them, and moving on from the slide, or skipping the walkthrough, SHALL send them all to the agent once, after which they are read-only. The first part MUST NOT publish without a valid impact map whose blocks were all sent.

#### Scenario: Opening an area

- **WHEN** the reviewer clicks the Billing exports area on the map
- **THEN** a panel below the map shows how the change reaches billing, its flow diagram and the reviewer's concerns under it

#### Scenario: Adding concerns and an area

- **WHEN** the reviewer adds "Does the export retry on its own?" under Billing exports and adds an area "Search indexing" with one concern
- **THEN** both are saved, the map shows Search indexing beside the agent's areas, and each area shows how many concerns it has

#### Scenario: Moving on sends the concerns

- **WHEN** the reviewer moves on from the impact map slide
- **THEN** the agent receives one `impact.send` event with every area, the agent's and the reviewer's, and the concerns under each, and the map becomes read-only

#### Scenario: No impact map

- **WHEN** the agent sends the first `deck.publish` with no impact map on What it might impact, or one naming a block that was never sent
- **THEN** the call is refused naming what is missing

### Requirement: Trade-offs answers the reviewer's concerns

Once the reviewer sends their concerns, the agent SHALL investigate each area and each concern and write Trade-offs: its own trade-offs alongside every concern, answered with what it found, its evidence and whether the concern holds. A concern that holds as a real problem SHALL also become a finding. While Trade-offs is being written, its place in the deck SHALL show the loading bar and what the agent is doing, and the deck SHALL move on to Trade-offs when it is published. Finishing the walkthrough SHALL wait for Trade-offs; skipping SHALL unlock the findings at once while Trade-offs is still written.

#### Scenario: Waiting for Trade-offs

- **WHEN** the reviewer moves on from the impact map and the agent is investigating
- **THEN** Trade-offs' place shows the loading bar and the agent's live status, and the Walkthrough tab says the agent is writing Trade-offs

#### Scenario: Concerns answered

- **WHEN** the agent publishes Trade-offs
- **THEN** the reviewer's view moves to its first slide, which answers each of their concerns under its area beside the agent's own trade-offs

#### Scenario: A concern holds

- **WHEN** the investigation shows the billing export does retry and doubles the load
- **THEN** Trade-offs says so with its evidence and the problem is also a finding the reviewer can react to

#### Scenario: Skip before Trade-offs

- **WHEN** the reviewer skips to the findings while Trade-offs is still being written
- **THEN** their concerns are sent, the findings unlock at once, and Trade-offs appears in the walkthrough when the agent publishes it

### Requirement: A slide is a titled set of blocks

A slide SHALL be a title and a list of blocks in the same layout as a write-up section, where an entry is a block id or a row of two or three ids shown side by side. A slide MAY use any block of the catalog, including `analogy`, `stepThrough`, `compare`, `image` and `code`.

#### Scenario: Side by side

- **WHEN** a slide lists `["intro", ["before", "after"]]`
- **THEN** the intro shows above the two blocks, which sit side by side

#### Scenario: Unknown block id

- **WHEN** a slide lists a block id the agent has not sent
- **THEN** the `slide.upsert` is refused with the path of that entry

### Requirement: One slide at a time with an overview

The page SHALL show one slide at a time at full width. The arrow keys and a chapter progress bar SHALL move between slides, and an overview grid SHALL show every slide for jumping to one. When a slide has a step-through, the arrow keys SHALL advance its steps before they move to the next slide.

#### Scenario: Keys

- **WHEN** the reviewer presses the right arrow on a slide with no step-through
- **THEN** the next slide shows

#### Scenario: Step-through takes keys first

- **WHEN** the reviewer presses the right arrow on a slide whose step-through is on step 2 of 5
- **THEN** the step-through moves to step 3 and the slide stays

#### Scenario: Overview

- **WHEN** the reviewer opens the overview and clicks slide 9
- **THEN** slide 9 shows at full width

### Requirement: Illustrations are agent-drawn SVG

The main agent SHALL write a brief for each illustration, and the `planroom-illustrator` subagent SHALL draw it as SVG into the review's `assets/` folder, where an `image` block shows it with pins. No image service MUST be called and no code or diff leaves the machine for it. SVG animation by SMIL or CSS SHALL play, scripts inside an SVG MUST NOT run, and every illustration SHALL have alt text.

#### Scenario: Drawing an illustration

- **WHEN** the agent briefs an analogy illustration
- **THEN** the illustrator writes `assets/<name>.svg` and an `image` block shows it, with no network request to an image service

#### Scenario: Script in an SVG

- **WHEN** an SVG asset contains a `<script>` element
- **THEN** the script does not run

#### Scenario: Missing alt text

- **WHEN** an `image` block for an illustration has no alt text
- **THEN** the block is refused naming the missing alt text

### Requirement: Motion respects reduced motion

Slide changes SHALL use CSS transitions and the View Transitions API and step-through state, with no animation library. Under `prefers-reduced-motion` all of it SHALL stop, a step-through SHALL show every step at once, and SVG animation SHALL stop.

#### Scenario: Reduced motion

- **WHEN** the reviewer's system sets `prefers-reduced-motion` and a slide with a five-step step-through opens
- **THEN** all five steps show at once, slide changes do not animate and animated SVGs are still

### Requirement: The walkthrough can be shared as an export

The Walkthrough tab SHALL export as a paged PDF with one slide per page and as a single HTML file with illustrations inlined. A step-through SHALL appear in its final state and your-take cards SHALL appear as answered. The plan and ask exports MUST be unchanged.

#### Scenario: PDF

- **WHEN** the reviewer exports a 10-slide walkthrough as PDF
- **THEN** the file has 10 pages, one per slide, with each step-through in its final state and each take as answered

#### Scenario: HTML

- **WHEN** the reviewer exports the walkthrough as HTML
- **THEN** one file opens offline with every slide and its illustrations inlined
