import { type ReactNode, useState } from 'react';
import { useNarrow } from '../hooks';
import { readSetting, writeSetting } from '../local';
import { planDir } from '../../shared/state';
import { useSelector } from '../store';
import { Logo, PanelIcon } from './icons';
import { PlanSwitcher } from './PlanSwitcher';
import { type PaneSize, ResizeHandle, useStoredWidth } from './Resizer';

const COLLAPSED_KEY = 'planroom:rail-collapsed';
const RAIL_SIZE: PaneSize = { key: 'planroom:rail-width', initial: 272, min: 200, maxShare: 0.4 };

/**
 * Planroom's mark and name with the change id under them, heading the rail level with the top row. The change id opens
 * the plan switcher. The collapsed rail keeps only the mark, which names the change on hover.
 */
function Brand({ compact = false }: { compact?: boolean }) {
    const path = useSelector((view) => planDir(view.format, view.changeId));
    if (compact) {
        return (
            <div className="brand" title={path}>
                <Logo />
            </div>
        );
    }
    return (
        <div className="brand">
            <div className="brand-mark">
                <Logo />
                <span className="brand-name">Planroom</span>
            </div>
            <PlanSwitcher />
        </div>
    );
}

/**
 * The left rail each tab puts its navigation in, running the full height of the page under the brand. On a wide screen
 * it collapses to a strip and resizes from its right edge, both remembered per browser; on a narrow one it is the
 * navigation drawer instead. `strip` is what the collapsed strip shows under its expand button.
 */
export function Rail({ children, strip }: { children: ReactNode; strip?: ReactNode }) {
    const narrow = useNarrow();
    const [collapsed, setCollapsed] = useState(() => readSetting(COLLAPSED_KEY) === '1');
    const [width, setWidth] = useStoredWidth(RAIL_SIZE);
    const collapse = (next: boolean) => {
        setCollapsed(next);
        writeSetting(COLLAPSED_KEY, next ? '1' : undefined);
    };

    if (narrow) {
        return (
            <div className="rail-wrap">
                <div className="rail-head">
                    <Brand />
                </div>
                {children}
            </div>
        );
    }
    if (collapsed) {
        return (
            <div className="rail-wrap is-collapsed">
                <div className="rail-head">
                    <Brand compact />
                </div>
                <button
                    type="button"
                    className="icon-button icon-mirror"
                    aria-label="Expand navigation"
                    title="Expand navigation"
                    onClick={() => collapse(false)}
                >
                    <PanelIcon open={false} />
                </button>
                {strip}
            </div>
        );
    }
    return (
        <div className="rail-wrap" style={{ width }}>
            <div className="rail-head">
                <Brand />
                <button
                    type="button"
                    className="icon-button icon-mirror"
                    aria-label="Collapse navigation"
                    title="Collapse navigation"
                    onClick={() => collapse(true)}
                >
                    <PanelIcon open />
                </button>
            </div>
            <div className="rail-scroll">{children}</div>
            <ResizeHandle label="Resize navigation" edge="right" size={RAIL_SIZE} width={width} setWidth={setWidth} />
        </div>
    );
}
