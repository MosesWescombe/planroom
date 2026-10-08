import isEqual from 'lodash/isEqual.js';
import { z } from 'zod';
import {
    architectureConfig,
    checkBlockConfig,
    flowConfig,
    REVIEW_BLOCK_TYPES,
    sequenceConfig,
    stepThroughConfig,
    yourTakeConfig
} from '../shared/blocks.js';
import {
    directionsQuestion,
    investigatedDirections,
    listingProblems,
    sectionLabel,
    sectionOfBlock,
    unreview,
    upsertQuestion
} from '../shared/derive.js';
import { AGENT_EVENTS, type AgentEvent, agentEventTypes, emitBatch } from '../shared/events.js';
import { type Issue, toIssues } from '../shared/issues.js';
import { type ContextBlock, isInfo, type QuestionRecord } from '../shared/questions.js';
import { type BlockRecord, blockIdsOf, ownRecord, type ThreadRecord, type Touched } from '../shared/records.js';
import {
    CHAPTER_TITLES,
    CHAPTERS,
    currentRound,
    deckSlides,
    impactMapOf,
    type ReviewPreferences,
    type RoundRecord,
    type SlideContent,
    slideShown,
    TAKE_TITLES
} from '../shared/review.js';
import type { Revision } from '../shared/revisions.js';
import type { SessionKind } from '../shared/state.js';
import type { ActivityEntry } from '../shared/view.js';
import { blockContentOf, type Draft, RejectedError } from './draft.js';

/** What `planroom_emit` reports back to the agent. */
export interface BatchResult {
    applied: { index: number; type: string; ref: string; version?: number; changed: boolean }[];
    /**
     * Blocks stored with an invalid config or unknown type. They render as error cards until you re-send them: a
     * write-up block by its id, a question's context with `question.upsert`, a reply's with `comment.edit`.
     */
    blockProblems: { block: string; reason: 'invalid' | 'unknown-type'; issues: Issue[] }[];
    /** The write-up revision this batch recorded, when it changed the write-up. */
    revision?: number;
    /** Set when the batch ended with `proposal.ready`: validation is running and its result arrives as a `validation.result` event. */
    validating?: boolean;
}

const roughBatch = z.object({
    events: z.array(z.looseObject({ type: z.string() })).max(100),
    summary: z.string().optional()
});

/**
 * Parse a batch, rejecting it whole on any envelope problem: an unknown event type
 * is named with its index, and every other error carries its field path.
 */
export function parseBatch(input: unknown): z.infer<typeof emitBatch> {
    const rough = roughBatch.safeParse(input);
    if (!rough.success) throw new RejectedError(toIssues(rough.error), 400);
    const unknown = rough.data.events.flatMap((event, index) =>
        agentEventTypes.some((type) => type === event.type)
            ? []
            : [
                  {
                      path: `events[${index}].type`,
                      message: `unknown event type "${event.type}"; expected one of ${agentEventTypes.join(', ')}`
                  }
              ]
    );
    if (unknown.length) throw new RejectedError(unknown, 400);
    const full = emitBatch.safeParse(input);
    if (!full.success) throw new RejectedError(toIssues(full.error), 400);
    return full.data;
}

/** The feed entry for a question that landed. An info card asks nothing, so it is a plain change, unread until seen. */
function addedNote(record: QuestionRecord): Omit<ActivityEntry, 'id' | 'at'> {
    const note = { title: `Added ${record.id}`, detail: record.title, ref: record.id };
    return isInfo(record) ? note : { ...note, kind: 'question' };
}

/** Report inline blocks (a question's context, a reply's diagrams) whose config fails, as `label[index]`. */
function reportInlineProblems(result: BatchResult, label: string, blocks: ContextBlock[] | undefined): void {
    (blocks ?? []).forEach((block, index) => {
        const check = checkBlockConfig(block.type, block.config);
        if (!check.ok) result.blockProblems.push({ block: `${label}[${index}]`, reason: check.reason, issues: check.issues });
    });
}

/** How many items a checklist block holds; 0 for any other block, or none. */
function checklistLength(block: Pick<BlockRecord, 'type' | 'config'> | undefined | null): number {
    if (block?.type !== 'checklist') return 0;
    const items = block.config.items;
    return Array.isArray(items) ? items.length : 0;
}

/** What a batch changed in the write-up, in words, for replies that did not say. */
function describeTouched(draft: Draft, before: Record<string, BlockRecord>, questionsChanged: string[]): Touched[] {
    const bySection = new Map<string, string[]>();
    const add = (sectionId: string, note: string) => bySection.set(sectionId, [...(bySection.get(sectionId) ?? []), note]);
    for (const blockId of draft.changedBlocks()) {
        const section = sectionOfBlock(draft.state, blockId);
        if (!section) continue;
        const added = checklistLength(draft.state.blocks[blockId]) - checklistLength(before[blockId]);
        add(section.id, added > 0 ? `${added} item${added === 1 ? '' : 's'} added` : 'edited');
    }
    for (const sectionId of draft.changedSections()) if (!bySection.has(sectionId)) add(sectionId, 'edited');
    const sections = [...bySection.entries()].map(([id, notes]) => ({
        ref: `section:${id}`,
        note: `${sectionLabel(draft.state, id)} ${[...new Set(notes)].join(', ')}`
    }));
    return [...sections, ...questionsChanged.map((id) => ({ ref: id, note: `${id} updated` }))];
}

