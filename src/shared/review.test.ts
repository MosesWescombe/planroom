import { describe, expect, it } from 'vitest';
import { NOW } from '../test/fixtures.js';
import {
    commentsMarkdown,
    comparePoints,
    DEFAULT_PREFERENCES,
    deriveComments,
    type ItemRecord,
    type ReviewParts,
    type RoundRecord,
    reviewPreferences,
    roundStage,
    SIGN_OFF_MARKDOWN,
    yoursShare
} from './review.js';

const DRAFT = 'one two three four five six seven eight nine ten';

/** A finding of round 1 with the given fields. */
function item(id: string, fields: Partial<ItemRecord> = {}): ItemRecord {
    return {
        id,
        kind: 'question',
        title: `Finding ${id}`,
        body: 'Why?',
        confidence: 0.7,
        anchor: { file: 'src/retry.ts', side: 'new', start: 10 },
        draft: DRAFT,
        round: 1,
        version: 1,
        updatedAt: NOW,
        ...fields
    };
}

function round(fields: Partial<RoundRecord> = {}): RoundRecord {
    return { n: 1, base: 'a', head: 'b', files: [], startedAt: NOW, summary: {}, posts: {}, earlier: {}, ...fields };
}

function parts(fields: Partial<ReviewParts> = {}, roundFields: Partial<RoundRecord> = {}): ReviewParts {
    return {
        review: {
            target: { kind: 'branch', branch: 'feature', base: 'main' },
            title: 'Feature',
            description: '',
            worktree: '.planroom/reviews/branch-feature/worktree',
            rounds: [round(roundFields)]
        },
        slides: {},
        items: {},
        reactions: {},
        takes: {},
        notes: {},
        ...fields
    };
}

describe('how much of a comment is yours', () => {
    it('counts the words a word diff finds new, ignoring punctuation and spacing', () => {
        expect(yoursShare(DRAFT, DRAFT)).toBe(0);
        expect(yoursShare(DRAFT, 'one two three four five alpha beta gamma delta epsilon')).toBe(50);
        expect(yoursShare(DRAFT, 'one two three four five alpha beta gamma delta epsilon zeta eta theta')).toBe(62);
        expect(yoursShare(DRAFT, `${DRAFT.replace(/ /g, '\n\n')}.`)).toBe(0);
        expect(yoursShare(DRAFT, 'something else entirely')).toBe(100);
    });
});

