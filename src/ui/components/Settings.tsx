import { useState } from 'react';
import { type PageWidth, usePageWidth } from '../pageWidth';
import { type SendKey, setSendKey, useSendKey } from '../sendKey';
import { type ThemePreference, useTheme } from '../theme';
import { SettingsIcon } from './icons';
import { Modal } from './Modal';

const SEND_OPTIONS: readonly { key: SendKey; label: string; detail: string }[] = [
    { key: 'shift-enter', label: 'Shift + Enter', detail: 'Enter starts a new line' },
    { key: 'enter', label: 'Enter', detail: 'Shift + Enter starts a new line' }
];

/** The colour scheme picker: follow the system, light or dark. */
function ThemeField() {
    const { preference, setPreference } = useTheme();
    return (
        <div className="field">
            <label className="field-label" htmlFor="setting-theme">
                Colour scheme
            </label>
            <select
                id="setting-theme"
                className="field-select"
                value={preference}
                onChange={(event) => setPreference(event.target.value as ThemePreference)}
            >
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
            </select>
        </div>
    );
}

/** Narrow, normal or wide main column; hidden on narrow screens, where the column already fills the width. */
function WidthField() {
    const { width, setWidth } = usePageWidth();
    return (
        <div className="field wide-only">
            <label className="field-label" htmlFor="setting-width">
                Page width
            </label>
            <select
                id="setting-width"
                className="field-select"
                value={width}
                onChange={(event) => setWidth(event.target.value as PageWidth)}
            >
                <option value="narrow">Narrow</option>
                <option value="normal">Normal</option>
                <option value="wide">Wide</option>
            </select>
        </div>
    );
}

/** The top bar's settings button and the dialog it opens: colour scheme, page width and the send key. */
export function SettingsButton() {
    const [open, setOpen] = useState(false);
    const sendKey = useSendKey();
    return (
        <>
            <button type="button" className="icon-button" aria-label="Settings" onClick={() => setOpen(true)}>
                <SettingsIcon />
            </button>
            {open && (
                <Modal label="Settings" onClose={() => setOpen(false)} className="dialog dialog-narrow">
                    <h2 className="dialog-title">Settings</h2>
                    <ThemeField />
                    <WidthField />
                    <div className="field" role="radiogroup" aria-labelledby="send-key-label">
                        <span className="field-label" id="send-key-label">
                            Send comments, messages and answers with
                        </span>
                        {SEND_OPTIONS.map((option) => (
                            <label key={option.key} className="toggle-row">
                                <span>
                                    <span className="strong">{option.label}</span>
                                    <span className="small muted">{option.detail}</span>
                                </span>
                                <input
                                    type="radio"
                                    name="send-key"
                                    checked={sendKey === option.key}
                                    onChange={() => setSendKey(option.key)}
                                />
                            </label>
                        ))}
                        <span className="small muted">⌘/Ctrl + Enter always sends.</span>
                    </div>
                </Modal>
            )}
        </>
    );
}
