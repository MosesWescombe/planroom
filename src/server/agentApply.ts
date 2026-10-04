import isEqual from 'lodash/isEqual.js';
import { z } from 'zod';
import { checkBlockConfig } from '../shared/blocks.js';
import {
    directionsQuestion,
    investigatedDirections,
    listingProblems,
    sectionLabel,
    sectionOfBlock,
    unreview,
    upsertQuestion
} from '../shared/derive.js';
import { type AgentEvent, agentEventTypes, emitBatch } from '../shared/events.js';
import { type Issue, toIssues } from '../shared/issues.js';
import { type ContextBlock, isInfo, type QuestionRecord } from '../shared/questions.js';
import { type BlockRecord, ownRecord, type ThreadRecord, type Touched } from '../shared/records.js';
import type { Revision } from '../shared/revisions.js';
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

/**
 * Apply a parsed batch to a draft. Any problem other than a block's own config
 * (a missing target, a broken reference, a read-only session) throws, and the
 * session discards the draft, so nothing applies.
 */
export function applyAgentBatch(
    draft: Draft,
    events: AgentEvent[],
    summary: string | undefined
): { result: BatchResult; revision?: Revision; editing?: string; validate: boolean } {
    if (draft.state.phases.acceptedAt) {
        throw new RejectedError([
            {
                path: '',
                message: 'The proposal was accepted, so this session is read-only. Tell the user the next step is /decompose.'
            }
        ]);
    }
    if (draft.state.phases.ended) {
        throw new RejectedError([
            { path: '', message: `The user ${draft.state.phases.ended.how} this session, so it is read-only. Stop.` }
        ]);
    }
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
            default:
                break;
        }
    });

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

    const changes = draft.revisionChanges();
    let revision: Revision | undefined;
    if (changes.length) {
        const n = draft.state.revision + 1;
        const labels = [...touchedSections].map((id) => sectionLabel(draft.state, id));
        revision = { n, at: now, summary: summary?.trim() || `Updated ${labels.join(', ') || 'the write-up'}`, changes };
        draft.setRevision(n);
        result.revision = n;
    }
    if (validate) result.validating = true;
    const editing = editingLabel(draft, questionsChanged);
    return { result, ...(revision ? { revision } : {}), ...(editing ? { editing } : {}), validate };
}
