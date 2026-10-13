# Spec Delta

## Purpose

Your-take cards, which make the reviewer commit to their own view before the agent's is shown, and the per-machine preferences that choose which prompts and review views appear.

## ADDED Requirements

### Requirement: Your-take cards come in four kinds

A `yourTake` block SHALL be one of four kinds. Predict SHALL let the reviewer write or pick a guess before the slide explains it. Pros and cons SHALL let the reviewer list the pros and cons they see. Risk rating SHALL let the reviewer rate correctness, performance, security and maintainability from 1 to 5. Understanding check SHALL ask a multiple-choice question per chapter and keep no score.

#### Scenario: Risk rating

- **WHEN** the reviewer rates security 4 and correctness 2 on a risk-rating card
- **THEN** the card records the ratings for all four areas the reviewer set

#### Scenario: Understanding check

- **WHEN** the reviewer answers a multiple-choice question wrongly
- **THEN** the card says it was wrong and links to the slide that explains it, and no score is kept

### Requirement: The answer is logged before the agent's view is revealed

A your-take card SHALL log the reviewer's answer as a page event the agent receives, and only then reveal the agent's own view beside it. The agent's view SHALL be written when the slide is made and SHALL NOT be shown before the answer. Pros and cons SHALL highlight overlap and differences with the agent's list, and a risk rating SHALL show the agent's ratings on the same chart.

#### Scenario: Predict then reveal

- **WHEN** the reviewer submits a guess on a predict card
- **THEN** a page event with the guess reaches the agent, and the card then shows the slide's answer and explanation

#### Scenario: Nothing revealed first

- **WHEN** a your-take card has not been answered
- **THEN** the agent's view is not in the page's rendered content

#### Scenario: Pros and cons overlap

- **WHEN** the reviewer lists "adds a retry" and the agent lists the same pro and one other
- **THEN** both lists show side by side with the shared pro highlighted and the other marked as a difference

### Requirement: Your-take is refused outside a review

A `yourTake` block SHALL be accepted only in a review session. In a planning or ask session the call MUST be refused.

#### Scenario: Your-take in a plan

- **WHEN** the agent sends a `yourTake` block in a planning session
- **THEN** the batch is refused naming the block type and the session kind

### Requirement: Preferences are saved per machine and handed to the agent

A Review section in Settings, shown only on a review page, SHALL hold a toggle for each your-take kind, a prompt density of light, normal or heavy, the review strength, model and effort each round offers when the reviewer starts its review, and a toggle for each review view. Preferences SHALL be saved in `$XDG_CONFIG_HOME/planroom/review.json`, not in browser storage. `planroom_review` and `planroom_state` SHALL return them to the agent.

#### Scenario: Saved across sessions

- **WHEN** the reviewer turns off risk-rating prompts and opens a review in a new session
- **THEN** Settings shows risk rating off and `planroom_review` returns it as off

#### Scenario: Plan page has no Review section

- **WHEN** Settings is opened on a planning page
- **THEN** it has no Review section

#### Scenario: Only enabled kinds appear

- **WHEN** only predict and pros and cons are enabled
- **THEN** the deck the agent writes contains no risk-rating or understanding-check cards

### Requirement: Preference changes apply when they can

A change to the prompt preferences SHALL apply to slides the agent has not yet written. A change to the review agent preferences SHALL apply to the next round the reviewer starts. A change to a review view preference SHALL apply at once.

#### Scenario: Turning a view off

- **WHEN** the reviewer turns off the file heat map
- **THEN** the heat map disappears from the page immediately

#### Scenario: Turning a prompt kind off mid-build

- **WHEN** the reviewer turns off predict cards after eight slides are staged
- **THEN** the eight staged slides are unchanged and later slides contain no predict cards
