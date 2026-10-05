import { useEffect, useState } from 'react';
import { readSetting, writeSetting } from './local';

/**
 * The page's design tokens, one set per theme. Light is the handoff's palette; dark
 * is designed to the same roles. Every token becomes a CSS custom property on the
 * root (`accentSoft` -> `--accent-soft`), and `TEXT_PAIRS` lists every text colour on
 * every background it is used on, for the WCAG AA contrast test.
 */
export const themes = {
    light: {
        paper: '#F6F4EE',
        surface: '#FFFEFB',
        sunken: '#EFECE4',
        raised: '#E9E5DB',
        line: '#E2DDD2',
        lineStrong: '#CFC8BA',
        ink: '#1D1C1A',
        ink2: '#4A4740',
        muted: '#6B675E',
        accent: '#2B5A8C',
        accentSoft: '#E6EDF5',
        accentWash: '#F2F6FA',
        accentText: '#1F4670',
        onAccent: '#FFFEFB',
        agent: '#A5561A',
        agentDot: '#C77B3A',
        agentSoft: '#F8EBDD',
        agentWash: '#FBF3EA',
        agentBorder: '#E0B98F',
        agentText: '#8A4512',
        comment: '#F5E6AE',
        commentLine: '#D9A93A',
        commentFocus: '#F0D98A',
        commentFocusLine: '#B98A1E',
        selection: '#CFE0F3',
        closed: '#8A857B',
        shadow: 'rgba(29, 28, 26, 0.08)',
        scrim: 'rgba(29, 28, 26, 0.45)',
        series1: '#2B5A8C',
        series2: '#A9C1DB',
        series3: '#5F86B0',
        series4: '#A5561A',
        series5: '#D9A93A',
        series6: '#8A857B',
        heat1: '#F2F6FA',
        heat2: '#E6EDF5',
        heat3: '#C8D7E8',
        heat4: '#A9C1DB',
        heat5: '#5F86B0',
        syntaxKeyword: '#7B3B8C',
        syntaxString: '#3D6A1E',
        syntaxNumber: '#0B6868',
        syntaxComment: '#6B675E',
        syntaxTitle: '#1F4670',
        syntaxType: '#8A4512',
        syntaxAttr: '#6E5400'
    },
    dark: {
        paper: '#161513',
        surface: '#1E1D1A',
        sunken: '#282622',
        raised: '#302E29',
        line: '#37342F',
        lineStrong: '#4C4942',
        ink: '#EEEAE2',
        ink2: '#CBC5B9',
        muted: '#A49E92',
        accent: '#7EA8D8',
        accentSoft: '#1D2C3E',
        accentWash: '#18222D',
        accentText: '#A9C9EE',
        onAccent: '#0F1B2A',
        agent: '#D78C4C',
        agentDot: '#D78C4C',
        agentSoft: '#3A2819',
        agentWash: '#2A2018',
        agentBorder: '#6E4828',
        agentText: '#F0B27E',
        comment: '#554515',
        commentLine: '#C9A13A',
        commentFocus: '#6E5A1D',
        commentFocusLine: '#E0B94A',
        selection: '#27466B',
        closed: '#8E897F',
        shadow: 'rgba(0, 0, 0, 0.35)',
        scrim: 'rgba(0, 0, 0, 0.6)',
        series1: '#7EA8D8',
        series2: '#3F6A99',
        series3: '#B7D0EC',
        series4: '#D78C4C',
        series5: '#D9B24A',
        series6: '#A49E92',
        heat1: '#18222D',
        heat2: '#1D2C3E',
        heat3: '#27405C',
        heat4: '#35577E',
        heat5: '#4F7AAB',
        syntaxKeyword: '#D3A6E6',
        syntaxString: '#A9D08E',
        syntaxNumber: '#7FD1C6',
        syntaxComment: '#A49E92',
        syntaxTitle: '#A9C9EE',
        syntaxType: '#F0B27E',
        syntaxAttr: '#E5C47A'
    }
} as const;

