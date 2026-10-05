import { groupProgress, humanize } from './derive.js';
import { describeAnswer, isInfo, type QuestionRecord } from './questions.js';
import type { ThreadMessage, ThreadRecord } from './records.js';
import { recordsDir, type SessionState } from './state.js';

/** One card in words: an info card's topic and why, or a question and where its answer stands. */
function cardLines(question: QuestionRecord): string[] {
    if (isInfo(question)) {
        const why = question.context?.why;
        return [`### ${question.id} (info): ${question.title}`, ...(why ? ['', why] : [])];
    }
    const { answer, status } = question;
    const answered = answer
        ? [`**Answer:** ${describeAnswer(question, answer)}`, ...(answer.note?.trim() ? [`**Note:** ${answer.note.trim()}`] : [])]
        : [];
    const where: Partial<Record<QuestionRecord['status'], string[]>> = {
        answered,
        'needs-review': [...answered, '_Answered before the question was reworded._'],
        conflict: [
            ...answered,
            `_Conflicts with ${question.conflict?.with ?? 'another answer'}: ${question.conflict?.reason ?? ''}_`
        ],
        closed: [`_Closed: ${question.closedReason ?? ''}_`],
        merged: [`_Merged into ${question.mergedInto ?? 'another question'}._`]
    };
    // One paragraph each, so the answer, its note and any caveat never run together.
    const paragraphs = where[status] ?? ['_Not answered._'];
    return [`### ${question.id}: ${question.title}`, ...paragraphs.flatMap((paragraph) => ['', paragraph])];
}

/** Pasted text as a code block, its fence longer than any run of backticks in it, so nothing in it can close it. */
function fenced(text: string): string {
    const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
    const fence = '`'.repeat(Math.max(3, longest + 1));
    return `${fence}\n${text}\n${fence}`;
}

/** One message in words, with what was pasted into it: an image by its repo path, a text snippet fenced. */
function messageText(message: ThreadMessage, assets: string): string {
    const pasted = (message.attachments ?? []).map((item) =>
        item.kind === 'image' ? `[image: ${assets}/${item.asset}]` : fenced(item.text)
    );
    return [`**${message.author === 'user' ? 'User' : 'Agent'}:** ${message.text}`, ...pasted].join('\n\n');
}

/** A comment or message thread as a quoted exchange under a line naming it, with the text it is on on that line. */
function threadLines(thread: ThreadRecord, assets: string): string[] {
    const on = thread.anchor?.quote ? ` on "${thread.anchor.quote.exact.replace(/\s+/g, ' ').trim()}"` : '';
    const label = thread.kind === 'message' ? `Message ${thread.id}` : `Comment ${thread.id}${on}`;
    const body = thread.messages.map((message) => messageText(message, assets)).join('\n\n');
    return [
        `**${label}**${thread.status === 'resolved' ? ' (resolved)' : ''}`,
        '',
        ...body.split('\n').map((line) => (line ? `> ${line}` : '>'))
    ];
}

/**
 * An ask as Markdown: its questions by group, each with its answer and the comments on it, then the messages to the
 * agent. The agent receives it when the user sends their answers, and it is what an ask's `output` file holds.
 */
export function askTranscript(
    state: Pick<SessionState, 'kind' | 'format' | 'changeId' | 'title' | 'questions' | 'threads'>
): string {
    const assets = `${recordsDir(state)}/assets`;
    const threads = Object.values(state.threads).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const lines = [`# ${state.title}`];
    for (const group of groupProgress(state).groups) {
        lines.push('', `## ${group.path.split('/').map(humanize).join(' / ')}`);
        for (const id of group.questionIds) {
            const question = state.questions[id];
            if (!question) continue;
            lines.push('', ...cardLines(question));
            for (const thread of threads.filter((candidate) => candidate.anchor?.target === `question:${id}`))
                lines.push('', ...threadLines(thread, assets));
        }
    }
    const messages = threads.filter((thread) => thread.kind === 'message');
    if (messages.length) lines.push('', '## Messages');
    for (const thread of messages) lines.push('', ...threadLines(thread, assets));
    return `${lines.join('\n')}\n`;
}
