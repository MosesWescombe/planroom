import { diffWords } from 'diff';
import { z } from 'zod';
import {
    type ImpactMapConfig,
    impactMapConfig,
    RISK_AREAS,
    recordId,
    repoPath,
    type TakeKind,
    type YourTakeConfig
} from './blocks.js';
import { contextBlock } from './questions.js';
import { type BlockRecord, blockIdsOf, sectionItem } from './records.js';

/**
 * A review's records and the pure derivations over them. The page and the server both run these, so the stage the
 * page shows is the one the server gates on, and the comments Post sends are the ones the preview drew.
 */

// ---------------------------------------------------------------- the deck

/**
 * The four chapters every deck follows, in order. The deck publishes in two parts: the first three, then Trade-offs,
 * written once the reviewer has sent their concerns on the What it might impact chapter's impact map.
 */
export const CHAPTERS = ['why', 'how', 'touches', 'tradeoffs'] as const;
export const chapter = z.enum(CHAPTERS);
export type Chapter = z.infer<typeof chapter>;
export const CHAPTER_TITLES: Record<Chapter, string> = {
    why: 'Why',
    how: 'How it works',
    touches: 'What it might impact',
    tradeoffs: 'Trade-offs'
};

/** What the agent sends for a slide: its chapter, its place in it, its title and its blocks, laid out like a section's. */
export const slideContent = z.object({
    id: recordId,
    chapter,
    order: z.number(),
    title: z.string().trim().min(1).max(200),
    blocks: z.array(sectionItem).min(1).max(12)
});
export type SlideContent = z.infer<typeof slideContent>;

/** A stored slide: its content, the round it belongs to and its version. */
export const slideRecord = slideContent.extend({
    round: z.number().int().min(1),
    version: z.number().int().min(1),
    updatedAt: z.string()
});
export type SlideRecord = z.infer<typeof slideRecord>;

// ---------------------------------------------------------------- the change

/** What a review is of: a Bitbucket Cloud pull request, or a local branch against its merge base with `base`. */
export const reviewTarget = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('pr'),
        workspace: z.string().min(1),
        repo: z.string().min(1),
        number: z.number().int().positive()
    }),
    z.object({ kind: z.literal('branch'), branch: z.string().min(1), base: z.string().min(1) })
]);
export type ReviewTarget = z.infer<typeof reviewTarget>;

/** One file the change touches, with its line counts. */
export const changedFile = z.object({
    path: z.string(),
    status: z.enum(['added', 'modified', 'removed', 'renamed']),
    /** A renamed file's old path. */
    from: z.string().optional(),
    additions: z.number().int().min(0),
    deletions: z.number().int().min(0)
});
export type ChangedFile = z.infer<typeof changedFile>;

/**
 * Where a finding or comment sits: a file of the diff and lines on its new side, or its old side for removed code.
 * Without `start` it is on the whole file.
 */
export const codeAnchor = z
    .object({
        file: repoPath,
        side: z.enum(['new', 'old']).default('new'),
        start: z.number().int().min(1).optional(),
        end: z.number().int().min(1).optional()
    })
    .refine((anchor) => anchor.end === undefined || (anchor.start !== undefined && anchor.end >= anchor.start), {
        message: 'needs a `start` at or before it',
        path: ['end']
    });
export type CodeAnchor = z.infer<typeof codeAnchor>;

/** An anchor as a reader names it: `src/retry.ts:40-44`, `src/retry.ts (old):12` or the file alone. */
export function describeCodeAnchor(anchor: CodeAnchor): string {
    if (anchor.start === undefined) return anchor.file;
    const lines = anchor.end !== undefined && anchor.end !== anchor.start ? `${anchor.start}-${anchor.end}` : `${anchor.start}`;
    return `${anchor.file}${anchor.side === 'old' ? ' (old)' : ''}:${lines}`;
}

// ---------------------------------------------------------------- findings

/** The dimensions the review runs by, one reviewer each. */
export const DIMENSIONS = ['correctness', 'security', 'performance', 'design', 'tests'] as const;
export const SEVERITIES = ['blocker', 'important', 'minor'] as const;
export type Severity = (typeof SEVERITIES)[number];

