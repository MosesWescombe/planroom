import { type ReactNode, useLayoutEffect, useRef } from 'react';
import { CloseIcon } from './icons';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

/** Open dialogs, innermost last: only it handles Escape and Tab, so a block's full screen closes alone. */
const openDialogs: object[] = [];

/**
 * A dialog over the page: Escape and the backdrop close it, Tab stays inside it, and
 * focus returns to where it was when it closes. Dialogs nest; keys go to the innermost.
 */
export function Modal({
    label,
    onClose,
    children,
    className = ''
}: {
    label: string;
    onClose: () => void;
    children: ReactNode;
    className?: string;
}) {
    const dialog = useRef<HTMLDivElement>(null);
    // The latest onClose, so a parent passing a new function each render does not re-run the focus setup.
    const close = useRef(onClose);
    close.current = onClose;
    // A layout effect, so a closed dialog leaves the stack in the same commit: React 17 defers passive cleanups.
    useLayoutEffect(() => {
        const token = {};
        openDialogs.push(token);
        const previous = document.activeElement as HTMLElement | null;
        const first = dialog.current?.querySelector<HTMLElement>(FOCUSABLE);
        (first ?? dialog.current)?.focus();
        const onKey = (event: KeyboardEvent) => {
            if (openDialogs[openDialogs.length - 1] !== token) return;
            if (event.key === 'Escape') {
                event.stopPropagation();
                close.current();
            }
            if (event.key !== 'Tab' || !dialog.current) return;
            const items = [...dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
            if (items.length === 0) return;
            const [head, tail] = [items[0]!, items[items.length - 1]!];
            if (event.shiftKey && document.activeElement === head) {
                event.preventDefault();
                tail.focus();
            } else if (!event.shiftKey && document.activeElement === tail) {
                event.preventDefault();
                head.focus();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => {
            window.removeEventListener('keydown', onKey);
            openDialogs.splice(openDialogs.indexOf(token), 1);
            previous?.focus?.();
        };
    }, []);
    return (
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
            <div ref={dialog} className={`modal ${className}`} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>
                <button type="button" className="icon-button modal-close" aria-label="Close" onClick={onClose}>
                    <CloseIcon />
                </button>
                {children}
            </div>
        </div>
    );
}
