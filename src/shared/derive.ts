import isEqual from 'lodash/isEqual.js';
import omit from 'lodash/omit.js';
import { describeAnchor } from './anchors.js';
import {
    ASSUMPTION_HOLDS,
    describeAnswer,
    isInfo,
    type QuestionContent,
    type QuestionRecord,
    type QuestionStatus
} from './questions.js';
import { type BlockRecord, blockIdsOf, type Outstanding, type SectionRecord, type ThreadRecord } from './records.js';
import type { SessionState } from './state.js';

/**
 * Pure functions over session state: the status and review transitions the server
 * applies, and the gates and counts the page shows. The server is the only writer;
 * the page imports these so both sides read state the same way.
 */

/** Statuses that count as resolved for progress and the phase gate. */
export const RESOLVED: ReadonlySet<QuestionStatus> = new Set(['answered', 'closed', 'merged']);

/** Statuses that stop "Finish phase 1" even when counted separately from open. */
const BLOCKING: ReadonlySet<QuestionStatus> = new Set(['needs-review', 'conflict', 'streaming']);

/**
 * The agent-owned fields compared to decide whether an upsert changed what the user answered. `topic` only labels the
 * decision, so it is compared on its own.
 */
function questionContentOf(question: QuestionContent | QuestionRecord): Omit<QuestionContent, 'status' | 'topic'> {
    const { id, group, title, impact, context, input, options, allowOther, conflict, links, direction } = question;
    return { id, group, title, impact, context, input, options, allowOther, conflict, links, direction };
}

/** The result of applying a `question.upsert`. `changed` is false for an identical re-send. */
export interface QuestionUpsert {
    record: QuestionRecord;
    changed: boolean;
}

/** Deep equality that treats an absent key and an undefined one as the same. */
function sameJson(a: unknown, b: unknown): boolean {
    return isEqual(JSON.parse(JSON.stringify(a ?? null)), JSON.parse(JSON.stringify(b ?? null)));
}

/**
 * Where a question lands once its conflict clears: `needs-review` when the agent reworded it since the saved answer,
 * `answered` when the answer still fits, `open` when there is none.
 */
export function afterConflict(question: Pick<QuestionRecord, 'answer' | 'contentVersion'>): QuestionStatus {
    if (!question.answer) return 'open';
    return question.answer.version < question.contentVersion ? 'needs-review' : 'answered';
}

/**
 * Apply a `question.upsert` to the stored question. The server assigns versions; a
 * content change to a question the user answered drops it to `needs-review`, keeping
 * the answer to show beside it. The agent's `status` only moves a question out of
 * `streaming`, reopens a closed or merged one, or raises a conflict: re-sending
 * `open` never wipes an answer. A conflict flags the answer rather than rewording the
 * question, so raising or clearing one leaves `contentVersion` as it was.
 */