/** The label the top bar shows while the agent edits: the first thing this batch changed. */
export function editingLabel(draft: Draft, questionsChanged: string[]): string | undefined {
    const block = draft.changedBlocks()[0];
    const blockSection = block ? sectionOfBlock(draft.state, block) : undefined;
    if (blockSection) return sectionLabel(draft.state, blockSection.id);
    const section = draft.changedSections()[0];
    if (section) return sectionLabel(draft.state, section);
    return questionsChanged[0];
}

/**
 * The Phase 1 stage rules over a batch's end state: one directions question, asked only once the goals are agreed;
 * every question's direction is one of its options; and a new question joins only a direction the user chose to
 * investigate.
 */
function checkDirections(
    draft: Draft,
    before: Record<string, QuestionRecord>,
    questionEvents: Map<string, number>,
    fail: (index: number, path: string, message: string) => void,
    issues: Issue[]
): void {
    const questions = Object.values(draft.state.questions);
    const where = (id: string, path: string, message: string) => {
        const index = questionEvents.get(id);
        if (index === undefined) issues.push({ path: `question ${id}`, message });
        else fail(index, `.question${path}`, message);
    };
    const offered = questions.filter((question) => question.input === 'directions');
    offered
        .slice(1)
        .forEach((question) =>
            where(question.id, '.input', `${offered[0]!.id} already offers the directions; add or reword its options instead`)
        );
    const asking = offered.find((question) => !before[question.id]);
    if (asking && !draft.state.phases.phase1.aligned) {
        where(
            asking.id,
            '.input',
            'agree the goals before offering directions: emit stage.advance { to: "explore" } first, in this batch or an earlier one'
        );
    }
    const directions = offered[0];
    const options = new Set((directions?.options ?? []).map((option) => option.id));
    const investigated = new Set(investigatedDirections(draft.state));
    for (const question of questions) {
        if (question.direction === undefined) continue;
        if (!directions) where(question.id, '.direction', 'there are no directions yet; ask the directions question first');
        else if (!options.has(question.direction))
            where(question.id, '.direction', `${directions.id} has no direction "${question.direction}"`);
        else if (!before[question.id] && !investigated.has(question.direction))
            where(
                question.id,
                '.direction',
                `the user did not choose to investigate "${question.direction}"; ask about the directions they picked in ${directions.id}`
            );
    }
}

/** A session kind as a message names it. */
const KIND_NAMES: Record<SessionKind, string> = { plan: 'a plan', ask: 'an ask', review: 'a review' };

/**
 * Every block a batch sends, by where it sits: write-up and slide blocks, question context and options, reply blocks and
 * a finding's context.
 */
function sentBlocks(events: AgentEvent[]): { path: string; type: string; config: unknown }[] {
    const inline = (path: string, blocks: ContextBlock[] | undefined) =>
        (blocks ?? []).map((block, index) => ({ path: `${path}[${index}].type`, type: block.type, config: block.config }));
    return events.flatMap((event, index) => {
        const at = `events[${index}]`;
        switch (event.type) {
            case 'doc.block.upsert':
                return [{ path: `${at}.block.type`, type: event.block.type, config: event.block.config }];
            case 'question.upsert':
                return [
                    ...inline(`${at}.question.context.blocks`, event.question.context?.blocks),
                    ...(event.question.options ?? []).flatMap((option, position) =>
                        inline(`${at}.question.options[${position}].blocks`, option.blocks)
                    )
                ];
            case 'comment.reply':
            case 'comment.edit':
                return inline(`${at}.blocks`, event.blocks);
            case 'item.upsert':
                return inline(`${at}.item.blocks`, event.item.blocks);
            default:
                return [];
        }
    });
}

/**
 * Reject a batch the session's kind cannot take: an event of another kind, a review-only block outside a review, a
 * your-take card of a kind the reviewer turned off, and in an ask, a question that belongs to a direction.
 */
function checkKind(kind: SessionKind, events: AgentEvent[], preferences: ReviewPreferences | undefined): void {
    const allowed = AGENT_EVENTS[kind];
    const issues = events.flatMap((event, index): Issue[] => {
        if (!allowed.has(event.type)) {
            const owner = AGENT_EVENTS.plan.has(event.type) ? 'a plan' : 'a review';
            return [
                {
                    path: `events[${index}].type`,
                    message: `${KIND_NAMES[kind]} takes only ${[...allowed].join(', ')}; ${event.type} belongs to ${owner}`
                }
            ];
        }
        if (kind !== 'ask' || event.type !== 'question.upsert') return [];
        const { input, direction } = event.question;
        if (input === 'directions') return [{ path: `events[${index}].question.input`, message: 'an ask has no directions' }];
        if (direction !== undefined)
            return [{ path: `events[${index}].question.direction`, message: 'an ask has no directions' }];
        return [];
    });
    for (const block of sentBlocks(events)) {
        if (kind !== 'review' && REVIEW_BLOCK_TYPES.has(block.type))
            issues.push({ path: block.path, message: `a ${block.type} block belongs to a review; this is ${KIND_NAMES[kind]}` });
        if (kind === 'review' && block.type === 'yourTake' && preferences) {
            const takeKind = yourTakeConfig.safeParse(block.config).data?.kind;
            if (takeKind && !preferences.takes[takeKind])
                issues.push({
                    path: block.path,
                    message: `the reviewer turned ${TAKE_TITLES[takeKind].toLowerCase()} cards off; use only the kinds their preferences enable`
                });
        }
    }
    if (issues.length) throw new RejectedError(issues, 400);
}

