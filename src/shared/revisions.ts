import { z } from 'zod';
import { sectionContent } from './records.js';

/**
 * Write-up revisions: one per agent batch (or undo) that changed the write-up, with
 * the before and after content of every block and section it touched. One log
 * serves undo, history and diffs.
 */

/** A block's content as the agent set it; review state and versions are not part of a revision. */
export const blockContent = z.object({
    id: z.string(),
    type: z.string(),
    config: z.record(z.string(), z.unknown()),
    caption: z.string().optional(),
    refs: z.array(z.string()).optional(),
    technical: z.boolean().optional()
});
export type BlockContent = z.infer<typeof blockContent>;

/** One block's or section's before and after content in a revision; null before means created, null after removed. */
export const revisionChange = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('block'), id: z.string(), before: blockContent.nullable(), after: blockContent.nullable() }),
    z.object({ kind: z.literal('section'), id: z.string(), before: sectionContent.nullable(), after: sectionContent.nullable() })
]);
export type RevisionChange = z.infer<typeof revisionChange>;

/** One write-up revision: its number, time, summary and changes. */
export const revision = z.object({
    n: z.number().int().min(1),
    at: z.string(),
    summary: z.string(),
    /** Set when this revision is the undo of another. */
    undoOf: z.number().int().optional(),
    changes: z.array(revisionChange)
});
export type Revision = z.infer<typeof revision>;

/** What the page lists for each revision, without the content images. */
export interface RevisionMeta {
    n: number;
    at: string;
    summary: string;
    undoOf?: number;
    touched: { kind: 'block' | 'section'; id: string }[];
    /** Whether this revision has already been undone. */
    undone: boolean;
}

/** What the page lists for each revision, marking the ones a later undo reverted. */
export function revisionMeta(all: readonly Revision[]): RevisionMeta[] {
    const undone = new Set(all.flatMap((rev) => (rev.undoOf === undefined ? [] : [rev.undoOf])));
    return all.map((rev) => ({
        n: rev.n,
        at: rev.at,
        summary: rev.summary,
        ...(rev.undoOf === undefined ? {} : { undoOf: rev.undoOf }),
        touched: rev.changes.map((change) => ({ kind: change.kind, id: change.id })),
        undone: undone.has(rev.n)
    }));
}

/**
 * Why revision `n` cannot be undone, or null when it can: a later revision touched
 * one of its blocks or sections, or it was already undone.
 */
export function undoBlocker(
    metas: readonly RevisionMeta[],
    n: number
): { kind: 'block' | 'section'; id: string; by: number } | 'undone' | 'missing' | null {
    const target = metas.find((meta) => meta.n === n);
    if (!target) return 'missing';
    if (target.undone) return 'undone';
    for (const later of metas.filter((meta) => meta.n > n)) {
        const clash = later.touched.find((item) => target.touched.some((own) => own.kind === item.kind && own.id === item.id));
        if (clash) return { ...clash, by: later.n };
    }
    return null;
}

/** The write-up's content as it stood after revision `n`: every block and section by id. */
export function documentAt(
    all: readonly Revision[],
    n: number
): { blocks: Map<string, BlockContent>; sections: Map<string, z.infer<typeof sectionContent>> } {
    const blocks = new Map<string, BlockContent>();
    const sections = new Map<string, z.infer<typeof sectionContent>>();
    for (const rev of all) {
        if (rev.n > n) break;
        for (const change of rev.changes) {
            if (change.kind === 'block') {
                if (change.after) blocks.set(change.id, change.after);
                else blocks.delete(change.id);
            } else if (change.after) sections.set(change.id, change.after);
            else sections.delete(change.id);
        }
    }
    return { blocks, sections };
}