export function upsertQuestion(existing: QuestionRecord | undefined, content: QuestionContent, now: string): QuestionUpsert {
    const incoming = questionContentOf(content);
    const topic = content.topic === undefined ? {} : { topic: content.topic };
    if (!existing) {
        const status: QuestionStatus = content.status ?? (content.conflict ? 'conflict' : 'open');
        return {
            changed: true,
            record: { ...incoming, ...topic, status, version: 1, contentVersion: 1, answer: null, createdAt: now, updatedAt: now }
        };
    }

    const current = existing.status;
    const contentChanged = !sameJson(questionContentOf(existing), incoming);
    const reworded = !sameJson(omit(questionContentOf(existing), 'conflict'), omit(incoming, 'conflict'));
    const conflictRaised =
        (content.status === 'conflict' && current !== 'conflict') ||
        (content.conflict !== undefined && !sameJson(content.conflict, existing.conflict));
    const version = existing.version + 1;
    const contentVersion = reworded ? version : existing.contentVersion;

    let status: QuestionStatus;
    if (conflictRaised) status = 'conflict';
    else if (current === 'closed' || current === 'merged') status = content.status === 'open' ? 'open' : current;
    else if (current === 'answered' || current === 'needs-review') status = contentChanged ? 'needs-review' : current;
    else if (current === 'conflict')
        status = content.conflict ? 'conflict' : afterConflict({ answer: existing.answer, contentVersion });
    else status = content.status === 'streaming' ? 'streaming' : 'open';

    if (!contentChanged && existing.topic === content.topic && status === current) return { changed: false, record: existing };

    const record: QuestionRecord = {
        ...incoming,
        ...topic,
        status,
        version,
        contentVersion,
        answer: existing.answer,
        createdAt: existing.createdAt,
        updatedAt: now
    };
    const answeredBefore = existing.answer !== null && current !== 'open';
    const changedByAgentAt = contentChanged && answeredBefore ? now : existing.changedByAgentAt;
    if (changedByAgentAt) record.changedByAgentAt = changedByAgentAt;
    if ((status === 'closed' || status === 'merged') && existing.closedReason !== undefined)
        record.closedReason = existing.closedReason;
    if (status === 'merged' && existing.mergedInto) record.mergedInto = existing.mergedInto;
    return { changed: true, record };
}

/**
 * The reviewed reset for a write-up section: any change to the section or one of its
 * blocks clears the user's tick and records who changed it.
 */
export function unreview(section: SectionRecord, by: 'agent' | 'undo', now: string): SectionRecord {
    return { ...section, reviewed: false, unreviewedBy: by, unreviewedAt: now };
}

/** The parts of session state the gates read. The persisted state and the page's view both satisfy it. */
export type PlanState = Pick<
    SessionState,
    'questions' | 'sections' | 'blocks' | 'threads' | 'confirmedAssumptions' | 'phases' | 'validation' | 'traces'
>;

// ---------------------------------------------------------------- questions: progress and the phase 1 gate

/** Questions in id order (Q-2 before Q-10). */
export function orderedQuestions(state: Pick<SessionState, 'questions'>): QuestionRecord[] {
    return Object.values(state.questions).sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)));
}

export interface GroupProgress {
    /** The full group path, e.g. `deep-dive/failure-modes`. */
    path: string;
    /** The first path segment as an eyebrow, e.g. `DEEP DIVE`. */
    heading: string;
    /** The rest of the path as a name, e.g. `Failure modes`. */
    name: string;
    resolved: number;
    total: number;
    questionIds: string[];
}

/** Turn a slug such as `failure-modes` into `Failure modes`; anything that is not a slug is kept as written. */
export function humanize(segment: string): string {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(segment)) return segment;
    const words = segment.replace(/-/g, ' ');
    return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Which Phase 1 questions a view shows: `undefined` for every question, `null` for the shared ones (no direction),
 * or a direction id for that direction's own.
 */
export type QuestionScope = string | null | undefined;

/** Whether a question belongs to `scope`. */
function inScope(question: QuestionRecord, scope: QuestionScope): boolean {
    return scope === undefined || (question.direction ?? null) === scope;
}

/** Group progress in order of each group's first question, plus the overall count, over the questions in `scope`. */
export function groupProgress(
    state: Pick<SessionState, 'questions'>,
    scope?: QuestionScope
): {
    groups: GroupProgress[];
    resolved: number;
    total: number;
} {
    const groups = new Map<string, GroupProgress>();
    for (const question of orderedQuestions(state).filter((candidate) => inScope(candidate, scope))) {
        const [first = question.group, ...rest] = question.group.split('/');
        const group = groups.get(question.group) ?? {
            path: question.group,
            heading: humanize(first).toUpperCase(),
            name: rest.length ? rest.map(humanize).join(' / ') : humanize(first),
            resolved: 0,
            total: 0,
            questionIds: []
        };
        // An info card shows in its group but asks nothing, so it is not counted.
        if (!isInfo(question)) {
            group.total += 1;
            if (RESOLVED.has(question.status)) group.resolved += 1;
        }
        group.questionIds.push(question.id);
        groups.set(question.group, group);
    }
    const list = [...groups.values()];
    return { groups: list, resolved: list.reduce((n, g) => n + g.resolved, 0), total: list.reduce((n, g) => n + g.total, 0) };
}

