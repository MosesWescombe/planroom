import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { AGREED, NOW, phasesWith, questionRecord } from '../../test/fixtures';
import { instance, makeView, posted, renderWith, storeWith } from '../../test/harness';
import { App } from '../App';
import { writeSetting } from '../local';
import { setSendKey } from '../sendKey';
import { DirectionSwitcher, DirectionsPhase, Interrogate } from './Interrogate';
import { QuestionCard } from './QuestionCard';

/** The card of question `id`, failing the test when it is not on the page. */
const card = (id: string) => instance(document.getElementById(`q-${id}`), HTMLElement);

/** The Directions tab as the shell shows it: its tabs bar over the phase. */
function DirectionsTab() {
    return (
        <>
            <DirectionSwitcher />
            <DirectionsPhase />
        </>
    );
}

describe('question cards', () => {
    it('recommended option: only option A says "Agent recommends"', () => {
        renderWith(storeWith(makeView({ questions: [questionRecord('Q-12')] })), <QuestionCard id="Q-12" />);
        const options = within(card('Q-12'))
            .getAllByRole('radio')
            .map((radio) => radio.closest('label'));
        expect(options[0]).toHaveTextContent('Agent recommends');
        expect(options[1]).not.toHaveTextContent('Agent recommends');
    });

    it('diagram in context: the flow renders inside the card, above the options', () => {
        const question = questionRecord('Q-12', 'open', {
            context: {
                why: 'Every request checks Redis.',
                blocks: [
                    {
                        type: 'flow',
                        config: {
                            nodes: [
                                { id: 'a', label: 'Request' },
                                { id: 'b', label: 'Limiter' }
                            ],
                            edges: [{ from: 'a', to: 'b' }]
                        }
                    }
                ]
            }
        });
        renderWith(storeWith(makeView({ questions: [question] })), <QuestionCard id="Q-12" />);
        const diagram = instance(card('Q-12').querySelector('svg.diagram'), SVGElement);
        const firstOption = within(card('Q-12')).getByRole('radio', { name: /Option A/ });
        expect(diagram).toBeInTheDocument();
        expect(diagram.compareDocumentPosition(firstOption) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('keeps source references behind a closed "Sources" disclosure', () => {
        const question = questionRecord('Q-12', 'open', { context: { refs: ['src/lib/redis.ts', 'src/middleware/limiter.ts'] } });
        renderWith(storeWith(makeView({ questions: [question] })), <QuestionCard id="Q-12" />);
        const sources = instance(card('Q-12').querySelector('details.q-refs'), HTMLDetailsElement);
        expect(sources).not.toHaveAttribute('open');
        expect(within(sources).getByText('Sources (2)').tagName).toBe('SUMMARY');
        expect(sources).toHaveTextContent('src/lib/redis.ts');
    });

    it('renders each input type: chips end with "Write my own…", multi toggles, freeform is a text box', () => {
        const questions = [
            questionRecord('Q-1', 'open', { input: 'chips' }),
            questionRecord('Q-2', 'open', { input: 'multi' }),
            questionRecord('Q-3', 'open', { input: 'freeform', options: undefined })
        ];
        renderWith(
            storeWith(makeView({ questions })),
            <>
                <QuestionCard id="Q-1" />
                <QuestionCard id="Q-2" />
                <QuestionCard id="Q-3" />
            </>
        );
        const chips = within(card('Q-1'))
            .getAllByRole('button')
            .filter((button) => button.classList.contains('choice-chip'));
        expect(chips[chips.length - 1]).toHaveTextContent('Write my own…');
        const multi = within(card('Q-2')).getByRole('button', { name: /Option A/ });
        fireEvent.click(multi);
        fireEvent.click(within(card('Q-2')).getByRole('button', { name: /Option B/ }));
        expect(within(card('Q-2')).getAllByRole('button', { pressed: true })).toHaveLength(2);
        expect(within(card('Q-3')).getByLabelText('Your answer')).toBeInstanceOf(HTMLTextAreaElement);
    });

    it('save: posts the answer with its note, and the card shows as answered', async () => {
        const store = storeWith(makeView({ questions: [questionRecord('Q-14')] }));
        renderWith(store, <QuestionCard id="Q-14" />);
        const user = userEvent.setup();
        await user.click(within(card('Q-14')).getByText(/Option B/));
        await user.type(screen.getByLabelText('Add a note (optional)'), 'Overrides need an expiry');
        await user.click(screen.getByRole('button', { name: 'Save answer' }));
        await waitFor(() => expect(posted).toHaveLength(1));
        expect(posted[0]).toEqual({
            type: 'answer.submit',
            questionId: 'Q-14',
            version: 1,
            answer: { choice: 'b', note: 'Overrides need an expiry' }
        });
        act(() =>
            store.apply([
                {
                    field: 'questions',
                    id: 'Q-14',
                    value: questionRecord('Q-14', 'answered', {
                        version: 2,
                        answer: { choice: 'b', note: 'Overrides need an expiry', version: 1, at: NOW }
                    })
                }
            ])
        );
        expect(card('Q-14')).toHaveTextContent('You answered: Option B. Overrides need an expiry');
        expect(window.localStorage.length).toBe(0);
    });

    describe('the send key saves from a text box', () => {
        afterEach(() => setSendKey('shift-enter'));

        it('by default Enter types a new line in the note and Shift+Enter saves', async () => {
            renderWith(storeWith(makeView({ questions: [questionRecord('Q-14')] })), <QuestionCard id="Q-14" />);
            const user = userEvent.setup();
            await user.click(within(card('Q-14')).getByText(/Option B/));
            const note = screen.getByLabelText('Add a note (optional)');
            await user.type(note, 'One{Enter}two');
            expect(note).toHaveValue('One\ntwo');
            expect(posted).toEqual([]);
            await user.type(note, '{Shift>}{Enter}{/Shift}');
            await waitFor(() => expect(posted).toHaveLength(1));
            expect(posted[0]).toMatchObject({ type: 'answer.submit', answer: { choice: 'b', note: 'One\ntwo' } });
        });

        it('with Enter chosen, Enter in a freeform answer saves, and an empty answer is not sent', async () => {
            setSendKey('enter');
            const question = questionRecord('Q-3', 'open', { input: 'freeform', options: undefined });
            renderWith(storeWith(makeView({ questions: [question] })), <QuestionCard id="Q-3" />);
            const user = userEvent.setup();
            const box = screen.getByLabelText('Your answer');
            await user.type(box, '{Enter}');
            expect(posted).toEqual([]);
            await user.type(box, 'Per key{Enter}');
            await waitFor(() => expect(posted).toHaveLength(1));
            expect(posted[0]).toMatchObject({ type: 'answer.submit', questionId: 'Q-3', answer: { text: 'Per key' } });
        });
    });

    it('view then edit: an answered question views disabled with no empty text boxes, and a double-click edits it', async () => {
        const question = questionRecord('Q-14', 'answered', {
            allowOther: true,
            answer: { choice: 'b', version: 1, at: NOW }
        });
        renderWith(storeWith(makeView({ questions: [question] })), <QuestionCard id="Q-14" />);
        const user = userEvent.setup();
        await user.click(within(card('Q-14')).getByRole('button', { name: 'View' }));
        const radios = within(card('Q-14')).getAllByRole('radio');
        expect(radios[1]).toBeChecked();
        radios.forEach((radio) => expect(radio).toBeDisabled());
        expect(within(card('Q-14')).queryByRole('textbox')).toBeNull();

        fireEvent.doubleClick(within(card('Q-14')).getByText('Question Q-14'));
        expect(within(card('Q-14')).getAllByRole('radio')[1]).toBeEnabled();
        expect(within(card('Q-14')).getAllByRole('radio')[1]).toBeChecked();
        expect(within(card('Q-14')).getByRole('textbox', { name: 'Your own answer' })).toBeEnabled();
        expect(within(card('Q-14')).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
        expect(posted).toEqual([]);
    });

    it('view shows a filled note, disabled, and closes back to one line', async () => {
        const question = questionRecord('Q-14', 'answered', {
            answer: { choice: 'b', note: 'Overrides need an expiry', version: 1, at: NOW }
        });
        renderWith(storeWith(makeView({ questions: [question] })), <QuestionCard id="Q-14" />);
        const user = userEvent.setup();
        await user.click(within(card('Q-14')).getByRole('button', { name: 'View' }));
        expect(within(card('Q-14')).getByLabelText('Add a note (optional)')).toBeDisabled();
        await user.click(within(card('Q-14')).getByRole('button', { name: 'Close' }));
        expect(card('Q-14')).toHaveTextContent('You answered: Option B. Overrides need an expiry');
        expect(posted).toEqual([]);
    });

    it('draft survives reload: the selection is still there, marked "Draft kept locally", and nothing was sent', async () => {
        const view = makeView({ questions: [questionRecord('Q-14')] });
        renderWith(storeWith(view), <QuestionCard id="Q-14" />);
        await userEvent.setup().click(within(card('Q-14')).getByText(/Option B/));
        cleanup();
        renderWith(storeWith(view), <QuestionCard id="Q-14" />);
        expect(within(card('Q-14')).getAllByRole('radio')[1]).toBeChecked();
        expect(card('Q-14')).toHaveTextContent('Draft kept locally');
        expect(posted).toEqual([]);
    });

    it('reworded question: shows needs review with the previous answer marked, and "Still right - save" re-submits it', async () => {
        const question = questionRecord('Q-13', 'needs-review', {
            version: 3,
            contentVersion: 3,
            changedByAgentAt: NOW,
            input: 'chips'
        });
        renderWith(storeWith(makeView({ questions: [question] })), <QuestionCard id="Q-13" />);
        expect(card('Q-13')).toHaveTextContent('Needs review');
        expect(card('Q-13')).toHaveTextContent('Reworded by agent');
        expect(within(card('Q-13')).getByRole('button', { name: /Option A/ })).toHaveTextContent('your last answer');
        await userEvent.setup().click(screen.getByRole('button', { name: 'Still right - save' }));
        await waitFor(() =>
            expect(posted).toEqual([{ type: 'answer.submit', questionId: 'Q-13', version: 3, answer: { choice: 'a' } }])
        );
    });

    it('agent drops a picked option: the unsaved picks keep what is still offered, and Save works', async () => {
        const store = storeWith(makeView({ questions: [questionRecord('Q-2', 'open', { input: 'multi' })] }));
        renderWith(store, <QuestionCard id="Q-2" />);
        const user = userEvent.setup();
        await user.click(within(card('Q-2')).getByRole('button', { name: /Option A/ }));
        await user.click(within(card('Q-2')).getByRole('button', { name: /Option B/ }));
        const reworded = questionRecord('Q-2', 'open', {
            input: 'multi',
            version: 2,
            contentVersion: 2,
            options: [
                { id: 'a', label: 'Option A' },
                { id: 'c', label: 'Option C' }
            ]
        });
        act(() => store.apply([{ field: 'questions', id: 'Q-2', value: reworded }]));
        const save = within(card('Q-2')).getByRole('button', { name: 'Save answer' });
        expect(save).toBeEnabled();
        await user.click(save);
        await waitFor(() =>
            expect(posted).toEqual([{ type: 'answer.submit', questionId: 'Q-2', version: 2, answer: { choices: ['a'] } }])
        );
    });

    it('"Still right - save" after the agent drops an option re-submits only the picks still offered', async () => {
        const reviewed = (input: 'multi' | 'single', choices: { choice?: string; choices?: string[] }) =>
            questionRecord('Q-2', 'needs-review', {
                input,
                version: 3,
                contentVersion: 3,
                changedByAgentAt: NOW,
                options: [
                    { id: 'a', label: 'Option A' },
                    { id: 'c', label: 'Option C' }
                ],
                answer: { ...choices, version: 1, at: NOW }
            });
        renderWith(storeWith(makeView({ questions: [reviewed('multi', { choices: ['a', 'b'] })] })), <QuestionCard id="Q-2" />);
        await userEvent.setup().click(screen.getByRole('button', { name: 'Still right - save' }));
        await waitFor(() =>
            expect(posted).toEqual([{ type: 'answer.submit', questionId: 'Q-2', version: 3, answer: { choices: ['a'] } }])
        );
        cleanup();
        renderWith(storeWith(makeView({ questions: [reviewed('single', { choice: 'b' })] })), <QuestionCard id="Q-2" />);
        expect(screen.getByRole('button', { name: 'Still right - save' })).toBeDisabled();
    });

    it('re-sent as streaming with no options, then in full: the unsaved pick survives', async () => {
        const store = storeWith(makeView({ questions: [questionRecord('Q-14')] }));
        renderWith(store, <QuestionCard id="Q-14" />);
        await userEvent.setup().click(within(card('Q-14')).getByText(/Option B/));
        const streaming = questionRecord('Q-14', 'streaming', { options: undefined, version: 2 });
        act(() => store.apply([{ field: 'questions', id: 'Q-14', value: streaming }]));
        const full = questionRecord('Q-14', 'open', { version: 3, contentVersion: 2 });
        act(() => store.apply([{ field: 'questions', id: 'Q-14', value: full }]));
        expect(within(card('Q-14')).getAllByRole('radio')[1]).toBeChecked();
    });

    it('a draft over the answer limit survives reload whole, choice included, and says why it cannot be saved', async () => {
        const view = makeView({ questions: [questionRecord('Q-14')] });
        renderWith(storeWith(view), <QuestionCard id="Q-14" />);
        await userEvent.setup().click(within(card('Q-14')).getByText(/Option B/));
        const long = 'n'.repeat(4001);
        fireEvent.change(screen.getByLabelText('Add a note (optional)'), { target: { value: long } });
        cleanup();
        renderWith(storeWith(view), <QuestionCard id="Q-14" />);
        expect(within(card('Q-14')).getAllByRole('radio')[1]).toBeChecked();
        expect(screen.getByLabelText('Add a note (optional)')).toHaveValue(long);
        const save = screen.getByRole('button', { name: 'Save answer' });
        expect(save).toBeDisabled();
        expect(save).toHaveAttribute('title', 'the note is over the 4000-character limit');
        expect(card('Q-14')).toHaveTextContent('Draft kept locally · the note is over the 4000-character limit');
    });

    it('availability conflict: shows both answers, and "Change Q-3" is sent to the agent', async () => {
        const questions = [
            { ...questionRecord('Q-3', 'answered'), options: [{ id: 'a', label: 'Availability first' }] },
            questionRecord('Q-12', 'conflict', {
                answer: { choice: 'b', version: 1, at: NOW },
                conflict: { with: 'Q-3', reason: 'Failing closed takes the API down with Redis.' }
            })
        ];
        renderWith(storeWith(makeView({ questions })), <QuestionCard id="Q-12" />);
        expect(card('Q-12')).toHaveTextContent('Needs a look');
        expect(card('Q-12')).toHaveTextContent('You: Option B');
        expect(card('Q-12')).toHaveTextContent('where you answered Availability first');
        await userEvent.setup().click(screen.getByRole('button', { name: 'Change Q-3' }));
        await waitFor(() => expect(posted).toEqual([{ type: 'conflict.resolve', questionId: 'Q-12', choice: 'change-other' }]));
    });

    it('closed by agent: collapses to the reason with a Reopen action', async () => {
        renderWith(
            storeWith(
                makeView({ questions: [questionRecord('Q-9', 'closed', { closedReason: 'you ruled out penalties in Q-4.' })] })
            ),
            <QuestionCard id="Q-9" />
        );
        expect(card('Q-9')).toHaveTextContent('Closed by agent: you ruled out penalties in Q-4.');
        await userEvent.setup().click(screen.getByRole('button', { name: 'Reopen' }));
        await waitFor(() => expect(posted).toEqual([{ type: 'question.reopen', questionId: 'Q-9' }]));
    });

    it('merged: collapses to its target, reopenable', () => {
        renderWith(
            storeWith(
                makeView({
                    questions: [
                        questionRecord('Q-7', 'merged', { mergedInto: 'Q-8', closedReason: 'token bucket covers bursts' })
                    ]
                })
            ),
            <QuestionCard id="Q-7" />
        );
        expect(card('Q-7')).toHaveTextContent('Merged into Q-8: token bucket covers bursts');
        expect(screen.getByRole('button', { name: 'Reopen' })).toBeInTheDocument();
    });

    it('being written: shows the agent writing, with no inputs', () => {
        renderWith(
            storeWith(
                makeView({
                    questions: [questionRecord('Q-21', 'streaming', { title: 'Should internal service keys skip limits' })]
                })
            ),
            <QuestionCard id="Q-21" />
        );
        expect(card('Q-21')).toHaveAttribute('aria-busy', 'true');
        expect(card('Q-21')).toHaveTextContent('Agent is writing…');
        expect(within(card('Q-21')).queryAllByRole('radio')).toHaveLength(0);
    });
});

describe('the Interrogate phase', () => {
    it('group counts: 2 answered, 1 closed and 1 open shows 3/4', () => {
        const group = 'deep-dive/failure-modes';
        const questions = [
            questionRecord('Q-1', 'answered', { group }),
            questionRecord('Q-2', 'answered', { group }),
            questionRecord('Q-3', 'closed', { group }),
            questionRecord('Q-4', 'open', { group })
        ];
        renderWith(storeWith(makeView({ questions })), <Interrogate />);
        const nav = screen.getByRole('navigation', { name: 'Question navigator' });
        expect(within(nav).getByRole('link', { name: /Failure modes/ })).toHaveTextContent('3/4');
        expect(within(nav).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '3');
    });

    it('collapsed navigator: still shows the overall count and one ring per group', () => {
        writeSetting('planroom:rail-collapsed', '1');
        const questions = [
            questionRecord('Q-1', 'answered', { group: 'deep-dive/failure-modes' }),
            questionRecord('Q-2', 'open', { group: 'deep-dive/failure-modes' }),
            questionRecord('Q-3', 'open', { group: 'scope/limits' })
        ];
        renderWith(storeWith(makeView({ questions })), <Interrogate />);
        expect(screen.queryByRole('navigation', { name: 'Question navigator' })).toBeNull();
        const strip = screen.getByRole('navigation', { name: 'Question progress' });
        expect(strip).toHaveTextContent('1/3');
        expect(within(strip).getByRole('link', { name: 'Failure modes, 1 of 2 resolved' })).toBeInTheDocument();
        expect(within(strip).getAllByRole('link')).toHaveLength(2);
    });

    it('user suggests a question: sent to the agent and shown as pending', async () => {
        const store = storeWith(makeView({ questions: [questionRecord('Q-1')] }));
        renderWith(store, <Interrogate />);
        const user = userEvent.setup();
        await user.click(screen.getByRole('button', { name: 'Add a question' }));
        await user.type(screen.getByLabelText('Suggest a question for the agent'), 'Should internal service keys skip limits?');
        await user.click(screen.getByRole('button', { name: 'Send' }));
        await waitFor(() =>
            expect(posted).toEqual([{ type: 'question.suggest', text: 'Should internal service keys skip limits?' }])
        );
        act(() =>
            store.apply([
                {
                    field: 'suggestions',
                    id: 'S-1',
                    value: {
                        id: 'S-1',
                        text: 'Should internal service keys skip limits?',
                        status: 'pending',
                        version: 1,
                        createdAt: NOW
                    }
                }
            ])
        );
        expect(screen.getByText('Pending · waiting for the agent')).toBeInTheDocument();
    });

    it('all resolved: "Finish phase 1" is enabled and sends the finished path', async () => {
        const questions = Array.from({ length: 22 }, (_, n) => questionRecord(`Q-${n + 1}`, n % 4 === 0 ? 'closed' : 'answered'));
        renderWith(storeWith(makeView({ questions, patch: AGREED })), <Interrogate />);
        const finish = screen.getByRole('button', { name: 'Finish phase 1' });
        expect(finish).toBeEnabled();
        await userEvent.setup().click(finish);
        await waitFor(() => expect(posted).toEqual([{ type: 'phase.complete', path: 'finished' }]));
    });

    it('finish early: with 8 open questions, Finish completes the phase with assumptions after a confirm', async () => {
        const questions = [
            ...Array.from({ length: 8 }, (_, n) => questionRecord(`Q-${n + 1}`)),
            questionRecord('Q-9', 'answered')
        ];
        renderWith(storeWith(makeView({ questions, patch: AGREED })), <Interrogate />);
        expect(screen.queryByRole('button', { name: 'Draft with assumptions' })).toBeNull();
        const user = userEvent.setup();
        await user.click(screen.getByRole('button', { name: 'Finish phase 1' }));
        expect(screen.getByText('Carry 8 unresolved questions into the write-up as assumptions?')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Finish with assumptions' }));
        await waitFor(() => expect(posted).toEqual([{ type: 'phase.complete', path: 'assumptions' }]));
    });

    it('nothing asked yet: Finish is disabled', () => {
        renderWith(storeWith(makeView({ patch: AGREED })), <Interrogate />);
        expect(screen.getByRole('button', { name: 'Finish phase 1' })).toBeDisabled();
    });

    it('agent working with 3 open questions: Finish shows it and interrupts through the assumptions confirm', async () => {
        const questions = [
            ...Array.from({ length: 3 }, (_, n) => questionRecord(`Q-${n + 1}`)),
            questionRecord('Q-4', 'answered')
        ];
        renderWith(
            storeWith(makeView({ questions, patch: AGREED }, { agent: { mode: 'waiting', queued: 0, working: true } })),
            <Interrogate />
        );
        expect(screen.queryByRole('button', { name: 'Finish phase 1' })).toBeNull();
        const user = userEvent.setup();
        await user.click(screen.getByRole('button', { name: 'Agent working Interrupt and finish' }));
        expect(
            screen.getByText('Interrupt the agent and carry 3 unresolved questions into the write-up as assumptions?')
        ).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Finish with assumptions' }));
        await waitFor(() => expect(posted).toEqual([{ type: 'phase.complete', path: 'assumptions' }]));
    });

    it('agent writing a question: Finish names it, and with the rest resolved still needs the confirm', () => {
        const questions = [questionRecord('Q-1', 'answered'), questionRecord('Q-2', 'streaming')];
        renderWith(storeWith(makeView({ questions, patch: AGREED })), <Interrogate />);
        expect(screen.getByRole('button', { name: /Interrupt and finish/ })).toHaveTextContent('Agent writing Q-2');
    });

    it('agent working with everything resolved: Interrupt and finish sends the finished path at once', async () => {
        const questions = [questionRecord('Q-1', 'answered'), questionRecord('Q-2', 'closed')];
        renderWith(
            storeWith(
                makeView({ questions, patch: AGREED }, { agent: { mode: 'offline', queued: 0, working: true, editing: 'Q-2' } })
            ),
            <Interrogate />
        );
        await userEvent.setup().click(screen.getByRole('button', { name: 'Agent editing Q-2 Interrupt and finish' }));
        await waitFor(() => expect(posted).toEqual([{ type: 'phase.complete', path: 'finished' }]));
    });

    it('agent waiting after an edit: the plain Finish button, no interrupt', () => {
        renderWith(
            storeWith(
                makeView(
                    { questions: [questionRecord('Q-1')], patch: AGREED },
                    { agent: { mode: 'waiting', queued: 0, editing: 'Q-1' } }
                )
            ),
            <Interrogate />
        );
        expect(screen.getByRole('button', { name: 'Finish phase 1' })).toBeEnabled();
        expect(screen.queryByRole('button', { name: /Interrupt/ })).toBeNull();
    });

    it('renders the agent understanding as markdown: code as code, HTML as text', () => {
        const text = 'Calls `queryAll` with **no** limit.\n\nSee <b>this</b> and Q-12.';
        renderWith(
            storeWith(makeView({ questions: [questionRecord('Q-12')], patch: { understanding: { text, version: 1 } } })),
            <Interrogate />
        );
        const understanding = instance(document.getElementById('understanding'), HTMLElement);
        expect(within(understanding).getByText('queryAll').tagName).toBe('CODE');
        expect(within(understanding).getByText('no').tagName).toBe('STRONG');
        expect(understanding.querySelectorAll('p')).toHaveLength(2);
        expect(understanding.querySelector('b')).toBeNull();
        expect(understanding).not.toHaveTextContent('`');
        expect(within(understanding).getByRole('link', { name: 'Q-12' })).toBeInTheDocument();
    });

    it('shows the agent understanding with question links', () => {
        renderWith(
            storeWith(
                makeView({
                    questions: [questionRecord('Q-12')],
                    patch: { understanding: { text: 'Fail open (Q-12).', version: 1 } }
                })
            ),
            <Interrogate />
        );
        const understanding = instance(document.getElementById('understanding'), HTMLElement);
        expect(within(understanding).getByRole('link', { name: 'Q-12' })).toBeInTheDocument();
        expect(understanding.querySelector('[data-anchor-target="understanding"]')).toHaveTextContent('Fail open (Q-12).');
    });
});

describe('phase 1 stages, assumptions and directions', () => {
    const options = [
        { id: 'redis', label: 'Redis token bucket', detail: 'Counts in **Redis**.', recommended: true },
        { id: 'gateway', label: 'Gateway plugin', detail: 'Limits at the edge.', tradeoff: 'Ties us to the gateway' }
    ];
    const offer = (picked?: string[]) =>
        questionRecord('Q-3', picked ? 'answered' : 'open', {
            group: 'explore/approach',
            title: 'Which ways should we investigate?',
            input: 'directions',
            options,
            answer: picked ? { choices: picked, version: 1, at: NOW } : null
        });
    const investigating = (picked: string[], more: ReturnType<typeof questionRecord>[] = []) =>
        makeView({ questions: [offer(picked), ...more], patch: AGREED });

    it('an assumption card: marked as one, and "Holds" or a correction is saved as its answer', async () => {
        const assumption = questionRecord('Q-2', 'open', {
            group: 'align/goals',
            title: 'Only the public API needs limits',
            input: 'assumption',
            options: undefined
        });
        renderWith(storeWith(makeView({ questions: [assumption] })), <QuestionCard id="Q-2" />);
        expect(card('Q-2')).toHaveClass('is-assumption');
        expect(within(card('Q-2')).getByText('Assumption')).toBeInTheDocument();
        const user = userEvent.setup();
        await user.click(screen.getByRole('button', { name: 'Holds' }));
        await user.click(screen.getByRole('button', { name: 'Save answer' }));
        await waitFor(() => expect(posted[0]).toMatchObject({ questionId: 'Q-2', answer: { choice: 'holds' } }));
        cleanup();
        renderWith(storeWith(makeView({ questions: [assumption] })), <QuestionCard id="Q-2" />);
        await user.click(screen.getByRole('button', { name: 'Not quite…' }));
        await user.type(screen.getByLabelText('What is actually the case'), 'Internal keys too');
        await user.click(screen.getByRole('button', { name: 'Save answer' }));
        await waitFor(() => expect(posted[1]).toMatchObject({ answer: { text: 'Internal keys too' } }));
    });

    it('an info card: its context and diagram, a way to ask about it, and nothing to answer or count', () => {
        const info = questionRecord('Q-4', 'open', {
            group: 'deep-dive/failure-modes',
            title: 'How a request reaches the limiter',
            input: 'info',
            options: undefined,
            context: {
                why: 'Every request checks **Redis** first.',
                blocks: [
                    {
                        type: 'flow',
                        config: {
                            nodes: [
                                { id: 'a', label: 'Request' },
                                { id: 'b', label: 'Limiter' }
                            ],
                            edges: [{ from: 'a', to: 'b' }]
                        }
                    }
                ]
            }
        });
        const questions = [questionRecord('Q-1', 'answered', { group: 'deep-dive/failure-modes' }), info];
        renderWith(storeWith(makeView({ questions, patch: AGREED })), <Interrogate />);
        expect(card('Q-4')).toHaveClass('is-info');
        expect(within(card('Q-4')).getByText('Info')).toBeInTheDocument();
        expect(card('Q-4').querySelector('svg.diagram')).toBeInTheDocument();
        expect(within(card('Q-4')).getByRole('button', { name: 'Ask to clarify' })).toBeInTheDocument();
        expect(within(card('Q-4')).queryByRole('button', { name: 'Save answer' })).toBeNull();
        expect(within(card('Q-4')).queryByRole('textbox')).toBeNull();
        const nav = screen.getByRole('navigation', { name: 'Question navigator' });
        expect(within(nav).getByRole('link', { name: /Failure modes/ })).toHaveTextContent('1/1');
        expect(screen.getByRole('button', { name: 'Finish phase 1' })).toBeEnabled();
    });

    it('pick directions: a tab per direction, the recommended one first, and the picked ones are saved', async () => {
        renderWith(storeWith(makeView({ questions: [offer()], patch: AGREED })), <QuestionCard id="Q-3" />);
        expect(card('Q-3')).toHaveClass('is-directions');
        expect(within(card('Q-3')).getByText('Directions')).toHaveClass('badge-directions');
        expect(within(card('Q-3')).queryByText('Q-3')).toBeNull();
        const tabs = within(card('Q-3')).getAllByRole('tab');
        expect(tabs.map((tab) => tab.textContent)).toEqual(['ARedis token bucket', 'BGateway plugin']);
        expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
        expect(screen.getByRole('tabpanel')).toHaveTextContent('Agent recommends');
        const user = userEvent.setup();
        await user.click(screen.getByRole('checkbox', { name: 'Investigate this direction' }));
        await user.click(within(card('Q-3')).getByRole('tab', { name: /Gateway plugin/ }));
        expect(screen.getByRole('tabpanel')).toHaveTextContent('Trade-off: Ties us to the gateway');
        await user.click(screen.getByRole('checkbox', { name: 'Investigate this direction' }));
        const redis = within(card('Q-3')).getByRole('tab', { name: /Redis token bucket/ });
        expect(within(redis).getByText('(investigating)')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Save answer' }));
        await waitFor(() =>
            expect(posted).toEqual([
                { type: 'answer.submit', questionId: 'Q-3', version: 1, answer: { choices: ['redis', 'gateway'] } }
            ])
        );
    });

    it('while aligning, the gate agrees the goals', async () => {
        renderWith(storeWith(makeView({ questions: [questionRecord('Q-1')] })), <Interrogate />);
        expect(screen.queryByRole('button', { name: 'Finish phase 1' })).toBeNull();
        await userEvent.setup().click(screen.getByRole('button', { name: 'Goals agreed - explore approaches' }));
        await waitFor(() => expect(posted).toEqual([{ type: 'stage.advance', to: 'explore' }]));
    });

    it('a skipped explore stage says why', () => {
        const view = makeView({
            questions: [questionRecord('Q-1')],
            patch: {
                phases: phasesWith({ aligned: { by: 'agent', at: NOW }, exploreSkipped: 'Only the gateway sees every call' })
            }
        });
        renderWith(storeWith(view), <Interrogate />);
        expect(screen.getByText('Only the gateway sees every call')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Finish phase 1' })).toBeEnabled();
    });

    it('Interrogate keeps the shared questions; Directions compares the directions, then gives each its own tab', async () => {
        const view = investigating(
            ['redis', 'gateway'],
            [
                questionRecord('Q-4', 'answered', { direction: 'redis', title: 'Which Redis?' }),
                questionRecord('Q-5', 'open', { direction: 'redis', title: 'Key shape?' }),
                questionRecord('Q-6', 'open', { title: 'Shared question' })
            ]
        );
        const { unmount } = renderWith(storeWith(view), <Interrogate />);
        expect(card('Q-6')).toBeInTheDocument();
        expect(document.getElementById('q-Q-4')).toBeNull();
        expect(screen.queryByRole('button', { name: /^Go ahead/ })).toBeNull();
        unmount();

        renderWith(storeWith(view), <DirectionsTab />, 'directions');
        const switcher = screen.getByRole('navigation', { name: 'Directions' });
        expect(within(switcher).getByRole('button', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
        expect(within(switcher).getByRole('button', { name: /Redis token bucket/ })).toHaveTextContent('1/2');
        const redis = screen.getByRole('region', { name: 'Redis token bucket' });
        expect(redis).toHaveTextContent('Recommended');
        expect(redis).toHaveTextContent('Counts in Redis.');
        expect(redis).toHaveTextContent('1 of 2 resolved');
        expect(
            within(screen.getByRole('region', { name: 'Still open from phase 1' })).getByText('Shared question')
        ).toBeVisible();
        expect(document.getElementById('q-Q-5')).toBeNull();
        await userEvent.setup().click(within(redis).getByRole('button', { name: 'Open Redis token bucket' }));
        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Redis token bucket');
        expect(card('Q-5')).toBeInTheDocument();
        expect(document.getElementById('q-Q-6')).toBeNull();
    });

    it('go ahead with a direction from its tab, carrying its unresolved questions after a confirm', async () => {
        const view = investigating(['redis', 'gateway'], [questionRecord('Q-5', 'open', { direction: 'redis' })]);
        renderWith(storeWith(view), <DirectionsTab />, 'directions');
        const user = userEvent.setup();
        const switcher = screen.getByRole('navigation', { name: 'Directions' });
        await user.click(within(switcher).getByRole('button', { name: /Redis token bucket/ }));
        await user.click(screen.getByRole('button', { name: 'Go ahead with Redis token bucket' }));
        expect(
            screen.getByText('Go ahead with Redis token bucket and carry 1 unresolved question into the write-up as assumptions?')
        ).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Go ahead with assumptions' }));
        await waitFor(() => expect(posted).toEqual([{ type: 'phase.complete', path: 'assumptions', direction: 'redis' }]));
    });

    it('the overview has no go-ahead, even with one direction; its tab goes ahead at once', async () => {
        renderWith(storeWith(investigating(['gateway'])), <DirectionsTab />, 'directions');
        expect(screen.queryByRole('button', { name: /^Go ahead/ })).toBeNull();
        const user = userEvent.setup();
        const switcher = screen.getByRole('navigation', { name: 'Directions' });
        await user.click(within(switcher).getByRole('button', { name: /Gateway plugin/ }));
        await user.click(screen.getByRole('button', { name: 'Go ahead with Gateway plugin' }));
        await waitFor(() => expect(posted).toEqual([{ type: 'phase.complete', path: 'finished', direction: 'gateway' }]));
    });

    it('a link to a direction question opens its tab in Directions', async () => {
        const view = makeView({
            questions: [offer(['redis']), questionRecord('Q-5', 'open', { direction: 'redis', title: 'Key shape?' })],
            patch: { ...AGREED, understanding: { text: 'See Q-5.', version: 1 } }
        });
        render(<App store={storeWith(view)} />);
        const user = userEvent.setup();
        await user.click(screen.getByRole('button', { name: /Interrogate/ }));
        expect(document.getElementById('q-Q-5')).toBeNull();
        await user.click(screen.getByRole('link', { name: 'Q-5' }));
        await waitFor(() => expect(card('Q-5')).toBeInTheDocument());
        expect(screen.getByRole('button', { name: /Directions/ })).toHaveAttribute('aria-current', 'page');
    });
});
