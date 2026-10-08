import isEqual from 'lodash/isEqual.js';
import type { Issue } from '../shared/issues.js';
import type { QuestionRecord } from '../shared/questions.js';
import type { BlockRecord, SectionContent, SectionRecord, SuggestionRecord, ThreadRecord } from '../shared/records.js';
import type {
    ItemRecord,
    NoteRecord,
    ReactionRecord,
    ReviewRecord,
    RoundRecord,
    SlideRecord,
    TakeRecord
} from '../shared/review.js';
import type { BlockContent, RevisionChange } from '../shared/revisions.js';
import type { SessionState } from '../shared/state.js';
import type { ActivityEntry, MapField, Patch } from '../shared/view.js';

/** An operation that cannot apply: nothing it did is kept. */
export class RejectedError extends Error {
    /** The message joins the issues, each prefixed with its path. */
    constructor(
        readonly issues: Issue[],
        /** HTTP status for page requests: 400 for a bad request, 404 for a missing record, 409 for a state conflict. */
        readonly status: 400 | 404 | 409 = 409
    ) {
        super(issues.map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message)).join('; '));
    }
}

/** Reject with one issue. */
export function reject(message: string, path = '', status: 400 | 404 | 409 = 409): never {
    throw new RejectedError([{ path, message }], status);
}

/** A block's content as the revision log stores it: its agent-owned fields, deep-copied. */
export function blockContentOf(block: BlockRecord): BlockContent {
    const { id, type, config, caption, refs, technical } = block;
    return JSON.parse(JSON.stringify({ id, type, config, caption, refs, technical }));
}

/** A section's content as the revision log stores it, with its own copy of the block list and of each row in it. */
export function sectionContentOf(section: SectionRecord): SectionContent {
    const { id, title, order, blocks } = section;
    return { id, title, order, blocks: blocks.map((item) => (typeof item === 'string' ? item : [...item])) };
}

/**
 * One operation's working copy of the session. Maps are copied on first write and
 * records replaced, never mutated, so the committed state is untouched until the
 * session swaps it in. Every write records the page patch for it, and every write-up
 * content change records its before and after image for the revision log.
 */
export class Draft {
    readonly state: SessionState;
    private readonly copied = new Set<MapField>();
    private readonly patches = new Map<string, Patch>();
    private readonly docChanges = new Map<string, RevisionChange>();
    readonly activity: Omit<ActivityEntry, 'id'>[] = [];

    /** Start from a shallow copy of `base`. `now` is the operation's timestamp. */
    constructor(
        base: SessionState,
        readonly now: string
    ) {
        this.state = { ...base };
    }

    /** The draft's own copy of a map, made on first write so the committed state is never mutated. */
    private own<T>(field: MapField, current: Record<string, T>): Record<string, T> {
        if (this.copied.has(field)) return current;
        this.copied.add(field);
        return { ...current };
    }

    /** Store a question and record its page patch. */
    putQuestion(record: QuestionRecord): void {
        this.state.questions = this.own('questions', this.state.questions);
        this.state.questions[record.id] = record;
        this.patches.set(`questions:${record.id}`, { field: 'questions', id: record.id, value: record });
    }

    /** Store a suggestion and record its page patch. */
    putSuggestion(record: SuggestionRecord): void {
        this.state.suggestions = this.own('suggestions', this.state.suggestions);
        this.state.suggestions[record.id] = record;
        this.patches.set(`suggestions:${record.id}`, { field: 'suggestions', id: record.id, value: record });
    }

    /** Store a comment thread and record its page patch. */
    putThread(record: ThreadRecord): void {
        this.state.threads = this.own('threads', this.state.threads);
        this.state.threads[record.id] = record;
        this.patches.set(`threads:${record.id}`, { field: 'threads', id: record.id, value: record });
    }

    /** Replace a checklist block's ticks and record the page patch. */
    putTicks(blockId: string, ticks: Record<string, boolean>): void {
        this.state.checklistTicks = this.own('checklistTicks', this.state.checklistTicks);
        this.state.checklistTicks[blockId] = ticks;
        this.patches.set(`checklistTicks:${blockId}`, { field: 'checklistTicks', id: blockId, value: ticks });
    }

