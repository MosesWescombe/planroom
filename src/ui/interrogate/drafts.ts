import { useCallback, useState } from 'react';
import { z } from 'zod';
import { type Answer, answer, type QuestionRecord } from '../../shared/questions';
import { readJson, writeJson } from '../local';

/**
 * An answer being written: kept in this browser only, never sent until saved. Its text and note are not capped as a
 * saved answer's are, so a draft keeps whatever was typed; `lengthProblem` says when it is too long to save.
 */
export const draftSchema = answer.extend({
    text: z.string().optional(),
    note: z.string().optional(),
    editing: z.boolean().optional()
});
export type AnswerDraft = z.infer<typeof draftSchema>;

/** The localStorage key a question's draft answer is kept under. */
export function draftKey(changeId: string, questionId: string): string {
    return `planroom:${changeId}:draft:${questionId}`;
}

/** A question's stored draft answer, or an empty draft when none is stored or it no longer parses. */
export function loadDraft(changeId: string, questionId: string): AnswerDraft {
    return draftSchema.safeParse(readJson(draftKey(changeId, questionId))).data ?? {};
}

/** Whether the draft holds anything the user chose or typed. */
export function hasContent(draft: AnswerDraft): boolean {
    return (
        draft.choice !== undefined || Boolean(draft.choices?.length) || Boolean(draft.text?.trim()) || Boolean(draft.note?.trim())
    );
}

/** The draft without the picks the question no longer offers. An assumption's "holds" is not an option, so it stays. */
export function withoutRemovedPicks(question: Pick<QuestionRecord, 'input' | 'options'>, draft: AnswerDraft): AnswerDraft {
    if (question.input === 'assumption') return draft;
    const ids = new Set((question.options ?? []).map((option) => option.id));
    const choice = draft.choice !== undefined && ids.has(draft.choice) ? draft.choice : undefined;
    const choices = draft.choices?.filter((id) => ids.has(id));
    return choice === draft.choice && choices?.length === draft.choices?.length ? draft : { ...draft, choice, choices };
}

/** The answer a draft would save. */
export function toAnswer(draft: AnswerDraft): Answer {
    const { choice, choices, text, note } = draft;
    return {
        ...(choice !== undefined ? { choice } : {}),
        ...(choices?.length ? { choices } : {}),
        ...(text?.trim() ? { text: text.trim() } : {}),
        ...(note?.trim() ? { note: note.trim() } : {})
    };
}

/** Why a draft is too long to save as an answer, or null when it fits. */
export function lengthProblem(draft: AnswerDraft): string | null {
    const issue = answer.safeParse(toAnswer(draft)).error?.issues[0];
    if (issue?.code !== 'too_big') return null;
    return `the ${issue.path[0] === 'note' ? 'note' : 'answer'} is over the ${issue.maximum}-character limit`;
}

/** A question's local draft, written through to localStorage so it survives a reload. */
export function useDraft(changeId: string, questionId: string): [AnswerDraft, (next: AnswerDraft) => void, () => void] {
    const [draft, setDraftState] = useState<AnswerDraft>(() => loadDraft(changeId, questionId));
    const setDraft = useCallback(
        (next: AnswerDraft) => {
            setDraftState(next);
            writeJson(draftKey(changeId, questionId), hasContent(next) || next.editing ? next : undefined);
        },
        [changeId, questionId]
    );
    const clear = useCallback(() => setDraft({}), [setDraft]);
    return [draft, setDraft, clear];
}