/**
 * The ids of blocks on a published slide of any round, with the slide: each part of the deck is fixed once it is out,
 * the blocks that explain the impact map's areas with it.
 */
function publishedBlocks(draft: Draft): Map<string, string> {
    const owners = new Map<string, string>();
    for (const round of draft.state.review?.rounds ?? []) {
        for (const slide of deckSlides(draft.state, round.n))
            if (slideShown(slide, round)) for (const id of blockIdsOf(slide)) owners.set(id, slide.id);
        const map = round.publishedAt ? impactMapOf(draft.state, round.n) : undefined;
        for (const id of map?.areas.flatMap((area) => area.blocks) ?? []) owners.set(id, map!.slideId);
    }
    return owners;
}

/** Refuse publishing while a block on `slides` or behind the impact map does not render. */
function checkRenders(draft: Draft, blocks: { id: string; on: string }[], index: number, fail: Fail): void {
    for (const { id, on } of blocks)
        if (draft.state.blocks[id]?.problem)
            fail(index, '.type', `block "${id}" on ${on} does not render; fix it before publishing`);
}

/**
 * Publish the deck's first part, Why to What it might impact: every one of those chapters needs a slide, and What it
 * might impact the round's one impact map, every block its areas name sent. Trade-offs stays staged.
 */
function publishFirstPart(draft: Draft, round: RoundRecord, index: number, fail: Fail): void {
    const slides = deckSlides(draft.state, round.n).filter((slide) => slide.chapter !== 'tradeoffs');
    if (slides.length === 0) {
        fail(index, '.type', 'there is nothing to publish: stage the slides with slide.upsert first');
        return;
    }
    const empty = CHAPTERS.filter((name) => name !== 'tradeoffs' && !slides.some((slide) => slide.chapter === name));
    if (empty.length) {
        fail(index, '.type', `every chapter needs a slide; ${empty.map((name) => CHAPTER_TITLES[name]).join(', ')} has none`);
        return;
    }
    const maps = slides.flatMap((slide) =>
        blockIdsOf(slide)
            .filter((id) => draft.state.blocks[id]?.type === 'impactMap')
            .map((id) => ({ id, slide }))
    );
    const map = impactMapOf(draft.state, round.n);
    if (maps.length !== 1 || maps[0]!.slide.chapter !== 'touches' || !map) {
        fail(
            index,
            '.type',
            maps.length > 1
                ? `a deck has one impactMap; ${maps.map((entry) => entry.id).join(', ')} are on its slides`
                : `${CHAPTER_TITLES.touches} needs one valid impactMap block on its slide: the areas the change might reach`
        );
        return;
    }
    for (const area of map.areas)
        for (const id of area.blocks)
            if (!Object.hasOwn(draft.state.blocks, id))
                fail(index, '.type', `block "${id}" for the ${area.id} area has not been sent; send it with doc.block.upsert`);
    checkRenders(
        draft,
        [
            ...slides.flatMap((slide) => blockIdsOf(slide).map((id) => ({ id, on: `slide ${slide.id}` }))),
            ...map.areas.flatMap((area) => area.blocks.map((id) => ({ id, on: `the ${area.id} area` })))
        ],
        index,
        fail
    );
    draft.updateRound(round.n, (current) => ({ ...current, publishedAt: draft.now }));
    draft.note({
        title: 'Published the walkthrough',
        detail: `${slides.length} slides, up to ${CHAPTER_TITLES.touches}`,
        kind: 'question'
    });
}

/** Publish Trade-offs, once the reviewer has sent their concerns on the impact map or skipped the walkthrough. */
function publishTradeoffs(draft: Draft, round: RoundRecord, index: number, fail: Fail): void {
    if (!round.impact?.sentAt && !round.walkthrough) {
        fail(index, '.type', 'Trade-offs waits for the reviewer: publish it after their impact.send event');
        return;
    }
    const slides = deckSlides(draft.state, round.n).filter((slide) => slide.chapter === 'tradeoffs');
    if (slides.length === 0) {
        fail(index, '.type', 'stage the Trade-offs slides with slide.upsert first');
        return;
    }
    checkRenders(
        draft,
        slides.flatMap((slide) => blockIdsOf(slide).map((id) => ({ id, on: `slide ${slide.id}` }))),
        index,
        fail
    );
    draft.updateRound(round.n, (current) => ({ ...current, tradeoffsAt: draft.now }));
    draft.note({ title: 'Published Trade-offs', detail: `${slides.length} slides`, kind: 'question' });
}

/** Where this batch's review events sit, for problems found once the whole batch has applied. */
interface ReviewBatch {
    slideEvents: Map<string, number>;
    itemEvents: Map<string, number>;
}

type Fail = (index: number, path: string, message: string) => void;

/** The agent-owned fields of a slide, to tell a re-send from a change. */
function slideContentOf(slide: SlideContent): SlideContent {
    const { id, chapter, order, title, blocks } = slide;
    return { id, chapter, order, title, blocks };
}

