import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { editorOf, editorText, makeView, renderWith, storeWith, typeInto } from '../../test/harness';
import { Attachments, usePastes } from './Attachments';
import { MarkdownEditor } from './MarkdownEditor';

/** A labelled editor, with `props` passed on. */
function Box(props: Partial<Parameters<typeof MarkdownEditor>[0]>) {
    const [text, setText] = useState('');
    return (
        <>
            <span id="box-label">Box</span>
            <MarkdownEditor id="box" labelId="box-label" value={text} onChange={setText} {...props} />
        </>
    );
}

/** An editor that takes pastes, as a message box does. */
function PastingBox() {
    const pastes = usePastes();
    return (
        <>
            <Box onPaste={pastes.onPaste} />
            <Attachments items={pastes.items} onRemove={pastes.remove} />
        </>
    );
}

describe('the Markdown editor', () => {
    it('shows its placeholder while empty', () => {
        render(<Box placeholder="Write your answer…" />);
        const box = screen.getByRole('textbox', { name: 'Box' });
        expect(box).toHaveAttribute('aria-placeholder', 'Write your answer…');
        expect(box.querySelector('.cm-placeholder')).toHaveTextContent('Write your answer…');
        typeInto(box, 'Per key');
        expect(box.querySelector('.cm-placeholder')).toBeNull();
    });

    it('cannot be edited while disabled, and can once enabled again', () => {
        const { rerender } = render(<Box disabled />);
        const box = screen.getByRole('textbox', { name: 'Box' });
        expect(box).toHaveAttribute('contenteditable', 'false');
        expect(editorOf(box).state.readOnly).toBe(true);
        rerender(<Box />);
        expect(box).toHaveAttribute('contenteditable', 'true');
        expect(editorOf(box).state.readOnly).toBe(false);
    });

    it('calls onSend on the send key outside a form, and types a new line on the other Enter', () => {
        const onSend = vi.fn();
        render(<Box onSend={onSend} />);
        const box = screen.getByRole('textbox', { name: 'Box' });
        typeInto(box, 'One');
        fireEvent.keyDown(box, { key: 'Enter' });
        expect(editorText(box)).toBe('One\n');
        expect(onSend).not.toHaveBeenCalled();
        fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
        expect(onSend).toHaveBeenCalledOnce();
        expect(editorText(box)).toBe('One\n');
    });

    it('takes a long paste as an attachment instead of text', () => {
        renderWith(storeWith(makeView()), <PastingBox />);
        const box = screen.getByRole('textbox', { name: 'Box' });
        const log = Array.from({ length: 40 }, (_, n) => `line ${n + 1}`).join('\n');
        fireEvent.paste(box, { clipboardData: { getData: () => log, files: [] } });
        expect(editorText(box)).toBe('');
        expect(screen.getByRole('button', { name: 'Pasted text, 40 lines' })).toBeInTheDocument();
    });

    it('shows a value changed from outside, as a discarded draft is', () => {
        const onChange = vi.fn();
        const { rerender } = render(<MarkdownEditor id="box" labelId="box" value="Half a thought" onChange={onChange} />);
        const box = screen.getByRole('textbox');
        expect(editorText(box)).toBe('Half a thought');
        rerender(<MarkdownEditor id="box" labelId="box" value="" onChange={onChange} />);
        expect(editorText(box)).toBe('');
    });
});
