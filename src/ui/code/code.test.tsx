import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { checkBlockConfig } from '../../shared/blocks';
import { BlockView } from '../blocks/Block';
import { Attachments } from '../components/Attachments';
import { renderWith, storeWith, makeView } from '../../test/harness';
import { CodeViewer, parsePatch } from './CodeViewer';
import { foldRanges, indentLevel } from './folding';
import { guessLanguage, highlightLines, looksLikeCode } from './highlight';

const TS = [
    'export function take(key: string): boolean {',
    '    const tokens = store.get(key) ?? capacity;',
    '    if (tokens < 1) {',
    '        return false;',
    '    }',
    '',
    '    store.set(key, tokens - 1);',
    '    return true;',
    '}',
    'const limit = 60;'
].join('\n');

const PROSE =
    'Thanks for the write-up. I think the rollout order is right but I am not sure about the fail-open default. ' +
    'If Redis is down for more than a minute we should page someone, and the limiter should log every request it ' +
    'lets through so we can see what we missed.\n\nAlso, for the free tier, can we start with a lower burst and ' +
    'raise it later? The team plan looks fine to me, and the error should say when the caller can try again.';

describe('folding', () => {
    it('folds each line over the deeper-indented lines after it, keeping the closing line in view', () => {
        expect(foldRanges(TS.split('\n').map(indentLevel))).toEqual(
            new Map([
                [2, 3],
                [0, 7]
            ])
        );
    });

    it('leaves trailing blank lines out of a fold and counts tabs to the next tab stop', () => {
        expect(foldRanges(['a:', '  b: 1', '', 'c: 2'].map(indentLevel))).toEqual(new Map([[0, 1]]));
        expect(indentLevel('\tx')).toBe(4);
        expect(indentLevel('  \tx')).toBe(4);
        expect(indentLevel('   ')).toBeUndefined();
    });

    it('folds a diff hunk under its header', () => {
        expect(foldRanges([-1, 0, 0, -1, 0])).toEqual(
            new Map([
                [0, 2],
                [3, 4]
            ])
        );
    });
});

describe('highlighting', () => {
    it('tells code from prose', () => {
        expect(looksLikeCode(TS)).toBe(true);
        expect(looksLikeCode('def take(self, key):\n    if key in self.store:\n        return True\n    return False')).toBe(
            true
        );
        expect(looksLikeCode('SELECT o.id\nFROM orders o\nJOIN customers c ON c.id = o.customer_id\nWHERE c.plan = 1;')).toBe(
            true
        );
        expect(looksLikeCode('{"a": 1}')).toBe(true);
        expect(looksLikeCode(PROSE)).toBe(false);
        expect(looksLikeCode('- Check the retry header\n- Add the fail-open metric\n- Page on-call after a minute')).toBe(false);
    });

    it('guesses the language of a paste', () => {
        expect(guessLanguage(TS)).toBe('typescript');
        expect(guessLanguage('{\n  "a": [1, 2]\n}')).toBe('json');
        expect(guessLanguage('def take(self, key):\n    return key in self.store')).toBe('python');
    });

    it('carries a span across line breaks, so a block comment colours every line it covers', () => {
        const lines = highlightLines('/* one\ntwo */\nconst x = 1;', 'ts');
        expect(lines[0]).toEqual([{ text: '/* one', scopes: ['hljs-comment'] }]);
        expect(lines[1]).toEqual([{ text: 'two */', scopes: ['hljs-comment'] }]);
        expect(lines[2]).toContainEqual({ text: 'const', scopes: ['hljs-keyword'] });
    });

    it('gives plain lines for an unknown language', () => {
        expect(highlightLines('a\n\nb', 'no-such-language')).toEqual([
            [{ text: 'a', scopes: [] }],
            [],
            [{ text: 'b', scopes: [] }]
        ]);
    });
});

