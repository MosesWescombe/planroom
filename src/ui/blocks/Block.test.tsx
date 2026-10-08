import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { blockRecord, sectionRecord } from '../../test/fixtures';
import { makeView, renderWith, storeWith } from '../../test/harness';
import { BlockView } from './Block';

// The lazy Mermaid chunk fails to load, as it does when a deploy replaced it or the network dropped.
vi.mock('./mermaid', () => {
    throw new Error('Failed to fetch dynamically imported module');
});

describe('a block whose lazy renderer fails to load', () => {
    it('shows the error card instead of unmounting the page', async () => {
        const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            const mermaid = { id: 'm1', type: 'mermaid', config: { source: 'graph TD\n  A --> B' } };
            const text = { id: 't1', type: 'text', config: { body: 'Still here' } };
            const store = storeWith(
                makeView({
                    blocks: [blockRecord(mermaid.id, mermaid.type, mermaid.config), blockRecord(text.id, text.type, text.config)],
                    sections: [sectionRecord('s1', 1, [mermaid.id, text.id])]
                })
            );
            renderWith(
                store,
                <>
                    <BlockView block={mermaid} placement="writeup" />
                    <BlockView block={text} placement="writeup" />
                </>,
                'writeup'
            );
            expect(await screen.findByRole('group', { name: 'Block m1 could not render' })).toBeInTheDocument();
            expect(screen.getByText('Still here')).toBeInTheDocument();
        } finally {
            quiet.mockRestore();
        }
    });
});

describe('a technical block', () => {
    it('sits folded behind a toggle labelled with its caption, and a plain block does not', () => {
        const technical = {
            id: 't1',
            type: 'text',
            config: { body: 'Keys live in Redis' },
            caption: 'Key layout',
            technical: true
        };
        const plain = { id: 't2', type: 'text', config: { body: 'Callers wait their turn' } };
        const store = storeWith(
            makeView({
                blocks: [
                    blockRecord(technical.id, technical.type, technical.config),
                    blockRecord(plain.id, plain.type, plain.config)
                ],
                sections: [sectionRecord('s1', 1, [technical.id, plain.id])]
            })
        );
        renderWith(
            store,
            <>
                <BlockView block={technical} placement="writeup" />
                <BlockView block={plain} placement="writeup" />
            </>,
            'writeup'
        );
        const fold = screen.getByText('Technical detail: Key layout').closest('details');
        expect(fold).not.toHaveAttribute('open');
        expect(fold).toContainElement(screen.getByText('Keys live in Redis'));
        expect(screen.getByText('Callers wait their turn').closest('details')).toBeNull();
    });
});
