import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ActivityEntry, AgentStatus, PlanSummary, RepoPlans } from '../../shared/view';
import { AGREED, commentThread, NOW, phasesWith, questionRecord } from '../../test/fixtures';
import { instance, makeView, posted, storeWith } from '../../test/harness';
import { App } from '../App';
import { keepScroll } from '../scrollKeeper';
import { ViewStore } from '../store';
import { applyTheme, cssName, resolveTheme, TEXT_PAIRS, themes } from '../theme';
import { describeAgentNow } from './SidePanel';
import { describeConnection } from './TopBar';

function renderApp(store: ViewStore) {
    return render(<App store={store} />);
}

describe('connection status', () => {
    it('shows exactly one of the five states', () => {
        expect(describeConnection('live', { mode: 'waiting', queued: 0 }).label).toBe('Agent connected · live');
        expect(describeConnection('live', { mode: 'push', queued: 0, editing: '§4' }).label).toBe('Agent editing §4');
        expect(describeConnection('live', { mode: 'waiting', queued: 0, working: true, doing: 'drafting the write-up' })).toEqual(
            { state: 'working', label: 'Agent drafting the write-up' }
        );
        expect(describeConnection('reconnecting', { mode: 'waiting', queued: 0 }).label).toBe('Reconnecting…');
        expect(describeConnection('closed', { mode: 'waiting', queued: 0 }).label).toBe('Planroom closed');
        expect(describeConnection('live', { mode: 'offline', queued: 2 }).label).toBe('Agent offline · 2 queued');
        expect(describeConnection('live', { mode: 'offline', queued: 0 }, true).label).toBe('Read-only');
    });

    it('stream drops: shows Reconnecting…, then both questions appear once each on reconnect', () => {
        const view = makeView({ questions: [questionRecord('Q-1')] });
        const store = storeWith(view);
        renderApp(store);
        act(() => store.setConnection('reconnecting'));
        expect(screen.getByText('Reconnecting…')).toBeInTheDocument();
        act(() => {
            store.snapshot({
                ...view,
                questions: { ...view.questions, 'Q-2': questionRecord('Q-2'), 'Q-3': questionRecord('Q-3') }
            });
            store.setConnection('live');
        });
        expect(screen.getAllByText('Question Q-2')).toHaveLength(1);
        expect(screen.getAllByText('Question Q-3')).toHaveLength(1);
        expect(screen.queryByText('Reconnecting…')).not.toBeInTheDocument();
    });
});

