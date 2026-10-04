import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { makeView, renderWith, storeWith } from '../test/harness';
import { TopBar } from './components/TopBar';
import { readSetting, writeSetting } from './local';
import { readPageWidth } from './pageWidth';

afterEach(() => {
    delete document.documentElement.dataset.width;
});

describe('page width', () => {
    it('choosing Wide in settings widens the page and is remembered; Normal forgets it', async () => {
        renderWith(storeWith(makeView()), <TopBar />);
        const user = userEvent.setup();
        await user.click(screen.getByRole('button', { name: 'Settings' }));
        const select = screen.getByLabelText('Page width');
        expect(select).toHaveValue('normal');
        await user.selectOptions(select, 'wide');
        expect(document.documentElement.dataset.width).toBe('wide');
        expect(readSetting('planroom:width')).toBe('wide');
        expect(document.cookie).toContain('planroom%3Awidth=wide');
        await user.selectOptions(select, 'normal');
        expect(document.documentElement.dataset.width).toBe('normal');
        expect(readSetting('planroom:width')).toBeUndefined();
    });

    it('starts from the stored width, and treats anything else in storage as normal', () => {
        writeSetting('planroom:width', 'narrow');
        expect(readPageWidth()).toBe('narrow');
        writeSetting('planroom:width', 'huge');
        expect(readPageWidth()).toBe('normal');
    });
});
