import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { makeView, renderWith, storeWith } from '../../test/harness';
import { readSetting, writeSetting } from '../local';
import { Rail } from './Rail';

function renderRail() {
    return renderWith(
        storeWith(makeView()),
        <Rail>
            <nav aria-label="Question navigator">Progress</nav>
        </Rail>
    );
}

describe('the left rail', () => {
    it('collapses to a strip and expands again, remembered per browser', () => {
        renderRail();
        fireEvent.click(screen.getByRole('button', { name: 'Collapse navigation' }));
        expect(screen.queryByRole('navigation', { name: 'Question navigator' })).toBeNull();
        expect(readSetting('planroom:rail-collapsed')).toBe('1');
        fireEvent.click(screen.getByRole('button', { name: 'Expand navigation' }));
        expect(screen.getByRole('navigation', { name: 'Question navigator' })).toBeInTheDocument();
        expect(readSetting('planroom:rail-collapsed')).toBeUndefined();
    });

    it('starts collapsed when it was left collapsed', () => {
        writeSetting('planroom:rail-collapsed', '1');
        renderRail();
        expect(screen.getByRole('button', { name: 'Expand navigation' })).toBeInTheDocument();
    });

    it('resizes from its right edge: arrows and dragging widen it up to 40% of the window, double-click resets', () => {
        const { container } = renderRail();
        const rail = container.querySelector('.rail-wrap');
        const splitter = screen.getByRole('separator', { name: 'Resize navigation' });
        fireEvent.keyDown(splitter, { key: 'ArrowRight' });
        fireEvent.keyDown(splitter, { key: 'ArrowRight' });
        expect(rail).toHaveStyle({ width: '320px' });
        expect(readSetting('planroom:rail-width')).toBe('320');
        // jsdom has no PointerEvent; a MouseEvent carries the same button and clientX.
        vi.stubGlobal('PointerEvent', MouseEvent);
        fireEvent.pointerDown(splitter, { button: 0, clientX: 320 });
        fireEvent.pointerMove(window, { clientX: 2000 });
        fireEvent.pointerUp(window);
        expect(splitter).toHaveAttribute('aria-valuenow', String(Math.round(window.innerWidth * 0.4)));
        fireEvent.doubleClick(splitter);
        expect(splitter).toHaveAttribute('aria-valuenow', '272');
        expect(readSetting('planroom:rail-width')).toBeUndefined();
    });
});
