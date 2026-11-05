import { act, cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_QUIZ, type QuizRecord, type QuizState } from '../../shared/quiz';
import { blockRecord, NOW, sectionRecord } from '../../test/fixtures';
import { makeView, OnScreen, posted, renderWith, storeWith } from '../../test/harness';
import { Rail } from '../components/Rail';
import type { Tab } from '../ui';
import { readViewed, VIEWED_MS } from '../viewed';
import { Section } from '../writeup/Section';

const QUESTION: QuizRecord = {
    id: 'Z-1',
    about: 'block:how-text',
    question: 'What does a request meet first?',
    choices: ['The handler', 'The limiter'],
    answer: 1,
    explanation: 'Every request passes the limiter first.',
    at: NOW
};

/** A plan's write-up of one section and block, with `quiz`. */
function writeupView(quiz: QuizState = EMPTY_QUIZ, kind: 'plan' | 'review' = 'plan') {
    return makeView({
        sections: [sectionRecord('how', 1, ['how-text'], { title: 'How it works' })],
        blocks: [blockRecord('how-text', 'text', { body: 'Requests pass the limiter first.' })],
        patch: { quiz, kind }
    });
}

function renderRail(view = writeupView(), tab: Tab = 'writeup') {
    return renderWith(
        storeWith(view),
        <Rail>
            <nav aria-label="Contents">Contents</nav>
        </Rail>,
        tab
    );
}

/** Mark refs as on screen in this browser, as reading them would. */
function seen(...refs: string[]) {
    window.localStorage.setItem('planroom:add-x:viewed', JSON.stringify(refs));
}

afterEach(() => {
    vi.useRealTimers();
});

describe('quiz me', () => {
    it("is offered on a plan's write-up and anywhere in a review, and not while read-only", () => {
        renderRail(writeupView(), 'interrogate');
        expect(screen.queryByRole('button', { name: 'Quiz me' })).toBeNull();
        cleanup();
        renderRail(writeupView(), 'writeup');
        expect(screen.getByRole('button', { name: 'Quiz me' })).toBeInTheDocument();
        cleanup();
        renderRail(writeupView(EMPTY_QUIZ, 'review'), 'findings');
        expect(screen.getByRole('button', { name: 'Quiz me' })).toBeInTheDocument();
        cleanup();
        renderRail({ ...writeupView(), viewOnly: true }, 'writeup');
        expect(screen.queryByRole('button', { name: 'Quiz me' })).toBeNull();
    });

    it('counts a block seen once it has been on screen for a moment', () => {
        vi.stubGlobal('IntersectionObserver', OnScreen);
        vi.useFakeTimers();
        renderWith(storeWith(writeupView()), <Section id="how" />, 'writeup');
        act(() => vi.advanceTimersByTime(VIEWED_MS - 1));
        expect(readViewed('add-x')).toEqual([]);
        act(() => vi.advanceTimersByTime(1));
        expect(readViewed('add-x')).toEqual(['block:how-text']);
    });

    it('asks about what has been seen, showing as loading until the first question comes through', async () => {
        seen('block:how-text');
        const store = storeWith(writeupView());
        renderWith(
            store,
            <Rail>
                <nav aria-label="Contents">Contents</nav>
            </Rail>,
            'writeup'
        );
        await userEvent.click(screen.getByRole('button', { name: 'Quiz me' }));
        expect(posted).toEqual([{ type: 'quiz.request', seen: ['block:how-text'] }]);
        expect(screen.queryByRole('dialog')).toBeNull();
        act(() => store.apply([{ field: 'quiz', value: { seen: ['block:how-text'], questions: [], requestedAt: NOW } }]));
        const loading = screen.getByRole('button', { name: 'Quiz me, the agent is writing your questions' });
        expect(loading).toBeDisabled();
        expect(loading).toHaveTextContent('Writing your quiz…');
        act(() => store.apply([{ field: 'quiz', value: { seen: ['block:how-text'], questions: [QUESTION] } }]));
        await userEvent.click(screen.getByRole('button', { name: 'Quiz me, 1 unanswered' }));
        expect(screen.getByRole('dialog', { name: 'Quiz me' })).toBeInTheDocument();
        expect(posted).toHaveLength(1);
    });

    it("opens on the agent's note instead of asking again", async () => {
        seen('block:how-text');
        renderRail(writeupView({ seen: ['block:how-text'], questions: [], note: 'Read **Risks** first.' }));
        await userEvent.click(screen.getByRole('button', { name: 'Quiz me' }));
        expect(posted).toEqual([]);
        expect(within(screen.getByRole('dialog', { name: 'Quiz me' })).getByText('Risks')).toBeInTheDocument();
    });

    it('asks nothing before anything is read, and says so', async () => {
        renderRail();
        await userEvent.click(screen.getByRole('button', { name: 'Quiz me' }));
        expect(posted).toEqual([]);
        const dialog = within(screen.getByRole('dialog', { name: 'Quiz me' }));
        expect(dialog.getByText(/Nothing to quiz you on yet/)).toBeInTheDocument();
        expect(dialog.getByRole('button', { name: 'Ask for questions' })).toBeDisabled();
    });

    it('shows whether a pick was right and why, keeps the pick, and counts what is left', async () => {
        renderRail(writeupView({ seen: ['block:how-text'], questions: [QUESTION] }));
        await userEvent.click(screen.getByRole('button', { name: 'Quiz me, 1 unanswered' }));
        expect(posted).toEqual([]);
        const dialog = within(screen.getByRole('dialog', { name: 'Quiz me' }));
        await userEvent.click(dialog.getByRole('button', { name: 'The handler' }));
        expect(dialog.getByText('Not quite.')).toBeInTheDocument();
        expect(dialog.getByText('Every request passes the limiter first.')).toBeInTheDocument();
        expect(dialog.getByRole('button', { name: /The limiter.*Right answer/ })).toHaveClass('is-right');
        expect(dialog.getByRole('button', { name: /The handler.*Your pick/ })).toHaveClass('is-wrong');
        expect(dialog.getByRole('status')).toHaveTextContent('0 of 1 right');
        expect(JSON.parse(window.localStorage.getItem('planroom:add-x:quiz-picks') ?? '{}')).toEqual({ 'Z-1': 0 });
        await userEvent.click(dialog.getByRole('button', { name: 'Show me where' }));
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(screen.getByRole('button', { name: 'Quiz me' })).toBeInTheDocument();
    });

    it('asks for more on More, and waits while the agent writes them', async () => {
        seen('block:how-text');
        renderRail(writeupView({ seen: ['block:how-text'], questions: [QUESTION] }));
        await userEvent.click(screen.getByRole('button', { name: 'Quiz me, 1 unanswered' }));
        await userEvent.click(screen.getByRole('button', { name: 'More questions' }));
        expect(posted).toEqual([{ type: 'quiz.request', seen: ['block:how-text'] }]);
        cleanup();
        renderRail(writeupView({ seen: ['block:how-text'], questions: [QUESTION], requestedAt: NOW }));
        await userEvent.click(screen.getByRole('button', { name: 'Quiz me, 1 unanswered' }));
        const dialog = within(screen.getByRole('dialog', { name: 'Quiz me' }));
        expect(dialog.getByText(/The agent is writing questions/)).toBeInTheDocument();
        expect(dialog.getByRole('button', { name: 'More questions' })).toBeDisabled();
    });
});
