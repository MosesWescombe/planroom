import { describe, expect, it } from 'vitest';
import { plainTitle } from './Markdown';

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
