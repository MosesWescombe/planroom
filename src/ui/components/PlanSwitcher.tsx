import { useCallback, useEffect, useState } from 'react';
import { planDir } from '../../shared/state';
import type { PlanStatus, PlanSummary, RepoPlans } from '../../shared/view';
import { fetchPlans, openPlan } from '../api';
import { relativeTime } from '../format';
import { useSelector } from '../store';
import { describeError, useActions, useBusy } from '../ui';
import { ChevronIcon, Logo } from './icons';
import { Modal } from './Modal';
import { Notices } from './Notices';

/** Where a plan stands, in words. */
const STATUS_LABEL: Record<PlanStatus, string> = {
    interrogate: 'Interrogate',
    directions: 'Directions',
    writeup: 'Write-up',
    proposal: 'Proposal',
    accepted: 'Accepted',
    cancelled: 'Cancelled',
    finished: 'Finished'
};

/** Statuses of a read-only plan, which a Reopen on its page makes editable again. */
const READ_ONLY: ReadonlySet<PlanStatus> = new Set<PlanStatus>(['accepted', 'cancelled', 'finished']);

/** The last folder of a repo path, which names it. */
function repoName(repoRoot: string): string {
    return repoRoot.split(/[\\/]/).filter(Boolean).pop() ?? repoRoot;
}

/** One plan's title, change id, a note, and where it stands. */
function PlanRow({ plan, note }: { plan: PlanSummary; note: string }) {
    return (
        <>
            <span className="nav-name plan-name">
                <span>{plan.title}</span>
                <span className="small muted">
                    <span className="mono" title={planDir(plan.format, plan.changeId)}>
                        {plan.changeId}
                    </span>
                    {plan.format === 'markdown' ? ' · Markdown' : ''} · {note}
                </span>
            </span>
            <span className={`badge ${READ_ONLY.has(plan.status) ? 'badge-neutral' : 'badge-open'}`}>
                {STATUS_LABEL[plan.status]}
            </span>
        </>
    );
}

/** A plan another Claude session has open: a link to its live page, in a new tab. */
function LivePlan({ plan, liveUrl }: { plan: PlanSummary; liveUrl: string }) {
    return (
        <a className="nav-item plan-item" href={liveUrl} target="_blank" rel="noreferrer">
            <PlanRow plan={plan} note="open in another session" />
        </a>
    );
}

/** What opening a plan from the list does: move the page and the agent to it, or show it read-only. */
function PlansNote({ readOnly }: { readOnly: boolean }) {
    return (
        <p className="small muted">
            Every plan under <code>openspec/changes/</code> and <code>agent-plans/</code>.{' '}
            {readOnly
                ? 'No Claude session is attached here, so each opens read-only: to work on one, ask Claude to resume it.'
                : 'Opening one moves this page to it, and the agent picks it up on its next step. An ended or accepted plan opens read-only until you reopen it.'}{' '}
            Plans in other repos open from a Claude session in that repo.
        </p>
    );
}

/**
 * Every plan in this repo, `current` marked: picking another asks Planroom to open it, and the page goes to its URL.
 * Under them, the plans of the other repos Planroom has run in, which open from a Claude session in their own repo, or
 * by link while one has them open. `onLoadFailed` runs once a failed load has been reported.
 */
