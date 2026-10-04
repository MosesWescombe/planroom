import type { z } from 'zod';

/** One validation problem, addressed by a dotted/bracketed field path such as `edges[1].to`. */
export interface Issue {
    path: string;
    message: string;
}

/** Render a zod issue path the way a reader writes it: `events[1].question.options[0].id`. */
export function formatPath(path: readonly PropertyKey[]): string {
    return path.reduce<string>((out, key) => {
        if (typeof key === 'number') return `${out}[${key}]`;
        return out ? `${out}.${String(key)}` : String(key);
    }, '');
}

/** Flatten a zod error into path/message pairs, optionally prefixed with the path of the value that was parsed. */
export function toIssues(error: z.ZodError, prefix: readonly PropertyKey[] = []): Issue[] {
    return error.issues.map((issue) => ({ path: formatPath([...prefix, ...issue.path]), message: issue.message }));
}

/** One-line summary of a list of issues, for tool results and error cards. */
export function describeIssues(issues: readonly Issue[]): string {
    return issues.map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message)).join('; ');
}
