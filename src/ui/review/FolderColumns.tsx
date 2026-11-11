import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FolderListing } from '../../shared/review';
import { fetchFolder } from '../api';
import { FolderIcon } from '../components/icons';

/**
 * Where a read-through file sits in the whole repo: Finder-style columns under its header, one per folder from the repo
 * root down to the file, each listing what that folder holds in the reviewed commit. The file, the other files on the
 * page and the changed files are marked; opening another folder swaps the columns after it. Each file starts with them
 * shown or hidden by the reviewer's Show the folders setting.
 */

/** The folders from the repo root down to `file`, each as its path from the root: '', 'src', 'src/ui'. */
export function foldersOf(file: string): string[] {
    const segments = file.split('/').slice(0, -1);
    return ['', ...segments.map((_, at) => segments.slice(0, at + 1).join('/'))];
}

/** `file`'s path with its folders muted before its name; its text stays the plain path. */
export function FilePath({ file }: { file: string }) {
    const cut = file.lastIndexOf('/') + 1;
    return (
        <>
            {cut > 0 && <span className="piece-file-dir">{file.slice(0, cut)}</span>}
            {file.slice(cut)}
        </>
    );
}

/** Every folder that holds a changed file, at any depth, by its path from the root. */
function changedFolders(changed: readonly string[]): Set<string> {
    return new Set(changed.flatMap((path) => foldersOf(path).slice(1)));
}

/** The folder columns for `file` in `round`: `changed` are the round's changed files, `onPage` the page's files. */
export function FolderColumns({
    round,
    file,
    changed,
    onPage
}: {
    round: number;
    file: string;
    changed: readonly string[];
    onPage: ReadonlySet<string>;
}) {
    const [trail, setTrail] = useState(() => foldersOf(file));
    const marks = useMemo(() => ({ files: new Set(changed), folders: changedFolders(changed) }), [changed]);
    const strip = useRef<HTMLDivElement>(null);
    // Columns are a fixed width, so the last one is in view at once, before any has loaded.
    useLayoutEffect(() => {
        const element = strip.current;
        if (element && trail.length > 0) element.scrollLeft = element.scrollWidth;
    }, [trail]);
    return (
        <div ref={strip} className="folder-columns" role="group" aria-label={`Folders down to ${file}`}>
            {trail.map((folder, at) => (
                <FolderColumn
                    key={folder}
                    round={round}
                    folder={folder}
                    open={trail[at + 1]}
                    file={file}
                    marks={marks}
                    onPage={onPage}
                    onOpen={(path) => setTrail([...trail.slice(0, at + 1), path])}
                />
            ))}
        </div>
    );
}

/** One folder's column: its folders, which open the next column, then its files. */
function FolderColumn({
    round,
    folder,
    open,
    file,
    marks,
    onPage,
    onOpen
}: {
    round: number;
    folder: string;
    /** The folder under this one whose column is open next, if any. */
    open: string | undefined;
    file: string;
    marks: { files: ReadonlySet<string>; folders: ReadonlySet<string> };
    onPage: ReadonlySet<string>;
    onOpen: (path: string) => void;
}) {
    const [listing, setListing] = useState<{ entries?: FolderListing['entries']; error?: string }>({});
    useEffect(() => {
        let live = true;
        setListing({});
        fetchFolder(round, folder).then(
            (found) => live && setListing({ entries: found.entries }),
            (caught: unknown) =>
                live && setListing({ error: caught instanceof Error ? caught.message : 'The folder could not be read' })
        );
        return () => {
            live = false;
        };
    }, [round, folder]);
    const list = useRef<HTMLUListElement>(null);
    // The open folder or the file, scrolled to the middle of a long column, without scrolling the page.
    useLayoutEffect(() => {
        const element = list.current;
        const current = element?.querySelector<HTMLElement>('[aria-current]');
        if (element && current) element.scrollTop = current.offsetTop - (element.clientHeight - current.offsetHeight) / 2;
    }, [listing, open]);
    const name = folder ? `${folder.slice(folder.lastIndexOf('/') + 1)}/` : 'Repo root';
    const pathOf = (entry: string) => (folder ? `${folder}/${entry}` : entry);
    return (
        <div className="folder-column">
            <div className="folder-column-name mono small muted truncate" title={folder || undefined}>
                {name}
            </div>
            {listing.error ? (
                <p className="small folder-column-note">{listing.error}</p>
            ) : !listing.entries ? (
                <span className="spinner folder-column-note" role="img" aria-label="Loading" />
            ) : (
                <ul ref={list} className="folder-column-list" aria-label={name}>
                    {listing.entries.map((entry) => {
                        const path = pathOf(entry.name);
                        const changed = entry.folder ? marks.folders.has(path) : marks.files.has(path);
                        const mark = changed && (
                            <span className="folder-entry-mark">
                                <span className="visually-hidden">, changed</span>
                            </span>
                        );
                        return (
                            <li key={entry.name}>
                                {entry.folder ? (
                                    <button
                                        type="button"
                                        className={`folder-entry is-folder${changed ? '' : ' muted'}`}
                                        aria-current={path === open ? 'true' : undefined}
                                        onClick={() => onOpen(path)}
                                    >
                                        <FolderIcon size={13} />
                                        <span className="truncate">{entry.name}</span>
                                        {mark}
                                    </button>
                                ) : (
                                    <span
                                        className={`folder-entry${path === file ? ' is-here' : onPage.has(path) ? ' is-on-page' : changed ? '' : ' muted'}`}
                                        aria-current={path === file ? 'location' : undefined}
                                    >
                                        <span className="truncate">{entry.name}</span>
                                        {mark}
                                    </span>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}