function PlanListing({ current, onLoadFailed }: { current?: string; onLoadFailed?: () => void }) {
    const { notify } = useActions();
    const [listing, setListing] = useState<{ plans: PlanSummary[]; elsewhere: RepoPlans[] } | 'failed'>();
    const [busy, track] = useBusy();
    useEffect(() => {
        let live = true;
        fetchPlans().then(
            (list) => live && setListing(list),
            (error: unknown) => {
                notify(describeError(error));
                if (live) setListing('failed');
                onLoadFailed?.();
            }
        );
        return () => {
            live = false;
        };
    }, [notify, onLoadFailed]);
    const choose = async (id: string) => {
        try {
            window.location.assign(await track(openPlan(id)));
        } catch (error) {
            notify(describeError(error));
        }
    };
    if (listing === 'failed') return <p className="muted">The plans could not be loaded.</p>;
    if (!listing)
        return (
            <p className="muted" role="status">
                Loading plans…
            </p>
        );
    return (
        <>
            {listing.plans.length === 0 && <p className="muted">No plans in this repo yet. Ask Claude to plan a change.</p>}
            <ul className="plan-list">
                {listing.plans.map((plan) => {
                    const here = plan.changeId === current;
                    return (
                        <li key={plan.changeId}>
                            {plan.liveUrl && !here ? (
                                <LivePlan plan={plan} liveUrl={plan.liveUrl} />
                            ) : (
                                <button
                                    type="button"
                                    className="nav-item plan-item"
                                    aria-current={here || undefined}
                                    disabled={here || busy}
                                    onClick={() => void choose(plan.changeId)}
                                >
                                    <PlanRow plan={plan} note={here ? 'open here' : relativeTime(plan.updatedAt)} />
                                </button>
                            )}
                        </li>
                    );
                })}
            </ul>
            {listing.elsewhere.map((repo) => (
                <section key={repo.repoRoot} className="nav-group" aria-label={`Plans in ${repoName(repo.repoRoot)}`}>
                    <h3 className="nav-heading" title={repo.repoRoot}>
                        {repoName(repo.repoRoot)}
                    </h3>
                    <ul className="plan-list">
                        {repo.plans.map((plan) => (
                            <li key={plan.changeId}>
                                {plan.liveUrl ? (
                                    <LivePlan plan={plan} liveUrl={plan.liveUrl} />
                                ) : (
                                    <div
                                        className="nav-item plan-item"
                                        title={`Ask Claude in ${repo.repoRoot} to reopen ${plan.changeId}`}
                                    >
                                        <PlanRow plan={plan} note={`${relativeTime(plan.updatedAt)} · reopen from that repo`} />
                                    </div>
                                )}
                            </li>
                        ))}
                    </ul>
                </section>
            ))}
        </>
    );
}

/** The plan list as a dialog over a plan's page, which it marks. */
function PlanList({ onClose }: { onClose: () => void }) {
    const changeId = useSelector((view) => view.changeId);
    const viewOnly = useSelector((view) => Boolean(view.viewOnly));
    return (
        <Modal label="Plans" onClose={onClose} className="dialog dialog-narrow">
            <h2 className="dialog-title">Plans</h2>
            <PlansNote readOnly={viewOnly} />
            <PlanListing current={changeId} onLoadFailed={onClose} />
        </Modal>
    );
}

/**
 * The plan browser's page, which shows no plan: Planroom's mark, then every plan, for picking one to open. `readOnly`
 * when the plans open read-only, in the standalone browser.
 */
export function PlanBrowser({ readOnly }: { readOnly: boolean }) {
    return (
        <main className="browser">
            <div className="brand-mark">
                <Logo />
                <span className="brand-name">Planroom</span>
            </div>
            <h1 className="dialog-title">Plans</h1>
            <PlansNote readOnly={readOnly} />
            <PlanListing />
            <Notices />
        </main>
    );
}

/** The change id under the brand, as the button that opens the plan list. */
export function PlanSwitcher() {
    const changeId = useSelector((view) => view.changeId);
    const path = useSelector((view) => planDir(view.format, view.changeId));
    const [open, setOpen] = useState(false);
    // Stable, so the list loads once each time the dialog opens.
    const close = useCallback(() => setOpen(false), []);
    return (
        <>
            <button type="button" className="plan-switch" aria-haspopup="dialog" onClick={() => setOpen(true)}>
                <span className="visually-hidden">Switch plan: </span>
                <span className="change-id" title={path}>
                    {changeId}
                </span>
                <ChevronIcon />
            </button>
            {open && <PlanList onClose={close} />}
        </>
    );
}