describe('the comments a round posts', () => {
    it('escapes the sign-off, so Markdown reads it as text rather than a bullet', () => {
        expect(SIGN_OFF_MARKDOWN).toBe('\\- Claude');
    });

    it('takes Agree as the draft signed and locked, Reword as your text, and Reject as nothing', () => {
        const comments = deriveComments(
            parts({
                items: {
                    'I-1': item('I-1'),
                    'I-2': item('I-2', { anchor: { file: 'src/a.ts', side: 'new', start: 3 } }),
                    'I-3': item('I-3')
                },
                reactions: {
                    'I-1': { verdict: 'agree', itemVersion: 1, at: NOW },
                    'I-2': {
                        verdict: 'reword',
                        text: 'one two three four five alpha beta gamma delta epsilon',
                        itemVersion: 1,
                        at: NOW
                    },
                    'I-3': { verdict: 'reject', reason: 'handled', itemVersion: 1, at: NOW }
                }
            }),
            1
        );
        expect(comments.map(({ key, source, yours, signed, locked }) => ({ key, source, yours, signed, locked }))).toEqual([
            { key: 'item:I-2', source: 'reword', yours: 50, signed: true, locked: true },
            { key: 'item:I-1', source: 'agree', yours: 0, signed: true, locked: true }
        ]);
        expect(comments[1]?.body).toBe(`${DRAFT}\n\n${SIGN_OFF_MARKDOWN}`);
    });

    it('lets the sign-off come off above 50%, and never signs a comment you wrote', () => {
        const rewording = 'one two three four five alpha beta gamma delta epsilon zeta eta theta';
        const state = parts({
            items: { 'I-1': item('I-1') },
            reactions: { 'I-1': { verdict: 'reword', text: rewording, unsigned: true, itemVersion: 1, at: NOW } },
            notes: {
                'N-1': { id: 'N-1', round: 1, anchor: { file: 'src/retry.ts', side: 'new', start: 12 }, text: 'Mine', at: NOW }
            }
        });
        const [reworded, note] = deriveComments(state, 1);
        expect(reworded).toMatchObject({ yours: 62, locked: false, signed: false, body: rewording });
        expect(note).toMatchObject({ key: 'note:N-1', yours: null, signed: false, body: 'Mine' });
    });

    it('makes a blocker a task by default, and puts the summary last unless it was deleted', () => {
        const state = parts(
            {
                items: { 'I-1': item('I-1', { kind: 'issue', severity: 'blocker' }) },
                reactions: { 'I-1': { verdict: 'agree', itemVersion: 1, at: NOW } }
            },
            { summary: { draft: 'Looks good.', task: false } }
        );
        const comments = deriveComments(state, 1);
        expect(comments.map(({ key, task }) => ({ key, task }))).toEqual([
            { key: 'item:I-1', task: true },
            { key: 'summary', task: false }
        ]);
        expect(comments[1]).toMatchObject({ body: `Looks good.\n\n${SIGN_OFF_MARKDOWN}`, locked: true });
        expect(comments[1]?.anchor).toBeUndefined();
        const deleted = parts(
            { items: state.items, reactions: state.reactions },
            { summary: { draft: 'Looks good.', deleted: true } }
        );
        expect(deriveComments(deleted, 1).map((comment) => comment.key)).toEqual(['item:I-1']);
    });

    it('copies as Markdown under where each comment sits', () => {
        const state = parts({
            items: { 'I-1': item('I-1') },
            reactions: { 'I-1': { verdict: 'agree', itemVersion: 1, at: NOW } }
        });
        expect(commentsMarkdown('Feature', deriveComments(state, 1))).toBe(
            `## Review: Feature\n\n### src/retry.ts:10\n\n${DRAFT}\n\n${SIGN_OFF_MARKDOWN}\n`
        );
    });
});

describe('where a round stands', () => {
    it('moves from building through the walkthrough and triage to the preview and posted', () => {
        expect(roundStage({ slides: {} }, round())).toBe('building');
        expect(roundStage({ slides: {} }, round({ publishedAt: NOW }))).toBe('walkthrough');
        expect(roundStage({ slides: {} }, round({ publishedAt: NOW, walkthrough: { how: 'skipped', at: NOW } }))).toBe('triage');
        expect(
            roundStage({ slides: {} }, round({ publishedAt: NOW, walkthrough: { how: 'finished', at: NOW }, previewing: true }))
        ).toBe('preview');
        expect(roundStage({ slides: {} }, round({ postedAt: NOW }))).toBe('posted');
        expect(roundStage({ slides: {} }, round({ n: 2 }))).toBe('next-round');
    });
});

describe('pros and cons', () => {
    it('marks the points both lists share and the ones only one has', () => {
        expect(comparePoints(['adds a retry', 'faster'], ['Adds a retry on timeout', 'more code'])).toEqual({
            mine: [true, false],
            agents: [true, false]
        });
    });
});

describe('preferences', () => {
    it('defaults every take and view on at a normal density with standard reviewers, and fills what an older file lacks', () => {
        expect(DEFAULT_PREFERENCES).toEqual({
            takes: { predict: true, prosCons: true, risk: true, check: true },
            density: 'normal',
            reviewers: { strength: 'standard', model: 'sonnet', effort: 'high' },
            views: { pins: true, diff: true, charts: true, heatmap: true, matrix: true }
        });
        expect(reviewPreferences.parse({ takes: { risk: false } }).takes).toEqual({
            predict: true,
            prosCons: true,
            risk: false,
            check: true
        });
        expect(reviewPreferences.parse({ reviewers: { strength: 'single' } }).reviewers).toEqual({
            strength: 'single',
            model: 'sonnet',
            effort: 'high'
        });
    });
});