/**
 * A finding's kind: an `issue` (a bug, risk or missing test), a design `opinion`, a `question` for the author, or in a
 * later round a `followup` reply on an earlier comment.
 */
export const ITEM_KINDS = ['issue', 'opinion', 'question', 'followup'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

const level = z.number().int().min(1).max(3);
const prose = z.string().trim().min(1).max(8000);

/** A finding's fields, before the rules each kind adds. */
const itemFields = z.object({
    id: recordId,
    kind: z.enum(ITEM_KINDS),
    /** One line: what the finding is. */
    title: z.string().trim().min(1).max(300),
    /** The claim, the opinion or the question, in full. */
    body: prose,
    dimension: z.enum(DIMENSIONS).optional(),
    /** How sure the verify pass is, 0 to 1. */
    confidence: z.number().min(0).max(1),
    anchor: codeAnchor.optional(),
    /** The node of one of the deck's diagrams it is about: a flow or architecture node id, or a sequence actor. */
    diagram: z.object({ block: recordId, node: z.string().min(1).max(120) }).optional(),
    severity: z.enum(SEVERITIES).optional(),
    evidence: prose.optional(),
    suggestion: prose.optional(),
    likelihood: level.optional(),
    impact: level.optional(),
    reasoning: prose.optional(),
    alternative: prose.optional(),
    /** A follow-up's earlier comment, by its key in the round's `earlier`. */
    replyTo: z.string().min(1).max(200).optional(),
    /** What a reader needs to judge it without opening the code: the lines, a before and after, the path it breaks. Never posted. */
    blocks: z.array(contextBlock).max(4).optional(),
    /** The comment to post, in the Markdown subset Bitbucket renders. */
    draft: prose
});

/** The fields each kind needs. */
const ITEM_NEEDS: Record<ItemKind, readonly (keyof z.infer<typeof itemFields>)[]> = {
    issue: ['anchor', 'severity', 'evidence', 'suggestion', 'likelihood', 'impact'],
    opinion: ['anchor', 'reasoning', 'alternative'],
    question: ['anchor'],
    followup: ['replyTo']
};

/** What the agent sends for a finding. Every field its kind needs is required, and an anchor names its lines. */
export const itemContent = itemFields.superRefine((item, ctx) => {
    for (const field of ITEM_NEEDS[item.kind])
        if (item[field] === undefined)
            ctx.addIssue({ code: 'custom', path: [field], message: `an ${item.kind} needs \`${field}\`` });
    if (item.anchor && item.anchor.start === undefined && item.kind !== 'followup')
        ctx.addIssue({ code: 'custom', path: ['anchor', 'start'], message: 'a finding names its lines' });
});
export type ItemContent = z.infer<typeof itemContent>;

/** A stored finding: its content, its round and version, and why the agent withdrew it, if it did. */
export const itemRecord = itemFields.extend({
    round: z.number().int().min(1),
    version: z.number().int().min(1),
    withdrawn: z.object({ reason: z.string(), at: z.string() }).optional(),
    updatedAt: z.string()
});
export type ItemRecord = z.infer<typeof itemRecord>;

/** Agree queues the agent's draft, Reword the reviewer's text, Reject nothing. */
export const verdict = z.enum(['agree', 'reword', 'reject']);
export type Verdict = z.infer<typeof verdict>;

/** The reviewer's reaction to a finding, and their choices for its comment. */
export const reactionRecord = z.object({
    verdict,
    /** A rewording: the comment in the reviewer's words. */
    text: z.string().optional(),
    /** Why the reviewer rejected it. */
    reason: z.string().optional(),
    /** The finding's version when the reviewer reacted. */
    itemVersion: z.number().int().min(1),
    /** "Make it a task": unset takes the default, on for a blocker. */
    task: z.boolean().optional(),
    /** The reviewer took the sign-off off, which counts only while more than half the words are theirs. */
    unsigned: z.boolean().optional(),
    at: z.string()
});
export type ReactionRecord = z.infer<typeof reactionRecord>;

// ---------------------------------------------------------------- your takes

const rating = z.number().int().min(1).max(5);

/** The reviewer's answer to a `yourTake` card, by its kind. */
export const takeAnswer = z
    .discriminatedUnion('kind', [
        z.object({ kind: z.literal('predict'), guess: z.string().trim().min(1).max(2000) }),
        z.object({
            kind: z.literal('prosCons'),
            pros: z.array(z.string().trim().min(1).max(400)).max(12),
            cons: z.array(z.string().trim().min(1).max(400)).max(12)
        }),
        z.object({
            kind: z.literal('risk'),
            ratings: z.object({
                correctness: rating.optional(),
                performance: rating.optional(),
                security: rating.optional(),
                maintainability: rating.optional()
            })
        }),
        z.object({ kind: z.literal('check'), choice: z.number().int().min(0) })
    ])
    .superRefine((answer, ctx) => {
        if (answer.kind === 'prosCons' && answer.pros.length + answer.cons.length === 0)
            ctx.addIssue({ code: 'custom', path: ['pros'], message: 'list a pro or a con' });
        if (answer.kind === 'risk' && RISK_AREAS.every((area) => answer.ratings[area] === undefined))
            ctx.addIssue({ code: 'custom', path: ['ratings'], message: 'rate at least one area' });
    });
export type TakeAnswer = z.infer<typeof takeAnswer>;

/** A take's answer in words, for the agent's log: the guess, the lists, the ratings, or the option and whether it was right. */
export function describeTake(config: YourTakeConfig, answer: TakeAnswer): string {
    switch (answer.kind) {
        case 'predict':
            return `guessed "${answer.guess}"`;
        case 'prosCons':
            return `pros: ${answer.pros.join('; ') || 'none'}. Cons: ${answer.cons.join('; ') || 'none'}.`;
        case 'risk':
            return RISK_AREAS.flatMap((area) =>
                answer.ratings[area] === undefined ? [] : [`${area} ${answer.ratings[area]}`]
            ).join(', ');
        case 'check': {
            const options = config.kind === 'check' ? config.options : [];
            const right = config.kind === 'check' && config.correct === answer.choice;
            return `picked "${options[answer.choice] ?? answer.choice}" (${right ? 'right' : 'wrong'})`;
        }
    }
}

/** A stored answer to a take, with the card's version it answered. */
export const takeRecord = z.object({ answer: takeAnswer, blockVersion: z.number().int().min(1), at: z.string() });
export type TakeRecord = z.infer<typeof takeRecord>;

// ---------------------------------------------------------------- preferences

/** The ways the Review tab shows findings, each of which the reviewer can turn off. */
export const REVIEW_VIEWS = ['pins', 'diff', 'charts', 'heatmap', 'matrix'] as const;
export type ReviewView = (typeof REVIEW_VIEWS)[number];
export const REVIEW_VIEW_TITLES: Record<ReviewView, string> = {
    pins: 'Pins on the diagrams',
    diff: 'Cards beside the diff',
    charts: 'Severity and kind charts',
    heatmap: 'File heat map',
    matrix: 'Risk matrix'
};
export const TAKE_TITLES: Record<TakeKind, string> = {
    predict: 'Predict, then reveal',
    prosCons: 'Pros and cons',
    risk: 'Risk rating',
    check: 'Understanding check'
};

/** How many your-take cards the agent puts in a deck. */
export const DENSITIES = ['light', 'normal', 'heavy'] as const;

/** How many `planroom-reviewer` subagents a review sends off, which is most of its token cost. */
export const REVIEW_STRENGTHS = ['single', 'standard', 'thorough'] as const;
export type ReviewStrength = (typeof REVIEW_STRENGTHS)[number];
export const REVIEW_STRENGTH_DETAILS: Record<ReviewStrength, string> = {
    single: 'One reviewer covers every dimension and checks its own findings.',
    standard: 'One reviewer covers every dimension, then a verifier tries to refute what it found.',
    thorough: 'One reviewer per dimension, then a verifier. Uses the most tokens.'
};

/** The models and efforts a reviewer subagent can run at, as Claude Code's Agent tool names them. */
export const REVIEWER_MODELS = ['haiku', 'sonnet', 'opus', 'fable'] as const;
export const REVIEWER_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/** How many reviewer subagents a round sends off, and at what model and effort. */
export const reviewerSettings = z.object({
    strength: z.enum(REVIEW_STRENGTHS).default('standard'),
    model: z.enum(REVIEWER_MODELS).default('sonnet'),
    effort: z.enum(REVIEWER_EFFORTS).default('high')
});
export type ReviewerSettings = z.infer<typeof reviewerSettings>;

/**
 * The reviewer's preferences, saved per machine: which your-take kinds the agent uses and how often, the reviewer
 * subagents each round offers to start, and which review views show. Every field has its default, so a partial or
 * older file still reads.
 */
const on = z.boolean().default(true);
export const reviewPreferences = z.object({
    takes: z
        .object({ predict: on, prosCons: on, risk: on, check: on })
        .default({ predict: true, prosCons: true, risk: true, check: true }),
    density: z.enum(DENSITIES).default('normal'),
    reviewers: reviewerSettings.default({ strength: 'standard', model: 'sonnet', effort: 'high' }),
    views: z
        .object({ pins: on, diff: on, charts: on, heatmap: on, matrix: on })
        .default({ pins: true, diff: true, charts: true, heatmap: true, matrix: true })
});
export type ReviewPreferences = z.infer<typeof reviewPreferences>;

/** The preferences before the reviewer changes any. */
export const DEFAULT_PREFERENCES: ReviewPreferences = reviewPreferences.parse({});

// ---------------------------------------------------------------- the reviewer's own comments

/** A comment the reviewer writes on a line, a file or, with no anchor, the pull request as a whole. */
export const noteContent = z.object({
    anchor: codeAnchor.optional(),
    text: z.string().trim().min(1).max(8000),
    task: z.boolean().optional()
});
export const noteRecord = noteContent.extend({ id: z.string(), round: z.number().int().min(1), at: z.string() });
export type NoteRecord = z.infer<typeof noteRecord>;

// ---------------------------------------------------------------- rounds

/** One comment Post sent: its Bitbucket ids, recorded as soon as each is created, and what was sent where. */
export const postRecord = z.object({
    id: z.number().int().optional(),
    taskId: z.number().int().optional(),
    body: z.string(),
    anchor: codeAnchor.optional(),
    /** Set while the comment failed and has not been sent since. */
    error: z.string().optional(),
    /** The reviewer dropped it when the author changed its lines, so it is never sent. */
    dropped: z.boolean().optional(),
    at: z.string()
});
export type PostRecord = z.infer<typeof postRecord>;

/** How an earlier comment stands after the author pushed. */
export const EARLIER_LABELS = ['addressed', 'partly', 'not-addressed', 'outdated'] as const;
export type EarlierLabel = (typeof EARLIER_LABELS)[number];

/** A comment from an earlier round, as this round follows it up. */
export const earlierRecord = z.object({
    /** The round it was posted in, and its key there. */
    round: z.number().int().min(1),
    key: z.string(),
    post: postRecord,
    label: z.enum(EARLIER_LABELS).optional(),
    note: z.string().optional(),
    /** The code that shows the label: a unified diff hunk. */
    code: z.string().optional(),
    replies: z.array(z.object({ author: z.string(), text: z.string(), at: z.string() })).default([]),
    /** The reviewer confirmed an addressed comment, so Post resolves its thread and task. */
    confirmed: z.boolean().optional(),
    resolvedAt: z.string().optional()
});
export type EarlierRecord = z.infer<typeof earlierRecord>;

/** A reviewer's questions and concerns on an impact map: under the agent's areas by id, and under areas they added. */
export const impactConcerns = z.object({
    concerns: z.record(z.string(), z.array(z.string())),
    added: z.array(z.object({ title: z.string(), concerns: z.array(z.string()) }))
});
export type ImpactConcerns = z.infer<typeof impactConcerns>;

/** One round of the review: the commits it covers, its deck's progress, the reviewer's progress through it, and its posting. */
export const roundRecord = z.object({
    n: z.number().int().min(1),
    /** The commit the diff is from: the merge base in round 1, the previous round's head after. */
    base: z.string(),
    head: z.string(),
    files: z.array(changedFile),
    startedAt: z.string(),
    /** The chapters and slide titles the agent planned, shown while the deck builds. */
    outline: z.array(z.object({ chapter, title: z.string() })).optional(),
    /** What the agent reports while it builds: pictures drawn of those briefed, and how its review is going. */
    progress: z
        .object({
            pictures: z.object({ drawn: z.number().int().min(0), total: z.number().int().min(0) }).optional(),
            review: z.string().optional()
        })
        .optional(),
    /** The reviewer subagents the reviewer chose for this round, and when they started them. */
    reviewers: reviewerSettings.extend({ at: z.string() }).optional(),
    /** When the first part of the deck, Why to What it might impact, was published. */
    publishedAt: z.string().optional(),
    /** The reviewer's questions and concerns on the impact map, saved as they write them and sent once. */
    impact: impactConcerns.extend({ sentAt: z.string().optional() }).optional(),
    /** When Trade-offs, the second part of the deck, was published. */
    tradeoffsAt: z.string().optional(),
    walkthrough: z.object({ how: z.enum(['finished', 'skipped']), at: z.string() }).optional(),
    /** Set when the reviewer opened Comments with every finding reacted to; a changed reaction clears it. */
    previewing: z.boolean().optional(),
    summary: z
        .object({
            draft: z.string().optional(),
            text: z.string().optional(),
            deleted: z.boolean().optional(),
            task: z.boolean().optional(),
            unsigned: z.boolean().optional()
        })
        .default({}),
    /** Post in flight or stopped: by a partial failure, a moved head, or an error before anything was sent. */
    posting: z
        .object({
            state: z.enum(['posting', 'partial', 'moved', 'error']),
            at: z.string(),
            error: z.string().optional(),
            /** The head the PR moved to, and the comments on lines it changed. */
            moved: z.object({ head: z.string(), keys: z.array(z.string()) }).optional()
        })
        .optional(),
    posts: z.record(z.string(), postRecord).default({}),
    postedAt: z.string().optional(),
    /** Comments from earlier rounds, by `<round>/<key>`. */
    earlier: z.record(z.string(), earlierRecord).default({})
});
export type RoundRecord = z.infer<typeof roundRecord>;

/** A review: what it is of, the PR's title and description, where the worktree is, and its rounds, oldest first. */
export const reviewRecord = z.object({
    target: reviewTarget,
    title: z.string(),
    description: z.string().default(''),
    author: z.string().optional(),
    /** The PR's page on Bitbucket. */
    link: z.string().optional(),
    source: z.string().optional(),
    destination: z.string().optional(),
    /** The worktree's repo-relative path. */
    worktree: z.string(),
    rounds: z.array(roundRecord).min(1)
});
export type ReviewRecord = z.infer<typeof reviewRecord>;

/** The review fields of the session state and the page view. */
export interface ReviewParts {
    review: ReviewRecord | null;
    slides: Record<string, SlideRecord>;
    items: Record<string, ItemRecord>;
    reactions: Record<string, ReactionRecord>;
    takes: Record<string, TakeRecord>;
    notes: Record<string, NoteRecord>;
}

/** The round being worked on: the last one. */
export function currentRound(review: Pick<ReviewRecord, 'rounds'>): RoundRecord {
    return review.rounds[review.rounds.length - 1]!;
}

/** A round's slides in deck order: by chapter, then by order. */
export function deckSlides(parts: Pick<ReviewParts, 'slides'>, round: number): SlideRecord[] {
    return Object.values(parts.slides)
        .filter((slide) => slide.round === round)
        .sort(
            (a, b) => CHAPTERS.indexOf(a.chapter) - CHAPTERS.indexOf(b.chapter) || a.order - b.order || a.id.localeCompare(b.id)
        );
}

/** Whether a slide of `round` is on the page: once its part of the deck is published. */
export function slideShown(
    slide: Pick<SlideRecord, 'chapter'>,
    round: Pick<RoundRecord, 'publishedAt' | 'tradeoffsAt'>
): boolean {
    return Boolean(slide.chapter === 'tradeoffs' ? round.tradeoffsAt : round.publishedAt);
}

/** A round's slides on the page, in deck order. */
export function shownSlides(parts: Pick<ReviewParts, 'slides'>, round: RoundRecord): SlideRecord[] {
    return deckSlides(parts, round.n).filter((slide) => slideShown(slide, round));
}

/** A round's impact map: the `impactMap` block on its slides, with the slide it sits on, if it has a valid one. */
export function impactMapOf(
    parts: Pick<ReviewParts, 'slides'> & { blocks: Record<string, Pick<BlockRecord, 'type' | 'config'>> },
    round: number
): { slideId: string; blockId: string; areas: ImpactMapConfig['areas'] } | undefined {
    for (const slide of deckSlides(parts, round))
        for (const blockId of blockIdsOf(slide)) {
            const block = parts.blocks[blockId];
            const config = block?.type === 'impactMap' ? impactMapConfig.safeParse(block.config).data : undefined;
            if (config) return { slideId: slide.id, blockId, areas: config.areas };
        }
    return undefined;
}

/** A round's findings the agent has not withdrawn, blockers first, then in id order. */
export function roundItems(parts: Pick<ReviewParts, 'items'>, round: number): ItemRecord[] {
    const rank = (item: ItemRecord) => (item.severity ? SEVERITIES.indexOf(item.severity) : SEVERITIES.length);
    return Object.values(parts.items)
        .filter((item) => item.round === round && !item.withdrawn)
        .sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id, undefined, { numeric: true }));
}