export type ThemeName = keyof typeof themes;
export type Token = keyof (typeof themes)['light'];
export type ThemePreference = ThemeName | 'system';

/** The code viewer's syntax colours, and every background a code line can have. */
const SYNTAX: readonly Token[] = [
    'syntaxKeyword',
    'syntaxString',
    'syntaxNumber',
    'syntaxComment',
    'syntaxTitle',
    'syntaxType',
    'syntaxAttr'
];
const CODE_BACKGROUNDS: readonly Token[] = ['surface', 'accentSoft', 'agentSoft', 'sunken'];

/** Every [text, background] token pair the page uses for text. */
export const TEXT_PAIRS: readonly (readonly [Token, Token])[] = [
    ['ink', 'paper'],
    ['ink', 'surface'],
    ['ink', 'sunken'],
    ['ink', 'raised'],
    ['ink2', 'paper'],
    ['ink2', 'surface'],
    ['ink2', 'sunken'],
    ['ink2', 'raised'],
    ['muted', 'paper'],
    ['muted', 'surface'],
    ['muted', 'sunken'],
    ['accent', 'paper'],
    ['accent', 'surface'],
    ['accentText', 'accentSoft'],
    ['accentText', 'accentWash'],
    ['accentText', 'surface'],
    ['accentText', 'sunken'],
    ['onAccent', 'accent'],
    ['agentText', 'agentSoft'],
    ['agentText', 'agentWash'],
    ['agentText', 'surface'],
    ['ink', 'agentWash'],
    ['ink2', 'agentWash'],
    ['ink', 'accentSoft'],
    ['ink', 'accentWash'],
    ['ink2', 'accentSoft'],
    ['ink', 'comment'],
    ['ink', 'commentFocus'],
    ['ink', 'selection'],
    ['ink', 'heat1'],
    ['ink', 'heat3'],
    ['ink', 'agentSoft'],
    ['paper', 'ink'],
    ['line', 'ink'],
    ...SYNTAX.flatMap((token) => CODE_BACKGROUNDS.map((background) => [token, background] as const))
];

/** `accentSoft` -> `accent-soft`, `ink2` -> `ink-2`, `series1` -> `series-1`. */
export function cssName(token: string): string {
    return token
        .replace(/([A-Z])/g, '-$1')
        .replace(/(\d+)$/, '-$1')
        .toLowerCase();
}

/** Put a theme's tokens on the root element as CSS custom properties. */
export function applyTheme(name: ThemeName, root: HTMLElement = document.documentElement): void {
    for (const [token, value] of Object.entries(themes[name])) root.style.setProperty(`--${cssName(token)}`, value);
    root.dataset.theme = name;
    root.style.colorScheme = name;
}

const KEY = 'planroom:theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

/** The stored theme choice, or `system` when nothing valid is stored. */
export function readPreference(): ThemePreference {
    const stored = readSetting(KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
}

/** The OS colour scheme, light when the browser cannot say. */
export function systemTheme(): ThemeName {
    return typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

/** The theme a choice shows: the OS's for `system`, else the one chosen. */
export function resolveTheme(preference: ThemePreference): ThemeName {
    return preference === 'system' ? systemTheme() : preference;
}

/** The light/dark/system choice, remembered in this browser, applied to the page and kept in step with the OS. */
export function useTheme(): { preference: ThemePreference; setPreference: (next: ThemePreference) => void } {
    const [preference, setPreference] = useState<ThemePreference>(readPreference);
    useEffect(() => {
        writeSetting(KEY, preference === 'system' ? undefined : preference);
        applyTheme(resolveTheme(preference));
        if (preference !== 'system' || typeof window.matchMedia !== 'function') return undefined;
        const query = window.matchMedia(DARK_QUERY);
        const follow = () => applyTheme(systemTheme());
        query.addEventListener('change', follow);
        return () => query.removeEventListener('change', follow);
    }, [preference]);
    return { preference, setPreference };
}
