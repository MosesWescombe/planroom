import upperFirst from 'lodash/upperFirst';
import { type ReactNode, useState } from 'react';
import { TAKE_KINDS } from '../../shared/blocks';
import {
    CODE_VIEW_TITLES,
    CODE_VIEWS,
    DENSITIES,
    REVIEW_STRENGTH_DETAILS,
    REVIEW_STRENGTHS,
    REVIEW_VIEW_TITLES,
    REVIEW_VIEWS,
    REVIEWER_EFFORTS,
    REVIEWER_MODELS,
    type ReviewerPreference,
    type ReviewPreferences,
    TAKE_TITLES,
    TECHNIQUE_TITLES,
    TECHNIQUES,
    TEST_VIEW_TITLES,
    TEST_VIEWS
} from '../../shared/review';
import { type PageWidth, usePageWidth } from '../pageWidth';
import { type SendKey, setSendKey, useSendKey } from '../sendKey';
import { deepEqual, useSelector } from '../store';
import { type ThemePreference, useTheme } from '../theme';
import { quietly, useActions } from '../ui';
import { SettingsIcon } from './icons';
import { Modal } from './Modal';

const SEND_OPTIONS: readonly { key: SendKey; label: string; detail: string }[] = [
    { key: 'shift-enter', label: 'Shift + Enter', detail: 'Enter starts a new line' },
    { key: 'enter', label: 'Enter', detail: 'Shift + Enter starts a new line' }
];

/** The colour scheme picker: follow the system, light or dark. */
function ThemeField() {
    const { preference, setPreference } = useTheme();
    return (
        <div className="field">
            <label className="field-label" htmlFor="setting-theme">
                Colour scheme
            </label>
            <select
                id="setting-theme"
                className="field-select"
                value={preference}
                onChange={(event) => setPreference(event.target.value as ThemePreference)}
            >
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
            </select>
        </div>
    );
}

/** Narrow, normal or wide main column; hidden on narrow screens, where the column already fills the width. */
function WidthField() {
    const { width, setWidth } = usePageWidth();
    return (
        <div className="field wide-only">
            <label className="field-label" htmlFor="setting-width">
                Page width
            </label>
            <select
                id="setting-width"
                className="field-select"
                value={width}
                onChange={(event) => setWidth(event.target.value as PageWidth)}
            >
                <option value="narrow">Narrow</option>
                <option value="normal">Normal</option>
                <option value="wide">Wide</option>
            </select>
        </div>
    );
}

/**
 * A row of the Review section that picks one of a fixed list of choices, named by `titles` or capitalised. `unset`
 * names an extra choice of none.
 */
function ChoiceRow<T extends string>({
    label,
    choices,
    titles,
    value,
    unset,
    onChange
}: {
    label: ReactNode;
    choices: readonly T[];
    titles?: Record<T, string>;
    value: T | undefined;
    unset?: string;
    onChange: (value: T | undefined) => void;
}) {
    return (
        <label className="toggle-row">
            <span>{label}</span>
            <select
                className="field-select"
                value={value ?? ''}
                onChange={(event) => onChange(choices.find((choice) => choice === event.target.value))}
            >
                {unset && <option value="">{unset}</option>}
                {choices.map((choice) => (
                    <option key={choice} value={choice}>
                        {titles?.[choice] ?? upperFirst(choice)}
                    </option>
                ))}
            </select>
        </label>
    );
}

/**
 * The reviewer subagents' strength, model and effort, in Settings and on the card that starts a round's review. In
 * Settings the strength can be left to how the reviewer reviews, which `unset` names.
 */
export function ReviewerFields<T extends ReviewerPreference>({
    value,
    unset,
    onChange
}: {
    value: T;
    unset?: string;
    onChange: (value: T) => void;
}) {
    return (
        <>
            <ChoiceRow
                label={
                    <>
                        Strength
                        <span className="small muted">
                            {value.strength
                                ? REVIEW_STRENGTH_DETAILS[value.strength]
                                : 'None for a read-through, standard for the deck.'}
                        </span>
                    </>
                }
                choices={REVIEW_STRENGTHS}
                value={value.strength}
                {...(unset ? { unset } : {})}
                onChange={(strength) => {
                    if (strength || unset) onChange({ ...value, strength });
                }}
            />
            <ChoiceRow
                label="Model"
                choices={REVIEWER_MODELS}
                value={value.model}
                onChange={(model) => model && onChange({ ...value, model })}
            />
            <ChoiceRow
                label="Effort"
                choices={REVIEWER_EFFORTS}
                value={value.effort}
                onChange={(effort) => effort && onChange({ ...value, effort })}
            />
        </>
    );
}

