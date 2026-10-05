import { describeAnchor } from '../shared/anchors.js';
import { checkBlockConfig, checklistItemKey } from '../shared/blocks.js';
import {
    acceptGate,
    afterConflict,
    assumptionTitle,
    canRequestChanges,
    directionsQuestion,
    directionTabs,
    endHow,
    isAssumption,
    listingProblems,
    openComments,
    orderedSections,
    outstandingItems,
    phase1Gate,
    sectionLabel,
    sectionOfBlock,
    unreview
} from '../shared/derive.js';
import type { LoggedAttachment, NewLoggedEvent, PageRequest } from '../shared/events.js';
import { answerProblem, describeAnswer, type QuestionRecord } from '../shared/questions.js';
import {
    type Attachment,
    type BlockRecord,
    ownRecord,
    type SectionRecord,
    type ThreadMessage,
    type ThreadRecord
} from '../shared/records.js';
import { type Revision, type RevisionChange, revisionMeta, undoBlocker } from '../shared/revisions.js';
import { planDir } from '../shared/state.js';
import type { ActivityEntry } from '../shared/view.js';
import { type Draft, RejectedError, reject } from './draft.js';

/** The outcome of one page request: the event to log (if any) and follow-up work. */
export interface PageOutcome {
    event?: NewLoggedEvent;
    revision?: Revision;
    /** Run `openspec validate` after committing. */
    validate?: boolean;
}

/** Log something the user did; the activity feed keeps these quiet. */
function noteYours(draft: Draft, entry: Omit<ActivityEntry, 'id' | 'at' | 'kind'>): void {
    draft.note({ ...entry, kind: 'yours' });
}

/** The question `id` names, or a 404 rejection. */
function question(draft: Draft, id: string): QuestionRecord {
    return draft.state.questions[id] ?? reject(`question ${id} does not exist`, 'questionId', 404);
}

/** The thread `id` names; thread ids are not record ids, so an inherited name such as `constructor` is not one. */
function thread(draft: Draft, id: string): ThreadRecord {
    return ownRecord(draft.state.threads, id) ?? reject(`thread ${id} does not exist`, 'threadId', 404);
}

/** A new version of a question with `changes` applied, its version bumped and `updatedAt` set. */
function bump(record: QuestionRecord, now: string, changes: Partial<QuestionRecord>): QuestionRecord {
    return { ...record, ...changes, version: record.version + 1, updatedAt: now };
}

/** Reopen a question: back to open, keeping any answer to show beside it. */
function reopened(record: QuestionRecord, now: string): QuestionRecord {
    const next = bump(record, now, { status: 'open' });
    delete next.closedReason;
    delete next.mergedInto;
    delete next.conflict;
    return next;
}

/** The next id for a comment (`C-n`) or message (`M-n`) thread, advancing its counter in the draft. */
function nextThreadId(draft: Draft, kind: 'comment' | 'message'): string {
    const counters = { ...draft.state.counters };
    counters[kind === 'comment' ? 'thread' : 'message'] += 1;
    draft.state.counters = counters;
    return kind === 'comment' ? `C-${counters.thread}` : `M-${counters.message}`;
}

/** What the user wrote in a message: its words and anything pasted into it. */
interface Said {
    text: string;
    attachments?: Attachment[];
}

/** A user message for a thread, keeping `attachments` off it when nothing was pasted. */
function userMessage(id: string, said: Said, at: string): ThreadMessage {
    const message: ThreadMessage = { id, author: 'user', text: said.text, at };
    if (said.attachments?.length) message.attachments = said.attachments;
    return message;
}

/** A message as the agent reads it: its words, and each paste with an image's repo path to open. */
function forAgent(draft: Draft, said: Said): { text: string; attachments?: LoggedAttachment[] } {
    if (!said.attachments?.length) return { text: said.text };
    const dir = `${planDir(draft.state.format, draft.state.changeId)}/.planroom/assets`;
    return {
        text: said.text,
        attachments: said.attachments.map((item) => (item.kind === 'image' ? { ...item, path: `${dir}/${item.asset}` } : item))
    };
}

/** A one-line summary of a message for the activity feed. */
function gist(said: Said): string {
    return said.text.slice(0, 80) || (said.attachments?.some((item) => item.kind === 'image') ? 'an image' : 'pasted text');
}

