import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { Revision } from '../../shared/revisions';
import { revisionMeta } from '../../shared/revisions';
import { blockRecord, commentThread, NOW, questionRecord, sectionRecord } from '../../test/fixtures';
import { defined, instance, makeView, posted, renderWith, storeWith } from '../../test/harness';
import { writeSetting } from '../local';
import { diffRevisions } from './revisions';
import { SubmitDialog } from './SubmitDialog';
import { Writeup } from './Writeup';

const phases = {
    phase1: { completed: true, path: 'finished' as const },
    submission: null,
    proposalReadyAt: null,
    proposalUnlocked: false,
    acceptedAt: null
};
const bar = (enterprise: number) => ({
    series: ['Sustained'],
    data: [
        ['Team', 600],
        ['Enterprise', enterprise]
    ]
});
const blockContent = (id: string, config: Record<string, unknown>) => ({ id, type: 'bar', config });

/** Two revisions of §4's bar chart. */
const revisions: Revision[] = [
    {
        n: 1,
        at: NOW,
        summary: 'First draft',
        changes: [
            { kind: 'block', id: 's4-bar', before: null, after: blockContent('s4-bar', bar(6000)) },
            {
                kind: 'section',
                id: 's4',
                before: null,
                after: { id: 's4', title: 'Limits by plan', order: 4, blocks: ['s4-bar'] }
            }
        ]
    },
    {
        n: 2,
        at: NOW,
        summary: 'Raised Enterprise',
        changes: [
            { kind: 'block', id: 's4-bar', before: blockContent('s4-bar', bar(6000)), after: blockContent('s4-bar', bar(9000)) }
        ]
    },
    {
        n: 3,
        at: NOW,
        summary: 'Raised it again',
        changes: [
            { kind: 'block', id: 's4-bar', before: blockContent('s4-bar', bar(9000)), after: blockContent('s4-bar', bar(12000)) }
        ]
    }
];

function writeupView(
    overrides: { reviewed?: boolean; unreviewedBy?: 'agent'; assumptions?: boolean; revisionCount?: number } = {}
) {
    const blocks = [blockRecord('s4-bar', 'bar', bar(12000), { version: 3 })];
    if (overrides.assumptions)
        blocks.push(
            blockRecord('a1', 'callout', { tone: 'assumption', title: 'Per region' }),
            blockRecord('a2', 'callout', { tone: 'assumption', title: 'Per org' })
        );
    return makeView(
        {
            questions: [questionRecord('Q-1', 'answered')],
            sections: [
                sectionRecord('s4', 1, overrides.assumptions ? ['s4-bar', 'a1', 'a2'] : ['s4-bar'], {
                    title: 'Limits by plan',
                    reviewed: overrides.reviewed ?? false,
                    ...(overrides.unreviewedBy ? { unreviewedBy: overrides.unreviewedBy, unreviewedAt: NOW } : {})
                })
            ],
            blocks,
            patch: { phases, revision: overrides.revisionCount ?? 3 }
        },
        { revisions: revisionMeta(revisions.slice(0, overrides.revisionCount ?? 3)) }
    );
}

