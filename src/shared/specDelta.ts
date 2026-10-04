/**
 * A reader for the OpenSpec spec-delta grammar, so the Proposal tab can render
 * requirements and scenarios by name (`openspec show --json` has no names).
 * `openspec validate` stays the judge of correctness; this reader is lenient and
 * only structures what is there.
 *
 *     ## ADDED Requirements
 *     ### Requirement: <name>
 *     <text>
 *     #### Scenario: <name>
 *     - **WHEN** ...
 *     - **THEN** ...
 *     - **AND** ...
 */

export type DeltaOperation = 'ADDED' | 'MODIFIED' | 'REMOVED' | 'RENAMED';

export interface ScenarioStep {
    keyword: string;
    text: string;
}

export interface Scenario {
    name: string;
    steps: ScenarioStep[];
}

export interface Requirement {
    name: string;
    /** The requirement's statement, the prose between its heading and its first scenario. */
    text: string;
    scenarios: Scenario[];
}

export interface DeltaSection {
    operation: DeltaOperation;
    requirements: Requirement[];
    /** For RENAMED sections: each `FROM` / `TO` pair. */
    renames: { from: string; to: string }[];
}

export interface SpecDelta {
    purpose?: string;
    sections: DeltaSection[];
}

const OPERATIONS: readonly DeltaOperation[] = ['ADDED', 'MODIFIED', 'REMOVED', 'RENAMED'];

const SECTION = /^##\s+(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements\s*$/i;
const REQUIREMENT = /^###\s+Requirement:\s*(.+?)\s*$/;
const SCENARIO = /^####\s+Scenario:\s*(.+?)\s*$/;
const STEP = /^\s*[-*]\s+\*\*([A-Z]+)\*\*\s*(.*)$/;
const RENAME = /^\s*[-*]\s*`?(FROM|TO)`?:\s*`?(?:###\s+Requirement:\s*)?(.+?)`?\s*$/i;

/** Parse a spec delta file into its sections, requirements and scenarios. */
export function parseSpecDelta(markdown: string): SpecDelta {
    const delta: SpecDelta = { sections: [] };
    let section: DeltaSection | undefined;
    let requirement: Requirement | undefined;
    let scenario: Scenario | undefined;
    let step: ScenarioStep | undefined;
    let inPurpose = false;
    const purpose: string[] = [];
    const statement: string[] = [];
    let pendingFrom: string | undefined;

    const flushStatement = () => {
        if (requirement && statement.length) requirement.text = statement.join('\n').trim();
        statement.length = 0;
    };

    for (const line of markdown.split('\n')) {
        const sectionMatch = SECTION.exec(line);
        if (sectionMatch) {
            flushStatement();
            inPurpose = false;
            const operation = OPERATIONS.find((op) => op === sectionMatch[1]!.toUpperCase()) ?? 'ADDED';
            section = { operation, requirements: [], renames: [] };
            delta.sections.push(section);
            requirement = scenario = step = undefined;
            continue;
        }
        if (/^##\s+Purpose\s*$/i.test(line)) {
            inPurpose = true;
            continue;
        }
        if (/^##\s/.test(line)) {
            inPurpose = false;
            continue;
        }
        if (inPurpose) {
            purpose.push(line);
            continue;
        }
        if (!section) continue;

        const requirementMatch = REQUIREMENT.exec(line);
        if (requirementMatch) {
            flushStatement();
            requirement = { name: requirementMatch[1]!, text: '', scenarios: [] };
            section.requirements.push(requirement);
            scenario = step = undefined;
            continue;
        }
        const scenarioMatch = SCENARIO.exec(line);
        if (scenarioMatch && requirement) {
            flushStatement();
            scenario = { name: scenarioMatch[1]!, steps: [] };
            requirement.scenarios.push(scenario);
            step = undefined;
            continue;
        }
        if (section.operation === 'RENAMED') {
            const renameMatch = RENAME.exec(line);
            if (renameMatch) {
                if (renameMatch[1]!.toUpperCase() === 'FROM') pendingFrom = renameMatch[2]!;
                else if (pendingFrom !== undefined) {
                    section.renames.push({ from: pendingFrom, to: renameMatch[2]! });
                    pendingFrom = undefined;
                }
                continue;
            }
        }
        if (scenario) {
            const stepMatch = STEP.exec(line);
            if (stepMatch) {
                step = { keyword: stepMatch[1]!, text: stepMatch[2]!.trim() };
                scenario.steps.push(step);
            } else if (step && line.trim()) {
                step.text = `${step.text} ${line.trim()}`;
            }
            continue;
        }
        if (requirement) statement.push(line);
    }
    flushStatement();
    const purposeText = purpose.join('\n').trim();
    if (purposeText) delta.purpose = purposeText;
    return delta;
}

/** Requirement and scenario totals across a delta, for the change-at-a-glance summary. */
export function countDelta(delta: SpecDelta): Record<DeltaOperation, number> & { scenarios: number } {
    const counts = { ADDED: 0, MODIFIED: 0, REMOVED: 0, RENAMED: 0, scenarios: 0 };
    for (const section of delta.sections) {
        counts[section.operation] += section.operation === 'RENAMED' ? section.renames.length : section.requirements.length;
        counts.scenarios += section.requirements.reduce((n, requirement) => n + requirement.scenarios.length, 0);
    }
    return counts;
}

/** The task groups in a `tasks.md`: each `## N. Title` heading with its checkbox counts. */
export function parseTasks(markdown: string): { title: string; total: number; done: number }[] {
    const groups: { title: string; total: number; done: number }[] = [];
    for (const line of markdown.split('\n')) {
        const heading = /^##\s+(?:\d+\.\s*)?(.+?)\s*$/.exec(line);
        if (heading) {
            groups.push({ title: heading[1]!, total: 0, done: 0 });
            continue;
        }
        const task = /^\s*[-*]\s+\[( |x|X)\]/.exec(line);
        const group = groups[groups.length - 1];
        if (task && group) {
            group.total += 1;
            if (task[1] !== ' ') group.done += 1;
        }
    }
    return groups;
}