/** Start a thread with the user's first message and store it in the draft. */
function newThread(draft: Draft, kind: 'comment' | 'message', said: Said, extra: Partial<ThreadRecord>): ThreadRecord {
    const id = nextThreadId(draft, kind);
    const record: ThreadRecord = {
        id,
        kind,
        status: 'open',
        messages: [userMessage(`${id}.1`, said, draft.now)],
        version: 1,
        createdAt: draft.now,
        updatedAt: draft.now,
        ...extra
    };
    draft.putThread(record);
    return record;
}

/** Forget the page's ticks and confirmation for a block an undo removes, so a later block with its id starts fresh. */
function forgetBlock(draft: Draft, id: string): void {
    draft.forgetPageMarks(id);
}

/**
 * Undo revision `n` by applying its before-images as a new revision. Refused when a later revision touched the same
 * records, or when the result would list a missing block or one block in two places.
 */
function undo(draft: Draft, revisions: readonly Revision[], n: number): { event: NewLoggedEvent; revision: Revision } {
    const blocker = undoBlocker(revisionMeta(revisions), n);
    if (blocker === 'missing') reject(`revision ${n} does not exist`, 'revision', 404);
    if (blocker === 'undone') reject(`revision ${n} was already undone`, 'revision');
    if (blocker) {
        const section = blocker.kind === 'section' ? draft.state.sections[blocker.id] : sectionOfBlock(draft.state, blocker.id);
        const label = section
            ? `§${orderedSections(draft.state).find((entry) => entry.section.id === section.id)?.number} changed again since`
            : `${blocker.id} changed again since`;
        reject(label, 'revision');
    }
    const target = revisions.find((rev) => rev.n === n)!;
    const now = draft.now;
    const touchedSections = new Set<string>();
    // Sections first, so a restored section can list blocks the undo brings back; integrity is checked at the end.
    const ordered: RevisionChange[] = [...target.changes].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'block' ? -1 : 1));
    for (const change of ordered) {
        if (change.kind === 'block') {
            const current = draft.state.blocks[change.id];
            if (!change.before) {
                draft.removeBlock(change.id);
                forgetBlock(draft, change.id);
            } else {
                const { id, type, config, caption, refs } = change.before;
                const restored: BlockRecord = {
                    id,
                    type,
                    config,
                    ...(caption !== undefined ? { caption } : {}),
                    ...(refs !== undefined ? { refs } : {}),
                    version: (current?.version ?? 0) + 1,
                    updatedAt: now
                };
                const check = checkBlockConfig(type, config);
                if (!check.ok) restored.problem = { reason: check.reason, issues: check.issues };
                draft.putBlock(restored);
            }
            const owner = sectionOfBlock(draft.state, change.id);
            if (owner) touchedSections.add(owner.id);
        } else {
            const current = draft.state.sections[change.id];
            if (!change.before) draft.removeSection(change.id);
            else {
                const base: SectionRecord = current ?? { ...change.before, version: 0, reviewed: false, updatedAt: now };
                draft.putSection({ ...base, ...change.before, version: base.version + 1, updatedAt: now }, true);
                touchedSections.add(change.id);
            }
        }
    }
    const broken = listingProblems(draft.state, draft.changedSections())[0];
    if (broken) {
        const where = sectionLabel(draft.state, broken.sectionId);
        reject(
            broken.kind === 'missing'
                ? `${where} lists ${broken.blockId}, which this undo would remove`
                : broken.kind === 'shared'
                  ? `${sectionLabel(draft.state, broken.owner)} and ${where} would both list ${broken.blockId}`
                  : `${where} would list ${broken.blockId} twice`,
            'revision'
        );
    }
    for (const sectionId of touchedSections) {
        const section = draft.state.sections[sectionId];
        if (section?.reviewed) draft.putSection(unreview(section, 'undo', now), false);
    }
    const newRevision = draft.state.revision + 1;
    const revision: Revision = {
        n: newRevision,
        at: now,
        summary: `Undid revision ${n}: ${target.summary}`,
        undoOf: n,
        changes: draft.revisionChanges()
    };
    draft.setRevision(newRevision);
    noteYours(draft, { title: `You undid revision ${n}`, detail: target.summary });
    return {
        revision,
        event: {
            type: 'edit.undone',
            revision: n,
            newRevision,
            blocks: target.changes.flatMap((change) => (change.kind === 'block' ? [change.id] : [])),
            sections: target.changes.flatMap((change) => (change.kind === 'section' ? [change.id] : []))
        }
    };
}

