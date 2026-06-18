import React from 'react';

interface Props {
  /** Accent uppercase header. Omit for a plain boxed panel (no header) —
   *  used when the surrounding SettingsSubSection already names the group. */
  title?: string;
  /** Optional accent-coloured icon shown before the title (e.g. on the flat
   *  Themes sections). Ignored when `title` is omitted. */
  icon?: React.ReactNode;
  /** Optional one-line description shown under the title. */
  desc?: string;
  children: React.ReactNode;
}

/**
 * Boxed settings sub-section — a bordered panel (optionally with an accent
 * uppercase header) that sets a group of related controls apart inside a
 * settings card. Wraps the `.settings-group` styles so the look stays
 * consistent everywhere it is used (Audio, Appearance, Library, …).
 */
export function SettingsGroup({ title, icon, desc, children }: Props) {
  return (
    <div className="settings-group">
      {title && (
        <div className="settings-group-title">
          {icon && <span className="settings-group-title-icon">{icon}</span>}
          {title}
        </div>
      )}
      <div className="settings-group-body">
        {desc && <div className="settings-group-desc">{desc}</div>}
        {children}
      </div>
    </div>
  );
}
