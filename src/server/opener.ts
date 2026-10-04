import { spawn } from 'node:child_process';

/** Opens a URL in the user's browser; resolves whether a browser was launched. */
export type BrowserOpener = (url: string) => Promise<boolean>;

/** The platform opener command for a URL. */
export function openerCommand(url: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
    if (platform === 'darwin') return { command: 'open', args: [url] };
    // `start` is a cmd builtin; its first quoted argument is the window title.
    if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '""', url] };
    return { command: 'xdg-open', args: [url] };
}

/**
 * Open the page with the platform opener. Failure is never fatal: the URL is always
 * returned to the agent to print. Output is discarded because stdout is the MCP stream.
 */
export const openInBrowser: BrowserOpener = (url) =>
    new Promise((resolve) => {
        const { command, args } = openerCommand(url);
        try {
            const child = spawn(command, args, { stdio: 'ignore', detached: true });
            child.once('error', () => resolve(false));
            child.once('spawn', () => {
                child.unref();
                resolve(true);
            });
        } catch {
            resolve(false);
        }
    });