export interface Phase1Gate {
    /** Whether "Finish phase 1" is enabled. */
    canFinish: boolean;
    resolved: number;
    total: number;
    /** Questions not yet resolved, which finishing early carries into the write-up as assumptions. */
    unresolved: QuestionRecord[];
    blocking: { open: number; needsReview: number; conflict: number; streaming: number };
}

/**
 * Phase 1 completes by "Finish" only when every question in scope is resolved and none is under review, in conflict
 * or being written. Going ahead with a direction scopes it to the shared questions plus that direction's own; with no
 * direction every question counts. Info cards ask nothing, so they never count.
 */
export function phase1Gate(state: Pick<SessionState, 'questions'>, direction?: string): Phase1Gate {
    const questions = orderedQuestions(state).filter(
        (question) => !isInfo(question) && (direction === undefined || !question.direction || question.direction === direction)
    );
    const count = (status: QuestionStatus) => questions.filter((question) => question.status === status).length;
    const unresolved = questions.filter((question) => !RESOLVED.has(question.status));
    const blocked = questions.some((question) => BLOCKING.has(question.status));
    return {
        canFinish: questions.length > 0 && unresolved.length === 0 && !blocked,
        resolved: questions.length - unresolved.length,
        total: questions.length,
        unresolved,
        blocking: {
            open: count('open'),
            needsReview: count('needs-review'),
            conflict: count('conflict'),
            streaming: count('streaming')
        }
    };
}

// ---------------------------------------------------------------- phase 1 stages and directions

/**
 * Phase 1 runs in stages: agree the goals (`align`), offer ways to achieve them (`explore`), question the chosen
 * directions in depth (`deep-dive`), then go ahead with one (`done`).
 */
export type Phase1Stage = 'align' | 'explore' | 'deep-dive' | 'done';

/** The one question that offers directions, if the agent has asked it. */
export function directionsQuestion(state: Pick<SessionState, 'questions'>): QuestionRecord | undefined {
    return Object.values(state.questions).find((question) => question.input === 'directions');
}

/** Directions-question statuses whose saved answer still picks what to investigate. */
const PICKED: ReadonlySet<QuestionStatus> = new Set(['answered', 'needs-review', 'conflict']);

/** The direction ids the user chose to investigate. None while the directions question is unanswered, open again or closed. */
export function investigatedDirections(state: Pick<SessionState, 'questions'>): string[] {
    const question = directionsQuestion(state);
    if (!question?.answer || !PICKED.has(question.status)) return [];
    return question.answer.choices ?? [];
}

/** Which Phase 1 stage the session is in, from the phase flags and the directions the user picked. */
export function phase1Stage(state: Pick<SessionState, 'questions' | 'phases'>): Phase1Stage {
    const phase1 = state.phases.phase1;
    if (phase1.completed) return 'done';
    if (!phase1.aligned) return 'align';
    return phase1.exploreSkipped || investigatedDirections(state).length ? 'deep-dive' : 'explore';
}

export interface DirectionTab {
    id: string;
    label: string;
    recommended: boolean;
    /** Whether the user chose to investigate it. A direction dropped since keeps its tab while it has questions. */
    investigated: boolean;
    /** Whether the user went ahead with it. */
    chosen: boolean;
    resolved: number;
    total: number;
}

