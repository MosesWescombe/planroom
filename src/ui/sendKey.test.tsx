import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { makeView, posted, renderWith, storeWith } from '../test/harness';
import { SidePanel } from './components/SidePanel';
import { TopBar } from './components/TopBar';
import { readSetting, writeSetting } from './local';
import { readSendKey, setSendKey } from './sendKey';

afterEach(() => setSendKey('shift-enter'));

function renderPage() {
    renderWith(
        storeWith(makeView()),
        <>
            <TopBar />
            <SidePanel />
        </>
    );
    return screen.getByLabelText('Message the agent');
}

describe('send key', () => {
    it('by default Enter types a new line and Shift+Enter sends', async () => {
        const box = renderPage();
        const user = userEvent.setup();
        await user.type(box, 'First line{Enter}second line');
        expect(box).toHaveValue('First line\nsecond line');
        expect(posted).toEqual([]);
        await user.type(box, '{Shift>}{Enter}{/Shift}');
        await waitFor(() => expect(posted).toEqual([{ type: 'message.send', text: 'First line\nsecond line' }]));
    });

    it('choosing Enter in settings reverses it, is remembered, and Shift+Enter forgets it again', async () => {
        const box = renderPage();
        const user = userEvent.setup();
        await user.click(screen.getByRole('button', { name: 'Settings' }));
        const dialog = screen.getByRole('dialog', { name: 'Settings' });
        expect(within(dialog).getByRole('radio', { name: /^Shift \+ Enter/ })).toBeChecked();
        await user.click(within(dialog).getByRole('radio', { name: /^Enter/ }));
        expect(readSetting('planroom:send-key')).toBe('enter');
        await user.click(within(dialog).getByRole('button', { name: 'Close' }));

        await user.type(box, 'One{Shift>}{Enter}{/Shift}two');
        expect(box).toHaveValue('One\ntwo');
        expect(posted).toEqual([]);
        await user.type(box, '{Enter}');
        await waitFor(() => expect(posted).toEqual([{ type: 'message.send', text: 'One\ntwo' }]));

        setSendKey('shift-enter');
        expect(readSetting('planroom:send-key')).toBeUndefined();
    });

    it('starts from the stored key, and treats anything else in storage as Shift+Enter', () => {
        writeSetting('planroom:send-key', 'enter');
        expect(readSendKey()).toBe('enter');
        writeSetting('planroom:send-key', 'tab');
        expect(readSendKey()).toBe('shift-enter');
    });
});
