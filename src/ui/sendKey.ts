import type { KeyboardEvent } from 'react';
import { useSyncExternalStoreWithSelector } from 'use-sync-external-store/shim/with-selector';
import { readSetting, writeSetting } from './local';

/** The keys a message box can send on, the default first. */
export const SEND_KEYS = ['shift-enter', 'enter'] as const;
/** Which Enter sends a message box: `shift-enter` (Enter types a new line) or `enter` (Shift+Enter types one). */
export type SendKey = (typeof SEND_KEYS)[number];

const KEY = 'planroom:send-key';

/** The stored send key, or `shift-enter` when nothing valid is stored. */
export function readSendKey(): SendKey {
    const stored = readSetting(KEY);
    return SEND_KEYS.find((key) => key === stored) ?? 'shift-enter';
}

// One value for the whole page, so every open message box follows a change at once.
let current: SendKey | undefined;
const listeners = new Set<() => void>();

/** Choose the send key, remembered in this browser. */
export function setSendKey(next: SendKey): void {
    current = next;
    writeSetting(KEY, next === 'shift-enter' ? undefined : next);
    for (const listener of listeners) listener();
}

/** The chosen send key, one for every message box on the page, read from storage on first use. */
export function useSendKey(): SendKey {
    return useSyncExternalStoreWithSelector(
        (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        () => (current ??= readSendKey()),
        undefined,
        (value) => value
    );
}

/**
 * Whether a keydown should send rather than type a new line. Cmd/Ctrl+Enter always sends; a held key
 * and an IME composing text never do.
 */
export function isSendKey(event: KeyboardEvent, sendKey: SendKey): boolean {
    if (event.key !== 'Enter' || event.repeat || event.nativeEvent.isComposing) return false;
    if (event.metaKey || event.ctrlKey) return true;
    return sendKey === 'enter' ? !event.shiftKey : event.shiftKey;
}

/** A message box's keydown handler: sends on the chosen key and leaves every other key to the textarea. */
export function useSendOnKey(): (event: KeyboardEvent, send: () => void) => void {
    const sendKey = useSendKey();
    return (event, send) => {
        if (!isSendKey(event, sendKey)) return;
        event.preventDefault();
        send();
    };
}

/** The composer's hint for the chosen key. */
export function sendHint(sendKey: SendKey): string {
    return sendKey === 'enter' ? '↵ to send · ⇧↵ new line' : '⇧↵ to send';
}
