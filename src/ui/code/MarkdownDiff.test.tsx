import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { parsePatch } from './CodeViewer';
import { isMarkdown, MarkdownDiff, markdownDiff } from './MarkdownDiff';

const GUIDE = parsePatch(`@@ -1,13 +1,14 @@
 # Retries

-Jobs retry three times.
+Jobs retry up to the policy limit.

 \`\`\`ts
 send(job);

 send(job, policy);
 \`\`\`

 - email
 - push
+- sms
`);

describe('markdownDiff', () => {
    it('diffs whole blocks: a changed paragraph or list is removed and added, a fence with a blank line stays one block', () => {
        expect(markdownDiff(GUIDE).map(({ kind, source }) => [kind, source])).toEqual([
            ['context', '# Retries'],
            ['remove', 'Jobs retry three times.'],
            ['add', 'Jobs retry up to the policy limit.'],
            ['context', '```ts\nsend(job);\n\nsend(job, policy);\n```'],
            ['remove', '- email\n- push'],
            ['add', '- email\n- push\n- sms']
        ]);
    });

    it('knows a Markdown file by its extension', () => {
        expect(['README.md', 'docs/Guide.MARKDOWN', 'src/md.ts', 'page.mdx'].map(isMarkdown)).toEqual([true, true, false, false]);
    });
});

describe('MarkdownDiff', () => {
    it('renders each block, marks the changed ones, and shows a note under the block its line is in, once', () => {
        render(
            <MarkdownDiff
                rows={GUIDE}
                label="docs/guide.md lines 1 to 14"
                notes={(row) => (row.text === '- push' ? <p>Push is optional</p> : null)}
            />
        );
        const blocks = within(screen.getByRole('group', { name: 'docs/guide.md lines 1 to 14' }));
        expect(blocks.getByRole('heading', { name: 'Retries' })).toBeInTheDocument();
        expect(blocks.getByText('Jobs retry three times.').closest('.markdown-block')).toHaveClass('is-remove');
        expect(blocks.getByText('Jobs retry up to the policy limit.').closest('.markdown-block')).toHaveClass('is-add');
        expect(blocks.getByText('sms').closest('.markdown-block')).toHaveTextContent('Added:');
        // `- push` is unchanged, so its note shows under the new list only, not the removed one too.
        expect(blocks.getAllByText('Push is optional')).toHaveLength(1);
        expect(blocks.getByText('Push is optional').closest('.code-note')?.previousElementSibling).toHaveClass('is-add');
    });
});
