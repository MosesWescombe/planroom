import { describe, expect, it } from 'vitest';
import { buildTree, commonRoot, compactFolders } from './FileTreeSelect';

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

    it('merges folders that hold only one folder into one, down to the first that holds more', () => {
        const deep = ['app/a.ts', 'app/controllers/devices/templates/b.ts', 'app/controllers/devices/templates/x/c.ts'];
        const tree = compactFolders(buildTree(deep, commonRoot(deep)));
        expect(tree.folders.map((folder) => folder.name)).toEqual(['controllers/devices/templates']);
        expect(tree.folders[0]?.files.map((file) => file.name)).toEqual(['b.ts']);
        expect(tree.folders[0]?.folders.map((folder) => folder.name)).toEqual(['x']);
    });
});
