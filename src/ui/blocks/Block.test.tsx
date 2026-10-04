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
