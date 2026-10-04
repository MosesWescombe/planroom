import { traceFor } from '../../shared/derive';
import type { DeltaOperation, Requirement } from '../../shared/specDelta';
import type { ProposalFile } from '../../shared/view';
import { QuestionLink } from '../components/LinkedText';
import { Markdown } from '../components/Markdown';
import { useSelector } from '../store';

/** `specs/rate-limits/spec.md` -> `rate-limits`. */
export function specName(path: string): string | undefined {
    return /^specs\/(.+)\/spec\.md$/.exec(path)?.[1];
}

const OP_CLASS: Record<DeltaOperation, string> = {
    ADDED: 'op-added',
    MODIFIED: 'op-modified',
    REMOVED: 'op-removed',
    RENAMED: 'op-renamed'
};

/** The questions a requirement traces back to, as links, or an "Untraced" chip when none does. */
function Trace({ requirement, spec }: { requirement: string; spec: string | undefined }) {
    const questions = useSelector((view) => traceFor(view, requirement, spec)?.join(','));
    if (questions === undefined) return <span className="chip chip-attention">Untraced</span>;
    return (
        <span className="trace" aria-label="Traced to">
            {questions
                .split(',')
                .filter(Boolean)
                .map((id) => (
                    <QuestionLink key={id} id={id} />
                ))}
        </span>
    );
}

/** One requirement: its name and trace, its text, and each scenario's steps. */
function RequirementCard({ requirement, spec }: { requirement: Requirement; spec: string | undefined }) {
    return (
        <section className="requirement">
            <div className="requirement-head">
                <h3>Requirement: {requirement.name}</h3>
                <Trace requirement={requirement.name} spec={spec} />
            </div>
            {requirement.text && (
                <div className="requirement-text">
                    <Markdown source={requirement.text} />
                </div>
            )}
            {requirement.scenarios.map((scenario) => (
                <div key={scenario.name} className="scenario">
                    <span className="scenario-name">Scenario: {scenario.name}</span>
                    <dl className="scenario-steps">
                        {scenario.steps.map((step, index) => (
                            <div key={index} className="scenario-step">
                                <dt>{step.keyword}</dt>
                                <dd>
                                    <Markdown source={step.text} />
                                </dd>
                            </div>
                        ))}
                    </dl>
                </div>
            ))}
        </section>
    );
}

/** A spec delta as its requirements and WHEN/THEN/AND scenarios, each traced back to question ids. */
export function SpecView({ file }: { file: ProposalFile }) {
    const spec = specName(file.path);
    const delta = file.spec;
    if (!delta || delta.sections.length === 0)
        return <p className="muted">No delta sections yet (## ADDED Requirements and the like).</p>;
    return (
        <div className="spec-view">
            {delta.sections.map((section, index) => (
                <div key={`${section.operation}-${index}`} className="delta-section">
                    <div className="delta-head">
                        <span className={`op-badge ${OP_CLASS[section.operation]}`}>{section.operation}</span>
                        <h2>Requirements</h2>
                    </div>
                    {section.requirements.map((requirement) => (
                        <RequirementCard key={requirement.name} requirement={requirement} spec={spec} />
                    ))}
                    {section.renames.map((rename) => (
                        <p key={rename.from} className="rename">
                            <span className="strong">{rename.from}</span> → <span className="strong">{rename.to}</span>
                        </p>
                    ))}
                </div>
            ))}
        </div>
    );
}

/** tasks.md as groups of read-only checkboxes. */
export function TasksView({ content }: { content: string }) {
    const groups: { title: string; items: { done: boolean; text: string }[] }[] = [];
    for (const line of content.split('\n')) {
        const heading = /^##\s+(.+?)\s*$/.exec(line);
        if (heading) groups.push({ title: heading[1]!, items: [] });
        const task = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/.exec(line);
        if (task) {
            if (groups.length === 0) groups.push({ title: 'Tasks', items: [] });
            groups[groups.length - 1]!.items.push({ done: task[1] !== ' ', text: task[2]! });
        }
    }
    return (
        <div className="tasks-view">
            {groups.map((group) => (
                <section key={group.title}>
                    <h3>{group.title}</h3>
                    <ul>
                        {group.items.map((item, index) => (
                            <li key={index} className="checklist-item">
                                <input
                                    type="checkbox"
                                    checked={item.done}
                                    readOnly
                                    disabled
                                    aria-label={item.done ? 'done' : 'not done'}
                                />
                                <span>
                                    <Markdown source={item.text} />
                                </span>
                            </li>
                        ))}
                    </ul>
                </section>
            ))}
        </div>
    );
}