/** A Phase 1 tab per direction the user investigates or that has questions, in the directions question's option order. */
export function directionTabs(state: Pick<SessionState, 'questions' | 'phases'>): DirectionTab[] {
    const options = directionsQuestion(state)?.options ?? [];
    const investigated = new Set(investigatedDirections(state));
    const questions = Object.values(state.questions);
    return options.flatMap((option) => {
        const own = questions.filter((question) => question.direction === option.id);
        if (!investigated.has(option.id) && own.length === 0) return [];
        const asked = own.filter((question) => !isInfo(question));
        return [
            {
                id: option.id,
                label: option.label,
                recommended: Boolean(option.recommended),
                investigated: investigated.has(option.id),
                chosen: state.phases.phase1.direction === option.id,
                resolved: asked.filter((question) => RESOLVED.has(question.status)).length,
                total: asked.length
            }
        ];
    });
}

// ---------------------------------------------------------------- write-up

export interface NumberedSection {
    section: SectionRecord;
    /** 1-based position, shown as §n. */
    number: number;
}

/** Sections in document order. */
export function orderedSections(state: Pick<SessionState, 'sections'>): NumberedSection[] {
    return Object.values(state.sections)
        .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
        .map((section, index) => ({ section, number: index + 1 }));
}

/** A section's label for the agent and the page: `§4`, or its id before it has a place. */
export function sectionLabel(state: Pick<SessionState, 'sections'>, sectionId: string): string {
    const numbered = orderedSections(state).find(({ section }) => section.id === sectionId);
    return numbered ? `§${numbered.number}` : sectionId;
}

/** The section a block sits in, or undefined when no section lists it. */
export function sectionOfBlock(state: Pick<SessionState, 'sections'>, blockId: string): SectionRecord | undefined {
    return Object.values(state.sections).find((section) => blockIdsOf(section).includes(blockId));
}

/**
 * A section listing a block it cannot: one that does not exist, one it already lists, or one another section holds.
 * `position` is the entry's index in the section's `blocks`, then its column for a block in a row.
 */
export type ListingProblem = { sectionId: string; position: number[]; blockId: string } & (
    | { kind: 'missing' | 'repeated' }
    | { kind: 'shared'; owner: string }
);

/**
 * Every broken section listing. The write-up holds together when each listed block exists and sits once, in one
 * section. With `changed`, a block listed twice counts only in those sections.
 */
export function listingProblems(state: Pick<SessionState, 'sections' | 'blocks'>, changed?: readonly string[]): ListingProblem[] {
    const owners = new Map<string, string>();
    const problems: ListingProblem[] = [];
    for (const section of Object.values(state.sections)) {
        const listed = section.blocks.flatMap((item, index) =>
            typeof item === 'string'
                ? [{ blockId: item, position: [index] }]
                : item.map((blockId, column) => ({ blockId, position: [index, column] }))
        );
        listed.forEach(({ blockId, position }) => {
            const where = { sectionId: section.id, position, blockId };
            const owner = owners.get(blockId);
            if (!Object.hasOwn(state.blocks, blockId)) problems.push({ ...where, kind: 'missing' });
            // Only a section being written now: a repeat saved by an older version would otherwise block every write.
            else if (owner === section.id) {
                if (!changed || changed.includes(section.id)) problems.push({ ...where, kind: 'repeated' });
            } else if (owner !== undefined) problems.push({ ...where, kind: 'shared', owner });
            owners.set(blockId, section.id);
        });
    }
    return problems;
}

/** Blocks the write-up shows: every block some section lists, in document order. */
export function documentBlocks(state: Pick<SessionState, 'sections' | 'blocks'>): BlockRecord[] {
    return orderedSections(state).flatMap(({ section }) =>
        blockIdsOf(section).flatMap((id) => (state.blocks[id] ? [state.blocks[id]] : []))
    );
}

/** An assumption is a `callout` block of tone `assumption` in the write-up. */
export function isAssumption(block: BlockRecord): boolean {
    return block.type === 'callout' && !block.problem && block.config.tone === 'assumption';
}

/** Whether the user has confirmed this assumption at its current version. */
export function isConfirmed(state: Pick<SessionState, 'confirmedAssumptions'>, block: BlockRecord): boolean {
    return state.confirmedAssumptions[block.id] === block.version;
}