/** Make a read-only session editable again, keeping the phase it reached: the proposal stays validated, unaccepted. */
function reopenSession(draft: Draft): PageOutcome {
    const { acceptedAt, ended, ...phases } = draft.state.phases;
    const from = acceptedAt ? 'accepted' : ended?.how;
    if (!from) reject('This session is not read-only');
    draft.setPhases({ ...phases, acceptedAt: null });
    noteYours(draft, { title: 'You reopened the session' });
    return { event: { type: 'session.reopen', from } };
}

/**
 * Apply one page request to a draft. Throws RejectedError when the request does not
 * fit the current state; the session then discards the draft and answers with the
 * error, and nothing is logged.
 */
export function applyPageRequest(draft: Draft, request: PageRequest, revisions: readonly Revision[]): PageOutcome {
    const { now, state } = draft;
    if (request.type === 'session.reopen') return reopenSession(draft);
    if (state.phases.acceptedAt) reject('The proposal was accepted; this session is read-only.');
    if (state.phases.ended) reject(`You ${state.phases.ended.how} this session; it is read-only.`);

    switch (request.type) {
        case 'answer.submit': {
            const record = question(draft, request.questionId);
            if (record.status === 'closed' || record.status === 'merged')
                reject(`${record.id} is ${record.status}; reopen it first`);
            if (record.status === 'streaming') reject(`${record.id} is still being written`);
            const problem = answerProblem(record, request.answer);
            if (problem) reject(problem, 'answer', 400);
            const next = bump(record, now, {
                status: 'answered',
                answer: { ...request.answer, version: request.version, at: now }
            });
            delete next.conflict;
            draft.putQuestion(next);
            const summary = describeAnswer(record, request.answer);
            noteYours(draft, { title: `You answered ${record.id}`, detail: summary, ref: record.id });
            return {
                event: {
                    type: 'answer.submit',
                    questionId: record.id,
                    version: request.version,
                    answer: request.answer,
                    summary,
                    stale: request.version < record.contentVersion
                }
            };
        }
        case 'question.reopen': {
            const record = question(draft, request.questionId);
            if (record.status === 'open' || record.status === 'streaming') reject(`${record.id} is already open`);
            draft.putQuestion(reopened(record, now));
            noteYours(draft, { title: `You reopened ${record.id}`, ref: record.id });
            return { event: { type: 'question.reopen', questionId: record.id } };
        }
        case 'conflict.resolve': {
            const record = question(draft, request.questionId);
            if (record.status !== 'conflict' || !record.conflict) reject(`${record.id} is not in conflict`);
            const other = record.conflict.with;
            const next = bump(record, now, { status: afterConflict(record) });
            delete next.conflict;
            draft.putQuestion(next);
            if (request.choice === 'change-other') {
                const otherRecord = state.questions[other];
                if (otherRecord && otherRecord.status !== 'open') draft.putQuestion(reopened(otherRecord, now));
            }
            noteYours(draft, {
                title: request.choice === 'keep' ? `You kept ${record.id}` : `You reopened ${other}`,
                detail: `resolving the conflict on ${record.id}`,
                ref: record.id
            });
            return { event: { type: 'conflict.resolve', questionId: record.id, choice: request.choice, other } };
        }
        case 'question.suggest': {
            const counters = { ...state.counters, suggestion: state.counters.suggestion + 1 };
            draft.state.counters = counters;
            const id = `S-${counters.suggestion}`;
            draft.putSuggestion({ id, text: request.text, status: 'pending', version: 1, createdAt: now });
            noteYours(draft, { title: 'You suggested a question', detail: request.text });
            return { event: { type: 'question.suggest', suggestionId: id, text: request.text } };
        }
        case 'comment.create': {
            if (request.anchor.position && request.anchor.position.end <= request.anchor.position.start)
                reject('the anchor selects no text', 'anchor.position', 400);
            const record = newThread(draft, 'comment', request, { anchor: request.anchor, intent: request.intent });
            noteYours(draft, {
                title: 'You commented',
                detail: describeAnchor(request.anchor),
                ref: `thread:${record.id}`
            });
            return {
                event: {
                    type: 'comment.create',
                    threadId: record.id,
                    anchor: request.anchor,
                    intent: request.intent,
                    ...forAgent(draft, request)
                }
            };
        }
        case 'thread.reply': {
            const record = thread(draft, request.threadId);
            draft.putThread({
                ...record,
                status: 'open',
                messages: [...record.messages, userMessage(`${record.id}.${record.messages.length + 1}`, request, now)],
                version: record.version + 1,
                updatedAt: now
            });
            return { event: { type: 'thread.reply', threadId: record.id, ...forAgent(draft, request) } };
        }
        case 'comment.resolve': {
            const record = thread(draft, request.threadId);
            if (record.status === 'resolved') reject(`thread ${record.id} is already resolved`);
            draft.putThread({ ...record, status: 'resolved', version: record.version + 1, updatedAt: now });
            return { event: { type: 'comment.resolve', threadId: record.id } };
        }
        case 'message.send': {
            const record = newThread(draft, 'message', request, {});
            noteYours(draft, { title: 'You messaged the agent', detail: gist(request), ref: `thread:${record.id}` });
            return { event: { type: 'message.send', threadId: record.id, ...forAgent(draft, request) } };
        }
        case 'review.mark': {
            const section =
                state.sections[request.sectionId] ?? reject(`section ${request.sectionId} does not exist`, 'sectionId', 404);
            if (section.reviewed === request.reviewed) return {};
            const next: SectionRecord = { ...section, reviewed: request.reviewed, version: section.version + 1, updatedAt: now };
            if (request.reviewed) {
                delete next.unreviewedBy;
                delete next.unreviewedAt;
            }
            // The tick is the user's own record: stored for the page and the submit gate, never logged for the agent.
            draft.putSection(next, false);
            return {};
        }
        case 'checklist.tick': {
            const block = state.blocks[request.blockId] ?? reject(`block ${request.blockId} does not exist`, 'blockId', 404);
            if (block.type !== 'checklist' || block.problem) reject(`block ${block.id} is not a valid checklist`, 'blockId', 400);
            if (block.config.interactive !== true) reject(`checklist ${block.id} is not interactive`, 'blockId');
            const items = Array.isArray(block.config.items) ? block.config.items : [];
            const keys = items.map((item: { id?: string }, index: number) => checklistItemKey(item, index));
            if (!keys.includes(request.item)) reject(`checklist ${block.id} has no item "${request.item}"`, 'item', 404);
            draft.putTicks(block.id, { ...(state.checklistTicks[block.id] ?? {}), [request.item]: request.done });
            return { event: { type: 'checklist.tick', blockId: block.id, item: request.item, done: request.done } };
        }
        case 'assumption.confirm': {
            const block = state.blocks[request.blockId] ?? reject(`block ${request.blockId} does not exist`, 'blockId', 404);
            if (!isAssumption(block)) reject(`block ${block.id} is not an assumption`, 'blockId', 400);
            if (state.confirmedAssumptions[block.id] === block.version) return {};
            draft.putConfirmed(block.id, block.version);
            noteYours(draft, { title: 'You confirmed an assumption', detail: assumptionTitle(block) });
            return { event: { type: 'assumption.confirm', blockId: block.id, title: assumptionTitle(block) } };
        }
        case 'block.fix': {
            const block = state.blocks[request.blockId] ?? reject(`block ${request.blockId} does not exist`, 'blockId', 404);
            // Re-check too: a block stored before a rule tightened has no stored problem, but the page shows one.
            const check = checkBlockConfig(block.type, block.config);
            const issues =
                block.problem?.issues ??
                (check.ok ? undefined : check.issues) ??
                (request.thrown && [{ path: '', message: `threw while drawing: ${request.thrown}` }]);
            if (!issues) reject(`block ${block.id} renders fine`, 'blockId');
            return { event: { type: 'block.fix', blockId: block.id, blockType: block.type, issues } };
        }
        case 'edit.undo': {
            const { event, revision } = undo(draft, revisions, request.revision);
            return { event, revision };
        }
        case 'stage.advance': {
            if (state.phases.phase1.completed) reject('Phase 1 is already complete');
            if (state.phases.phase1.aligned) reject('The goals are already agreed');
            draft.setPhases({ ...state.phases, phase1: { ...state.phases.phase1, aligned: { by: 'user', at: now } } });
            noteYours(draft, { title: 'You agreed the goals' });
            return {
                event: {
                    type: 'stage.advance',
                    to: 'explore',
                    open: phase1Gate(state).unresolved.map((q) => ({ questionId: q.id, title: q.title, status: q.status }))
                }
            };
        }
        case 'phase.complete': {
            if (state.phases.phase1.completed) reject('Phase 1 is already complete');
            // Once directions are investigated, finishing means going ahead with one of them.
            const tabs = directionTabs(state);
            const chosen = request.direction === undefined ? undefined : tabs.find((tab) => tab.id === request.direction);
            if (tabs.length && !request.direction)
                reject(`Choose the direction to go ahead with: ${tabs.map((tab) => tab.label).join(', ')}`, 'direction', 400);
            if (request.direction !== undefined && !chosen)
                reject(`"${request.direction}" is not a direction you are investigating`, 'direction', 400);
            const gate = phase1Gate(state, chosen?.id);
            if (request.path === 'finished' && !gate.canFinish) {
                reject(
                    `Phase 1 cannot finish yet: ${gate.total - gate.resolved} of ${gate.total} questions are unresolved or need a look`
                );
            }
            draft.setPhases({
                ...state.phases,
                phase1: {
                    ...state.phases.phase1,
                    completed: true,
                    path: request.path,
                    at: now,
                    ...(chosen ? { direction: chosen.id } : {})
                }
            });
            noteYours(draft, {
                title: chosen
                    ? `You went ahead with ${chosen.label}`
                    : request.path === 'finished'
                      ? 'You finished phase 1'
                      : 'You chose to draft with assumptions',
                ...(chosen && request.path === 'assumptions' ? { detail: 'unresolved questions carried as assumptions' } : {}),
                ...(chosen ? { ref: directionsQuestion(state)?.id } : {})
            });
            return {
                event: {
                    type: 'phase.complete',
                    path: request.path,
                    ...(chosen ? { direction: { id: chosen.id, label: chosen.label } } : {}),
                    assumptions: gate.unresolved.map((q) => ({ questionId: q.id, title: q.title, status: q.status }))
                }
            };
        }
        case 'phase.submit': {
            if (!state.phases.phase1.completed) reject('Finish phase 1 before submitting');
            if (request.changeId !== state.changeId)
                reject(`this session plans ${state.changeId}, not ${request.changeId}`, 'changeId', 400);
            if (request.revision !== state.revision)
                reject(`the write-up is at revision ${state.revision}; review it again before submitting`, 'revision');
            const items = outstandingItems(state);
            if (items.length && !request.anyway) {
                throw new RejectedError(
                    items.map((item) => ({ path: item.ref, message: item.label })),
                    409
                );
            }
            draft.setPhases({
                ...state.phases,
                submission: { revision: request.revision, validate: request.validate, outstanding: items, at: now },
                proposalReadyAt: null,
                proposalUnlocked: false
            });
            noteYours(draft, {
                title: `You submitted write-up v${request.revision}`,
                detail: items.length ? `${items.length} items outstanding` : undefined
            });
            return {
                event: {
                    type: 'phase.submit',
                    changeId: state.changeId,
                    revision: request.revision,
                    validate: request.validate,
                    outstanding: items
                }
            };
        }
        case 'validation.rerun': {
            if (!state.phases.submission) reject('Submit the write-up before validating');
            if (!state.phases.proposalReadyAt) reject('The agent has not proposed the change yet; wait for it to finish');
            return { validate: true };
        }
        case 'proposal.accept': {
            const gate = acceptGate(state);
            if (!gate.canAccept) reject(gate.reason ?? 'The proposal cannot be accepted yet');
            draft.setPhases({ ...state.phases, acceptedAt: now });
            noteYours(draft, { title: 'You accepted the proposal' });
            return { event: { type: 'proposal.accept', changeId: state.changeId } };
        }
        case 'proposal.requestChanges': {
            if (!state.phases.proposalUnlocked) reject('There is no proposal to review yet');
            if (!canRequestChanges(state, request.text)) reject('Leave a comment on the proposal or write a message first');
            const message = request.text ? newThread(draft, 'message', { text: request.text }, {}) : undefined;
            noteYours(draft, { title: 'You requested changes', ...(request.text ? { detail: request.text.slice(0, 80) } : {}) });
            return {
                event: {
                    type: 'proposal.requestChanges',
                    ...(request.text ? { text: request.text } : {}),
                    ...(message ? { threadId: message.id } : {}),
                    openComments: openComments(state, ['proposal']).map((open) => open.id)
                }
            };
        }
        case 'session.end': {
            const how = endHow(state);
            draft.setPhases({ ...state.phases, ended: { how, at: now } });
            noteYours(draft, { title: how === 'finished' ? 'You finished the session' : 'You cancelled the session' });
            return { event: { type: 'session.end', how } };
        }
        default:
            return {};
    }
}