    /** Drop a block's ticks and confirmation, and send the page the patches that delete them. */
    forgetPageMarks(blockId: string): void {
        if (Object.hasOwn(this.state.checklistTicks, blockId)) {
            this.state.checklistTicks = this.own('checklistTicks', this.state.checklistTicks);
            delete this.state.checklistTicks[blockId];
            this.patches.set(`checklistTicks:${blockId}`, { field: 'checklistTicks', id: blockId, value: null });
        }
        if (Object.hasOwn(this.state.confirmedAssumptions, blockId)) {
            this.state.confirmedAssumptions = this.own('confirmedAssumptions', this.state.confirmedAssumptions);
            delete this.state.confirmedAssumptions[blockId];
            this.patches.set(`confirmedAssumptions:${blockId}`, { field: 'confirmedAssumptions', id: blockId, value: null });
        }
    }

    /** Record the block version whose assumption the user confirmed, and the page patch. */
    putConfirmed(blockId: string, version: number): void {
        this.state.confirmedAssumptions = this.own('confirmedAssumptions', this.state.confirmedAssumptions);
        this.state.confirmedAssumptions[blockId] = version;
        this.patches.set(`confirmedAssumptions:${blockId}`, { field: 'confirmedAssumptions', id: blockId, value: version });
    }

    /** Store a section and record its page patch, leaving the revision log alone. */
    private storeSection(record: SectionRecord): void {
        this.state.sections = this.own('sections', this.state.sections);
        this.state.sections[record.id] = record;
        this.patches.set(`sections:${record.id}`, { field: 'sections', id: record.id, value: record });
    }

    /** Store a block and record its page patch, leaving the revision log alone. */
    private storeBlock(record: BlockRecord): void {
        this.state.blocks = this.own('blocks', this.state.blocks);
        this.state.blocks[record.id] = record;
        this.patches.set(`blocks:${record.id}`, { field: 'blocks', id: record.id, value: record });
    }

    /** Store a section; `contentChanged` says whether its title, order or blocks changed, for the revision log. */
    putSection(record: SectionRecord, contentChanged: boolean): void {
        if (contentChanged) {
            const key = `section:${record.id}`;
            const previous = this.docChanges.get(key);
            const current = this.state.sections[record.id];
            const before = previous?.kind === 'section' ? previous.before : current ? sectionContentOf(current) : null;
            this.docChanges.set(key, { kind: 'section', id: record.id, before, after: sectionContentOf(record) });
        }
        this.storeSection(record);
    }

    /** Store a block whose content changed, recording it for the revision log. */
    putBlock(record: BlockRecord): void {
        const key = `block:${record.id}`;
        const previous = this.docChanges.get(key);
        const current = this.state.blocks[record.id];
        const before = previous?.kind === 'block' ? previous.before : current ? blockContentOf(current) : null;
        this.docChanges.set(key, { kind: 'block', id: record.id, before, after: blockContentOf(record) });
        this.storeBlock(record);
    }

    /** Remove a block (an undo of its creation), recording it for the revision log. */
    removeBlock(id: string): void {
        const current = this.state.blocks[id];
        if (!current) return;
        const key = `block:${id}`;
        const previous = this.docChanges.get(key);
        const before = previous?.kind === 'block' ? previous.before : blockContentOf(current);
        this.docChanges.set(key, { kind: 'block', id, before, after: null });
        this.state.blocks = this.own('blocks', this.state.blocks);
        delete this.state.blocks[id];
        this.patches.set(`blocks:${id}`, { field: 'blocks', id, value: null });
    }

    /** Remove a section (an undo of its creation), recording it for the revision log. */
    removeSection(id: string): void {
        const current = this.state.sections[id];
        if (!current) return;
        const key = `section:${id}`;
        const previous = this.docChanges.get(key);
        const before = previous?.kind === 'section' ? previous.before : sectionContentOf(current);
        this.docChanges.set(key, { kind: 'section', id, before, after: null });
        this.state.sections = this.own('sections', this.state.sections);
        delete this.state.sections[id];
        this.patches.set(`sections:${id}`, { field: 'sections', id, value: null });
    }