describe('phase tabs', () => {
    it('write-up locked: the tab is disabled and reads "After phase 2"', () => {
        renderApp(storeWith(makeView({ questions: [questionRecord('Q-1')] })));
        const tab = screen.getByRole('button', { name: /Write-up/ });
        expect(tab).toBeDisabled();
        expect(tab).toHaveTextContent('After phase 2');
    });

    it('one top row: four phases, then status and settings; the brand and the change id head the rail', () => {
        renderApp(storeWith(makeView({ questions: [questionRecord('Q-1')] })));
        const row = instance(document.querySelector('.topbar'), HTMLElement);
        const phases = within(row).getByRole('navigation', { name: 'Planning phases' });
        expect(
            within(phases)
                .getAllByRole('button')
                .map((tab) => tab.textContent)
        ).toEqual([
            '1InterrogateAlign · 0 of 1 resolved',
            '2DirectionsAfter phase 1',
            '3Write-upAfter phase 2',
            '4ProposalAfter submit'
        ]);
        expect(within(row).getByRole('status')).toHaveTextContent('Agent connected · live');
        expect(within(row).getByRole('button', { name: 'Settings' })).toBeInTheDocument();
        expect(within(row).queryByText('add-x')).toBeNull();
        const rail = instance(screen.getByRole('button', { name: 'Collapse navigation' }).closest('.rail-wrap'), HTMLElement);
        expect(within(rail).getByText('Planroom')).toBeInTheDocument();
        expect(within(rail).getByText('add-x')).toHaveAttribute('title', 'openspec/changes/add-x');
    });

    it('Export PDF opens the print dialog', () => {
        const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);
        renderApp(storeWith(makeView({ questions: [questionRecord('Q-1')] })));
        fireEvent.click(screen.getByRole('button', { name: 'Export PDF' }));
        expect(print).toHaveBeenCalledOnce();
        print.mockRestore();
    });

    it('picking directions opens Directions, with its tabs under the top row; going ahead opens the write-up', () => {
        const offer = (picked?: string[]) =>
            questionRecord('Q-3', picked ? 'answered' : 'open', {
                group: 'explore/approach',
                input: 'directions',
                options: [
                    { id: 'redis', label: 'Redis token bucket', detail: 'Counts in Redis.', recommended: true },
                    { id: 'gateway', label: 'Gateway plugin' }
                ],
                answer: picked ? { choices: picked, version: 1, at: NOW } : null
            });
        const view = makeView({ questions: [offer(), questionRecord('Q-1', 'open')], patch: AGREED });
        const store = storeWith(view);
        renderApp(store);
        expect(screen.getByRole('button', { name: /Interrogate/ })).toHaveTextContent('Explore · 0 of 2 resolved');
        expect(screen.getByRole('button', { name: /Directions/ })).toBeDisabled();
        expect(screen.queryByRole('navigation', { name: 'Directions' })).toBeNull();

        act(() => store.apply([{ field: 'questions', id: 'Q-3', value: offer(['redis', 'gateway']) }]));
        const directions = screen.getByRole('button', { name: /Directions/ });
        expect(directions).toHaveAttribute('aria-current', 'page');
        expect(directions).toHaveTextContent('Investigating 2 of 2');
        expect(screen.getByRole('button', { name: /Interrogate/ })).toHaveTextContent('2 directions picked');
        const bar = screen.getByRole('navigation', { name: 'Directions' });
        expect(within(bar).getByRole('button', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
        expect(screen.getByRole('region', { name: 'Redis token bucket' })).toHaveTextContent('Recommended');
        expect(screen.getByRole('region', { name: 'Still open from phase 1' })).toHaveTextContent('Question Q-1');

        fireEvent.click(screen.getByRole('button', { name: /Interrogate/ }));
        expect(screen.queryByRole('navigation', { name: 'Directions' })).toBeNull();

        const ahead = phasesWith({ aligned: { by: 'user', at: NOW }, completed: true, direction: 'redis' });
        act(() => store.apply([{ field: 'phases', value: ahead }]));
        expect(screen.getByRole('button', { name: /Write-up/ })).toHaveAttribute('aria-current', 'page');
        expect(screen.getByRole('button', { name: /Directions/ })).toHaveTextContent('Chose Redis token bucket');
        // Unresolved shared questions are the write-up's assumptions now, not open questions.
        fireEvent.click(screen.getByRole('button', { name: /Directions/ }));
        expect(screen.queryByRole('region', { name: 'Still open from phase 1' })).toBeNull();
    });

    it('back to an earlier phase: the Interrogate tab still shows every question during Phase 3', () => {
        const phases = {
            phase1: { completed: true, path: 'finished' as const },
            submission: { revision: 1, validate: true, outstanding: [], at: NOW },
            proposalReadyAt: NOW,
            proposalUnlocked: true,
            acceptedAt: null
        };
        renderApp(
            storeWith(
                makeView({ questions: [questionRecord('Q-1', 'answered'), questionRecord('Q-2', 'closed')], patch: { phases } })
            )
        );
        expect(screen.getByRole('button', { name: /Proposal/ })).toHaveAttribute('aria-current', 'page');
        fireEvent.click(screen.getByRole('button', { name: /Interrogate/ }));
        expect(screen.getByText('Question Q-1')).toBeInTheDocument();
        expect(screen.getByText('Question Q-2')).toBeInTheDocument();
    });

    it('opens the Proposal tab on submit, before the change validates', () => {
        const view = makeView({ questions: [questionRecord('Q-1', 'answered')] });
        view.phases = { ...view.phases, phase1: { completed: true, path: 'finished' } };
        const store = storeWith(view);
        renderApp(store);
        expect(screen.getByRole('button', { name: /Proposal/ })).toHaveTextContent('After submit');
        act(() =>
            store.apply([
                {
                    field: 'phases',
                    value: { ...view.phases, submission: { revision: 1, validate: true, outstanding: [], at: NOW } }
                }
            ])
        );
        const tab = screen.getByRole('button', { name: /Proposal/ });
        expect(tab).toHaveAttribute('aria-current', 'page');
        expect(tab).toHaveTextContent('Agent is proposing');
        expect(screen.getByRole('heading', { name: 'Agent is proposing…' })).toBeInTheDocument();
    });

    it('opens the Write-up tab when phase 1 completes', () => {
        const view = makeView({ questions: [questionRecord('Q-1', 'answered')] });
        const store = storeWith(view);
        renderApp(store);
        act(() => store.apply([{ field: 'phases', value: { ...view.phases, phase1: { completed: true, path: 'finished' } } }]));
        expect(screen.getByRole('button', { name: /Write-up/ })).toHaveAttribute('aria-current', 'page');
    });
});

describe('old plans', () => {
    const plans: PlanSummary[] = [
        { changeId: 'add-x', title: 'Add X', format: 'openspec', status: 'interrogate', updatedAt: NOW },
        { changeId: 'add-centralised-logs', title: 'Centralised logs', format: 'markdown', status: 'finished', updatedAt: NOW }
    ];

    const elsewhere: RepoPlans[] = [
        {
            repoRoot: '/home/me/agora-processor-app',
            plans: [
                {
                    changeId: 'accept-packets',
                    title: 'Accept packets',
                    format: 'openspec',
                    status: 'writeup',
                    updatedAt: NOW,
                    liveUrl: 'http://127.0.0.1:4000/live/'
                },
                { changeId: 'drop-retries', title: 'Drop retries', format: 'openspec', status: 'cancelled', updatedAt: NOW }
            ]
        }
    ];

    /** Stub the plan endpoints; returns the change ids the page asked to open. */
    function stubPlans(): string[] {
        const opened: string[] = [];
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string, init?: RequestInit) => {
                if (url === 'api/plans') return new Response(JSON.stringify({ plans, elsewhere }), { status: 200 });
                if (url === 'api/plans/open') {
                    opened.push(JSON.parse(String(init?.body)).changeId);
                    return new Response(JSON.stringify({ error: 'held', issues: [{ path: '', message: 'Held elsewhere' }] }), {
                        status: 409
                    });
                }
                return new Response('{}', { status: 404 });
            })
        );
        return opened;
    }

    it('the change id opens a list of every plan, this one marked, Markdown ones named; picking another asks Planroom to open it', async () => {
        const opened = stubPlans();
        renderApp(storeWith(makeView()));
        await userEvent.click(screen.getByRole('button', { name: 'Switch plan: add-x' }));
        const dialog = await screen.findByRole('dialog', { name: 'Plans' });
        const here = await within(dialog).findByRole('button', { name: /Add X/ });
        expect(here).toBeDisabled();
        expect(here).toHaveAttribute('aria-current', 'true');
        const old = within(dialog).getByRole('button', { name: /Centralised logs/ });
        expect(old).toHaveTextContent('Finished');
        expect(old).toHaveTextContent('Markdown');
        expect(within(old).getByText('add-centralised-logs')).toHaveAttribute('title', 'agent-plans/add-centralised-logs');
        expect(here).not.toHaveTextContent('Markdown');
        await userEvent.click(old);
        expect(opened).toEqual(['add-centralised-logs']);
        expect(await screen.findByText('Held elsewhere')).toBeInTheDocument();
    });

    it("other repos' plans: a live one links to its page, an idle one says to reopen it from its repo", async () => {
        stubPlans();
        renderApp(storeWith(makeView()));
        await userEvent.click(screen.getByRole('button', { name: 'Switch plan: add-x' }));
        const repo = await screen.findByRole('region', { name: 'Plans in agora-processor-app' });
        expect(within(repo).getByRole('link', { name: /Accept packets/ })).toHaveAttribute('href', 'http://127.0.0.1:4000/live/');
        expect(within(repo).getByText(/reopen from that repo/)).toBeInTheDocument();
        expect(within(repo).queryByRole('button')).toBeNull();
    });

    it('the plan browser page lists every plan with none marked; picking one asks Planroom to open it', async () => {
        const opened = stubPlans();
        const store = new ViewStore();
        store.browse(true);
        renderApp(store);
        expect(screen.getByRole('heading', { name: 'Plans' })).toBeInTheDocument();
        expect(screen.getByText(/each opens read-only/)).toBeInTheDocument();
        const plan = await screen.findByRole('button', { name: /Add X/ });
        expect(plan).toBeEnabled();
        expect(plan).not.toHaveAttribute('aria-current');
        await userEvent.click(plan);
        expect(opened).toEqual(['add-x']);
        expect(await screen.findByText('Held elsewhere')).toBeInTheDocument();
    });

    it('a plan the standalone browser shows is read-only and says how to work on it, with no Reopen or Cancel', () => {
        renderApp(storeWith(makeView({}, { viewOnly: true })));
        expect(screen.getByText(/ask Claude in this repo to resume/)).toBeInTheDocument();
        expect(screen.getByText('Read-only')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Reopen' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    });

    it('a read-only session offers Reopen, which tells Planroom', async () => {
        renderApp(storeWith(makeView({ patch: { phases: { ...phasesWith({}), ended: { how: 'finished', at: NOW } } } })));
        expect(screen.getByText('You finished this session. It is read-only.')).toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'Reopen' }));
        expect(posted).toEqual([{ type: 'session.reopen' }]);
    });

    it('once Planroom has closed the page, the banner offers no Reopen', () => {
        const store = storeWith(makeView({ patch: { phases: { ...phasesWith({}), acceptedAt: NOW } } }));
        renderApp(store);
        act(() => store.setConnection('closed'));
        expect(screen.getByText(/Proposal accepted\./)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Reopen' })).toBeNull();
        expect(screen.getByText('Planroom closed')).toBeInTheDocument();
    });
});

