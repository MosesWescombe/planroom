import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import sortBy from 'lodash/sortBy.js';
import { pagePhase } from '../shared/derive.js';
import { PLAN_ROOTS, type PlanFormat, parseStateFile, planFormat } from '../shared/state.js';
import type { PlanSummary, RepoPlans } from '../shared/view.js';
import { liveHolder } from './lock.js';
import { knownRepos, readRegistry } from './registry.js';
import { CHANGE_ID } from './session.js';
import { planroomDir } from './store.js';

/**
 * Read one change's plan in `format` for the switcher, or undefined when it has none there or its state file does not
 * load. `plansRoot` is the repo's Markdown plans folder.
 */
async function readPlan(
    repoRoot: string,
    format: PlanFormat,
    changeId: string,
    plansRoot: string | undefined
): Promise<PlanSummary | undefined> {
    const dir = planroomDir(repoRoot, format, changeId, plansRoot);
    const file = join(dir, 'state.json');
    try {
        const [raw, stat, holder] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file), liveHolder(join(dir, 'lock'))]);
        const state = parseStateFile(raw, file);
        return {
            changeId,
            title: state.title,
            format,
            ...(format === 'markdown' && plansRoot && plansRoot !== PLAN_ROOTS.markdown ? { plansRoot } : {}),
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
 * Every folder under `openspec/changes/` or the repo's Markdown plans folder, `plansRoot` (by default `agent-plans/`),
 * that has a Planroom plan, most recently changed first. Archived changes are left out: their folder is no longer
 * `changes/<id>/`, so they cannot be opened by id.
 */
export async function listPlans(repoRoot: string, plansRoot?: string): Promise<PlanSummary[]> {
    const plans = await Promise.all(
        planFormat.options.map(async (format) => {
            const root = format === 'markdown' && plansRoot ? plansRoot : PLAN_ROOTS[format];
            const entries = await fs.readdir(join(repoRoot, root), { withFileTypes: true }).catch(() => []);
            return Promise.all(
                entries
                    .filter((entry) => entry.isDirectory() && entry.name !== 'archive')
                    .map((entry) => readPlan(repoRoot, format, entry.name, plansRoot))
            );
        })
    );
    return sortBy(
        plans.flat().filter((plan): plan is PlanSummary => plan !== undefined),
        (plan) => plan.updatedAt
    ).reverse();
}

/** Every repo the registry knows other than `repoRoot`. */
export async function otherRepos(registry: string, repoRoot: string): Promise<string[]> {
    return (await knownRepos(registry)).filter((repo) => repo !== resolve(repoRoot));
}

/** The plans in every other repo the registry knows, each in its own Markdown plans folder, leaving out repos with none. */
export async function listPlansElsewhere(registry: string, repoRoot: string): Promise<RepoPlans[]> {
    const { repos, plansDirs } = await readRegistry(registry);
    const others = repos.filter((repo) => repo !== resolve(repoRoot));
    const listed = await Promise.all(
        others.map(async (repo) => ({ repoRoot: repo, plans: await listPlans(repo, plansDirs[repo]) }))
    );
    return listed.filter((repo) => repo.plans.length > 0);
}

/**
 * Whether a change has a plan the switcher can open, in either format, its Markdown one under `plansRoot`. A change id
 * that is not kebab-case never does.
 */
export async function hasPlan(repoRoot: string, changeId: string, plansRoot?: string): Promise<boolean> {
    if (!CHANGE_ID.test(changeId)) return false;
    const plans = await Promise.all(planFormat.options.map((format) => readPlan(repoRoot, format, changeId, plansRoot)));
    return plans.some((plan) => plan !== undefined);
}
