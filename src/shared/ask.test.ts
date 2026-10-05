import { describe, expect, it } from 'vitest';
import { commentThread, NOW, questionRecord, stateWith } from '../test/fixtures.js';
import { askTranscript } from './ask.js';

describe('the ask transcript', () => {
    it('lists each card by group with its answer and comments, then the messages', () => {
        const state = stateWith({
            questions: [
                questionRecord('Q-1', 'open', {
                    group: 'auth/tokens',
                    input: 'info',
                    title: 'How tokens refresh today',
                    options: [],
                    context: { why: 'Every 15 minutes.' }
                }),
                questionRecord('Q-2', 'answered', {
                    group: 'auth/tokens',
                    answer: { choice: 'a', note: 'Keep it short', version: 1, at: NOW }
                }),
                questionRecord('Q-3', 'open', { group: 'rollout' }),
                questionRecord('Q-4', 'closed', { group: 'rollout', closedReason: 'Moot after Q-2' })
            ],
            threads: [
                commentThread('C-1', 'question:Q-2', {
                    messages: [
                        {
                            id: 'C-1.1',
                            author: 'user',
                            text: 'Why not B?',
                            attachments: [{ kind: 'image', asset: 'paste-1.png' }],
                            at: NOW
                        },
                        { id: 'C-1.2', author: 'agent', text: 'B needs a migration.\nIt is slower.', at: NOW }
                    ],
                    status: 'resolved'
                }),
                {
                    ...commentThread('M-1', 'unused'),
                    kind: 'message',
                    messages: [{ id: 'M-1.1', author: 'user', text: 'Ship it Friday', at: NOW }]
                }
            ],
            patch: { kind: 'ask', changeId: 'auth-questions', title: 'Auth migration' }
        });
        expect(askTranscript(state)).toBe(
            [
                '# Auth migration',
                '',
                '## Auth / Tokens',
                '',
                '### Q-1 (info): How tokens refresh today',
                '',
                'Every 15 minutes.',
                '',
                '### Q-2: Question Q-2',
                '',
                '**Answer:** Option A',
                '',
                '**Note:** Keep it short',
                '',
                '**Comment C-1 on "text"** (resolved)',
                '',
                '> **User:** Why not B?',
                '>',
                '> [image: .planroom/asks/auth-questions/assets/paste-1.png]',
                '>',
                '> **Agent:** B needs a migration.',
                '> It is slower.',
                '',
                '## Rollout',
                '',
                '### Q-3: Question Q-3',
                '',
                '_Not answered._',
                '',
                '### Q-4: Question Q-4',
                '',
                '_Closed: Moot after Q-2_',
                '',
                '## Messages',
                '',
                '**Message M-1**',
                '',
                '> **User:** Ship it Friday',
                ''
            ].join('\n')
        );
    });
});
