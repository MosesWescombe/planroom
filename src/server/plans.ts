import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import sortBy from 'lodash/sortBy.js';
import { pagePhase } from '../shared/derive.js';
import { parseStateFile, PLAN_ROOTS, type PlanFormat, planFormat } from '../shared/state.js';
import type { PlanSummary, RepoPlans } from '../shared/view.js';
import { liveHolder } from './lock.js';
import { knownRepos } from './registry.js';
import { CHANGE_ID } from './session.js';
import { planroomDir } from './store.js';

/** Read one change's plan in `format` for the switcher, or undefined when it has none there or its state file does not load. */
async function readPlan(repoRoot: string, format: PlanFormat, changeId: string): Promise<PlanSummary | undefined> {
    const dir = planroomDir(repoRoot, format, changeId);
    const file = join(dir, 'state.json');
    try {
        const [raw, stat, holder] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file), liveHolder(join(dir, 'lock'))]);
        const state = parseStateFile(raw, file);
        return {
            changeId,
            title: state.title,
            format,
            status: state.phases.ended?.how ?? pagePhase(state),
            updatedAt: stat.mtime.toISOString(),
            // A holder still starting has no URL yet.
            ...(holder?.url.startsWith('http') ? { liveUrl: holder.url } : {})
        };
    } catch {
        return undefined;
    }
}

/**
 * Every folder under `openspec/changes/` or `agent-plans/` that has a Planroom plan, most recently changed first.
 * Archived changes are left out: their folder is no longer `changes/<id>/`, so they cannot be opened by id.
 */
export async function listPlans(repoRoot: string): Promise<PlanSummary[]> {
    const plans = await Promise.all(
        planFormat.options.map(async (format) => {
            const entries = await fs.readdir(join(repoRoot, PLAN_ROOTS[format]), { withFileTypes: true }).catch(() => []);
            return Promise.all(
                entries
                    .filter((entry) => entry.isDirectory() && entry.name !== 'archive')
                    .map((entry) => readPlan(repoRoot, format, entry.name))
            );
        })
    );
    return sortBy(
        plans.flat().filter((plan): plan is PlanSummary => plan !== undefined),
        (plan) => plan.updatedAt
    ).reverse();
}

/** The plans in every other repo the registry knows, leaving out repos with none. */
export async function listPlansElsewhere(registry: string, repoRoot: string): Promise<RepoPlans[]> {
    const others = (await knownRepos(registry)).filter((repo) => repo !== resolve(repoRoot));
    const listed = await Promise.all(others.map(async (repo) => ({ repoRoot: repo, plans: await listPlans(repo) })));
    return listed.filter((repo) => repo.plans.length > 0);
}

/** Whether a change has a plan the switcher can open, in either format. A change id that is not kebab-case never does. */
export async function hasPlan(repoRoot: string, changeId: string): Promise<boolean> {
    if (!CHANGE_ID.test(changeId)) return false;
    const plans = await Promise.all(planFormat.options.map((format) => readPlan(repoRoot, format, changeId)));
    return plans.some((plan) => plan !== undefined);
}
