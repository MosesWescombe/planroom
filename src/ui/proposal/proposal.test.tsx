import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ThreadRecord } from '../../shared/records';
import { parseSpecDelta, parseTasks } from '../../shared/specDelta';
import type { ProposalFile, View } from '../../shared/view';
import { EndSessionButton } from '../components/EndSession';
import { commentThread, NOW, questionRecord } from '../../test/fixtures';
import { instance, makeView, posted, renderWith, storeWith } from '../../test/harness';
import { Proposal } from './Proposal';
import { proposingSteps } from './Proposing';
import { ReviewPanel } from './ReviewPanel';

const spec = (budget: string) =>
    [
        '## ADDED Requirements',
        '',
        '### Requirement: Fail open when the limit store is unavailable',
        '',
        `If the limit check does not complete within ${budget}, the system SHALL serve the request.`,
        '',
        '#### Scenario: Redis times out',
        '',
        '- **WHEN** the limit check exceeds its time budget',
        '- **THEN** the request is served',
        '- **AND** `ratelimit.fail_open` is incremented',
        '',
        '### Requirement: Health endpoints are exempt',
        '',
        'Requests to `/health` SHALL NOT consume tokens.',
        '',
        '#### Scenario: Health check',
        '',
        '- **WHEN** a client calls /health',
        '- **THEN** no token is taken'
    ].join('\n');

function specFile(content: string): ProposalFile {
    return { path: 'specs/rate-limits/spec.md', kind: 'spec', marks: ['ADDED'], content, spec: parseSpecDelta(content) };
}

const tasks = '## 1. Limiter middleware\n\n- [ ] 1.1 Add it\n- [x] 1.2 Lua\n\n## 2. Docs\n\n- [ ] 2.1 Headers\n';

function proposalView(overrides: Partial<View> = {}, threads: ThreadRecord[] = []): View {
    const phases = {
        phase1: { completed: true, path: 'finished' as const },
        submission: { revision: 2, validate: true, outstanding: [], at: NOW },
        proposalReadyAt: NOW,
        proposalUnlocked: true,
        acceptedAt: null
    };
    return makeView(
        {
            questions: [questionRecord('Q-12', 'answered'), questionRecord('Q-13', 'answered')],
            threads,
            patch: {
                phases,
                validation: { passed: true, issues: [], trigger: 'proposal.ready', at: NOW },
                traces: [
                    { spec: 'rate-limits', requirement: 'Fail open when the limit store is unavailable', questions: ['Q-12'] }
                ]
            }
        },
        {
            proposal: {
                scannedAt: NOW,
                files: [
                    { path: 'proposal.md', kind: 'proposal', marks: ['new'], content: '## Why\n\nNoisy integrations.\n' },
                    { path: 'tasks.md', kind: 'tasks', marks: ['new'], content: tasks, tasks: parseTasks(tasks) },
                    specFile(spec('50 ms'))
                ]
            },
            ...overrides
        }
    );
}

