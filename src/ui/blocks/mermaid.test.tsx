import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import MermaidBlock from './mermaid';

/** The theme colours the block reads from the page; jsdom loads no stylesheet, and Mermaid rejects empty colours. */
const COLOURS = ['surface', 'accent-soft', 'accent', 'ink', 'sunken', 'paper'];

beforeEach(() => COLOURS.forEach((name) => document.documentElement.style.setProperty(`--${name}`, '#336699')));
afterEach(() => document.documentElement.removeAttribute('style'));

describe('mermaid with the real library', () => {
    it('a source that fails to parse shows the parse error and leaves no temporary element in the page', async () => {
        render(<MermaidBlock id="m1" config={{ source: 'graph TD\n  A --> (' }} placement="writeup" />);
        expect(await screen.findByText(/Parse error on line 2/)).toBeInTheDocument();
        expect(document.querySelector('[id^="dmermaid-"], [id^="mermaid-"]')).toBeNull();
    });
});