describe('side panel', () => {
    it('collapse: stays collapsed after a reload, as an icon strip with the comment count', () => {
        renderApp(storeWith(makeView({ questions: [questionRecord('Q-1')] })));
        fireEvent.click(screen.getByRole('button', { name: 'Collapse side panel' }));
        expect(screen.getByRole('complementary', { name: 'Side panel, collapsed' })).toBeInTheDocument();
        cleanup();
        renderApp(storeWith(makeView({ questions: [questionRecord('Q-1')] })));
        const strip = screen.getByRole('complementary', { name: 'Side panel, collapsed' });
        expect(within(strip).getByRole('button', { name: 'Comments, 0 open' })).toBeInTheDocument();
        expect(within(strip).getByRole('button', { name: 'Message the agent' })).toBeInTheDocument();
        fireEvent.click(within(strip).getByRole('button', { name: 'Expand side panel' }));
        expect(screen.getByRole('complementary', { name: 'Side panel' })).toBeInTheDocument();
    });

    it('adjust and reload: the navigator is still a strip, the panel keeps its width and the main column is still wide', async () => {
        const view = makeView({ questions: [questionRecord('Q-1')] });
        renderApp(storeWith(view));
        fireEvent.click(screen.getByRole('button', { name: 'Collapse navigation' }));
        // jsdom has no PointerEvent; a MouseEvent carries the same button and clientX.
        vi.stubGlobal('PointerEvent', MouseEvent);
        const splitter = screen.getByRole('separator', { name: 'Resize side panel' });
        fireEvent.pointerDown(splitter, { button: 0, clientX: 600 });
        fireEvent.pointerMove(window, { clientX: 560 });
        fireEvent.pointerUp(window);
        const user = userEvent.setup();
        await user.click(screen.getByRole('button', { name: 'Settings' }));
        await user.selectOptions(screen.getByLabelText('Page width'), 'wide');
        cleanup();
        delete document.documentElement.dataset.width;

        renderApp(storeWith(view));
        expect(screen.getByRole('navigation', { name: 'Question progress' })).toBeInTheDocument();
        expect(screen.queryByRole('navigation', { name: 'Question navigator' })).toBeNull();
        expect(screen.getByRole('complementary', { name: 'Side panel' })).toHaveStyle({ width: '568px' });
        fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
        expect(screen.getByLabelText('Page width')).toHaveValue('wide');
        expect(document.documentElement.dataset.width).toBe('wide');
        delete document.documentElement.dataset.width;
    });
});

