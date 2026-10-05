import { createRoot } from 'react-dom/client';
import { App } from './App';
import { openStream } from './api';
import { applyPageWidth, readPageWidth } from './pageWidth';
import { ViewStore } from './store';
import { applyTheme, readPreference, resolveTheme } from './theme';
import './app.css';

// Apply the theme and width before the first paint, so a dark-mode page never flashes light and nothing reflows.
applyTheme(resolveTheme(readPreference()));
applyPageWidth(readPageWidth());
// Printing, and so Export PDF, always uses the light theme; the chosen one comes back after.
window.addEventListener('beforeprint', () => applyTheme('light'));
window.addEventListener('afterprint', () => applyTheme(resolveTheme(readPreference())));

const store = new ViewStore();
openStream({
    onMessage: (message) => {
        if (message.type === 'browse') store.browse(message.readOnly);
        else if (message.type === 'snapshot') store.snapshot(message.view);
        else store.apply(message.patches);
    },
    onState: (state) => store.setConnection(state)
});

createRoot(document.getElementById('root')!).render(<App store={store} />);
