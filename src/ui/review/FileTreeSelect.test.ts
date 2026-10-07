import { describe, expect, it } from 'vitest';
import { buildTree, commonRoot } from './FileTreeSelect';

describe('FileTreeSelect', () => {
    const paths = ['src/ui/a.ts', 'src/ui/x/b.ts', 'src/ui/x/c.ts'];

    it('starts the tree at the folders every path shares', () => {
        expect(commonRoot(paths)).toEqual(['src', 'ui']);
        expect(commonRoot(['src/a.ts', 'lib/b.ts'])).toEqual([]);
        expect(commonRoot(['src/a.ts'])).toEqual(['src']);
    });

    it('nests the files below that root', () => {
        const tree = buildTree(paths, commonRoot(paths));
        expect(tree.files.map((file) => file.path)).toEqual(['src/ui/a.ts']);
        expect(tree.folders.map((folder) => [folder.name, folder.files.length])).toEqual([['x', 2]]);
    });
});
