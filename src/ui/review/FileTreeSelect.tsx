import { useState } from 'react';
import { ChevronIcon } from '../components/icons';

/** A folder of the tree: its name, the folders under it and the files in it. */
interface Folder {
    name: string;
    folders: Folder[];
    files: { name: string; path: string }[];
}

/** The folders every path shares, as segments: the most common root, which the tree starts from. */
export function commonRoot(paths: string[]): string[] {
    const dirs = paths.map((path) => path.split('/').slice(0, -1));
    const [first = [], ...rest] = dirs;
    const shared = first.findIndex((segment, depth) => rest.some((dir) => dir[depth] !== segment));
    return first.slice(0, shared === -1 ? first.length : shared);
}

/** The paths as a tree of folders below `root`. */
export function buildTree(paths: string[], root: string[]): Folder {
    const top: Folder = { name: root.join('/'), folders: [], files: [] };
    for (const path of paths) {
        const segments = path.split('/').slice(root.length);
        const name = segments.pop() ?? path;
        let folder = top;
        for (const segment of segments) {
            let next = folder.folders.find((candidate) => candidate.name === segment);
            if (!next) {
                next = { name: segment, folders: [], files: [] };
                folder.folders.push(next);
            }
            folder = next;
        }
        folder.files.push({ name, path });
    }
    return top;
}

function FolderList({ folder, value, onPick }: { folder: Folder; value: string; onPick: (path: string) => void }) {
    return (
        <ul className="file-tree-list">
            {folder.folders.map((child) => (
                <li key={child.name}>
                    <span className="file-tree-folder">
                        <ChevronIcon /> {child.name}
                    </span>
                    <FolderList folder={child} value={value} onPick={onPick} />
                </li>
            ))}
            {folder.files.map((file) => (
                <li key={file.path}>
                    <button
                        type="button"
                        className="file-tree-file"
                        aria-current={file.path === value}
                        onClick={() => onPick(file.path)}
                    >
                        {file.name}
                    </button>
                </li>
            ))}
        </ul>
    );
}

/** A dropdown of `paths` shown as a tree from their most common root, in place of a flat select. */
export function FileTreeSelect({
    paths,
    value,
    onChange,
    noneLabel
}: {
    paths: string[];
    value: string;
    onChange: (path: string) => void;
    /** Offers an entry above the tree that picks no file (an empty path), under this name. */
    noneLabel?: string;
}) {
    const [open, setOpen] = useState(false);
    const root = commonRoot(paths);
    const tree = buildTree(paths, root);
    return (
        <div
            className="file-tree-select"
            onKeyDown={(event) => event.key === 'Escape' && setOpen(false)}
            onBlur={(event) => event.currentTarget.contains(event.relatedTarget) || setOpen(false)}
        >
            <button
                type="button"
                className="field-select file-tree-button"
                aria-label="File"
                aria-haspopup="true"
                aria-expanded={open}
                onClick={() => setOpen(!open)}
            >
                <span className="file-tree-value">
                    {(value ? value.split('/').slice(root.length).join('/') : noneLabel) || 'Choose a file'}
                </span>
                <ChevronIcon />
            </button>
            {open && (
                <div className="file-tree-popup">
                    {noneLabel !== undefined && (
                        <button
                            type="button"
                            className="file-tree-file"
                            aria-current={value === ''}
                            onClick={() => {
                                onChange('');
                                setOpen(false);
                            }}
                        >
                            {noneLabel}
                        </button>
                    )}
                    {root.length > 0 && <div className="file-tree-root mono small muted">{tree.name}/</div>}
                    <FolderList
                        folder={tree}
                        value={value}
                        onPick={(path) => {
                            onChange(path);
                            setOpen(false);
                        }}
                    />
                </div>
            )}
        </div>
    );
}
