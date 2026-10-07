import upperFirst from 'lodash/upperFirst';
import { useState } from 'react';
import { flushSync } from 'react-dom';
import type { AgentStatus } from '../../shared/view';
import { exportHtml } from '../exportHtml';
import { setPrinting } from '../hooks';
import { ReviewTabs } from '../review/ReviewTabs';
import { type Connection, deepEqual, useConnection, useSelector } from '../store';
import { useActions, useUiState } from '../ui';
import { EndSessionButton } from './EndSession';
import { DownloadIcon, MenuIcon, PanelIcon } from './icons';
import { Modal } from './Modal';
import { PhaseTabs } from './PhaseTabs';
import { SettingsButton } from './Settings';

export type ConnectionState = 'live' | 'editing' | 'working' | 'reconnecting' | 'offline';

/** Exactly one of the five connection states, and its words. `viewOnly`: a read-only plan with no agent to describe. */
export function describeConnection(
    connection: Connection,
    agent: AgentStatus,
    viewOnly = false
): { state: ConnectionState; label: string } {
    if (connection === 'closed') return { state: 'offline', label: 'Planroom closed' };
    if (connection !== 'live') return { state: 'reconnecting', label: 'Reconnecting…' };
    if (viewOnly) return { state: 'offline', label: 'Read-only' };
    if (agent.editing) return { state: 'editing', label: `Agent editing ${agent.editing}` };
    if (agent.working) return { state: 'working', label: `Agent ${agent.doing ?? 'thinking'}` };
    if (agent.mode === 'offline')
        return { state: 'offline', label: agent.queued ? `Agent offline · ${agent.queued} queued` : 'Agent offline' };
    return { state: 'live', label: 'Agent connected · live' };
}

/** The connection and agent status pill. Hovering it lists what each running subagent is doing. */
export function ConnectionPill() {
    const connection = useConnection();
    const agent = useSelector((view) => view.agent, deepEqual);
    const viewOnly = useSelector((view) => Boolean(view.viewOnly));
    const { state, label } = describeConnection(connection, agent, viewOnly);
    const title = [label, ...(agent.subagents ?? []).map((task) => `· ${upperFirst(task)}`)].join('\n');
    return (
        <div className={`pill pill-${state}`} role="status" aria-live="polite" title={title}>
            <span className="pill-dot" aria-hidden="true" />
            <span className="pill-label">{label}</span>
        </div>
    );
}

/**
 * Exports the open tab without the page's controls, as a PDF through the browser's print dialog ("Save as PDF"), which
 * keeps text selectable and diagrams as vectors, or as one standalone HTML file. The print styles in app.css drop the
 * page chrome and unroll the scrolling column; exportHtml.ts applies the same styles to its file.
 */
function ExportButton() {
    const [open, setOpen] = useState(false);
    const { tab } = useUiState();
    const name = useSelector((view) => (view.kind === 'ask' ? view.changeId : `${view.changeId}-${tab}`));
    // The dialog closes first, so neither the print nor the file shows it.
    const pdf = () => {
        flushSync(() => setOpen(false));
        window.print();
    };
    // A review's deck lays out every slide while it is copied.
    const html = () => {
        setOpen(false);
        setPrinting(true);
        void exportHtml(`${name}.html`).finally(() => setPrinting(false));
    };
    return (
        <>
            <button type="button" className="icon-button" aria-label="Export" title="Export" onClick={() => setOpen(true)}>
                <DownloadIcon />
            </button>
            {open && (
                <Modal label="Export" onClose={() => setOpen(false)} className="dialog dialog-narrow">
                    <h2 className="dialog-title">Export</h2>
                    <p>
                        This tab as a document, without the page's controls{tab === 'walkthrough' ? ', one slide to a page' : ''}.
                        PDF opens the print dialog: choose Save as PDF. HTML saves one file that opens in any browser.
                    </p>
                    <div className="dialog-actions">
                        <button type="button" className="button-secondary" onClick={html}>
                            HTML
                        </button>
                        <button type="button" className="button-primary" onClick={pdf}>
                            PDF
                        </button>
                    </div>
                </Modal>
            )}
        </>
    );
}

/**
 * The top row, beside the rail: the phase tabs, the status pill, export, settings, End session, and the drawer toggles on
 * narrow screens, where the phase tabs wrap onto a row of their own. The change id heads the rail, under the brand. An
 * ask has no phases to show or session to end: it ends by sending its answers.
 */
export function TopBar() {
    const { drawer } = useUiState();
    const { setDrawer } = useActions();
    const ask = useSelector((view) => view.kind === 'ask');
    const review = useSelector((view) => view.kind === 'review');
    return (
        <header className="topbar">
            <button
                type="button"
                className="icon-button narrow-only"
                aria-label="Open navigation"
                aria-expanded={drawer === 'nav'}
                onClick={() => setDrawer(drawer === 'nav' ? undefined : 'nav')}
            >
                <MenuIcon />
            </button>
            {review ? <ReviewTabs /> : !ask && <PhaseTabs />}
            <div className="topbar-end">
                <ConnectionPill />
                <ExportButton />
                <SettingsButton />
                {!ask && <EndSessionButton />}
                <button
                    type="button"
                    className="icon-button narrow-only"
                    aria-label="Open side panel"
                    aria-expanded={drawer === 'panel'}
                    onClick={() => setDrawer(drawer === 'panel' ? undefined : 'panel')}
                >
                    <PanelIcon open={false} />
                </button>
            </div>
        </header>
    );
}