describe('CodeViewer', () => {
    it('highlights, numbers from the start line and names its lines', () => {
        const { container } = render(<CodeViewer source={TS} start={40} language="ts" title="limiter.ts" label="Excerpt" />);
        const lines = screen.getByRole('group', { name: 'Excerpt' });
        expect(container.querySelector('.hljs-keyword')).toHaveTextContent('export');
        expect(within(lines).getByText('40')).toBeInTheDocument();
        expect(screen.getByText('limiter.ts')).toBeInTheDocument();
        expect(screen.getByText('ts')).toBeInTheDocument();
        expect(screen.queryByRole('tablist', { name: 'Diff view' })).toBeNull();
    });

    it('folding a snippet: a function folds to one line with its closing brace in view and unfolds again, and a block folds on its own', async () => {
        const user = userEvent.setup();
        render(<CodeViewer source={TS} language="ts" label="Code" />);
        const lines = screen.getByRole('group', { name: 'Code' });
        await user.click(screen.getByRole('button', { name: 'Fold 7 lines' }));
        expect(lines).not.toHaveTextContent('store.set');
        expect([...lines.querySelectorAll('.line-text')].map((line) => line.textContent)).toContain('}');
        expect(lines).toHaveTextContent('const limit = 60;');
        expect(screen.getByRole('button', { name: 'Unfold 7 lines' })).toHaveAttribute('aria-expanded', 'false');
        await user.click(screen.getByRole('button', { name: 'Unfold 7 lines' }));
        expect(lines).toHaveTextContent('store.set');
        await user.click(screen.getByRole('button', { name: 'Fold 1 line' }));
        expect(lines).not.toHaveTextContent('return false');
        expect(lines).toHaveTextContent('store.set');
    });

    it('folds and unfolds everything at once', async () => {
        const user = userEvent.setup();
        render(<CodeViewer source={TS} language="ts" label="Code" />);
        const lines = screen.getByRole('group', { name: 'Code' });
        await user.click(screen.getByRole('button', { name: 'Fold all' }));
        expect(lines).not.toHaveTextContent('tokens');
        await user.click(screen.getByRole('button', { name: 'Unfold all' }));
        expect(lines).toHaveTextContent('return false');
    });

    it('copies its source', async () => {
        const user = userEvent.setup();
        render(<CodeViewer source={TS} language="ts" label="Code" />);
        await user.click(screen.getByRole('button', { name: 'Copy' }));
        expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
        expect(await navigator.clipboard.readText()).toBe(TS);
    });

    it('highlights both sides of a diff and folds each hunk', async () => {
        const user = userEvent.setup();
        const patch =
            '@@ -1,2 +1,2 @@\n-const retries = 3;\n+const retries = 1;\n export default retries;\n@@ -9 +9 @@\n-let a = 1;';
        const { container } = render(<CodeViewer source={patch} format="diff" language="ts" label="Proposed change" />);
        const removed = container.querySelector('.code-line.is-remove');
        expect(removed).toHaveTextContent('Removed: const retries = 3;');
        expect(removed?.querySelector('.hljs-keyword')).toHaveTextContent('const');
        await user.click(screen.getByRole('button', { name: 'Fold 3 lines' }));
        expect(screen.getByRole('group', { name: 'Proposed change' })).not.toHaveTextContent('export default');
    });

    it('shows a diff inline or either side alone, numbered as in that file, and copies what it shows', async () => {
        const user = userEvent.setup();
        const patch =
            '@@ -12,3 +12,4 @@\n const redis = new Redis({\n-  maxRetries: 3,\n+  maxRetries: 1,\n+  timeout: 50,\n });';
        const { container } = render(<CodeViewer source={patch} format="diff" language="ts" label="Proposed change" />);
        const gutter = () => [...container.querySelectorAll('.line-number')].map((number) => number.textContent);
        expect(screen.getByRole('tab', { name: 'Inline' })).toHaveAttribute('aria-selected', 'true');
        expect(gutter()).toEqual(['', '12', '−', '+', '+', '15']);

        await user.click(screen.getByRole('tab', { name: 'Original' }));
        expect(screen.getByRole('tab', { name: 'Original' })).toHaveAttribute('aria-selected', 'true');
        expect(gutter()).toEqual(['', '12', '13', '14']);
        expect(screen.getByRole('group', { name: 'Proposed change' })).not.toHaveTextContent('timeout');

        await user.click(screen.getByRole('tab', { name: 'New' }));
        expect(gutter()).toEqual(['', '12', '13', '14', '15']);
        expect(screen.getByRole('group', { name: 'Proposed change' })).not.toHaveTextContent('maxRetries: 3');
        await user.click(screen.getByRole('button', { name: 'Copy' }));
        await screen.findByRole('button', { name: 'Copied' });
        expect(await navigator.clipboard.readText()).toBe('const redis = new Redis({\n  maxRetries: 1,\n  timeout: 50,\n});');
    });

    it('skips git headers before the first hunk and keeps the no-newline marker out of the lines', async () => {
        const patch = [
            'diff --git a/retries.ts b/retries.ts',
            'index 1a2b3c4..5d6e7f8 100644',
            '--- a/retries.ts',
            '+++ b/retries.ts',
            '@@ -1,2 +1,2 @@',
            ' export const a = 1;',
            '-export const retries = 3;',
            '\\ No newline at end of file',
            '+export const retries = 1;',
            '\\ No newline at end of file'
        ].join('\n');
        expect(parsePatch(patch).map((line) => [line.kind, line.oldNumber, line.number, line.text])).toEqual([
            ['hunk', undefined, undefined, '@@ -1,2 +1,2 @@'],
            ['context', 1, 1, 'export const a = 1;'],
            ['remove', 2, undefined, 'export const retries = 3;'],
            ['add', undefined, 2, 'export const retries = 1;']
        ]);
        const user = userEvent.setup();
        render(<CodeViewer source={patch} format="diff" language="ts" label="Proposed change" />);
        await user.click(screen.getByRole('tab', { name: 'Original' }));
        await user.click(screen.getByRole('button', { name: 'Copy' }));
        await screen.findByRole('button', { name: 'Copied' });
        expect(await navigator.clipboard.readText()).toBe('export const a = 1;\nexport const retries = 3;');
    });
});