/** Where a review round stands; the tabs unlock along it. */
export type ReviewStage = 'building' | 'walkthrough' | 'triage' | 'preview' | 'posted' | 'next-round';

/** The stage of `round`: posted, previewing, triaging once the walkthrough is done, reading once the deck is out, else building. */
export function roundStage(parts: Pick<ReviewParts, 'slides'>, round: RoundRecord): ReviewStage {
    if (round.postedAt) return 'posted';
    if (round.previewing) return 'preview';
    if (round.walkthrough) return 'triage';
    if (round.publishedAt) return 'walkthrough';
    if (round.n > 1 && deckSlides(parts, round.n).length === 0) return 'next-round';
    return 'building';
}

/** The review's stage: its current round's. */
export function reviewStage(parts: Pick<ReviewParts, 'review' | 'slides'>): ReviewStage {
    return parts.review ? roundStage(parts, currentRound(parts.review)) : 'building';
}

/** Whether findings may show: once the reviewer finished or skipped the round's walkthrough. */
export function findingsUnlocked(round: Pick<RoundRecord, 'walkthrough'>): boolean {
    return round.walkthrough !== undefined;
}

/** Findings of the round, follow-ups included, the reviewer has not reacted to yet. */
export function unreacted(parts: Pick<ReviewParts, 'items' | 'reactions'>, round: number): ItemRecord[] {
    return roundItems(parts, round).filter((item) => !parts.reactions[item.id]);
}