describe('the write-up', () => {
    it('edited after review: the section shows "Unticked · changed by agent" and counts against the submit gate', () => {
        renderWith(storeWith(writeupView({ unreviewedBy: 'agent' })), <Writeup />, 'writeup');
        const section = instance(document.getElementById('section-s4'), HTMLElement);
        expect(section).toHaveTextContent('Unticked · changed by agent');
        expect(within(section).getByRole('checkbox', { name: '§1 reviewed' })).not.toBeChecked();
        expect(screen.getByText('1 section still needs you.')).toBeInTheDocument();
        expect(screen.getByRole('link', { name: /Limits by plan/ }).querySelector('.dot-agent')).not.toBeNull();
    });

    it('renders the lede as markdown, like the understanding it comes from', () => {
        const view = writeupView();
        view.understanding = { text: '`pnpm cli uplink-v2` always ends with **Uplinks sent**.\n\nSecond paragraph.', version: 1 };
        renderWith(storeWith(view), <Writeup />, 'writeup');
        const lede = instance(document.querySelector('.doc-lede'), HTMLElement);
        expect(within(lede).getByText('pnpm cli uplink-v2').tagName).toBe('CODE');
        expect(within(lede).getByText('Uplinks sent').tagName).toBe('STRONG');
        expect(lede).not.toHaveTextContent('`');
        expect(lede).not.toHaveTextContent('Second paragraph');
    });

    it('reviewed: the contents entry shows the tick, and drops it when the agent changes the section', () => {
        const { unmount } = renderWith(storeWith(writeupView({ reviewed: true })), <Writeup />, 'writeup');
        expect(
            within(screen.getByRole('link', { name: /Limits by plan/ })).getByRole('img', { name: 'reviewed' })
        ).toBeInTheDocument();
        unmount();
        renderWith(storeWith(writeupView({ unreviewedBy: 'agent' })), <Writeup />, 'writeup');
        expect(within(screen.getByRole('link', { name: /Limits by plan/ })).queryByRole('img', { name: 'reviewed' })).toBeNull();
    });

    it('collapsed contents: the strip counts reviewed sections and marks each one', () => {
        writeSetting('planroom:rail-collapsed', '1');
        renderWith(storeWith(writeupView({ reviewed: true })), <Writeup />, 'writeup');
        expect(screen.queryByRole('navigation', { name: 'Contents' })).toBeNull();
        const strip = screen.getByRole('navigation', { name: 'Review progress' });
        expect(strip).toHaveTextContent('1/1');
        expect(within(strip).getByRole('link', { name: '§1 Limits by plan, reviewed' })).toBeInTheDocument();
    });

    it('ticking the review box tells the agent', async () => {
        renderWith(storeWith(writeupView()), <Writeup />, 'writeup');
        await userEvent.setup().click(screen.getByRole('checkbox', { name: '§1 reviewed' }));
        await waitFor(() => expect(posted).toEqual([{ type: 'review.mark', sectionId: 's4', reviewed: true }]));
    });

    it('undo: "Undo edit" beside the changed marker undoes the latest edit', async () => {
        renderWith(storeWith(writeupView({ unreviewedBy: 'agent', revisionCount: 2 })), <Writeup />, 'writeup');
        await userEvent.setup().click(screen.getByRole('button', { name: /Undo edit/ }));
        await waitFor(() => expect(posted).toEqual([{ type: 'edit.undo', revision: 2 }]));
    });

    it('superseded edit: in the history, undo of the first of two edits to §1 is disabled with the reason', async () => {
        renderWith(storeWith(writeupView({ unreviewedBy: 'agent' })), <Writeup />, 'writeup');
        await userEvent.setup().click(screen.getByRole('button', { name: /History/ }));
        const dialog = screen.getByRole('dialog', { name: 'Write-up history' });
        const second = instance(within(dialog).getByText('v2 · Raised Enterprise').closest('li'), HTMLLIElement);
        expect(within(second).getByRole('button', { name: 'Undo edit' })).toBeDisabled();
        expect(second).toHaveTextContent('§1 changed again since');
        const third = instance(within(dialog).getByText('v3 · Raised it again').closest('li'), HTMLLIElement);
        expect(within(third).getByRole('button', { name: 'Undo edit' })).toBeEnabled();
    });

    it('diff two revisions: the bar chart is changed, with the Enterprise value marked', () => {
        const [section] = diffRevisions(revisions, 2, 3);
        expect(section).toMatchObject({ id: 's4', change: 'changed', blocks: [{ id: 's4-bar', change: 'changed' }] });
        const parts = defined(section?.blocks[0]).parts;
        expect(parts.filter((part) => part.removed).map((part) => part.value.trim())).toEqual(['9000']);
        expect(parts.filter((part) => part.added).map((part) => part.value.trim())).toEqual(['12000']);
        expect(diffRevisions(revisions, 3, 3)).toEqual([]);
    });
});

