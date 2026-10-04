import { type ClipboardEvent, useCallback, useMemo, useState } from 'react';
import { type Attachment, MAX_SNIPPET } from '../../shared/records';
import { assetUrl, uploadAsset } from '../api';
import { CodeViewer } from '../code/CodeViewer';
import { guessLanguage, looksLikeCode } from '../code/highlight';
import { plural } from '../format';
import { describeError, useActions } from '../ui';
import { CloseIcon } from './icons';
import { Modal } from './Modal';
import { ZoomView } from './ZoomView';

/** A paste longer than either of these becomes a snippet instead of going into the message text. */
const SNIPPET_CHARS = 1000;
const SNIPPET_LINES = 15;

/** How many lines text runs to. */
const lines = (text: string) => text.split('\n').length;

/** What a message box has had pasted into it, and the handler that takes the pastes. */
export interface Pastes {
    items: Attachment[];
    /** An image is still uploading, so the message cannot be sent yet. */
    uploading: boolean;
    onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
    remove: (index: number) => void;
    clear: () => void;
}

/**
 * Pastes into a message box: an image is uploaded to the change's assets, and text over the
 * snippet threshold is kept as a snippet. Shorter text pastes into the box as usual. Text wins
 * when the clipboard has both, since spreadsheets put a picture of the copied cells beside them.
 */
export function usePastes(): Pastes {
    const { notify } = useActions();
    const [items, setItems] = useState<Attachment[]>([]);
    const [uploads, setUploads] = useState(0);
    const add = (item: Attachment) => setItems((current) => [...current, item]);
    const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
        const text = event.clipboardData.getData('text/plain');
        const images = [...event.clipboardData.files].filter((file) => file.type.startsWith('image/'));
        if (!text && images.length) {
            event.preventDefault();
            for (const image of images) {
                setUploads((n) => n + 1);
                uploadAsset(image)
                    .then((asset) => add({ kind: 'image', asset }))
                    .catch((error: unknown) => notify(`The image did not upload: ${describeError(error)}`))
                    .finally(() => setUploads((n) => n - 1));
            }
        } else if (text.length > SNIPPET_CHARS || lines(text) > SNIPPET_LINES) {
            event.preventDefault();
            if (text.length > MAX_SNIPPET) notify(`That paste is over ${MAX_SNIPPET.toLocaleString()} characters; trim it first`);
            else add({ kind: 'text', text });
        }
    };
    const clear = useCallback(() => setItems([]), []);
    const remove = (index: number) => setItems((current) => current.filter((_, at) => at !== index));
    return { items, uploading: uploads > 0, onPaste, remove, clear };
}

/** Pasted text: in the code viewer when it reads as code, otherwise as it was pasted. */
function PastedText({ text }: { text: string }) {
    const code = useMemo(() => (looksLikeCode(text) ? { language: guessLanguage(text) } : undefined), [text]);
    if (!code) return <pre className="attachment-snippet">{text}</pre>;
    return <CodeViewer source={text} language={code.language} label="Pasted code" />;
}

/** A paste opened full screen: an image to zoom, or text in a dialog. */
function Opened({ item, onClose }: { item: Attachment; onClose: () => void }) {
    if (item.kind === 'image')
        return (
            <Modal label="Pasted image" onClose={onClose} className="fullscreen fullscreen-zoom">
                <ZoomView label="Pasted image">
                    <img className="attachment-full" src={assetUrl(item.asset)} alt="Pasted image" />
                </ZoomView>
            </Modal>
        );
    return (
        <Modal label="Pasted text" onClose={onClose} className="dialog dialog-wide">
            <h2 className="dialog-title">Pasted text</h2>
            <PastedText text={item.text} />
        </Modal>
    );
}

/**
 * A message's pastes: image thumbnails and snippet buttons, each opening in full in a modal.
 * With `onRemove`, as in a message box, each can be taken off again.
 */
export function Attachments({
    items,
    onRemove
}: {
    items: readonly Attachment[] | undefined;
    onRemove?: (index: number) => void;
}) {
    const [open, setOpen] = useState<Attachment>();
    if (!items?.length) return null;
    return (
        <>
            <ul className="attachments">
                {items.map((item, index) => (
                    <li key={index} className="attachment">
                        {item.kind === 'image' ? (
                            <button
                                type="button"
                                className="attachment-open attachment-image"
                                aria-label="Pasted image, open full size"
                                onClick={() => setOpen(item)}
                            >
                                <img src={assetUrl(item.asset)} alt="" />
                            </button>
                        ) : (
                            <button
                                type="button"
                                className="attachment-open attachment-text"
                                aria-label={`Pasted text, ${plural(lines(item.text), 'line')}`}
                                onClick={() => setOpen(item)}
                            >
                                <span className="attachment-preview">{item.text.trim().split('\n')[0]}</span>
                                <span className="attachment-size">{plural(lines(item.text), 'line')}</span>
                            </button>
                        )}
                        {onRemove && (
                            <button
                                type="button"
                                className="icon-button attachment-remove"
                                aria-label="Remove paste"
                                onClick={() => onRemove(index)}
                            >
                                <CloseIcon size={10} />
                            </button>
                        )}
                    </li>
                ))}
            </ul>
            {open && <Opened item={open} onClose={() => setOpen(undefined)} />}
        </>
    );
}