// ---------------------------------------------------------------- comments and the sign-off

/** What ends a comment drafted by the agent until the reviewer has made most of it their own. */
export const SIGN_OFF = '- Claude';

/**
 * The sign-off as the comment's Markdown carries it: escaped, since a line of its own starting "- " is a bullet list to
 * Bitbucket's renderer and the preview's alike. Both show it as "- Claude".
 */
export const SIGN_OFF_MARKDOWN = '\\- Claude';

/** Words as a reader counts them: punctuation and spacing do not count. */
function words(text: string): number {
    return text.match(/[\p{L}\p{N}_'’-]+/gu)?.length ?? 0;
}

/**
 * How much of `text` is the reviewer's own, from 0 to 100: the share of its words a word diff against the agent's
 * `draft` finds new. Reformatting moves no words, so it counts for nothing.
 */
export function yoursShare(draft: string, text: string): number {
    let added = 0;
    let total = 0;
    for (const part of diffWords(draft, text)) {
        if (part.removed) continue;
        const count = words(part.value);
        total += count;
        if (part.added) added += count;
    }
    return total === 0 ? 0 : Math.round((100 * added) / total);
}

/** Up to this share of the reviewer's own words, the sign-off stays on. */
export const SIGN_OFF_LOCK = 50;

/** One comment as the preview draws it and Post sends it. */
export interface DerivedComment {
    /** `item:<id>`, `note:<id>` or `summary`. */
    key: string;
    source: 'agree' | 'reword' | 'note' | 'summary';
    itemId?: string;
    /** Where it sits; the summary sits on the PR as a whole. */
    anchor?: CodeAnchor;
    /** A follow-up's earlier comment, by its key in the round's `earlier`. */
    replyTo?: string;
    /** The words before any sign-off. */
    text: string;
    /** What is posted: the text, and the sign-off while signed. */
    body: string;
    /** The share of words that are the reviewer's own; null for a comment the reviewer wrote from scratch. */
    yours: number | null;
    signed: boolean;
    /** The sign-off cannot come off: an agreed draft, or one at most half the reviewer's. */
    locked: boolean;
    task: boolean;
}

/** The body Post sends for `text`, signed or not. */
export function commentBody(text: string, signed: boolean): string {
    const trimmed = text.trim();
    return signed ? `${trimmed}\n\n${SIGN_OFF_MARKDOWN}` : trimmed;
}

/** The sign-off fields for agent-drafted `text`: whether it is signed and locked, and how much is the reviewer's. */
function signOff(
    draft: string,
    text: string,
    unsigned: boolean | undefined
): Pick<DerivedComment, 'yours' | 'signed' | 'locked'> {
    const yours = yoursShare(draft, text);
    const locked = yours <= SIGN_OFF_LOCK;
    return { yours, locked, signed: locked || !unsigned };
}

/** The position order comments read and post in: by file, then by line, the summary last. */
function position(comment: DerivedComment): [number, string, number, string] {
    if (!comment.anchor) return [1, '', 0, comment.key];
    return [0, comment.anchor.file, comment.anchor.start ?? 0, comment.key];
}

/**
 * Every comment a round would post, from its three sources: a reaction to a finding (Agree takes the agent's draft,
 * Reword the reviewer's text, Reject nothing), a comment the reviewer wrote, and the summary, which comes last. Agent
 * text ends with the sign-off while it is at most half the reviewer's own, or when the reviewer has not taken it off.
 */
export function deriveComments(parts: ReviewParts, roundNumber: number): DerivedComment[] {
    const round = parts.review?.rounds.find((candidate) => candidate.n === roundNumber);
    if (!round) return [];
    const comments: DerivedComment[] = [];
    for (const item of roundItems(parts, roundNumber)) {
        const reaction = parts.reactions[item.id];
        if (!reaction || reaction.verdict === 'reject') continue;
        const base = {
            key: `item:${item.id}`,
            itemId: item.id,
            ...(item.anchor ? { anchor: item.anchor } : {}),
            ...(item.replyTo ? { replyTo: item.replyTo } : {}),
            task: reaction.task ?? item.severity === 'blocker'
        };
        if (reaction.verdict === 'agree') {
            comments.push({
                ...base,
                source: 'agree',
                text: item.draft,
                body: commentBody(item.draft, true),
                yours: 0,
                signed: true,
                locked: true
            });
        } else {
            const text = reaction.text?.trim() || item.draft;
            const sign = signOff(item.draft, text, reaction.unsigned);
            comments.push({ ...base, source: 'reword', text, body: commentBody(text, sign.signed), ...sign });
        }
    }
    for (const note of Object.values(parts.notes).filter((candidate) => candidate.round === roundNumber)) {
        comments.push({
            key: `note:${note.id}`,
            source: 'note',
            anchor: note.anchor,
            text: note.text,
            body: commentBody(note.text, false),
            yours: null,
            signed: false,
            locked: false,
            task: note.task ?? false
        });
    }
    comments.sort((a, b) => {
        const [x, y] = [position(a), position(b)];
        return x[0] - y[0] || x[1].localeCompare(y[1]) || x[2] - y[2] || x[3].localeCompare(y[3]);
    });
    const { summary } = round;
    const summaryText = summary.text ?? summary.draft;
    if (!summary.deleted && summaryText?.trim()) {
        const sign =
            summary.draft === undefined
                ? { yours: null, signed: false, locked: false }
                : signOff(summary.draft, summaryText, summary.unsigned);
        comments.push({
            key: 'summary',
            source: 'summary',
            text: summaryText,
            body: commentBody(summaryText, sign.signed),
            ...sign,
            task: summary.task ?? false
        });
    }
    return comments;
}

/** The comments as one Markdown document, for a local branch's Copy as Markdown: each under where it sits, the summary last. */
export function commentsMarkdown(title: string, comments: readonly DerivedComment[]): string {
    const sections = comments.map((comment) => {
        const heading = comment.anchor
            ? describeCodeAnchor(comment.anchor)
            : comment.key === 'summary'
              ? 'Summary'
              : 'On the pull request';
        return `### ${heading}\n\n${comment.body}${comment.task ? '\n\n_Task_' : ''}`;
    });
    return `## Review: ${title}\n\n${sections.join('\n\n')}\n`;
}

// ---------------------------------------------------------------- pros and cons

/** Words too common to say whether two points match. */
const STOPWORDS = new Set(
    'a an and are as at be by for from has have in is it its of on or that the this to was were will with'.split(' ')
);

/** A point's content words, lower-cased. */
function terms(point: string): Set<string> {
    return new Set((point.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => !STOPWORDS.has(word)));
}

/** Whether two points say the same thing: one's words contain the other's, or they share most of them. */
export function samePoint(a: string, b: string): boolean {
    const [x, y] = [terms(a), terms(b)];
    if (x.size === 0 || y.size === 0) return false;
    const shared = [...x].filter((word) => y.has(word)).length;
    return shared === Math.min(x.size, y.size) || shared / new Set([...x, ...y]).size >= 0.5;
}

/**
 * The reviewer's points beside the agent's: which of each list the other shares.
 * ponytail: matches by shared words, so a paraphrase with other words counts as a difference; ask the agent to pair
 * them if that proves too strict.
 */
export function comparePoints(mine: readonly string[], agents: readonly string[]): { mine: boolean[]; agents: boolean[] } {
    return {
        mine: mine.map((point) => agents.some((other) => samePoint(point, other))),
        agents: agents.map((point) => mine.some((other) => samePoint(point, other)))
    };
}

// ---------------------------------------------------------------- the html block's frame

/** What an `html` block may load: its inline script and style, `data:` images and fonts, and nothing over the network. */
export const FRAME_CSP =
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:";

/**
 * The document an `html` block runs as: its policy as the first element of the head, ahead of anything the agent
 * wrote, then the agent's HTML as the body. A policy the agent adds can only narrow it further.
 */
export function frameDocument(html: string): string {
    return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}"><meta charset="utf-8"><style>body{margin:0;font:14px system-ui,sans-serif}</style></head><body>${html}</body></html>`;
}

// ---------------------------------------------------------------- posting

/**
 * Comments go up as drafts (`pending`) the reviewer publishes with "Finish review" in Bitbucket, which sends one
 * notification. The page says which it was.
 * ponytail: the API documents `pending` but not whether its drafts join the UI's "Finish review"; spike 5.1 on a scratch
 * PR settles it. If they do not, set this to false: Post then publishes directly, summary last, and the page says so.
 */
export const POST_AS_DRAFTS = true;
