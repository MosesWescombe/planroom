import lowerFirst from 'lodash/lowerFirst.js';
import { type Phase, sectionLabel, sectionOfBlock } from '../shared/derive.js';
import type { LoggedEvent } from '../shared/events.js';
import type { SessionState } from '../shared/state.js';

/** What the agent is on: `doing` in words that follow "Agent", and the thread when it is a comment. */
export interface Work {
    doing: string;
    thread?: string;
}

/** What a working agent is doing when nothing it received says more. */
export const PHASE_WORK: Record<Phase, string> = {
    interrogate: 'drafting questions',
    writeup: 'drafting the write-up',
    proposal: 'working on the proposal',
    accepted: 'thinking'
};

/** Where an anchor sits, for a short label: `Q-3`, `§4`, a proposal file or the summary. */
function placeOf(target: string, state: SessionState): string | undefined {
    const colon = target.indexOf(':');
    const kind = colon === -1 ? target : target.slice(0, colon);
    const id = target.slice(colon + 1);
    if (kind === 'question' || kind === 'file') return id;
    if (kind === 'section') return sectionLabel(state, id);
    if (kind === 'block') {
        const section = sectionOfBlock(state, id);
        return section && sectionLabel(state, section.id);
    }
    return kind === 'understanding' ? 'the summary' : undefined;
}

/** The work a comment or message asks for: a reply, naming where the thread sits. */
function replying(threadId: string, state: SessionState): Work {
    const thread = state.threads[threadId];
    const place = thread?.anchor && placeOf(thread.anchor.target, state);
    const what = thread?.kind === 'message' ? 'your message' : 'your comment';
    return { doing: `replying to ${what}${place ? ` on ${place}` : ''}`, thread: threadId };
}

/** The work one event asks for, or undefined for events that need little, like a checklist tick. */
function workFor(event: LoggedEvent, events: readonly LoggedEvent[], state: SessionState): Work | undefined {
    switch (event.type) {
        case 'comment.create':
        case 'thread.reply':
        case 'message.send':
            return replying(event.threadId, state);
        case 'answer.submit': {
            const answers = events.filter((other) => other.type === 'answer.submit').length;
            return { doing: `following up on ${answers > 1 ? `${answers} answers` : event.questionId}` };
        }
        case 'question.reopen':
            return { doing: `revisiting ${event.questionId}` };
        case 'conflict.resolve':
            return { doing: `resolving the conflict on ${event.questionId}` };
        case 'question.suggest':
            return { doing: 'considering your suggested question' };
        case 'stage.advance':
            return { doing: 'exploring directions' };
        case 'phase.complete':
            return { doing: 'drafting the write-up' };
        case 'phase.submit':
            return { doing: 'writing the proposal' };
        case 'proposal.requestChanges':
            return { doing: 'revising the proposal', ...(event.threadId ? { thread: event.threadId } : {}) };
        case 'validation.result':
            return event.passed ? undefined : { doing: 'fixing validation errors' };
        case 'block.fix': {
            const place = placeOf(`block:${event.blockId}`, state);
            return { doing: `fixing a block${place ? ` in ${place}` : ''}` };
        }
        default:
            return undefined;
    }
}

/** What the agent is on after a wait hands it `events`: the first one it has to act on, since it goes in seq order. */
export function describeWork(events: readonly LoggedEvent[], state: SessionState): Work | undefined {
    for (const event of events) {
        const work = workFor(event, events, state);
        if (work) return work;
    }
    return undefined;
}

/** The agent's own `doing`, made to follow "Agent": "Researching X" becomes "researching X", "SQL" stays. */
export function followsAgent(doing: string): string {
    return /^[A-Z][a-z]/.test(doing) ? lowerFirst(doing) : doing;
}
