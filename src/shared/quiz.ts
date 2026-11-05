import { z } from 'zod';
import { sectionLabel, sectionOfBlock } from './derive.js';
import type { PageRecord, PieceSpec } from './readthrough.js';
import { type BlockRecord, blockIdsOf, ownRecord, type SectionRecord } from './records.js';
import type { ItemRecord, SlideRecord } from './review.js';
import type { SessionState } from './state.js';

/**
 * Quiz me: multiple-choice questions the agent writes on what the reader has already seen, for them to check
 * themselves against it. The page records what has been on screen and sends it with each request, and the server
 * refuses a question about anything else.
 *
 * What the reader has seen is named by refs: `block:<id>` for a write-up or slide block, `item:<id>` for a finding, and
 * `piece:<round>:<id>` for a read-through piece.
 */

/** One question as the agent writes it: what it is about, its choices, the right one and why. */
export const quizQuestion = z.object({
    /** What it is about: one of the refs a `quiz.request` listed in `seen`. */
    about: z.string().min(1).max(200),
    question: z.string().trim().min(1).max(1000),
    choices: z.array(z.string().trim().min(1).max(500)).min(2).max(5),
    /** The index of the right choice. */
    answer: z.number().int().min(0),
    /** Why the right choice is right, shown once the reader picks. */
    explanation: z.string().trim().min(1).max(2000)
});
export type QuizQuestion = z.infer<typeof quizQuestion>;

/** A stored question: its id, `Z-<n>` in the order sent, and when it was sent. */
export const quizRecord = quizQuestion.extend({ id: z.string(), at: z.string() });
export type QuizRecord = z.infer<typeof quizRecord>;

/** A session's quiz: what the reader had seen, the questions so far, and a request the agent has yet to answer. */
export const quizState = z.object({
    /** Every ref the reader's requests listed: the only things a question may be about. */
    seen: z.array(z.string()),
    questions: z.array(quizRecord),
    /** Set while a request waits for the agent's questions. */
    requestedAt: z.string().optional(),
    /** What the agent said with its latest questions, such as what to read before it can ask more. */
    note: z.string().optional()
});
export type QuizState = z.infer<typeof quizState>;

/** A session's quiz before anything is asked. */
export const EMPTY_QUIZ: QuizState = { seen: [], questions: [] };

/** What a seen ref names: a block on a write-up section or a slide, a finding, or a read-through piece on its page. */
export type QuizPlace =
    | { kind: 'block'; block: BlockRecord; section: SectionRecord; slide?: undefined }
    | { kind: 'block'; block: BlockRecord; section?: undefined; slide: SlideRecord }
    | { kind: 'item'; item: ItemRecord }
    | { kind: 'piece'; page: PageRecord; piece: PieceSpec };

type QuizParts = Pick<SessionState, 'sections' | 'blocks' | 'slides' | 'items' | 'pages'>;

/** What `ref` names in `parts`, or undefined when it names nothing on show: a block in no section or slide, say. */
export function quizPlace(parts: QuizParts, ref: string): QuizPlace | undefined {
    const colon = ref.indexOf(':');
    const kind = ref.slice(0, colon);
    const id = ref.slice(colon + 1);
    if (kind === 'block') {
        const block = ownRecord(parts.blocks, id);
        if (!block) return undefined;
        const section = sectionOfBlock(parts, id);
        if (section) return { kind, block, section };
        const slide = Object.values(parts.slides).find((candidate) => blockIdsOf(candidate).includes(id));
        return slide ? { kind, block, slide } : undefined;
    }
    if (kind === 'item') {
        const item = ownRecord(parts.items, id);
        return item && !item.withdrawn ? { kind, item } : undefined;
    }
    const piece = /^piece:(\d+):(.+)$/.exec(ref);
    if (!piece) return undefined;
    const [, round, pieceId] = piece;
    for (const page of Object.values(parts.pages)) {
        const found = page.round === Number(round) ? page.pieces.find((candidate) => candidate.id === pieceId) : undefined;
        if (found) return { kind: 'piece', page, piece: found };
    }
    return undefined;
}

/** A place in words for the agent, e.g. `flow block in §3 "How it works"` or `src/retry.ts 4-9 on page "Retry cap"`. */
export function describeQuizPlace(parts: Pick<SessionState, 'sections'>, place: QuizPlace): string {
    switch (place.kind) {
        case 'block':
            return place.section
                ? `${place.block.type} block in ${sectionLabel(parts, place.section.id)} "${place.section.title}"`
                : `${place.block.type} block on slide "${place.slide.title}"`;
        case 'item':
            return `finding ${place.item.id}: ${place.item.title}`;
        case 'piece': {
            const { piece, page } = place;
            const lines = piece.lines ?? (piece.oldLines ? `old ${piece.oldLines}` : '');
            return `${piece.file}${lines ? ` ${lines}` : ''} on read-through page "${page.title}"`;
        }
    }
}
