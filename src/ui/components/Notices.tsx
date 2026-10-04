import { useActions, useUiState } from '../ui';
import { CloseIcon } from './icons';

/** Refusals and failures from the server, shown briefly. */
export function Notices() {
    const { notices } = useUiState();
    const { dismiss } = useActions();
    return (
        <div className="notices" role="alert" aria-live="assertive">
            {notices.map((notice) => (
                <div key={notice.id} className="notice">
                    <span>{notice.text}</span>
                    <button type="button" className="icon-button" aria-label="Dismiss" onClick={() => dismiss(notice.id)}>
                        <CloseIcon size={14} />
                    </button>
                </div>
            ))}
        </div>
    );
}
