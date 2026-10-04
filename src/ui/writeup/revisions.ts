import { diffWords } from 'diff';
import isEqual from 'lodash/isEqual';
import { orderedSections, sectionOfBlock } from '../../shared/derive';
import { blockIdsOf, type SectionRecord } from '../../shared/records';
import { type BlockContent, documentAt, type Revision, type RevisionMeta, undoBlocker } from '../../shared/revisions';
import { fetchRevision } from '../api';

/** Revisions never change once written, so each is fetched once. */
const cache = new Map<number, Promise<Revision>>();

/** Revisions 1 to `upTo` in full, fetched in parallel. A failed fetch is not cached, so the next call retries it. */
export function loadRevisions(upTo: number): Promise<Revision[]> {
    const all: Promise<Revision>[] = [];
    for (let n = 1; n <= upTo; n += 1) {
        let entry = cache.get(n);
        if (!entry) {
            entry = fetchRevision(n);
            cache.set(n, entry);
            entry.catch(() => cache.delete(n));
        }
        all.push(entry);
    }
    return Promise.all(all);
}

/** A block as comparable text: its config pretty-printed, plus its caption. */
export function blockText(block: BlockContent): string {
    return `${JSON.stringify(block.config, null, 2)}${block.caption ? `\ncaption: ${block.caption}` : ''}`;
}

export interface BlockDiff {
    id: string;
    type: string;
    change: 'added' | 'removed' | 'changed';
    /** Word-level changes for a changed block; for added and removed, the whole text as one part. */
    parts: { value: string; added?: boolean; removed?: boolean }[];
}

export interface SectionDiff {
    id: string;
    title: string;
    change: 'added' | 'removed' | 'changed' | 'unchanged';
    blocks: BlockDiff[];
}

/** Compare the write-up after revision `from` with the write-up after revision `to`, block by block. */
export function diffRevisions(all: readonly Revision[], from: number, to: number): SectionDiff[] {
    const before = documentAt(all, from);
    const after = documentAt(all, to);
    const sectionIds = [...new Set([...after.sections.keys(), ...before.sections.keys()])];
    const order = (id: string) => after.sections.get(id)?.order ?? before.sections.get(id)?.order ?? 0;
    const diffs = sectionIds
        .sort((a, b) => order(a) - order(b))
        .map((id): SectionDiff => {
            const was = before.sections.get(id);
            const now = after.sections.get(id);
            const blockIds = [...new Set([...(now ? blockIdsOf(now) : []), ...(was ? blockIdsOf(was) : [])])];
            const blocks = blockIds.flatMap((blockId): BlockDiff[] => {
                const old = before.blocks.get(blockId);
                const current = after.blocks.get(blockId);
                if (old && current) {
                    const oldText = blockText(old);
                    const newText = blockText(current);
                    return oldText === newText && old.type === current.type
                        ? []
                        : [{ id: blockId, type: current.type, change: 'changed', parts: diffWords(oldText, newText) }];
                }
                if (current)
                    return [
                        { id: blockId, type: current.type, change: 'added', parts: [{ value: blockText(current), added: true }] }
                    ];
                if (old)
                    return [
                        { id: blockId, type: old.type, change: 'removed', parts: [{ value: blockText(old), removed: true }] }
                    ];
                return [];
            });
            const change = !was
                ? 'added'
                : !now
                  ? 'removed'
                  : was.title !== now.title || blocks.length > 0 || !isEqual(was.blocks, now.blocks)
                    ? 'changed'
                    : 'unchanged';
            return { id, title: now?.title ?? was?.title ?? id, change, blocks };
        });
    return diffs.filter((diff) => diff.change !== 'unchanged');
}

/** Why a revision cannot be undone, in words, or undefined when it can. */
export function undoReason(
    metas: readonly RevisionMeta[],
    n: number,
    sections: Record<string, SectionRecord>
): string | undefined {
    const blocker = undoBlocker(metas, n);
    if (blocker === null) return undefined;
    if (blocker === 'undone') return 'Already undone';
    if (blocker === 'missing') return 'This revision is gone';
    const numbered = orderedSections({ sections });
    const owner = blocker.kind === 'section' ? sections[blocker.id] : sectionOfBlock({ sections }, blocker.id);
    const label = owner ? `§${numbered.find((entry) => entry.section.id === owner.id)?.number ?? '?'}` : blocker.id;
    return `${label} changed again since`;
}

/** The latest revision that touched a section or one of its blocks. */
export function latestTouching(metas: readonly RevisionMeta[], section: SectionRecord): RevisionMeta | undefined {
    return [...metas]
        .reverse()
        .find((meta) =>
            meta.touched.some((item) =>
                item.kind === 'section' ? item.id === section.id : blockIdsOf(section).includes(item.id)
            )
        );
}