describe('multi-file diffs', () => {
    it('skips the header of every file, not just the first', () => {
        const patch = [
            'diff --git a/a.ts b/a.ts',
            '--- a/a.ts',
            '+++ b/a.ts',
            '@@ -1 +1 @@',
            '-const a = 1;',
            '+const a = 2;',
            'diff --git a/b.ts b/b.ts',
            'index 1a2b3c4..5d6e7f8 100644',
            '--- a/b.ts',
            '+++ b/b.ts',
            '@@ -3,2 +3,2 @@',
            ' const b = 1;',
            '-const c = 1;',
            '+const c = 2;'
        ].join('\n');
        expect(parsePatch(patch).map((line) => [line.kind, line.oldNumber, line.number, line.text])).toEqual([
            ['hunk', undefined, undefined, '@@ -1 +1 @@'],
            ['remove', 1, undefined, 'const a = 1;'],
            ['add', undefined, 1, 'const a = 2;'],
            ['hunk', undefined, undefined, '@@ -3,2 +3,2 @@'],
            ['context', 3, 3, 'const b = 1;'],
            ['remove', 4, undefined, 'const c = 1;'],
            ['add', undefined, 4, 'const c = 2;']
        ]);
    });

    it('keeps a removed line that happens to start with dashes inside a hunk', () => {
        const patch = ['@@ -1,2 +1,1 @@', '--- a divider', ' kept'].join('\n');
        expect(parsePatch(patch).map((line) => [line.kind, line.text])).toEqual([
            ['hunk', '@@ -1,2 +1,1 @@'],
            ['remove', '-- a divider'],
            ['context', 'kept']
        ]);
    });
});

describe('code block', () => {
    it('needs a source for a snippet', () => {
        expect(checkBlockConfig('code', { mode: 'snippet' })).toMatchObject({
            ok: false,
            issues: [{ path: 'source', message: 'a snippet needs a source' }]
        });
    });

    it('shows a snippet in the viewer, highlighted by its lang', () => {
        renderWith(
            storeWith(makeView()),
            <BlockView
                block={{ id: 'c', type: 'code', config: { mode: 'snippet', file: 'src/limiter.ts', lang: 'ts', source: TS } }}
                placement="question"
            />
        );
        const lines = screen.getByRole('group', { name: 'src/limiter.ts' });
        expect(lines.querySelector('.hljs-keyword')).toHaveTextContent('export');
        expect(screen.getByRole('button', { name: 'Fold 7 lines' })).toBeInTheDocument();
    });
});

describe('pasted text', () => {
    it('opens pasted code in the viewer', async () => {
        const user = userEvent.setup();
        render(<Attachments items={[{ kind: 'text', text: TS }]} />);
        await user.click(screen.getByRole('button', { name: 'Pasted text, 10 lines' }));
        const dialog = screen.getByRole('dialog', { name: 'Pasted text' });
        expect(within(dialog).getByRole('group', { name: 'Pasted code' })).toHaveTextContent('return true;');
        expect(within(dialog).getByText('typescript')).toBeInTheDocument();
        expect(within(dialog).getByRole('button', { name: 'Fold 7 lines' })).toBeInTheDocument();
    });

    it('opens pasted prose as plain text', async () => {
        const user = userEvent.setup();
        render(<Attachments items={[{ kind: 'text', text: PROSE }]} />);
        await user.click(screen.getByRole('button', { name: 'Pasted text, 3 lines' }));
        const dialog = screen.getByRole('dialog', { name: 'Pasted text' });
        expect(within(dialog).queryByRole('group', { name: 'Pasted code' })).toBeNull();
        expect(dialog).toHaveTextContent('page someone');
    });
});
