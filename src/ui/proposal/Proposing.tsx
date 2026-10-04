import { memo } from 'react';
import type { ProposalFile } from '../../shared/view';
import { CheckIcon, WarningIcon } from '../components/icons';
import { deepEqual, useSelector } from '../store';

type Step = { label: string; detail?: string; state: 'done' | 'current' | 'waiting' | 'failed' };

/**
 * The proposing steps, ticked off as the files appear on disk and validation runs: an OpenSpec change's files, or with
 * `planFile` a Markdown plan's one file. The last step is always the check, strict unless `strict` is false.
 */
export function proposingSteps(
    files: readonly ProposalFile[],
    validating: boolean,
    validation: { passed: boolean } | null,
    readyAt: string | null,
    { planFile, strict = true }: { planFile?: string; strict?: boolean } = {}
): Step[] {
    const has = (path: string) => files.some((file) => file.path === path && file.content.trim().length > 0);
    const specs = files.filter((file) => file.kind === 'spec');
    const tasks = files.find((file) => file.kind === 'tasks');
    const writing: (Omit<Step, 'state'> & { done: boolean })[] = planFile
        ? [{ label: `Writing ${planFile}`, done: has(planFile) }]
        : [
              { label: 'Scaffolded change folder', done: true },
              { label: 'Wrote proposal.md & design.md', done: has('proposal.md') && has('design.md') },
              {
                  label: 'Writing spec deltas',
                  ...(specs.length ? { detail: specs.map((file) => file.path).join(', ') } : {}),
                  done: specs.length > 0
              },
              { label: 'Break down tasks.md', done: (tasks?.tasks ?? []).some((group) => group.total > 0) }
          ];
    const current = writing.findIndex((step) => !step.done);
    const steps: Step[] = writing.map(({ done, ...step }, index) => ({
        ...step,
        state: done ? 'done' : index === current ? 'current' : 'waiting'
    }));
    const validated = readyAt !== null && validation !== null && !validating;
    steps.push({
        label: planFile ? `Check ${planFile}` : strict ? 'Validate --strict' : 'Validate',
        state: validating ? 'current' : validated ? (validation!.passed ? 'done' : 'failed') : 'waiting'
    });
    return steps;
}

/** A step's mark: a tick when done, a warning when failed, else a dot styled by its state. */
function StepMark({ state }: { state: Step['state'] }) {
    if (state === 'done')
        return (
            <span className="step-mark is-done" aria-hidden="true">
                <CheckIcon size={9} />
            </span>
        );
    if (state === 'failed')
        return (
            <span className="step-mark is-failed" aria-hidden="true">
                <WarningIcon size={10} />
            </span>
        );
    return <span className={`step-mark is-${state}`} aria-hidden="true" />;
}

/** Phase 3 before the change validates: the agent's progress, live from the change folder and the validation run. */
export const Proposing = memo(function Proposing() {
    const markdown = useSelector((view) => view.format === 'markdown');
    const steps = useSelector(
        (view) =>
            proposingSteps(
                view.proposal.files,
                view.validating,
                view.validation,
                view.phases.proposalReadyAt,
                markdown ? { planFile: `${view.changeId}.md` } : { strict: view.phases.submission?.validate !== false }
            ),
        deepEqual
    );
    const failed = steps[steps.length - 1]!.state === 'failed';
    return (
        <>
            <header className="page-head">
                <div className="eyebrow">{markdown ? 'PHASE 3 · MARKDOWN PLAN' : 'PHASE 3 · OPENSPEC PROPOSAL'}</div>
                <h1>{failed ? 'Validation failed' : markdown ? 'Agent is writing the plan…' : 'Agent is proposing…'}</h1>
            </header>
            <section className="proposing" aria-label="Proposing progress">
                <ol className="steps" aria-busy="true">
                    {steps.map((step) => (
                        <li key={step.label} className={`step is-${step.state}`}>
                            <StepMark state={step.state} />
                            <span className="step-text">
                                <span>{step.label}</span>
                                {step.detail && <span className="mono small muted">{step.detail}</span>}
                            </span>
                        </li>
                    ))}
                </ol>
                <p className="small">
                    {failed
                        ? 'The agent has the errors and is fixing them. You can review the change once validation passes.'
                        : 'You can review the change once validation passes. The files appear below as the agent writes them.'}
                </p>
            </section>
        </>
    );
});
