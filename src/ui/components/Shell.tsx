import { useEffect, useRef } from 'react';
import { type PagePhase, pagePhase } from '../../shared/derive';
import { Ask } from '../ask/Ask';
import { CommentLayer } from '../comments/CommentLayer';
import { DirectionSwitcher, DirectionsPhase, Interrogate } from '../interrogate/Interrogate';
import { Proposal } from '../proposal/Proposal';
import { useTrackSeen } from '../seen';
import { useConnection, useSelector } from '../store';
import { quietly, type Tab, useActions, useBusy, useUiState } from '../ui';
import { Writeup } from '../writeup/Writeup';
import { Notices } from './Notices';
import { SidePanel } from './SidePanel';
import { TopBar } from './TopBar';

const ORDER: Record<PagePhase, number> = { interrogate: 0, directions: 1, writeup: 2, proposal: 3, accepted: 4 };

/** The tab a phase opens on. */
export function tabForPhase(phase: PagePhase): Tab {
    return phase === 'accepted' ? 'proposal' : phase;
}

/**
 * When the session reaches a later phase, open its tab: picking directions opens Directions, Finish or going ahead
 * the write-up, Submit the proposal.
 */
function useFollowPhase(): void {
    const phase = useSelector((view) => pagePhase(view));
    const { setTab, setPanelTab } = useActions();
    const previous = useRef(phase);
    useEffect(() => {
        if (ORDER[phase] > ORDER[previous.current] && phase !== 'accepted') {
            setTab(tabForPhase(phase));
            if (phase === 'proposal') setPanelTab('review');
        }
        previous.current = phase;
    }, [phase, setTab, setPanelTab]);
}

/** Makes a read-only session editable again; the agent is told, and picks the plan up where it stands. */
function ReopenButton() {
    const { send } = useActions();
    const [busy, track] = useBusy();
    return (
        <button
            type="button"
            className="button-secondary button-small"
            disabled={busy}
            onClick={() => quietly(track(send({ type: 'session.reopen' })))}
        >
            Reopen
        </button>
    );
}

/**
 * The read-only banner, once the proposal is accepted or the user ended the session, with a way to reopen it. On a plan
 * shown read-only, by the standalone browser or from another repo, it says where to work on it instead: no agent is
 * attached to reopen it for. A sent ask only says so: the agent reopens it by asking more.
 */
function Accepted() {
    const changeId = useSelector((view) => view.changeId);
    const ask = useSelector((view) => view.kind === 'ask');
    const accepted = useSelector((view) => Boolean(view.phases.acceptedAt));
    const ended = useSelector((view) => view.phases.ended?.how);
    const viewOnly = useSelector((view) => Boolean(view.viewOnly));
    const elsewhere = useSelector((view) => view.elsewhere);
    // Once Planroom has closed the page there is no server to reopen it through.
    const closed = useConnection() === 'closed';
    if (ask && ended)
        return (
            <div className="banner" role="status">
                You sent your answers to the agent. This page is read-only.
            </div>
        );
    if (viewOnly)
        return (
            <div className="banner" role="status">
                Read-only: no Claude session is attached. To work on this plan, ask Claude in{' '}
                {elsewhere ? <code>{elsewhere}</code> : 'this repo'} to resume <code>{changeId}</code>.
            </div>
        );
    if (!accepted && !ended) return null;
    return (
        <div className="banner banner-actions">
            <span role="status">
                {accepted ? 'Proposal accepted. This session is read-only.' : `You ${ended} this session. It is read-only.`}
            </span>
            {!closed && <ReopenButton />}
        </div>
    );
}

/**
 * The page layout: the rail runs the full height on the left, beside the top row (phase tabs, change, status and
 * settings), the Directions tabs under it while in Directions, then the current phase with the side panel, and the
 * comment and notice layers. An ask has no phases: its questions stand where Interrogate would. Escape closes an open
 * drawer.
 */
export function Shell() {
    const { tab, drawer } = useUiState();
    const { setDrawer } = useActions();
    const ask = useSelector((view) => view.kind === 'ask');
    useFollowPhase();
    useTrackSeen();
    useEffect(() => {
        if (!drawer) return undefined;
        const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setDrawer(undefined);
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [drawer, setDrawer]);
    return (
        <div className="app" data-drawer={drawer ?? 'none'}>
            <TopBar />
            {tab === 'directions' && <DirectionSwitcher />}
            <Accepted />
            <div className="body">
                {tab === 'interrogate' && (ask ? <Ask /> : <Interrogate />)}
                {tab === 'directions' && <DirectionsPhase />}
                {tab === 'writeup' && <Writeup />}
                {tab === 'proposal' && <Proposal />}
                <SidePanel />
                {drawer && <button type="button" className="scrim" aria-label="Close" onClick={() => setDrawer(undefined)} />}
            </div>
            <CommentLayer />
            <Notices />
        </div>
    );
}
