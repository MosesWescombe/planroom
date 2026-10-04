import type { QuestionContent, QuestionRecord, QuestionStatus } from '../shared/questions.js';
import type { BlockRecord, SectionItem, SectionRecord, ThreadRecord } from '../shared/records.js';
import { emptyState, type SessionState } from '../shared/state.js';

export const NOW = '2026-09-29T00:00:00.000Z';

/** Agent-side content for a single-choice question. */
export function questionContent(id: string, overrides: Partial<QuestionContent> = {}): QuestionContent {
    return {
        id,
        group: 'scope',
        title: `Question ${id}`,
        input: 'single',
        options: [
            { id: 'a', label: 'Option A', recommended: true },
            { id: 'b', label: 'Option B' }
        ],
        ...overrides
    };
}

/** A stored question in the given status; answered-like statuses carry an answer. */
export function questionRecord(
    id: string,
    status: QuestionStatus = 'open',
    overrides: Partial<QuestionRecord> = {}
): QuestionRecord {
    const answered = status === 'answered' || status === 'needs-review';
    return {
        ...questionContent(id),
        status,
        version: 1,
        contentVersion: 1,
        answer: answered ? { choice: 'a', version: 1, at: NOW } : null,
        createdAt: NOW,
        updatedAt: NOW,
        ...overrides
    };
}

export function sectionRecord(
    id: string,
    order: number,
    blocks: SectionItem[],
    overrides: Partial<SectionRecord> = {}
): SectionRecord {
    return { id, title: `Section ${id}`, order, blocks, version: 1, reviewed: false, updatedAt: NOW, ...overrides };
}

export function blockRecord(
    id: string,
    type: string,
    config: Record<string, unknown>,
    overrides: Partial<BlockRecord> = {}
): BlockRecord {
    return { id, type, config, version: 1, updatedAt: NOW, ...overrides };
}

export function commentThread(id: string, target: string, overrides: Partial<ThreadRecord> = {}): ThreadRecord {
    return {
        id,
        kind: 'comment',
        anchor: { target, position: { start: 0, end: 4 }, quote: { exact: 'text', prefix: '', suffix: '' } },
        intent: 'change',
        status: 'open',
        messages: [{ id: `${id}.1`, author: 'user', text: 'Please change', at: NOW }],
        version: 1,
        createdAt: NOW,
        updatedAt: NOW,
        ...overrides
    };
}

/** A session state with the given records keyed by id. */
export function stateWith(parts: {
    questions?: QuestionRecord[];
    sections?: SectionRecord[];
    blocks?: BlockRecord[];
    threads?: ThreadRecord[];
    patch?: Partial<SessionState>;
}): SessionState {
    const byId = <T extends { id: string }>(records: T[] = []) =>
        Object.fromEntries(records.map((record) => [record.id, record]));
    return {
        ...emptyState('add-x', 'Add X', NOW),
        questions: byId(parts.questions),
        sections: byId(parts.sections),
        blocks: byId(parts.blocks),
        threads: byId(parts.threads),
        ...parts.patch
    };
}

/** Session phases with Phase 1 at the given point, e.g. past the align stage with `{ aligned: { by: 'user', at: NOW } }`. */
export function phasesWith(phase1: Partial<SessionState['phases']['phase1']>): SessionState['phases'] {
    const { phases } = emptyState('add-x', 'Add X', NOW);
    return { ...phases, phase1: { ...phases.phase1, ...phase1 } };
}

/** A patch for a session whose goals are agreed, so Phase 1 is past the align stage. */
export const AGREED: Partial<SessionState> = { phases: phasesWith({ aligned: { by: 'user', at: NOW } }) };
