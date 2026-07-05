import React from 'react';

/**
 * Settings sub-card primitives — the canonical way to render per-mode / detail
 * controls as a set-apart group inside a settings section (e.g. the "Target
 * LUFS" box under the Normalization engine picker). The Audio tab's first four
 * sections are the reference for this look.
 *
 * These wrap the shared `settings-norm-*` styles so callers never hand-roll the
 * box with inline padding or one-off classes. New settings sub-options should
 * use these instead of bare `<div>`s — see `NormalizationBlock` for usage.
 */

/** Bordered, accent-tinted panel that groups detail controls inside a section. */
export function SettingsSubCard({
  children,
  style,
  className,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
  className?: string;
}) {
  return (
    <div className={`settings-norm-block${className ? ` ${className}` : ''}`} style={style}>
      {children}
    </div>
  );
}

/**
 * One labelled group inside a {@link SettingsSubCard}: an optional title and
 * description, the controls, and an optional grey note line below them.
 *
 * `row` lays the label out beside the controls (for a slider/value pair, like
 * the Normalization sliders); the default stacks label → description →
 * controls (for a picker, like the Hi-Res blend-rate buttons).
 */
export function SettingsField({
  label,
  desc,
  note,
  row = false,
  children,
}: {
  label?: React.ReactNode;
  desc?: React.ReactNode;
  note?: React.ReactNode;
  row?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="settings-norm-field">
      {row ? (
        <>
          <div className="settings-norm-row">
            {label != null && <span className="settings-norm-label">{label}</span>}
            {children}
          </div>
          {desc != null && <div className="settings-norm-help">{desc}</div>}
        </>
      ) : (
        <>
          {label != null && (
            <span className="settings-norm-label" style={{ minWidth: 0 }}>
              {label}
            </span>
          )}
          {desc != null && <div className="settings-norm-help">{desc}</div>}
          {children}
        </>
      )}
      {note != null && (
        <div className="settings-norm-help" role="note">
          {note}
        </div>
      )}
    </div>
  );
}

/**
 * A horizontal control row (label and/or control + value side by side), for a
 * standalone slider inside a {@link SettingsSubCard} or a nested slider/value
 * pair inside a stacked {@link SettingsField}. For a labelled field whose
 * description sits below the row, prefer `<SettingsField row …>`.
 */
export function SettingsRow({ children }: { children: React.ReactNode }) {
  return <div className="settings-norm-row">{children}</div>;
}

/** Right-aligned, tabular value readout for a slider row. */
export function SettingsValue({ children }: { children: React.ReactNode }) {
  return <span className="settings-norm-value">{children}</span>;
}

/**
 * Accent callout (border-left + tinted background) for an important caveat
 * inside a {@link SettingsSubCard} — e.g. the Normalization first-play note.
 * For a plain grey note line, use the `note` prop on {@link SettingsField}.
 */
export function SettingsCallout({ children }: { children: React.ReactNode }) {
  return <div className="settings-norm-note">{children}</div>;
}
