import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { NOW, questionRecord } from '../../test/fixtures';
import { makeView, posted, storeWith } from '../../test/harness';
import { App } from '../App';

/** An ask with one answered and one open question, rendered as the page renders it. */
function renderAsk(ended = false) {
    const view = makeView({
        questions: [questionRecord('Q-1', 'answered'), questionRecord('Q-2')],
        patch: { kind: 'ask', changeId: 'auth-questions', title: 'Auth migration', output: 'docs/auth.md' }
    });
    if (ended) view.phases = { ...view.phases, ended: { how: 'finished', at: NOW } };
    render(<App store={storeWith(view)} />);
}

describe('an ask', () => {
    it('shows its questions without phases, a plan switcher or End session', () => {
        renderAsk();
        expect(screen.getByRole('heading', { name: 'Auth migration' })).toBeInTheDocument();
        expect(screen.getByText('Question Q-2')).toBeInTheDocument();
        expect(screen.getByText('docs/auth.md')).toBeInTheDocument();
        expect(screen.queryByRole('navigation', { name: 'Planning phases' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Switch plan/ })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    });

    it('sends the answers, asking first while a question is unanswered', async () => {
        renderAsk();
        await userEvent.click(screen.getByRole('button', { name: 'Send answers to the agent' }));
        expect(screen.getByText('Send your answers with 1 question unanswered?')).toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'Send anyway' }));
        expect(posted).toEqual([{ type: 'ask.done' }]);
    });

    it('once sent, says so and offers nothing to send or reopen', () => {
        renderAsk(true);
        expect(screen.getByText('You sent your answers to the agent. This page is read-only.')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Send answers/ })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Reopen' })).not.toBeInTheDocument();
    });
});