/** The assumption's headline, for lists and the agent's log. */
export function assumptionTitle(block: BlockRecord): string {
    const { title, body } = block.config;
    if (typeof title === 'string' && title) return title;
    return typeof body === 'string' ? body.slice(0, 120) : block.id;
}

/** One row of the write-up's Decisions table: an answered question, what was chosen, and whether that still stands. */
export interface DecisionRow {
    questionId: string;
    /** The question's topic, else its title. */
    decision: string;
    /** What the user chose, in words. */
    choice: string;
    /** The user's note on their answer. */
    note?: string;
    /** Set while the answer is in doubt: the agent reworded the question since, or it conflicts with another answer. */
    unsettled?: 'needs-review' | 'conflict';
}

/** Statuses whose saved answer is a decision, settled or not. */
const DECIDED: ReadonlySet<QuestionStatus> = new Set(['answered', 'needs-review', 'conflict']);

/** An answer in words for the Decisions table. */
function choiceOf(question: QuestionRecord, answer: NonNullable<QuestionRecord['answer']>, direction?: string): string {
    if (question.input === 'directions' && direction !== undefined)
        return question.options?.find((option) => option.id === direction)?.label ?? direction;
    if (question.input === 'assumption' && answer.choice === ASSUMPTION_HOLDS)
        // With a topic naming the decision, the statement the user confirmed is the choice.
        return question.topic ? question.title : 'Confirmed';
    if (question.input === 'assumption') return answer.text?.trim() ?? '';
    return describeAnswer(question, answer);
}

/**
 * The decisions the write-up ends with: one row per answered question, in id order, scoped like the Phase 1 gate to the
 * shared questions and the chosen direction's own. The page builds the table from the answers, so the agent never
 * writes one and it cannot drift from what the user said.
 */
export function decisionRows(state: Pick<SessionState, 'questions' | 'phases'>): DecisionRow[] {
    const direction = state.phases.phase1.direction;
    return orderedQuestions(state).flatMap((question): DecisionRow[] => {
        const { answer } = question;
        if (!answer || isInfo(question) || !DECIDED.has(question.status)) return [];
        if (direction !== undefined && question.direction !== undefined && question.direction !== direction) return [];
        const note = answer.note?.trim();
        const { status } = question;
        return [
            {
                questionId: question.id,
                decision: question.topic ?? question.title,
                choice: choiceOf(question, answer, direction),
                ...(note ? { note } : {}),
                ...(status === 'needs-review' || status === 'conflict' ? { unsettled: status } : {})
            }
        ];
    });
}

// ---------------------------------------------------------------- comments

export type ThreadScope = 'interrogate' | 'writeup' | 'proposal' | 'message';

/**
 * Which phase a thread belongs to, from its anchor target:
 * `question:Q-1`, `qblock:Q-1:0` and `understanding` are Phase 1,
 * `section:s1` and `block:b1` are the write-up, `file:<path>` is the proposal.
 */
export function threadScope(thread: Pick<ThreadRecord, 'kind' | 'anchor'>): ThreadScope {
    if (thread.kind === 'message' || !thread.anchor) return 'message';
    const target = thread.anchor.target;
    if (target.startsWith('file:')) return 'proposal';
    if (target.startsWith('section:') || target.startsWith('block:')) return 'writeup';
    return 'interrogate';
}

/** Open comment threads, optionally limited to some scopes. Direct messages are not comments. */
export function openComments(state: Pick<SessionState, 'threads'>, scopes?: readonly ThreadScope[]): ThreadRecord[] {
    return Object.values(state.threads).filter(
        (thread) => thread.kind === 'comment' && thread.status === 'open' && (!scopes || scopes.includes(threadScope(thread)))
    );
}

// ---------------------------------------------------------------- submit and accept gates