describe('decisions and columns', () => {
    it('decisions from answers: the write-up ends with a Decisions section the page builds, last in the contents and never reviewed', () => {
        const view = writeupView();
        view.questions['Q-2'] = questionRecord('Q-2', 'answered', {
            topic: 'Store',
            answer: { choice: 'b', version: 1, at: NOW }
        });
        view.questions['Q-3'] = questionRecord('Q-3', 'needs-review');
        renderWith(storeWith(view), <Writeup />, 'writeup');
        const section = instance(document.getElementById('section-_decisions'), HTMLElement);
        expect(within(section).getByRole('heading', { level: 2 })).toHaveTextContent('2Decisions');
        expect([...section.querySelectorAll('tbody tr')].map((row) => row.textContent)).toEqual([
            'Question Q-1Option AQ-1',
            'StoreOption BQ-2',
            'Question Q-3Option ANeeds reviewQ-3'
        ]);
        expect([...section.querySelectorAll('tbody td:last-child a')].map((link) => link.textContent)).toEqual([
            'Q-1',
            'Q-2',
            'Q-3'
        ]);
        expect(within(section).queryByRole('checkbox')).toBeNull();
        const contents = screen.getByRole('navigation', { name: 'Contents' });
        expect(
            within(contents)
                .getAllByRole('link')
                .map((link) => link.textContent)
        ).toEqual(['1Limits by plan', '2Decisions']);
        // The derived section adds nothing to the gate: only §1 and the question under review need the user.
        expect(screen.getByText('1 section and 1 question still need you.')).toBeInTheDocument();
    });

    it('no answers, no decisions: the section and its contents entry stay away until a question is answered', () => {
        const view = writeupView();
        view.questions = {};
        renderWith(storeWith(view), <Writeup />, 'writeup');
        expect(document.getElementById('section-_decisions')).toBeNull();
        expect(screen.queryByRole('link', { name: /Decisions/ })).toBeNull();
    });

    it('side-by-side columns: a row in a section lists blocks that render next to each other, between the blocks around it', () => {
        const view = makeView({
            questions: [],
            sections: [sectionRecord('s1', 1, ['intro', ['before', 'after'], 'notes'], { title: 'How it works' })],
            blocks: [
                blockRecord('intro', 'text', { body: 'Intro' }),
                blockRecord('before', 'flow', { nodes: [{ id: 'a', label: 'Today' }], edges: [] }),
                blockRecord('after', 'flow', { nodes: [{ id: 'b', label: 'After' }], edges: [] }),
                blockRecord('notes', 'text', { body: 'Notes' })
            ],
            patch: { phases, revision: 1 }
        });
        renderWith(storeWith(view), <Writeup />, 'writeup');
        const section = instance(document.getElementById('section-s1'), HTMLElement);
        const row = instance(section.querySelector('.section-row'), HTMLElement);
        expect([...row.children].map((child) => child.id)).toEqual(['block-before', 'block-after']);
        expect([...section.children].slice(1).map((child) => child.id || child.className)).toEqual([
            'block-intro',
            'section-row',
            'block-notes'
        ]);
    });

    it('moving two blocks into columns is a change to the section in a diff, though no block changed', () => {
        const section = (blocks: (string | string[])[]) => ({ id: 's1', title: 'How', order: 1, blocks });
        const layoutRevisions: Revision[] = [
            {
                n: 1,
                at: NOW,
                summary: 'Draft',
                changes: [
                    { kind: 'block', id: 'a', before: null, after: blockContent('a', bar(1)) },
                    { kind: 'block', id: 'b', before: null, after: blockContent('b', bar(2)) },
                    { kind: 'section', id: 's1', before: null, after: section(['a', 'b']) }
                ]
            },
            {
                n: 2,
                at: NOW,
                summary: 'Side by side',
                changes: [{ kind: 'section', id: 's1', before: section(['a', 'b']), after: section([['a', 'b']]) }]
            }
        ];
        expect(diffRevisions(layoutRevisions, 1, 2)).toEqual([{ id: 's1', title: 'How', change: 'changed', blocks: [] }]);
    });
});

