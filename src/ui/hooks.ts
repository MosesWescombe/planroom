import { useEffect, useState } from 'react';

/** The current time, refreshed every `intervalMs`, for relative timestamps. */
export function useNow(intervalMs = 15_000): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
        return () => window.clearInterval(timer);
    }, [intervalMs]);
    return now;
}

/** Whether the viewport is below the narrow-layout breakpoint. */
export function useNarrow(query = '(max-width: 959.98px)'): boolean {
    const [narrow, setNarrow] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia(query).matches);
    useEffect(() => {
        if (typeof window.matchMedia !== 'function') return undefined;
        const media = window.matchMedia(query);
        const update = () => setNarrow(media.matches);
        update();
        media.addEventListener('change', update);
        return () => media.removeEventListener('change', update);
    }, [query]);
    return narrow;
}