/** Everything the submit gate counts: unreviewed sections, unconfirmed assumptions, open comments, unresolved questions. */
export function outstandingItems(state: PlanState): Outstanding[] {
    const items: Outstanding[] = [];
    for (const { section, number } of orderedSections(state)) {
        if (!section.reviewed) {
            const why = section.unreviewedBy === 'agent' ? 'changed by agent, not re-reviewed' : 'not reviewed';
            items.push({ kind: 'section', ref: section.id, label: `§${number} ${section.title} - ${why}` });
        }
    }
    for (const block of documentBlocks(state)) {
        if (isAssumption(block) && !isConfirmed(state, block)) {
            items.push({ kind: 'assumption', ref: block.id, label: `Assumption unconfirmed: ${assumptionTitle(block)}` });
        }
    }
    for (const thread of openComments(state, ['interrogate', 'writeup'])) {
        items.push({
            kind: 'comment',
            ref: thread.id,
            label: `Open comment on ${thread.anchor ? describeAnchor(thread.anchor) : ''}`
        });
    }
    for (const question of phase1Gate(state, state.phases.phase1.direction).unresolved) {
        items.push({ kind: 'question', ref: question.id, label: `${question.id} ${question.status}: ${question.title}` });
    }
    return items;
}

export interface SubmitCounts {
    sections: number;
    assumptions: number;
    comments: number;
    questions: number;
    total: number;
}

/** Outstanding items counted by kind, for the submit bar. */
export function submitCounts(items: readonly Outstanding[]): SubmitCounts {
    const count = (kind: Outstanding['kind']) => items.filter((item) => item.kind === kind).length;
    return {
        sections: count('section'),
        assumptions: count('assumption'),
        comments: count('comment'),
        questions: count('question'),
        total: items.length
    };
}

/** "1 changed section, 1 comment and 2 assumptions still need you." */
export function describeCounts(counts: SubmitCounts): string {
    const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
    const parts = [
        counts.sections && plural(counts.sections, 'section', 'sections'),
        counts.comments && plural(counts.comments, 'comment', 'comments'),
        counts.assumptions && plural(counts.assumptions, 'assumption', 'assumptions'),
        counts.questions && plural(counts.questions, 'question', 'questions')
    ].filter((part): part is string => Boolean(part));
    if (parts.length === 0) return 'Nothing is outstanding.';
    const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
    return `${list} still ${counts.total === 1 ? 'needs' : 'need'} you.`;
}

export interface AcceptGate {
    canAccept: boolean;
    /** Why accepting is disabled, for the button's description. */
    reason?: string;
}

/**
 * "Accept proposal" needs the submitted change to have passed validation, a passing latest validation and no open
 * comment on the proposal. A new submission relocks it: the last validation was of the previous change.
 */
export function acceptGate(state: PlanState): AcceptGate {
    if (state.phases.acceptedAt) return { canAccept: false, reason: 'Already accepted' };
    if (!state.validation?.passed) return { canAccept: false, reason: 'The latest validation did not pass' };
    if (!state.phases.proposalUnlocked) return { canAccept: false, reason: 'The agent is still writing the proposal' };
    const open = openComments(state, ['proposal']).length;
    if (open > 0)
        return {
            canAccept: false,
            reason: `${open} comment${open === 1 ? '' : 's'} on the proposal need${open === 1 ? 's' : ''} resolving`
        };
    return { canAccept: true };
}

/**
 * The check the submitted plan goes through, as the page and the activity feed name it: `openspec validate`, strict
 * unless the submission turned it off, or a Markdown plan's check for its plan file.
 */
export function checkCommand(state: Pick<SessionState, 'changeId' | 'format' | 'phases'>): string {
    if (state.format === 'markdown') return `check ${state.changeId}.md`;
    return `openspec validate ${state.changeId}${state.phases.submission?.validate === false ? '' : ' --strict'}`;
}

