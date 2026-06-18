import React from 'react';

interface Props {
  /** Accent uppercase header. Omit for a plain boxed panel (no header) —
   *  used when the surrounding SettingsSubSection already names the group. */
  title?: string;
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
export function SettingsGroup({ title, desc, children }: Props) {
  return (
    <div className="settings-group">
      {title && <div className="settings-group-title">{title}</div>}
      <div className="settings-group-body">
        {desc && <div className="settings-group-desc">{desc}</div>}
        {children}
      </div>
    </div>
  );
}
