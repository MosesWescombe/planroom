import escapeRegExp from 'lodash/escapeRegExp.js';

/** Words that may lead a declaration: exports, access and other modifiers. */
const MODIFIER = String.raw`(?:export|default|declare|abstract|async|public|private|protected|internal|static|final|sealed|open|partial|override|virtual|readonly|unsafe|extern|inline|data|enum|pub(?:\([^)]*\))?)`;

/** Keywords that declare the name after them. */
const KEYWORD =
    '(?:class|interface|type|enum|struct|trait|union|record|object|protocol|namespace|module|typealias|typedef|function|def|fn|func|fun|sub|const|let|var|val)';

/** Words that start a statement or an expression, never a function header. */
const CONTROL =
    '(?:if|else|elif|while|for|foreach|do|switch|match|when|case|guard|return|await|yield|throw|new|try|catch|finally|using|lock|synchronized|with|in|of|not|and|or|go|defer|select|unless|until|loop)';

/** What may come before a header's name: its return type, generics and further modifiers. */
const TYPE = String.raw`(?:[\w$<>,.\[\]?*\s]*\s)?`;

/** The longest line tried; a declaration is short, and a minified line would only make the patterns backtrack. */
const MAX_LINE = 400;

/**
 * Whether a line of code reads as declaring `name`, by the shapes declarations take across common languages rather
 * than by parsing one: after a declaring keyword (`class Foo`, `export async function foo`, `const foo`, `def foo`,
 * `pub fn foo`), as a Go method, as a header led by a modifier (`public static Foo foo(`, `private foo: Foo`), or as a
 * function or method header ending in `{` (`foo(x: number): string {`, `int foo(int x) {`). Imports, calls and object
 * literal keys do not count, nor do interface members and other properties without a modifier.
 */
// ponytail: shape matching, so a call that looks like a header (a Kotlin trailing lambda) counts and a declaration in
// an unlisted shape (Python `FOO = 1`, a multi-line header without a modifier) does not; a symbol index such as
// tree-sitter tags would make it exact.
export function declares(line: string, name: string): boolean {
    if (line.length > MAX_LINE) return false;
    const n = `${escapeRegExp(name)}(?![\\w$])`;
    return [
        String.raw`^\s*(?:${MODIFIER}\s+)*${KEYWORD}[\s*]+${n}`,
        String.raw`^\s*func\s*\([^)]*\)\s*${n}`,
        String.raw`^\s*(?:${MODIFIER}\s+)+${TYPE}${n}\s*(?:<[^>]*>)?[?!]?\s*[(:=]`,
        String.raw`^\s*(?!${CONTROL}(?![\w$]))${TYPE}${n}\s*(?:<[^>]*>)?\([^;'"\`]*\)[^;=]*\{\s*$`
    ].some((pattern) => new RegExp(pattern).test(line));
}