describe('proposing', () => {
    it('ticks off the proposal, design, spec deltas and tasks as each file appears, then validation', () => {
        const file = (path: string, kind: ProposalFile['kind'], extra: Partial<ProposalFile> = {}): ProposalFile => ({
            path,
            kind,
            marks: [],
            content: 'x',
            ...extra
        });
        const states = (files: ProposalFile[], validating = false, validation: { passed: boolean } | null = null) =>
            proposingSteps(files, validating, validation, validation ? NOW : null).map((step) => step.state);
        expect(states([])).toEqual(['done', 'current', 'waiting', 'waiting', 'waiting']);
        expect(states([file('proposal.md', 'proposal'), file('design.md', 'design')])).toEqual([
            'done',
            'done',
            'current',
            'waiting',
            'waiting'
        ]);
        const all = [
            file('proposal.md', 'proposal'),
            file('design.md', 'design'),
            file('specs/a/spec.md', 'spec'),
            file('tasks.md', 'tasks', { tasks: [{ title: 'A', total: 2, done: 0 }] })
        ];
        expect(states(all, true)).toEqual(['done', 'done', 'done', 'done', 'current']);
        expect(states(all, false, { passed: false })).toEqual(['done', 'done', 'done', 'done', 'failed']);
        expect(states(all, false, { passed: true })).toEqual(['done', 'done', 'done', 'done', 'done']);
        expect(proposingSteps(all, false, null, null).at(-1)?.label).toBe('Validate --strict');
        expect(proposingSteps(all, false, null, null, { strict: false }).at(-1)?.label).toBe('Validate');
    });

    it('names the validation the submission asked for: strict by default, plain when strict was turned off', () => {
        const view = proposalView();
        renderWith(storeWith(view), <Proposal />, 'proposal');
        expect(screen.getByText('$ openspec validate add-x --strict')).toBeInTheDocument();
        cleanup();
        view.phases = { ...view.phases, submission: { revision: 2, validate: false, outstanding: [], at: NOW } };
        renderWith(storeWith(view), <Proposal />, 'proposal');
        expect(screen.getByText('$ openspec validate add-x')).toBeInTheDocument();
    });

    it('a Markdown plan: writing its one file, then checking it', () => {
        const plan: ProposalFile = { path: 'add-x.md', kind: 'other', marks: [], content: '# Plan' };
        const steps = (files: ProposalFile[], validation: { passed: boolean } | null = null) =>
            proposingSteps(files, false, validation, validation ? NOW : null, { planFile: 'add-x.md' }).map(
                ({ label, state }) => [label, state]
            );
        expect(steps([])).toEqual([
            ['Writing add-x.md', 'current'],
            ['Check add-x.md', 'waiting']
        ]);
        expect(steps([plan], { passed: true })).toEqual([
            ['Writing add-x.md', 'done'],
            ['Check add-x.md', 'done']
        ]);
    });

    it('a Markdown plan under review: no requirement counts, and the plan file shown', () => {
        const view = proposalView({
            format: 'markdown',
            proposal: { scannedAt: NOW, files: [{ path: 'add-x.md', kind: 'other', marks: [], content: '# Add X - plan' }] }
        });
        renderWith(storeWith(view), <Proposal />, 'proposal');
        expect(screen.getByRole('heading', { name: 'Review the plan' })).toBeInTheDocument();
        expect(screen.getByRole('heading', { name: 'Add X - plan' })).toBeInTheDocument();
        expect(screen.getByText('check add-x.md')).toBeInTheDocument();
        cleanup();
        renderWith(storeWith(view), <ReviewPanel />, 'proposal');
        expect(screen.queryByText('CHANGE AT A GLANCE')).toBeNull();
        expect(screen.getByRole('button', { name: 'Accept proposal' })).toBeEnabled();
    });

    it('before the change validates: the tab shows the progress and the files so far, and no review actions', () => {
        const view = proposalView();
        view.phases = { ...view.phases, proposalReadyAt: null, proposalUnlocked: false };
        view.validation = null;
        renderWith(storeWith(view), <Proposal />, 'proposal');
        expect(screen.getByRole('heading', { name: 'Agent is proposing…' })).toBeInTheDocument();
        const steps = within(screen.getByRole('region', { name: 'Proposing progress' })).getAllByRole('listitem');
        expect(steps.map((step) => step.className)).toEqual([
            'step is-done',
            'step is-current',
            'step is-done',
            'step is-done',
            'step is-waiting'
        ]);
        expect(screen.getByRole('heading', { name: /Fail open/ })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Re-run' })).toBeDisabled();
        cleanup();
        renderWith(storeWith(view), <ReviewPanel />, 'proposal');
        expect(screen.queryByRole('button', { name: 'Accept proposal' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Request changes' })).toBeNull();
    });

    it('an ended plan, or one the standalone browser shows, offers no review actions', () => {
        const ended = proposalView();
        ended.phases = { ...ended.phases, ended: { how: 'finished', at: NOW } };
        for (const view of [ended, { ...proposalView(), viewOnly: true as const }]) {
            renderWith(storeWith(view), <ReviewPanel />, 'proposal');
            expect(screen.queryByRole('button', { name: 'Accept proposal' })).toBeNull();
            expect(screen.queryByRole('button', { name: 'Request changes' })).toBeNull();
            cleanup();
        }
    });
});

describe('the change renders as written on disk', () => {
    it('renders each requirement with its WHEN/THEN/AND scenario, and the file tree with its marks', () => {
        renderWith(storeWith(proposalView()), <Proposal />, 'proposal');
        expect(
            screen.getByRole('heading', { name: 'Requirement: Fail open when the limit store is unavailable' })
        ).toBeInTheDocument();
        const steps = [...document.querySelectorAll('.scenario-step dt')].map((term) => term.textContent);
        expect(steps).toEqual(['WHEN', 'THEN', 'AND', 'WHEN', 'THEN']);
        const files = screen.getByRole('navigation', { name: 'Change files' });
        // jsdom names the <wbr> after the slash as a space; browsers leave it out.
        expect(within(files).getByRole('link', { name: /rate-limits\/ ?spec.md/ })).toHaveTextContent('ADDED');
        expect(within(files).getByRole('link', { name: /tasks.md/ })).toHaveTextContent('3 tasks');
        expect(within(files).getByRole('link', { name: /proposal.md/ })).toHaveTextContent('new');
    });

    it('lists each nested file under its own top folder, not all under specs/', () => {
        const view = proposalView();
        const handoff: ProposalFile = { path: 'handoff/HANDOFF.md', kind: 'other', marks: [], content: '# Handoff' };
        view.proposal = { ...view.proposal, files: [...view.proposal.files, handoff] };
        renderWith(storeWith(view), <Proposal />, 'proposal');
        const files = screen.getByRole('navigation', { name: 'Change files' });
        expect([...files.querySelectorAll('.folder')].map((folder) => folder.textContent)).toEqual([
            'add-x/',
            'specs/',
            'handoff/'
        ]);
        expect(within(files).getByRole('link', { name: 'HANDOFF.md' })).toBeInTheDocument();
    });

    it('traced requirement: shows a Q-12 link; an untraced one is marked', () => {
        renderWith(storeWith(proposalView()), <Proposal />, 'proposal');
        const traced = instance(screen.getByRole('heading', { name: /Fail open/ }).closest('section'), HTMLElement);
        expect(within(traced).getByRole('link', { name: 'Q-12' })).toBeInTheDocument();
        const untraced = instance(screen.getByRole('heading', { name: /Health endpoints/ }).closest('section'), HTMLElement);
        expect(untraced).toHaveTextContent('Untraced');
    });

    it('agent edits a spec: the rendered requirement updates without a reload', () => {
        const view = proposalView();
        const store = storeWith(view);
        renderWith(store, <Proposal />, 'proposal');
        expect(screen.getByText(/within 50 ms/)).toBeInTheDocument();
        act(() =>
            store.apply([
                {
                    field: 'proposal',
                    value: {
                        ...view.proposal,
                        files: view.proposal.files.map((file) =>
                            file.kind === 'spec' ? specFile(spec('a configurable budget')) : file
                        )
                    }
                }
            ])
        );
        expect(screen.getByText(/within a configurable budget/)).toBeInTheDocument();
    });

    it('toggles to the raw markdown, which stays commentable', () => {
        renderWith(storeWith(proposalView()), <Proposal />, 'proposal');
        fireEvent.click(screen.getByRole('tab', { name: 'Markdown' }));
        expect(document.querySelector('.raw-markdown')).toHaveTextContent('#### Scenario: Redis times out');
        expect(document.querySelector('[data-anchor-target="file:specs/rate-limits/spec.md"]')).not.toBeNull();
    });

    it('re-run after a hand edit: sends the re-run and shows the result that replaces it', async () => {
        const store = storeWith(proposalView());
        renderWith(store, <Proposal />, 'proposal');
        expect(screen.getByText('Validation passed')).toBeInTheDocument();
        await userEvent.setup().click(screen.getByRole('button', { name: 'Re-run' }));
        await waitFor(() => expect(posted).toEqual([{ type: 'validation.rerun' }]));
        act(() =>
            store.apply([
                {
                    field: 'validation',
                    value: {
                        passed: false,
                        issues: [{ level: 'ERROR', path: 'tasks.md', message: 'Bad task' }],
                        trigger: 'rerun',
                        at: NOW
                    }
                }
            ])
        );
        expect(screen.getByText('Validation failed')).toBeInTheDocument();
        expect(screen.getByText('tasks.md: Bad task')).toBeInTheDocument();
    });
});

describe('the review panel', () => {
    it('summarises the change and how many answers are traced', () => {
        renderWith(storeWith(proposalView()), <ReviewPanel />, 'proposal');
        const tiles = [...document.querySelectorAll('.glance-tile')].map((tile) => tile.textContent);
        expect(tiles).toEqual(['2requirements added', '0requirements modified', '3tasks in 2 groups', '1/2answers traced']);
    });

    it('accept: tells the agent', async () => {
        renderWith(storeWith(proposalView()), <ReviewPanel />, 'proposal');
        await userEvent.setup().click(screen.getByRole('button', { name: 'Accept proposal' }));
        await waitFor(() => expect(posted).toEqual([{ type: 'proposal.accept' }]));
    });

    it('accept blocked by a comment: disabled, saying the comment needs resolving', () => {
        renderWith(
            storeWith(proposalView({}, [commentThread('C-1', 'file:specs/rate-limits/spec.md')])),
            <ReviewPanel />,
            'proposal'
        );
        const accept = screen.getByRole('button', { name: 'Accept proposal' });
        expect(accept).toBeDisabled();
        expect(accept).toHaveAccessibleDescription('1 comment on the proposal needs resolving');
    });

    it('request changes needs a comment or a message', async () => {
        renderWith(storeWith(proposalView()), <ReviewPanel />, 'proposal');
        const user = userEvent.setup();
        await user.click(screen.getByRole('button', { name: 'Request changes' }));
        const send = screen.getByRole('button', { name: 'Send to agent' });
        expect(send).toBeDisabled();
        await user.type(screen.getByLabelText('What should change?'), 'Split the spec in two');
        await user.click(send);
        await waitFor(() => expect(posted).toEqual([{ type: 'proposal.requestChanges', text: 'Split the spec in two' }]));
    });

    it('once accepted, shows no actions', () => {
        const view = proposalView();
        view.phases = { ...view.phases, acceptedAt: NOW };
        renderWith(storeWith(view), <ReviewPanel />, 'proposal');
        expect(screen.queryByRole('button', { name: 'Accept proposal' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Request changes' })).toBeNull();
    });
});

describe('ending the session', () => {
    it('reads Cancel until the proposal validates, and asks before ending', async () => {
        const phases = { ...proposalView().phases, proposalUnlocked: false };
        renderWith(storeWith(proposalView({ phases })), <EndSessionButton />, 'proposal');
        const user = userEvent.setup();
        await user.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(posted).toEqual([]);
        await user.click(screen.getByRole('button', { name: 'Cancel session' }));
        await waitFor(() => expect(posted).toEqual([{ type: 'session.end' }]));
    });

    it('reads Finish once the proposal validates, also at the foot of the proposal', () => {
        renderWith(storeWith(proposalView()), <Proposal />, 'proposal');
        expect(screen.getByRole('button', { name: 'Finish' })).toBeInTheDocument();
    });

    it('is hidden once the session is read-only', () => {
        const phases = { ...proposalView().phases, ended: { how: 'finished' as const, at: NOW } };
        renderWith(storeWith(proposalView({ phases })), <Proposal />, 'proposal');
        expect(screen.queryByRole('button', { name: 'Finish' })).toBeNull();
    });
});