/** Apply one review event: stage a slide, report progress, publish the deck, or write a finding, the summary or a label. */
function applyReviewEvent(
    draft: Draft,
    event: Extract<
        AgentEvent,
        {
            type:
                | 'slide.upsert'
                | 'deck.progress'
                | 'deck.publish'
                | 'item.upsert'
                | 'item.withdraw'
                | 'summary.draft'
                | 'earlier.label';
        }
    >,
    index: number,
    fail: Fail,
    result: BatchResult,
    batch: ReviewBatch
): void {
    const review = draft.state.review;
    if (!review) {
        fail(index, '.type', 'no review is open');
        return;
    }
    const round = currentRound(review);
    const now = draft.now;
    const applied = (ref: string, changed: boolean, version?: number) =>
        result.applied.push({ index, type: event.type, ref, ...(version !== undefined ? { version } : {}), changed });
    /** Whether the round is posted, refusing the event when it is: a posted round takes no more findings. */
    const posted = (): boolean => {
        if (round.postedAt) fail(index, '.type', `round ${round.n} is posted; it takes no more ${event.type}`);
        return Boolean(round.postedAt);
    };
    switch (event.type) {
        case 'slide.upsert': {
            const { slide } = event;
            const existing = draft.state.slides[slide.id];
            if (existing && existing.round !== round.n) {
                fail(
                    index,
                    '.slide.id',
                    `slide ${slide.id} belongs to round ${existing.round}, whose deck is fixed; give this round's slide a new id`
                );
                return;
            }
            if (round.tradeoffsAt) {
                fail(index, '.type', `round ${round.n}'s deck is published, so it is fixed for the round`);
                return;
            }
            if (round.publishedAt && (slide.chapter !== 'tradeoffs' || (existing && slideShown(existing, round)))) {
                fail(
                    index,
                    '.slide.chapter',
                    `round ${round.n}'s deck is published up to What it might impact; only Trade-offs slides can still be staged`
                );
                return;
            }
            batch.slideEvents.set(slide.id, index);
            const changed = !existing || !isEqual(slideContentOf(existing), slideContentOf(slide));
            if (changed) draft.putSlide({ ...slide, round: round.n, version: (existing?.version ?? 0) + 1, updatedAt: now });
            applied(slide.id, changed, draft.state.slides[slide.id]?.version);
            return;
        }
        case 'deck.progress': {
            const progress = {
                ...round.progress,
                ...(event.pictures ? { pictures: event.pictures } : {}),
                ...(event.review ? { review: event.review } : {}),
                ...(event.reviewed ? { reviewedAt: now } : {})
            };
            draft.updateRound(round.n, (current) => ({
                ...current,
                ...(event.outline ? { outline: event.outline } : {}),
                progress
            }));
            applied(`round ${round.n}`, true);
            return;
        }
        case 'deck.publish': {
            if (round.tradeoffsAt) {
                fail(index, '.type', `round ${round.n}'s deck is already published`);
                return;
            }
            if (round.publishedAt) publishTradeoffs(draft, round, index, fail);
            else publishFirstPart(draft, round, index, fail);
            applied(`round ${round.n}`, true);
            return;
        }
        case 'item.upsert': {
            const { item } = event;
            const existing = draft.state.items[item.id];
            if (posted()) return;
            if (existing && existing.round !== round.n) {
                fail(
                    index,
                    '.item.id',
                    `finding ${item.id} belongs to round ${existing.round}; give this round's finding a new id`
                );
                return;
            }
            const files = new Set(round.files.flatMap((file) => [file.path, ...(file.from ? [file.from] : [])]));
            if (item.anchor && !files.has(item.anchor.file)) {
                fail(index, '.item.anchor.file', `${item.anchor.file} is not in round ${round.n}'s diff`);
                return;
            }
            if (item.replyTo !== undefined && !Object.hasOwn(round.earlier, item.replyTo)) {
                fail(index, '.item.replyTo', `round ${round.n} has no earlier comment "${item.replyTo}"`);
                return;
            }
            batch.itemEvents.set(item.id, index);
            const content = JSON.parse(JSON.stringify(item));
            const {
                round: _round,
                version: _version,
                updatedAt: _at,
                withdrawn,
                ...before
            } = existing ?? {
                round: 0,
                version: 0,
                updatedAt: ''
            };
            const changed = !existing || Boolean(withdrawn) || !isEqual(before, content);
            if (changed) draft.putItem({ ...content, round: round.n, version: (existing?.version ?? 0) + 1, updatedAt: now });
            reportInlineProblems(result, `${item.id} blocks`, item.blocks);
            applied(item.id, changed, draft.state.items[item.id]?.version);
            return;
        }
        case 'item.withdraw': {
            const existing = ownRecord(draft.state.items, event.id);
            if (!existing || existing.round !== round.n) {
                fail(index, '.id', `round ${round.n} has no finding ${event.id}`);
                return;
            }
            if (draft.state.reactions[event.id]) {
                fail(index, '.id', `the reviewer already reacted to ${event.id}; reply in its thread instead`);
                return;
            }
            const changed = !existing.withdrawn;
            if (changed)
                draft.putItem({
                    ...existing,
                    withdrawn: { reason: event.reason, at: now },
                    version: existing.version + 1,
                    updatedAt: now
                });
            applied(event.id, changed, draft.state.items[event.id]?.version);
            return;
        }
        case 'summary.draft': {
            if (posted()) return;
            const changed = round.summary.draft !== event.text;
            if (changed)
                draft.updateRound(round.n, (current) => ({ ...current, summary: { ...current.summary, draft: event.text } }));
            applied('summary', changed);
            return;
        }
        case 'earlier.label': {
            const entry = ownRecord(round.earlier, event.key);
            if (!entry) {
                fail(index, '.key', `round ${round.n} has no earlier comment "${event.key}"`);
                return;
            }
            const next = {
                ...entry,
                label: event.label,
                ...(event.note ? { note: event.note } : {}),
                ...(event.code ? { code: event.code } : {})
            };
            const changed = !isEqual(next, entry);
            if (changed)
                draft.updateRound(round.n, (current) => ({ ...current, earlier: { ...current.earlier, [event.key]: next } }));
            applied(event.key, changed);
            return;
        }
    }
}

