import { common, createLowlight } from 'lowlight';

const lowlight = createLowlight(common);

type HastNode = ReturnType<typeof lowlight.highlight>['children'][number];

/** One run of highlighted text: its text and the highlight.js classes of each span around it, outermost first. */
export interface Token {
    text: string;
    scopes: string[];
}

/**
 * The languages a guess picks from. highlight.js's full set misreads short pastes (TypeScript as
 * VB.NET, prose as SQL), so the guess is held to what this team pastes. The TypeScript grammar
 * covers JavaScript too, and leaving `javascript` out stops it winning TypeScript pastes.
 */
const GUESSABLE = ['typescript', 'json', 'yaml', 'bash', 'sql', 'python', 'css', 'xml', 'graphql', 'diff', 'go'];

/** Characters that are dense in code and rare in prose. */
const CODE_SYMBOLS = /[{}[\]()<>;=_$|&\\]/g;

/** Whether text parses as a JSON object or array. */
function isJson(text: string): boolean {
    if (!/^\s*[[{]/.test(text)) return false;
    try {
        JSON.parse(text);
        return true;
    } catch {
        return false;
    }
}

/**
 * Whether pasted text reads as code rather than prose: JSON, or text dense in code symbols or
 * mostly indented. Paragraphs are long lines, so text averaging over 120 characters a line is prose.
 */
export function looksLikeCode(text: string): boolean {
    if (isJson(text)) return true;
    const lines = text.split('\n').filter((line) => line.trim());
    const chars = text.replace(/\s/g, '').length;
    if (lines.length === 0 || chars / lines.length > 120) return false;
    const symbols = text.match(CODE_SYMBOLS)?.length ?? 0;
    const indented = lines.filter((line) => /^\s/.test(line)).length;
    return symbols / chars >= 0.03 || indented / lines.length >= 0.3;
}

/** The likeliest language for a piece of code, or undefined when nothing matches. */
export function guessLanguage(code: string): string | undefined {
    if (isJson(code)) return 'json';
    const result = lowlight.highlightAuto(code, { subset: GUESSABLE });
    return result.data?.relevance ? result.data.language : undefined;
}

/** The language to highlight code in: the one named, else the file's extension, else a guess from the code. */
export function resolveLanguage(code: string, lang?: string, file?: string): string | undefined {
    const extension = file && /\.([\w-]+)$/.exec(file)?.[1];
    return [lang, extension].find((name) => name && lowlight.registered(name)) ?? guessLanguage(code);
}

/**
 * Highlight code and split it into lines of tokens. A span that crosses a line break, such as a
 * block comment, is carried onto every line it covers. An unknown language gives plain lines.
 */
export function highlightLines(code: string, language: string | undefined): Token[][] {
    if (!language || !lowlight.registered(language)) return code.split('\n').map((text) => (text ? [{ text, scopes: [] }] : []));
    const lines: Token[][] = [[]];
    const walk = (nodes: readonly HastNode[], scopes: string[]) => {
        for (const node of nodes) {
            if (node.type === 'text') {
                node.value.split('\n').forEach((text, index) => {
                    if (index > 0) lines.push([]);
                    if (text) lines[lines.length - 1]!.push({ text, scopes });
                });
            } else if (node.type === 'element') {
                const names = node.properties.className;
                walk(node.children, [...scopes, Array.isArray(names) ? names.join(' ') : String(names ?? '')]);
            }
        }
    };
    walk(lowlight.highlight(language, code).children, []);
    return lines;
}
