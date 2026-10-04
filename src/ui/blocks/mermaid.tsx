import { useEffect, useState } from 'react';
import type { BlockProps } from './Block';
import { loadMermaid } from './mermaidLoader';

let renderCount = 0;

/** A CSS custom property's current value on the root element, trimmed. */
function cssVar(name: string): string {
    return getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
}

/** The theme applied to the page, re-read when the theme switch changes it. */
function useThemeName(): string | undefined {
    const [theme, setTheme] = useState(() => document.documentElement.dataset.theme);
    useEffect(() => {
        const observer = new MutationObserver(() => setTheme(document.documentElement.dataset.theme));
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
        return () => observer.disconnect();
    }, []);
    return theme;
}

/**
 * The Mermaid fallback, loaded lazily and run with `securityLevel: 'strict'`, which
 * sanitizes its SVG output and disables click handlers and HTML labels. It is the
 * only block whose markup is not built by the page's own components.
 */
export default function MermaidBlock({ config }: BlockProps<'mermaid'>) {
    const theme = useThemeName();
    const [state, setState] = useState<{ svg?: string; error?: string }>({});
    useEffect(() => {
        let live = true;
        renderCount += 1;
        const renderId = `mermaid-${renderCount}`;
        loadMermaid()
            .then(async (mermaid) => {
                mermaid.initialize({
                    startOnLoad: false,
                    securityLevel: 'strict',
                    // Throw on a bad source instead of drawing Mermaid's own error picture into the page.
                    suppressErrorRendering: true,
                    theme: 'base',
                    fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
                    themeVariables: {
                        background: cssVar('surface'),
                        primaryColor: cssVar('accent-soft'),
                        primaryBorderColor: cssVar('accent'),
                        primaryTextColor: cssVar('ink'),
                        lineColor: cssVar('ink'),
                        textColor: cssVar('ink'),
                        secondaryColor: cssVar('sunken'),
                        tertiaryColor: cssVar('paper')
                    }
                });
                const { svg } = await mermaid.render(renderId, config.source);
                if (live) setState({ svg });
            })
            .catch((error: unknown) => {
                // Mermaid draws in a `d<id>` wrapper on the body and skips removing it on some failures.
                document.getElementById(`d${renderId}`)?.remove();
                if (live) setState({ error: error instanceof Error ? error.message : 'Mermaid could not render this source' });
            });
        return () => {
            live = false;
        };
    }, [config.source, theme]);

    if (state.error) {
        return (
            <div className="block-error">
                <span className="block-error-title">This Mermaid diagram couldn&apos;t render</span>
                <code>{state.error}</code>
                <pre className="raw-config">{config.source}</pre>
            </div>
        );
    }
    if (!state.svg) return <div className="block-loading">Drawing…</div>;
    // Mermaid's own output, sanitized by Mermaid in strict mode: the one block the page does not build itself.
    // eslint-disable-next-line react/no-danger
    return <div className="mermaid-output" dangerouslySetInnerHTML={{ __html: state.svg }} />;
}