/** The node ids a finding can pin to on a diagram block: flow and architecture node ids, sequence actors. */
function diagramNodes(block: BlockRecord | undefined): string[] | undefined {
    const ids = (nodes: { id: string }[]) => nodes.map((node) => node.id);
    switch (block?.type) {
        case 'flow': {
            const config = flowConfig.safeParse(block.config).data;
            return config && ids(config.nodes);
        }
        case 'architecture': {
            const config = architectureConfig.safeParse(block.config).data;
            return config && ids(config.nodes);
        }
        case 'sequence':
            return sequenceConfig.safeParse(block.config).data?.actors;
        case 'stepThrough': {
            const diagram = stepThroughConfig.safeParse(block.config).data?.diagram;
            if (!diagram) return undefined;
            return diagram.type === 'flow' ? ids(diagram.config.nodes) : diagram.config.actors;
        }
        default:
            return undefined;
    }
}

/**
 * The review's integrity over the batch's end state: each block a changed slide lists exists and sits on one slide
 * once, and a finding pinned to a diagram names a node it has.
 */
function checkReviewIntegrity(draft: Draft, batch: ReviewBatch, fail: Fail): void {
    const owners = new Map<string, string>();
    for (const slide of Object.values(draft.state.slides))
        for (const id of blockIdsOf(slide)) if (!owners.has(id)) owners.set(id, slide.id);
    for (const [slideId, index] of batch.slideEvents) {
        const slide = draft.state.slides[slideId];
        if (!slide) continue;
        const seen = new Set<string>();
        slide.blocks.forEach((entry, position) => {
            const row =
                typeof entry === 'string'
                    ? [[entry, [position]] as const]
                    : entry.map((id, column) => [id, [position, column]] as const);
            for (const [blockId, at] of row) {
                const path = `.slide.blocks${at.map((step) => `[${step}]`).join('')}`;
                const owner = owners.get(blockId);
                if (!Object.hasOwn(draft.state.blocks, blockId))
                    fail(
                        index,
                        path,
                        `block "${blockId}" has not been sent; send it with doc.block.upsert in this batch or an earlier one`
                    );
                else if (seen.has(blockId)) fail(index, path, `block "${blockId}" is already listed on this slide`);
                else if (owner !== slideId) fail(index, path, `block "${blockId}" is already on slide ${owner}`);
                seen.add(blockId);
            }
        });
    }
    for (const [itemId, index] of batch.itemEvents) {
        const link = draft.state.items[itemId]?.diagram;
        if (!link) continue;
        const nodes = diagramNodes(draft.state.blocks[link.block]);
        if (!nodes)
            fail(
                index,
                '.item.diagram.block',
                `block "${link.block}" is not a flow, sequence, architecture or step-through diagram`
            );
        else if (!nodes.includes(link.node))
            fail(index, '.item.diagram.node', `diagram "${link.block}" has no node "${link.node}"`);
    }
}

/** The label the top bar shows while the agent edits a review. Findings stay unnamed until the reviewer reaches them. */
function reviewEditing(draft: Draft): string | undefined {
    const fields = new Set(draft.listPatches().map((patch) => patch.field));
    if (fields.has('slides') || fields.has('blocks')) return 'the deck';
    if (fields.has('items')) return 'the review';
    return undefined;
}

/**
 * Apply a parsed batch to a draft. Any problem other than a block's own config
 * (a missing target, a broken reference, a read-only session) throws, and the
 * session discards the draft, so nothing applies.
 */
