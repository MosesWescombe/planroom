import { render, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Markdown, plainTitle } from './Markdown';

describe('plainTitle', () => {
    it.each([
        ['Drop the `as any` cast', 'Drop the as any cast'],
        ['**Bold**, *italic* and _also_', 'Bold, italic and also'],
        ['See [the docs](https://x.test)', 'See the docs'],
        ['`PLANROOM_BITBUCKET_ATTEMPTS` and snake_case_name', 'PLANROOM_BITBUCKET_ATTEMPTS and snake_case_name'],
        ['`a **b**` stays code', 'a **b** stays code'],
        ['2 * 3 * 4', '2 * 3 * 4'],
        ['Handle *args and **kwargs', 'Handle *args and **kwargs'],
        ['**`as any`** cast', 'as any cast'],
        ['Fix [`foo()`](src/a.ts)', 'Fix foo()'],
        ['Escaped \\*star\\*', 'Escaped *star*']
    ])('%s', (source, plain) => {
        expect(plainTitle(source)).toBe(plain);
    });
});

describe('Markdown', () => {
    it('renders a pipe table between paragraphs, its cells as inline Markdown', () => {
        const source = [
            'Two callers:',
            '',
            '| Caller | How often |',
            '|---|---|',
            '| `PostDecoderValidationModule.execute` | once per decoded uplink |',
            '| **InfluxEgressProcessor** | once per egress job attempt, retries included |',
            '',
            'Both run after decoding.'
        ].join('\n');
        const view = within(render(<Markdown source={source} document />).container);
        const table = view.getByRole('table');
        expect(
            within(table)
                .getAllByRole('columnheader')
                .map((cell) => cell.textContent)
        ).toEqual(['Caller', 'How often']);
        expect(within(table).getAllByRole('row')).toHaveLength(3);
        expect(within(table).getByText('PostDecoderValidationModule.execute').tagName).toBe('CODE');
        expect(within(table).getByText('InfluxEgressProcessor').tagName).toBe('STRONG');
        expect(view.getByText('Two callers:')).toBeInTheDocument();
        expect(view.getByText('Both run after decoding.')).toBeInTheDocument();
    });

    it('leaves a table inside fenced code as code', () => {
        const { container } = render(<Markdown source={['```', '| a | b |', '|---|---|', '```'].join('\n')} document />);
        expect(within(container).queryByRole('table')).not.toBeInTheDocument();
    });
});