/** How ending the session now reads: Cancel until the proposal has validated, Finish from then on. */
export function endHow(state: Pick<SessionState, 'phases'>): 'cancelled' | 'finished' {
    return state.phases.proposalUnlocked ? 'finished' : 'cancelled';
}

/** True once the proposal is accepted or the user ended the session: it then takes no more edits. */
export function isReadOnly(state: Pick<SessionState, 'phases'>): boolean {
    return Boolean(state.phases.acceptedAt || state.phases.ended);
}

/** "Request changes" needs an open comment on the proposal or a message to send with it. */
export function canRequestChanges(state: PlanState, message: string | undefined): boolean {
    return !state.phases.acceptedAt && (openComments(state, ['proposal']).length > 0 || Boolean(message?.trim()));
}

/** How many answered questions at least one traced requirement points back to. */
export function tracedAnswers(state: Pick<SessionState, 'questions' | 'traces'>): { traced: number; answered: number } {
    const tracedIds = new Set(state.traces.flatMap((trace) => trace.questions));
    const answered = Object.values(state.questions).filter((question) => question.status === 'answered');
    return { traced: answered.filter((question) => tracedIds.has(question.id)).length, answered: answered.length };
}

/** The questions a requirement is traced to, or undefined when it has no trace. */
export function traceFor(state: Pick<SessionState, 'traces'>, requirement: string, spec?: string): string[] | undefined {
    const trace = state.traces.find(
        (candidate) => candidate.requirement === requirement && (!candidate.spec || !spec || candidate.spec === spec)
    );
    return trace?.questions;
}

// ---------------------------------------------------------------- tabs

export type Phase = 'interrogate' | 'writeup' | 'proposal' | 'accepted';

/** The furthest phase the session has reached. Submitting starts the proposal. */
export function currentPhase(state: Pick<SessionState, 'phases'>): Phase {
    if (state.phases.acceptedAt) return 'accepted';
    if (state.phases.submission) return 'proposal';
    return state.phases.phase1.completed ? 'writeup' : 'interrogate';
}

/**
 * The phase the page shows: `currentPhase`, with Directions between Interrogate and the write-up while there are
 * direction tabs. The agent's contract keeps `currentPhase`, where Directions is still part of Phase 1.
 */
export type PagePhase = Phase | 'directions';

/** The furthest page phase the session has reached. Picking directions to investigate starts Directions. */
export function pagePhase(state: Pick<SessionState, 'questions' | 'phases'>): PagePhase {
    const phase = currentPhase(state);
    return phase === 'interrogate' && directionTabs(state).length > 0 ? 'directions' : phase;
}

export interface TabState {
    unlocked: boolean;
    /** What unlocks a locked tab, e.g. "After phase 1". */
    lockedLabel?: string;
    /** Why a tab that will not unlock was skipped, e.g. "Skipped: one clear way". */
    skipped?: string;
}

/**
 * The four phase tabs. Interrogate is always open; Directions opens with the first direction tab and is skipped when
 * the agent skipped explore or Phase 1 finished without directions; the write-up opens when Phase 1 completes.
 */
export function tabs(state: Pick<SessionState, 'questions' | 'phases'>): Record<Exclude<PagePhase, 'accepted'>, TabState> {
    const { phase1 } = state.phases;
    const skipped = phase1.exploreSkipped ? 'Skipped: one clear way' : phase1.completed ? 'Skipped' : undefined;
    return {
        interrogate: { unlocked: true },
        directions: directionTabs(state).length
            ? { unlocked: true }
            : skipped
              ? { unlocked: false, skipped }
              : { unlocked: false, lockedLabel: 'After phase 1' },
        writeup: phase1.completed
            ? { unlocked: true }
            : { unlocked: false, lockedLabel: phase1.exploreSkipped ? 'After phase 1' : 'After phase 2' },
        proposal: state.phases.submission ? { unlocked: true } : { unlocked: false, lockedLabel: 'After submit' }
    };
}