export function applyAgentBatch(
    draft: Draft,
    events: AgentEvent[],
    summary: string | undefined,
    preferences?: ReviewPreferences
): { result: BatchResult; revision?: Revision; editing?: string; validate: boolean } {
    if (draft.state.phases.acceptedAt) {
        throw new RejectedError([
            {
                path: '',
                message: 'The proposal was accepted, so this session is read-only. Stop.'
            }
        ]);
    }
    if (draft.state.phases.ended) {
        throw new RejectedError([
            {
                path: '',
                message:
                    draft.state.kind === 'ask'
                        ? 'The user sent their answers, so this ask is read-only. Wait for the ask.done if you have not had it, then call planroom_ask with its id to ask more.'
                        : draft.state.kind === 'review'
                          ? 'The reviewer ended this review, so it is read-only. Stop; planroom_review with the same target reopens it.'
                          : `The user ${draft.state.phases.ended.how} this session, so it is read-only. Stop.`
            }
        ]);
    }
    checkKind(draft.state.kind, events, preferences);
    const now = draft.now;
    const result: BatchResult = { applied: [], blockProblems: [] };
    const issues: Issue[] = [];
    const fail = (index: number, path: string, message: string) => issues.push({ path: `events[${index}]${path}`, message });
    const blocksBefore = draft.state.blocks;
    const questionsChanged: string[] = [];
    const replies: { index: number; threadId: string; explicit: boolean }[] = [];
    const sectionEvents = new Map<string, number>();
    const questionEvents = new Map<string, number>();
    const questionsBefore = draft.state.questions;
    const slideEvents = new Map<string, number>();
    const itemEvents = new Map<string, number>();
    const fixed = publishedBlocks(draft);
    let validate = false;

    // Once the user finishes Phase 1, even mid-batch, the question set is closed: rejecting a new question is how
    // an agent that was still working learns it was interrupted.
    const phase1 = draft.state.phases.phase1;
    if (phase1.completed) {
        events.forEach((event, index) => {
            if (event.type === 'question.upsert' && !draft.state.questions[event.question.id])
                fail(
                    index,
                    '.question.id',
                    `the user finished Phase 1${phase1.path === 'assumptions' ? ' early' : ''}, so ${event.question.id} cannot be added. ` +
                        'Stop asking: call planroom_wait for the phase.complete event and write the write-up. Decline a question.suggest with suggestion.decline.'
                );
            if (event.type === 'stage.advance') fail(index, '.to', 'the user finished Phase 1; there is no stage to move to');
        });
    }

    events.forEach((event, index) => {
        switch (event.type) {
            case 'question.upsert': {
                const { question } = event;
                questionEvents.set(question.id, index);
                const existing = draft.state.questions[question.id];
                const { record, changed } = upsertQuestion(existing, question, now);
                if (changed) {
                    draft.putQuestion(record);
                    questionsChanged.push(question.id);
                    // A streamed question is logged once, when it lands; the live status covers the writing.
                    if (!existing) {
                        if (record.status !== 'streaming') draft.note(addedNote(record));
                    } else if (record.status === 'needs-review' && existing.status !== 'needs-review') {
                        draft.note({
                            title: `Reworded ${record.id}`,
                            detail: 'back to needs review',
                            ref: record.id,
                            kind: 'attention'
                        });
                    } else if (record.status === 'conflict' && existing.status !== 'conflict') {
                        draft.note({
                            title: `Flagged ${record.id}`,
                            detail: `conflicts with ${record.conflict?.with ?? 'another answer'}`,
                            ref: record.id,
                            kind: 'attention'
                        });
                    } else if (existing.status === 'streaming' && record.status !== 'streaming') {
                        draft.note(addedNote(record));
                    } else if (record.status !== 'streaming') {
                        draft.note({ title: `Updated ${record.id}`, ref: record.id });
                    }
                }
                reportInlineProblems(result, `${question.id} context.blocks`, question.context?.blocks);
                if (event.fromSuggestion !== undefined) {
                    const suggestion = ownRecord(draft.state.suggestions, event.fromSuggestion);
                    if (!suggestion) fail(index, '.fromSuggestion', `suggestion ${event.fromSuggestion} does not exist`);
                    else if (suggestion.status !== 'added' || suggestion.questionId !== question.id) {
                        draft.putSuggestion({
                            ...suggestion,
                            status: 'added',
                            questionId: question.id,
                            version: suggestion.version + 1
                        });
                    }
                }
                result.applied.push({ index, type: event.type, ref: question.id, version: record.version, changed });
                break;
            }
            case 'question.close':
            case 'question.merge': {
                const existing = draft.state.questions[event.id];
                if (!existing) {
                    fail(index, '.id', `question ${event.id} does not exist`);
                    break;
                }
                let next = { ...existing };
                if (event.type === 'question.close') {
                    next = { ...next, status: 'closed', closedReason: event.reason };
                    delete next.mergedInto;
                } else {
                    if (event.into === event.id) fail(index, '.into', 'a question cannot merge into itself');
                    else if (!draft.state.questions[event.into]) fail(index, '.into', `question ${event.into} does not exist`);
                    next = { ...next, status: 'merged', mergedInto: event.into, closedReason: event.reason ?? '' };
                }
                const changed =
                    next.status !== existing.status ||
                    next.closedReason !== existing.closedReason ||
                    next.mergedInto !== existing.mergedInto;
                if (changed) {
                    const record = { ...next, version: existing.version + 1, updatedAt: now };
                    draft.putQuestion(record);
                    questionsChanged.push(event.id);
                    draft.note(
                        event.type === 'question.close'
                            ? { title: `Closed ${event.id}`, detail: event.reason, ref: event.id, kind: 'closed' }
                            : {
                                  title: `Merged ${event.id} into ${event.into}`,
                                  ...(event.reason ? { detail: event.reason } : {}),
                                  ref: event.id,
                                  kind: 'closed'
                              }
                    );
                }
                result.applied.push({
                    index,
                    type: event.type,
                    ref: event.id,
                    version: draft.state.questions[event.id]?.version,
                    changed
                });
                break;
            }
            case 'understanding.update': {
                const current = draft.state.understanding;
                const changed = current.text !== event.text;
                if (changed) {
                    draft.setUnderstanding({ text: event.text, version: current.version + 1, updatedAt: now });
                    draft.note({ title: 'Updated the summary', ref: 'understanding' });
                }
                result.applied.push({
                    index,
                    type: event.type,
                    ref: 'understanding',
                    version: draft.state.understanding.version,
                    changed
                });
                break;
            }
            case 'stage.advance': {
                if (phase1.completed) break;
                const current = draft.state.phases.phase1;
                const aligned = current.aligned ?? { by: 'agent' as const, at: now };
                let next = current;
                if (event.to === 'explore') {
                    if (!current.aligned) {
                        next = { ...current, aligned };
                        draft.note({ title: 'Agreed the goals', detail: 'exploring ways to do it' });
                    }
                } else if (!event.reason) {
                    fail(
                        index,
                        '.reason',
                        'say why there is nothing to explore: the one clear way, and why the others fall away'
                    );
                } else {
                    const offered = directionsQuestion(draft.state);
                    if (offered)
                        fail(
                            index,
                            '.to',
                            `directions are already offered in ${offered.id}; the user picks what to investigate by answering it`
                        );
                    else if (current.exploreSkipped !== event.reason) {
                        next = { ...current, aligned, exploreSkipped: event.reason };
                        draft.note({ title: 'Went straight to the deep dive', detail: event.reason });
                    }
                }
                const changed = next !== current;
                if (changed) draft.setPhases({ ...draft.state.phases, phase1: next });
                result.applied.push({ index, type: event.type, ref: event.to, changed });
                break;
            }
            case 'doc.section.upsert': {
                const content = event.section;
                const existing = draft.state.sections[content.id];
                sectionEvents.set(content.id, index);
                const changed =
                    !existing ||
                    existing.title !== content.title ||
                    existing.order !== content.order ||
                    !isEqual(existing.blocks, content.blocks);
                if (changed) {
                    draft.putSection(
                        {
                            ...(existing ?? { reviewed: false }),
                            ...content,
                            version: existing ? existing.version + 1 : 1,
                            updatedAt: now
                        },
                        true
                    );
                }
                result.applied.push({
                    index,
                    type: event.type,
                    ref: content.id,
                    version: draft.state.sections[content.id]?.version,
                    changed
                });
                break;
            }
            case 'doc.block.upsert': {
                const envelope = event.block;
                const existing = draft.state.blocks[envelope.id];
                const content = JSON.parse(JSON.stringify(envelope));
                const changed =
                    !existing || !isEqual(blockContentOf(existing), blockContentOf({ ...content, version: 0, updatedAt: '' }));
                const slide = fixed.get(envelope.id);
                if (changed && slide) {
                    fail(
                        index,
                        '.block.id',
                        `block "${envelope.id}" is on slide ${slide}, published, so it cannot change this round`
                    );
                    break;
                }
                const check = checkBlockConfig(envelope.type, envelope.config);
                if (!check.ok) result.blockProblems.push({ block: envelope.id, reason: check.reason, issues: check.issues });
                if (changed) {
                    const record: BlockRecord = { ...content, version: existing ? existing.version + 1 : 1, updatedAt: now };
                    if (!check.ok) record.problem = { reason: check.reason, issues: check.issues };
                    draft.putBlock(record);
                }
                result.applied.push({
                    index,
                    type: event.type,
                    ref: envelope.id,
                    version: draft.state.blocks[envelope.id]?.version,
                    changed
                });
                break;
            }
            case 'comment.reply': {
                const thread = ownRecord(draft.state.threads, event.threadId);
                if (!thread) {
                    fail(index, '.threadId', `thread ${event.threadId} does not exist`);
                    break;
                }
                const message = {
                    id: `${thread.id}.${thread.messages.length + 1}`,
                    author: 'agent' as const,
                    text: event.text,
                    at: now,
                    ...(event.touched ? { touched: event.touched } : {}),
                    ...(event.blocks ? { blocks: event.blocks } : {})
                };
                reportInlineProblems(result, `${message.id} blocks`, event.blocks);
                const record: ThreadRecord = {
                    ...thread,
                    messages: [...thread.messages, message],
                    status: event.resolve ? 'resolved' : thread.status,
                    version: thread.version + 1,
                    updatedAt: now
                };
                draft.putThread(record);
                replies.push({ index, threadId: thread.id, explicit: event.touched !== undefined });
                draft.note({
                    title: thread.kind === 'message' ? 'Replied to your message' : 'Replied to a comment',
                    ref: `thread:${thread.id}`
                });
                result.applied.push({ index, type: event.type, ref: message.id, version: record.version, changed: true });
                break;
            }
            case 'comment.edit': {
                const thread = Object.values(draft.state.threads).find((candidate) =>
                    candidate.messages.some((message) => message.id === event.messageId)
                );
                const existing = thread?.messages.find((message) => message.id === event.messageId);
                if (!thread || !existing) {
                    fail(index, '.messageId', `message ${event.messageId} does not exist`);
                    break;
                }
                if (existing.author !== 'agent') {
                    fail(index, '.messageId', `${event.messageId} is the user's message; edit only your own replies`);
                    break;
                }
                const message = {
                    ...existing,
                    ...(event.text !== undefined ? { text: event.text } : {}),
                    ...(event.touched ? { touched: event.touched } : {}),
                    ...(event.blocks ? { blocks: event.blocks } : {})
                };
                reportInlineProblems(result, `${message.id} blocks`, message.blocks);
                const changed = !isEqual(message, existing);
                if (changed) {
                    draft.putThread({
                        ...thread,
                        messages: thread.messages.map((candidate) => (candidate.id === message.id ? message : candidate)),
                        version: thread.version + 1,
                        updatedAt: now
                    });
                    draft.note({ title: 'Edited a reply', ref: `thread:${thread.id}` });
                }
                result.applied.push({
                    index,
                    type: event.type,
                    ref: message.id,
                    version: draft.state.threads[thread.id]?.version,
                    changed
                });
                break;
            }
            case 'suggestion.decline': {
                const suggestion = ownRecord(draft.state.suggestions, event.id);
                if (!suggestion) {
                    fail(index, '.id', `suggestion ${event.id} does not exist`);
                    break;
                }
                const changed = suggestion.status !== 'declined' || suggestion.reason !== event.reason;
                if (changed) {
                    draft.putSuggestion({
                        ...suggestion,
                        status: 'declined',
                        reason: event.reason,
                        version: suggestion.version + 1
                    });
                    draft.note({ title: 'Declined a suggested question', detail: event.reason, kind: 'closed' });
                }
                result.applied.push({ index, type: event.type, ref: event.id, changed });
                break;
            }
            case 'proposal.trace': {
                const unknown = event.questions.filter((id) => !draft.state.questions[id]);
                unknown.forEach((id) =>
                    fail(index, `.questions[${event.questions.indexOf(id)}]`, `question ${id} does not exist`)
                );
                const others = draft.state.traces.filter(
                    (trace) => !(trace.requirement === event.requirement && trace.spec === event.spec)
                );
                const trace = {
                    requirement: event.requirement,
                    questions: event.questions,
                    ...(event.spec ? { spec: event.spec } : {})
                };
                draft.setTraces([...others, trace]);
                result.applied.push({ index, type: event.type, ref: event.requirement, changed: true });
                break;
            }
            case 'proposal.ready': {
                if (!draft.state.phases.submission) {
                    fail(index, '', 'proposal.ready needs a submission from the page first; wait for a phase.submit event');
                    break;
                }
                draft.setPhases({ ...draft.state.phases, proposalReadyAt: now });
                const strict = draft.state.phases.submission.validate !== false;
                const { changeId, format } = draft.state;
                draft.note(
                    format === 'markdown'
                        ? { title: 'Wrote the plan', detail: `checking ${changeId}.md` }
                        : { title: 'Proposed the change', detail: `running openspec validate${strict ? ' --strict' : ''}` }
                );
                validate = true;
                result.applied.push({ index, type: event.type, ref: draft.state.changeId, changed: true });
                break;
            }
            case 'slide.upsert':
            case 'deck.progress':
            case 'deck.publish':
            case 'item.upsert':
            case 'item.withdraw':
            case 'summary.draft':
            case 'earlier.label':
                applyReviewEvent(draft, event, index, fail, result, { slideEvents, itemEvents });
                break;
            default:
                break;
        }
    });

    if (draft.state.kind === 'review') checkReviewIntegrity(draft, { slideEvents, itemEvents }, fail);

    // Referential integrity over the batch's end state: every listed block exists and sits once, in one section.
    for (const problem of listingProblems(draft.state, draft.changedSections())) {
        const { sectionId, position, blockId } = problem;
        const message =
            problem.kind === 'missing'
                ? `block "${blockId}" has not been sent; send it with doc.block.upsert in this batch or an earlier one`
                : problem.kind === 'shared'
                  ? `block "${blockId}" is already in section "${problem.owner}"`
                  : `block "${blockId}" is already listed in this section`;
        const index = sectionEvents.get(sectionId);
        if (index === undefined) issues.push({ path: `section ${sectionId}`, message });
        else fail(index, `.section.blocks${position.map((at) => `[${at}]`).join('')}`, message);
    }
    checkDirections(draft, questionsBefore, questionEvents, fail, issues);
    if (issues.length) throw new RejectedError(issues, 400);

    // The reviewed reset: any section whose content or blocks changed loses its tick.
    const touchedSections = new Set([
        ...draft.changedSections(),
        ...draft.changedBlocks().flatMap((id) => sectionOfBlock(draft.state, id)?.id ?? [])
    ]);
    for (const sectionId of touchedSections) {
        const section = draft.state.sections[sectionId];
        if (section?.reviewed) draft.putSection(unreview(section, 'agent', now), false);
    }
    for (const sectionId of touchedSections) {
        draft.note({
            title: `Updated ${sectionLabel(draft.state, sectionId)}`,
            detail: draft.state.sections[sectionId]?.title,
            ref: `section:${sectionId}`
        });
    }

    // Replies that did not say what they touched list what this batch changed.
    const touched = describeTouched(draft, blocksBefore, questionsChanged);
    for (const reply of replies) {
        if (reply.explicit || touched.length === 0) continue;
        const thread = draft.state.threads[reply.threadId]!;
        const messages = thread.messages.map((message, position) =>
            position === thread.messages.length - 1 ? { ...message, touched } : message
        );
        draft.putThread({ ...thread, messages });
    }

    // A review's blocks live on its slides, which are fixed once published, so they keep no write-up revisions.
    const changes = draft.state.kind === 'review' ? [] : draft.revisionChanges();
    let revision: Revision | undefined;
    if (changes.length) {
        const n = draft.state.revision + 1;
        const labels = [...touchedSections].map((id) => sectionLabel(draft.state, id));
        revision = { n, at: now, summary: summary?.trim() || `Updated ${labels.join(', ') || 'the write-up'}`, changes };
        draft.setRevision(n);
        result.revision = n;
    }
    if (validate) result.validating = true;
    const editing = draft.state.kind === 'review' ? reviewEditing(draft) : editingLabel(draft, questionsChanged);
    return { result, ...(revision ? { revision } : {}), ...(editing ? { editing } : {}), validate };
}