/**
 * A review's preferences, saved on this machine for every review: which your-take cards the agent writes and how many,
 * which apply to slides it has not written yet; the technique and reviewer subagents each round's start card offers;
 * which views of the findings show; and the read-through's code view, tests and auto-tick, which apply at once.
 */
function ReviewSection() {
    const preferences = useSelector((view) => view.preferences, deepEqual);
    const { send } = useActions();
    if (!preferences) return null;
    const save = (next: ReviewPreferences) => quietly(send({ type: 'preferences.set', preferences: next }));
    return (
        <fieldset className="field settings-review">
            <legend className="field-label">Review</legend>
            <span className="small muted">
                Saved on this machine for every review. Card changes apply to slides not yet written.
            </span>
            <span className="small strong">Your-take cards</span>
            {TAKE_KINDS.map((kind) => (
                <label key={kind} className="toggle-row">
                    <span>{TAKE_TITLES[kind]}</span>
                    <input
                        type="checkbox"
                        checked={preferences.takes[kind]}
                        onChange={(event) =>
                            save({ ...preferences, takes: { ...preferences.takes, [kind]: event.target.checked } })
                        }
                    />
                </label>
            ))}
            <ChoiceRow
                label="How many cards"
                choices={DENSITIES}
                value={preferences.density}
                onChange={(density) => density && save({ ...preferences, density })}
            />
            <span className="small strong">Starting a round</span>
            <span className="small muted">What each round offers when you start it; your last choice is kept.</span>
            <ChoiceRow
                label="How to review"
                choices={TECHNIQUES}
                titles={TECHNIQUE_TITLES}
                value={preferences.technique}
                onChange={(technique) => technique && save({ ...preferences, technique })}
            />
            <ReviewerFields
                value={preferences.reviewers}
                unset="By how you review"
                onChange={(reviewers) => save({ ...preferences, reviewers })}
            />
            <span className="small strong">Read-through</span>
            <ChoiceRow
                label="Code view"
                choices={CODE_VIEWS}
                titles={CODE_VIEW_TITLES}
                value={preferences.readthrough.view}
                onChange={(view) => view && save({ ...preferences, readthrough: { ...preferences.readthrough, view } })}
            />
            <ChoiceRow
                label="Tests shown as"
                choices={TEST_VIEWS}
                titles={TEST_VIEW_TITLES}
                value={preferences.readthrough.tests}
                onChange={(tests) => tests && save({ ...preferences, readthrough: { ...preferences.readthrough, tests } })}
            />
            <label className="toggle-row">
                <span>
                    Auto-tick
                    <span className="small muted">
                        A piece ticks itself after 10 seconds on screen, or when you comment on it.
                    </span>
                </span>
                <input
                    type="checkbox"
                    checked={preferences.readthrough.autoTick}
                    onChange={(event) =>
                        save({ ...preferences, readthrough: { ...preferences.readthrough, autoTick: event.target.checked } })
                    }
                />
            </label>
            <span className="small strong">Views of the findings</span>
            {REVIEW_VIEWS.map((view) => (
                <label key={view} className="toggle-row">
                    <span>{REVIEW_VIEW_TITLES[view]}</span>
                    <input
                        type="checkbox"
                        checked={preferences.views[view]}
                        onChange={(event) =>
                            save({ ...preferences, views: { ...preferences.views, [view]: event.target.checked } })
                        }
                    />
                </label>
            ))}
        </fieldset>
    );
}

/** The top bar's settings button and the dialog it opens: colour scheme, page width and the send key. */
export function SettingsButton() {
    const [open, setOpen] = useState(false);
    const sendKey = useSendKey();
    return (
        <>
            <button type="button" className="icon-button" aria-label="Settings" onClick={() => setOpen(true)}>
                <SettingsIcon />
            </button>
            {open && (
                <Modal label="Settings" onClose={() => setOpen(false)} className="dialog dialog-settings">
                    <h2 className="dialog-title">Settings</h2>
                    <div className="settings-columns">
                        <div className="settings-column">
                            <ThemeField />
                            <WidthField />
                            <div className="field" role="radiogroup" aria-labelledby="send-key-label">
                                <span className="field-label" id="send-key-label">
                                    Send comments, messages and answers with
                                </span>
                                {SEND_OPTIONS.map((option) => (
                                    <label key={option.key} className="toggle-row">
                                        <span>
                                            <span className="strong">{option.label}</span>
                                            <span className="small muted">{option.detail}</span>
                                        </span>
                                        <input
                                            type="radio"
                                            name="send-key"
                                            checked={sendKey === option.key}
                                            onChange={() => setSendKey(option.key)}
                                        />
                                    </label>
                                ))}
                                <span className="small muted">⌘/Ctrl + Enter always sends.</span>
                            </div>
                        </div>
                        <ReviewSection />
                    </div>
                </Modal>
            )}
        </>
    );
}
