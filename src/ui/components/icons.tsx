/** The handoff's stroke icons. All are decorative; the control carrying one names itself. */

interface IconProps {
    size?: number;
}

const stroke = { fill: 'none', stroke: 'currentColor', strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

/** A tick, for done and answered. */
export function CheckIcon({ size = 10 }: IconProps) {
    return (
        <svg width={size} height={size} viewBox="0 0 16 16" {...stroke} strokeWidth="2.4" aria-hidden="true">
            <path d="M3.5 8.5l3 3 6-7" />
        </svg>
    );
}

/** A short dash, for a closed question. */
export function DashIcon({ size = 10 }: IconProps) {
    return (
        <svg width={size} height={size} viewBox="0 0 16 16" {...stroke} strokeWidth="2.2" aria-hidden="true">
            <path d="M4 8h8" />
        </svg>
    );
}

/** A padlock, for a locked phase. */
export function LockIcon({ size = 11 }: IconProps) {
    return (
        <svg width={size} height={size} viewBox="0 0 16 16" {...stroke} strokeWidth="1.8" aria-hidden="true">
            <rect x="3" y="7" width="10" height="7" rx="1.5" />
            <path d="M5.5 7V5a2.5 2.5 0 015 0v2" />
        </svg>
    );
}

/** A plus sign, for adding. */
export function PlusIcon({ size = 14 }: IconProps) {
    return (
        <svg width={size} height={size} viewBox="0 0 16 16" {...stroke} strokeWidth="1.8" aria-hidden="true">
            <path d="M8 3v10M3 8h10" />
        </svg>
    );
}

/** A minus sign, for removing. */
export function MinusIcon({ size = 14 }: IconProps) {
    return (
        <svg width={size} height={size} viewBox="0 0 16 16" {...stroke} strokeWidth="1.8" aria-hidden="true">
            <path d="M3 8h10" />
        </svg>
    );
}

/** A warning triangle. */
export function WarningIcon({ size = 16 }: IconProps) {
    return (
        <svg width={size} height={size} viewBox="0 0 16 16" {...stroke} strokeWidth="1.8" aria-hidden="true">
            <path d="M8 2.5l6 11H2z" />
            <path d="M8 7v3" />
        </svg>
    );
}

/** An arrow turning into a line, for a merged question. */
export function MergeIcon({ size = 18 }: IconProps) {
    return (
        <svg width={size} height={size} viewBox="0 0 16 16" {...stroke} strokeWidth="1.6" aria-hidden="true">
            <path d="M3 3v4a3 3 0 003 3h7" />
            <path d="M10 7l3 3-3 3" />
        </svg>
    );
}

/** A speech bubble, for comments. */
export function CommentIcon({ size = 18 }: IconProps) {
    return (
        <svg width={size} height={size} viewBox="0 0 16 16" {...stroke} strokeWidth="1.4" aria-hidden="true">
            <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
        </svg>
    );
}

/** A pulse line, for the Activity tab. */
export function ActivityIcon({ size = 18 }: IconProps) {
    return (
        <svg width={size} height={size} viewBox="0 0 20 20" {...stroke} strokeWidth="1.6" aria-hidden="true">
            <path d="M2.5 10h3l2-5 5 10 2-5h3" />
        </svg>
    );
}

/** A paper plane, for sending. */
export function SendIcon({ size = 18 }: IconProps) {
    return (
        <svg width={size} height={size} viewBox="0 0 20 20" {...stroke} strokeWidth="1.6" aria-hidden="true">
            <path d="M3 10l14-6-5 13-2.5-5.5z" />
        </svg>
    );
}

/** A ticked page, for the Review tab. */
export function ReviewIcon({ size = 18 }: IconProps) {
    return (
        <svg width={size} height={size} viewBox="0 0 20 20" {...stroke} strokeWidth="1.6" aria-hidden="true">
            <rect x="4" y="2.5" width="12" height="15" rx="2" />
            <path d="M7 10l2 2 4-4.5" />
        </svg>
    );
}

/** The side panel, its chevron pointing right when `open` and left when not. */
export function PanelIcon({ size = 18, open }: IconProps & { open: boolean }) {
    return (
        <svg width={size} height={size} viewBox="0 0 20 20" {...stroke} strokeWidth="1.6" aria-hidden="true">
            <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
            <line x1="12.5" y1="3.5" x2="12.5" y2="16.5" />
            <path d={open ? 'M7 8l2 2-2 2' : 'M9 8l-2 2 2 2'} />
        </svg>
    );
}

/** Three lines, for the navigation menu. */
export function MenuIcon({ size = 20 }: IconProps) {
    return (
        <svg width={size} height={size} viewBox="0 0 20 20" {...stroke} strokeWidth="1.6" aria-hidden="true">
            <path d="M3 5h14M3 10h14M3 15h14" />
        </svg>
    );
}

/** Three sliders, for settings. */
export function SettingsIcon({ size = 18 }: IconProps) {
    return (
        <svg width={size} height={size} viewBox="0 0 20 20" {...stroke} strokeWidth="1.6" aria-hidden="true">
            <path d="M3 5h8M15 5h2M3 10h3M10 10h7M3 15h9M16 15h1" />
            <circle cx="13" cy="5" r="2" />
            <circle cx="8" cy="10" r="2" />
            <circle cx="14" cy="15" r="2" />
        </svg>
    );
}

/** A folder. */
export function FolderIcon({ size = 14 }: IconProps) {
    return (
        <svg width={size} height={size} viewBox="0 0 16 16" {...stroke} strokeWidth="1.5" aria-hidden="true">
            <path d="M2 4.5h4l1.5 1.5H14v6.5H2z" />
        </svg>
    );
}

/** Arrows out to two corners, for full screen. */
export function ExpandIcon({ size = 14 }: IconProps) {
    return (
        <svg width={size} height={size} viewBox="0 0 16 16" {...stroke} strokeWidth="1.6" aria-hidden="true">
            <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5l-4.5 4.5M2.5 13.5l4.5-4.5" />
        </svg>
    );
}

/** An arrow down into a tray, for export. */
export function DownloadIcon({ size = 18 }: IconProps) {
    return (
        <svg width={size} height={size} viewBox="0 0 20 20" {...stroke} strokeWidth="1.6" aria-hidden="true">
            <path d="M10 3v10M6 9l4 4 4-4M3 14v3h14v-3" />
        </svg>
    );
}

/** A cross, for closing. */
export function CloseIcon({ size = 16 }: IconProps) {
    return (
        <svg width={size} height={size} viewBox="0 0 16 16" {...stroke} strokeWidth="1.8" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
    );
}

/** Points down; rotate it to point right for a collapsed state. */
export function ChevronIcon({ size = 10 }: IconProps) {
    return (
        <svg width={size} height={size} viewBox="0 0 16 16" {...stroke} strokeWidth="2" aria-hidden="true">
            <path d="M4 6l4 4 4-4" />
        </svg>
    );
}

/** The Planroom mark from the top bar. */
export function Logo() {
    return (
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
            <rect x="0" y="0" width="24" height="24" rx="6" fill="var(--ink)" />
            <line x1="6" y1="8" x2="18" y2="8" stroke="var(--paper)" strokeWidth="2" strokeLinecap="round" />
            <line x1="6" y1="12" x2="14" y2="12" stroke="var(--paper)" strokeWidth="2" strokeLinecap="round" />
            <line x1="6" y1="16" x2="11" y2="16" stroke="#E0A56F" strokeWidth="2" strokeLinecap="round" />
        </svg>
    );
}