    /** Store a review slide and record its page patch. */
    putSlide(record: SlideRecord): void {
        this.state.slides = this.own('slides', this.state.slides);
        this.state.slides[record.id] = record;
        this.patches.set(`slides:${record.id}`, { field: 'slides', id: record.id, value: record });
    }

    /** Store a review finding and record its page patch. */
    putItem(record: ItemRecord): void {
        this.state.items = this.own('items', this.state.items);
        this.state.items[record.id] = record;
        this.patches.set(`items:${record.id}`, { field: 'items', id: record.id, value: record });
    }

    /** Store the reviewer's reaction to a finding and record its page patch. */
    putReaction(itemId: string, record: ReactionRecord): void {
        this.state.reactions = this.own('reactions', this.state.reactions);
        this.state.reactions[itemId] = record;
        this.patches.set(`reactions:${itemId}`, { field: 'reactions', id: itemId, value: record });
    }

    /** Store the reviewer's answer to a your-take card and record its page patch. */
    putTake(blockId: string, record: TakeRecord): void {
        this.state.takes = this.own('takes', this.state.takes);
        this.state.takes[blockId] = record;
        this.patches.set(`takes:${blockId}`, { field: 'takes', id: blockId, value: record });
    }

    /** Store a comment the reviewer wrote and record its page patch. */
    putNote(record: NoteRecord): void {
        this.state.notes = this.own('notes', this.state.notes);
        this.state.notes[record.id] = record;
        this.patches.set(`notes:${record.id}`, { field: 'notes', id: record.id, value: record });
    }

    /** Remove a comment the reviewer wrote, and send the page the patch that deletes it. */
    removeNote(id: string): void {
        this.state.notes = this.own('notes', this.state.notes);
        delete this.state.notes[id];
        this.patches.set(`notes:${id}`, { field: 'notes', id, value: null });
    }

    /** Replace the review record and record the page patch. */
    setReview(value: ReviewRecord): void {
        this.state.review = value;
        this.patches.set('review', { field: 'review', value });
    }

    /** Replace one round of the review with `change` applied to it, and record the page patch. */
    updateRound(n: number, change: (round: RoundRecord) => RoundRecord): void {
        const review = this.state.review;
        if (!review) throw new Error('updateRound outside a review');
        this.setReview({ ...review, rounds: review.rounds.map((round) => (round.n === n ? change(round) : round)) });
    }

    /** Replace the agent's understanding and record the page patch. */
    setUnderstanding(value: SessionState['understanding']): void {
        this.state.understanding = value;
        this.patches.set('understanding', { field: 'understanding', value });
    }

    /** Replace the proposal traces and record the page patch. */
    setTraces(value: SessionState['traces']): void {
        this.state.traces = value;
        this.patches.set('traces', { field: 'traces', value });
    }

    /** Replace the validation result and record the page patch. */
    setValidation(value: SessionState['validation']): void {
        this.state.validation = value;
        this.patches.set('validation', { field: 'validation', value });
    }

    /** Replace the phase states, recording a patch only when they changed. */
    setPhases(value: SessionState['phases']): void {
        if (isEqual(value, this.state.phases)) return;
        this.state.phases = value;
        this.patches.set('phases', { field: 'phases', value });
    }

    /** Set the write-up revision number and record the page patch. */
    setRevision(value: number): void {
        this.state.revision = value;
        this.patches.set('revision', { field: 'revision', value });
    }

    /** Add an entry to the activity feed, stamped with the operation's time. */
    note(entry: Omit<ActivityEntry, 'id' | 'at'>): void {
        this.activity.push({ ...entry, at: this.now });
    }

    /** Write-up changes recorded so far, dropping any that ended where they started. */
    revisionChanges(): RevisionChange[] {
        return [...this.docChanges.values()].filter((change) => !isEqual(change.before, change.after));
    }

    /** Block ids whose content this operation changed. */
    changedBlocks(): string[] {
        return this.revisionChanges().flatMap((change) => (change.kind === 'block' ? [change.id] : []));
    }

    /** Section ids whose content this operation changed. */
    changedSections(): string[] {
        return this.revisionChanges().flatMap((change) => (change.kind === 'section' ? [change.id] : []));
    }

    /** The page patches to broadcast: the last value written to each record, in first-write order. */
    listPatches(): Patch[] {
        return [...this.patches.values()];
    }
}
