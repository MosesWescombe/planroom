/** "now", "12s ago", "3m ago", "2h ago", or the date. */
export function relativeTime(iso: string | undefined, now = Date.now()): string {
    if (!iso) return '';
    const seconds = Math.round((now - Date.parse(iso)) / 1000);
    if (Number.isNaN(seconds)) return '';
    if (seconds < 5) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
    return new Date(iso).toLocaleDateString();
}

/** 3000 -> "3,000", 0.0004 -> "0.0004" (a fraction keeps 3 significant digits), a missing value -> "-"; strings pass through. */
export function formatValue(value: string | number | null | undefined): string {
    if (value === null || value === undefined) return '-';
    if (typeof value === 'string') return value;
    // The default rounds to 3 decimals, which shows a small non-zero value as "0".
    return value !== 0 && Math.abs(value) < 1
        ? value.toLocaleString('en', { maximumSignificantDigits: 3 })
        : value.toLocaleString('en');
}

/** `n` and the noun: `one` when `n` is 1, else `many`, which defaults to `one` plus "s". */
export function plural(n: number, one: string, many = `${one}s`): string {
    return `${n} ${n === 1 ? one : many}`;
}
