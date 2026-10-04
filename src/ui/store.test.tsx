import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Profiler } from 'react';
import { describe, expect, it } from 'vitest';
import { blockRecord, questionRecord, sectionRecord } from '../test/fixtures';
import { instance, makeView, renderWith, storeWith } from '../test/harness';
import { QuestionCard } from './interrogate/QuestionCard';

function counted(ids: string[]) {
    const renders: Record<string, number> = {};
    const tree = (
        <>
            {ids.map((id) => (
                <Profiler key={id} id={id} onRender={() => (renders[id] = (renders[id] ?? 0) + 1)}>
                    <QuestionCard id={id} />
                </Profiler>
            ))}
        </>
    );
    return { renders, tree };
}

describe('per-record rendering', () => {
    it('one upsert re-renders one card', () => {
        const store = storeWith(makeView({ questions: [questionRecord('Q-13'), questionRecord('Q-14')] }));
        const { renders, tree } = counted(['Q-13', 'Q-14']);
        renderWith(store, tree);
        const before = { ...renders };
        store.apply([
            {
                field: 'questions',
                id: 'Q-13',
                value: questionRecord('Q-13', 'open', { title: 'Reworded', version: 2, contentVersion: 2 })
            }
        ]);
        expect(renders['Q-13']).toBe((before['Q-13'] ?? 0) + 1);
        expect(renders['Q-14']).toBe(before['Q-14']);
        expect(screen.getByText('Reworded')).toBeInTheDocument();
    });

    it('a reconnect snapshot with nothing new re-renders nothing', () => {
        const view = makeView({ questions: [questionRecord('Q-1'), questionRecord('Q-2')] });
        const store = storeWith(view);
        const { renders, tree } = counted(['Q-1', 'Q-2']);
        renderWith(store, tree);
        const before = { ...renders };
        store.snapshot(JSON.parse(JSON.stringify(view)));
        expect(renders).toEqual(before);
    });

    it('a reconnect snapshot replaces a block and section re-created at the same version with other content', () => {
        const store = storeWith(
            makeView({
                sections: [sectionRecord('s1', 1, ['b1'], { title: 'Old title' })],
                blocks: [blockRecord('b1', 'markdown', { text: 'Old text' })]
            })
        );
        store.snapshot(
            makeView({
                sections: [sectionRecord('s1', 1, ['b1'], { title: 'New title' })],
                blocks: [blockRecord('b1', 'markdown', { text: 'New text' })]
            })
        );
        expect(store.getView()?.sections.s1?.title).toBe('New title');
        expect(store.getView()?.blocks.b1?.config).toEqual({ text: 'New text' });
    });

    it('typing while the agent edits another card: text, caret and focus are unchanged', async () => {
        const store = storeWith(makeView({ questions: [questionRecord('Q-13'), questionRecord('Q-14')] }));
        renderWith(
            store,
            <>
                <QuestionCard id="Q-13" />
                <QuestionCard id="Q-14" />
            </>
        );
        const user = userEvent.setup();
        const q14 = instance(document.getElementById('q-Q-14'), HTMLElement);
        await user.click(within(q14).getByRole('radio', { name: /Option A/ }));
        const note = instance(document.getElementById('note-Q-14'), HTMLTextAreaElement);
        await user.type(note, 'Overrides need an expiry');
        note.setSelectionRange(9, 9);
        store.apply([
            {
                field: 'questions',
                id: 'Q-13',
                value: questionRecord('Q-13', 'open', { title: 'Reworded by agent', version: 2, contentVersion: 2 })
            }
        ]);
        expect(screen.getByText('Reworded by agent')).toBeInTheDocument();
        expect(document.activeElement).toBe(note);
        expect(note.value).toBe('Overrides need an expiry');
        expect(note.selectionStart).toBe(9);
        fireEvent.blur(note);
    });
});