describe('activity feed', () => {
    it('says what the agent is doing, and animates only while it works', () => {
        expect(describeAgentNow('live', { mode: 'push', queued: 0, working: true, editing: 'Q-3' })).toEqual({
            busy: true,
            label: 'Editing Q-3'
        });
        expect(describeAgentNow('live', { mode: 'waiting', queued: 0, working: true })).toEqual({
            busy: true,
            label: 'Thinking'
        });
        expect(describeAgentNow('live', { mode: 'waiting', queued: 0, working: true, doing: 'researching the callers' })).toEqual(
            {
                busy: true,
                label: 'Researching the callers'
            }
        );
        expect(describeAgentNow('live', { mode: 'waiting', queued: 0, editing: 'Q-3' })).toEqual({
            busy: false,
            label: 'Waiting for you'
        });
        expect(describeAgentNow('live', { mode: 'offline', queued: 2 })).toEqual({
            busy: false,
            label: 'Offline · 2 changes queued'
        });
    });

    it('agent researching: the top bar says what the agent is on until it waits again', () => {
        const agent: AgentStatus = { mode: 'push', queued: 0, working: true, doing: 'researching how alarms are indexed' };
        const store = storeWith(makeView({ questions: [questionRecord('Q-1')] }, { agent }));
        renderApp(store);
        expect(screen.getByRole('status', { name: 'Agent researching how alarms are indexed' })).toBeInTheDocument();
        act(() => store.apply([{ field: 'agent', value: { mode: 'waiting', queued: 0 } }]));
        expect(screen.getByRole('status', { name: 'Agent connected · live' })).toBeInTheDocument();
    });

    it('agent replying to a comment: the top bar says so, and so does the comment row in place of waiting for the agent', () => {
        const agent: AgentStatus = {
            mode: 'waiting',
            queued: 0,
            working: true,
            doing: 'replying to your comment on §4',
            thread: 'C-1'
        };
        const thread = commentThread('C-1', 'block:s4-table', {
            messages: [{ id: 'C-1.1', author: 'user', text: 'Overrides need an owner', at: NOW }]
        });
        renderApp(storeWith(makeView({ questions: [questionRecord('Q-1')], threads: [thread] }, { agent })));
        expect(screen.getByRole('status', { name: 'Agent replying to your comment on §4' })).toBeInTheDocument();
        const panel = within(screen.getByRole('complementary', { name: 'Side panel' }));
        fireEvent.click(panel.getByRole('tab', { name: /Comments/ }));
        const row = panel.getByRole('button', { name: /Overrides need an owner/ });
        expect(row).toHaveTextContent('Agent replying to your comment on §4');
        expect(row).not.toHaveTextContent('Waiting for the agent');
    });

    it('agent waiting on its subagents: the feed lists what each one is doing, and the top bar says how many', () => {
        const agent: AgentStatus = {
            mode: 'waiting',
            queued: 0,
            working: true,
            doing: 'waiting on 2 subagents',
            subagents: ['reading the billing service', 'tracing alarm writes']
        };
        renderApp(storeWith(makeView({ questions: [questionRecord('Q-1')] }, { agent })));
        const panel = within(screen.getByRole('complementary', { name: 'Side panel' }));
        expect(panel.getByText('Waiting on 2 subagents')).toBeInTheDocument();
        expect(
            within(panel.getByRole('list', { name: 'Subagents' }))
                .getAllByRole('listitem')
                .map((item) => item.textContent)
        ).toEqual(['Reading the billing service', 'Tracing alarm writes']);
        const pill = screen.getByRole('status', { name: /^Agent waiting on 2 subagents/ });
        expect(pill).toHaveTextContent('Agent waiting on 2 subagents');
        expect(pill).toHaveAttribute(
            'title',
            'Agent waiting on 2 subagents\n· Reading the billing service\n· Tracing alarm writes'
        );
    });

    it('a new question stands out until it is resolved, and your answer stays folded away', () => {
        const activity: ActivityEntry[] = [
            { id: 3, at: NOW, title: 'You answered Q-1', detail: 'Leave the contract alone', ref: 'Q-1', kind: 'yours' },
            { id: 2, at: NOW, title: 'Added Q-2', detail: 'How should it roll out?', ref: 'Q-2', kind: 'question' },
            { id: 1, at: NOW, title: 'Added Q-1', detail: 'Which requests change?', ref: 'Q-1', kind: 'question' }
        ];
        renderApp(storeWith(makeView({ questions: [questionRecord('Q-1', 'answered'), questionRecord('Q-2')] }, { activity })));
        const panel = within(screen.getByRole('complementary', { name: 'Side panel' }));
        expect(panel.getByText('Waiting for you')).toBeInTheDocument();
        expect(panel.getByText('New question · Q-2')).toBeInTheDocument();
        expect(panel.queryByText('New question · Q-1')).not.toBeInTheDocument();
        expect(panel.getByText('Added Q-1 · answered')).toBeInTheDocument();
        expect(panel.getByText('Leave the contract alone')).not.toBeVisible();
        fireEvent.click(panel.getByText('You answered Q-1'));
        expect(panel.getByText('Leave the contract alone')).toBeVisible();
    });

    it('a reply reads as unread until its thread is opened, not just listed, and stays read after a reload', () => {
        vi.stubGlobal('IntersectionObserver', OnScreen);
        const activity: ActivityEntry[] = [{ id: 1, at: NOW, title: 'Replied to a comment', ref: 'thread:C-1' }];
        const thread = commentThread('C-1', 'question:Q-1', {
            messages: [
                { id: 'C-1.1', author: 'user', text: 'Please change', at: NOW },
                { id: 'C-1.2', author: 'agent', text: 'Changed it.', at: NOW }
            ]
        });
        const view = makeView({ questions: [questionRecord('Q-1')], threads: [thread] }, { activity });
        renderApp(storeWith(view));
        const panel = within(screen.getByRole('complementary', { name: 'Side panel' }));
        expect(panel.getByText('Unread:')).toBeInTheDocument();
        fireEvent.click(panel.getByRole('tab', { name: /Comments/ }));
        const row = panel.getByRole('button', { name: /Please change/ });
        expect(row).toHaveClass('is-unread');
        expect(row).toHaveTextContent('New reply from the agent');
        fireEvent.click(row);
        expect(row).not.toHaveClass('is-unread');
        expect(row).toHaveTextContent('Agent replied');
        fireEvent.click(panel.getByRole('tab', { name: 'Activity' }));
        expect(panel.queryByText('Unread:')).not.toBeInTheDocument();
        cleanup();
        renderApp(storeWith(view));
        expect(screen.queryByText('Unread:')).not.toBeInTheDocument();
    });
});