describe('the submit dialog', () => {
    it('blocked submit: "Not quite ready" with each item and its link; "Submit anyway" is the way on', async () => {
        const view = writeupView({ unreviewedBy: 'agent', assumptions: true });
        renderWith(storeWith(view), <SubmitDialog onClose={() => undefined} />, 'writeup');
        const dialog = screen.getByRole('dialog', { name: 'Not quite ready' });
        expect(within(dialog).getByText('§1 Limits by plan - changed by agent, not re-reviewed')).toBeInTheDocument();
        expect(within(dialog).getByText('Assumption unconfirmed: Per region')).toBeInTheDocument();
        expect(within(dialog).getByText('Assumption unconfirmed: Per org')).toBeInTheDocument();
        expect(within(dialog).getAllByRole('link', { name: 'Go' })).toHaveLength(3);
        const user = userEvent.setup();
        await user.click(within(dialog).getByRole('button', { name: 'Submit anyway' }));
        expect(screen.getByText('3 outstanding items will be recorded with the submission.')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Submit & propose' }));
        await waitFor(() =>
            expect(posted).toEqual([{ type: 'phase.submit', changeId: 'add-x', revision: 3, validate: true, anyway: true }])
        );
    });

    it('ready submit: shows the change id, the files and strict validation, then submits', async () => {
        renderWith(storeWith(writeupView({ reviewed: true })), <SubmitDialog onClose={() => undefined} />, 'writeup');
        const dialog = screen.getByRole('dialog', { name: 'Propose this as an OpenSpec change' });
        expect(dialog).toHaveTextContent('add-x');
        expect(dialog).toHaveTextContent('proposal.md');
        expect(dialog).toHaveTextContent('tasks.md');
        const validate = within(dialog).getByRole('checkbox');
        expect(validate).toBeChecked();
        await userEvent.setup().click(within(dialog).getByRole('button', { name: 'Submit & propose' }));
        await waitFor(() => expect(posted).toEqual([{ type: 'phase.submit', changeId: 'add-x', revision: 3, validate: true }]));
    });

    it('a Markdown plan: names the plan file it writes, with no strict validation to choose', async () => {
        const view = { ...writeupView({ reviewed: true }), format: 'markdown' as const };
        renderWith(storeWith(view), <SubmitDialog onClose={() => undefined} />, 'writeup');
        const dialog = screen.getByRole('dialog', { name: 'Write this up as a Markdown plan' });
        expect(dialog).toHaveTextContent('agent-plans/add-x/add-x.md');
        expect(dialog).not.toHaveTextContent('proposal.md');
        expect(within(dialog).queryByRole('checkbox')).toBeNull();
        await userEvent.setup().click(within(dialog).getByRole('button', { name: 'Submit & write plan' }));
        await waitFor(() => expect(posted).toEqual([{ type: 'phase.submit', changeId: 'add-x', revision: 3, validate: true }]));
    });

    it('submitting closes the dialog; the work goes on in the Proposal tab', async () => {
        let closed = false;
        renderWith(storeWith(writeupView({ reviewed: true })), <SubmitDialog onClose={() => (closed = true)} />, 'writeup');
        await userEvent.setup().click(screen.getByRole('button', { name: 'Submit & propose' }));
        await waitFor(() => expect(closed).toBe(true));
    });

    it('open comments count against the gate', () => {
        const view = writeupView({ reviewed: true });
        view.threads = { 'C-1': commentThread('C-1', 'block:s4-bar') };
        renderWith(storeWith(view), <Writeup />, 'writeup');
        expect(screen.getByText('1 comment still needs you.')).toBeInTheDocument();
    });
});
