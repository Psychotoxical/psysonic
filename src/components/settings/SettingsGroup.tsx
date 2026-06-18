import React from 'react';

interface Props {
  title: string;
  /** Optional one-line description shown under the title. */
  desc?: string;
  children: React.ReactNode;
}

/**
 * Boxed settings sub-section — a bordered panel with an accent uppercase
 * header that sets a group of related controls apart inside a settings card.
 * Wraps the `.settings-group` styles so the look stays consistent everywhere
 * it is used (Audio, Appearance, Library, …).
 */
export function SettingsGroup({ title, desc, children }: Props) {
  return (
    <div className="settings-group">
      <div className="settings-group-title">{title}</div>
      {desc && <div className="settings-group-desc">{desc}</div>}
      {children}
    </div>
  );
}