/** An IntersectionObserver that reports every observed element as fully on screen, since jsdom has none. */
class OnScreen implements IntersectionObserver {
    readonly root = null;
    readonly rootMargin = '0px';
    readonly scrollMargin = '0px';
    readonly thresholds = [0];

    constructor(private readonly callback: IntersectionObserverCallback) {}

    observe(target: Element): void {
        const rect = target.getBoundingClientRect();
        const entry: IntersectionObserverEntry = {
            target,
            time: 0,
            intersectionRatio: 1,
            isIntersecting: true,
            boundingClientRect: rect,
            intersectionRect: rect,
            rootBounds: null
        };
        this.callback([entry], this);
    }

    unobserve(): void {}

    disconnect(): void {}

    takeRecords(): IntersectionObserverEntry[] {
        return [];
    }
}

/** WCAG relative luminance and contrast ratio. */
function contrast(foreground: string, background: string): number {
    const luminance = (hex: string) => {
        const channel = (index: number) => {
            const value = parseInt(hex.slice(index, index + 2), 16) / 255;
            return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
    };
    const [one, other] = [luminance(foreground), luminance(background)];
    return (Math.max(one, other) + 0.05) / (Math.min(one, other) + 0.05);
}

describe('themes', () => {
    it.each(Object.entries(themes))('every text/background pair meets WCAG AA in %s', (_name, palette) => {
        const failures = TEXT_PAIRS.map(([text, background]) => ({
            text,
            background,
            ratio: contrast(palette[text], palette[background])
        })).filter((pair) => pair.ratio < 4.5);
        expect(failures).toEqual([]);
    });

    it('both themes define the same tokens', () => {
        expect(Object.keys(themes.dark).sort()).toEqual(Object.keys(themes.light).sort());
    });

    it('dark system preference: renders dark when no choice is stored', () => {
        vi.stubGlobal('matchMedia', (query: string) => ({
            matches: query.includes('dark'),
            addEventListener: () => undefined,
            removeEventListener: () => undefined
        }));
        expect(resolveTheme('system')).toBe('dark');
        applyTheme(resolveTheme('system'));
        expect(document.documentElement.dataset.theme).toBe('dark');
        expect(document.documentElement.style.getPropertyValue('--series-1')).toBe(themes.dark.series1);
        expect(cssName('accentSoft')).toBe('accent-soft');
        expect(cssName('ink2')).toBe('ink-2');
    });
});

describe('scroll anchoring fallback', () => {
    function rect(top: number, height: number) {
        return { top, bottom: top + height, left: 0, right: 100, width: 100, height, x: 0, y: top, toJSON: () => ({}) };
    }

    it('content above the viewport grows: the section in view does not move', () => {
        const store = new ViewStore();
        const container = document.createElement('div');
        const above = document.createElement('section');
        const inView = document.createElement('section');
        for (const element of [above, inView]) element.setAttribute('data-scroll-anchor', '');
        container.append(above, inView);
        document.body.append(container);
        let aboveHeight = 400;
        container.getBoundingClientRect = () => rect(0, 800);
        // The container is scrolled so `inView` starts at the top of the viewport.
        container.scrollTop = 400;
        above.getBoundingClientRect = () => rect(-container.scrollTop, aboveHeight);
        inView.getBoundingClientRect = () => rect(aboveHeight - container.scrollTop, 600);

        const stop = keepScroll(store, () => container, false);
        store.snapshot(makeView());
        // The agent adds a paragraph to the section above: the DOM grows by 120px while the update renders.
        store.subscribe(() => {
            aboveHeight = 520;
        });
        store.apply([{ field: 'title', value: 'Changed' }]);
        expect(inView.getBoundingClientRect().top).toBe(0);
        expect(container.scrollTop).toBe(520);
        stop();
        container.remove();
    });
});
