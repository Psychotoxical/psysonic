import React from 'react';
import { useTranslation } from 'react-i18next';

interface Props {
  /** Accent uppercase header. Omit for a plain boxed panel (no header) —
   *  used when the surrounding SettingsSubSection already names the group. */
  title?: string;
  /** Optional accent-coloured icon shown before the title (e.g. on the flat
   *  Themes sections). Ignored when `title` is omitted. */
  icon?: React.ReactNode;
  /** Optional one-line description shown under the title. */
  desc?: string;
  /** Show an "Advanced" badge after the title (e.g. for a group that only
   *  renders in Advanced Mode). Ignored when `title` is omitted. */
  advanced?: boolean;
  /** Optional right-aligned node in the title row (e.g. a reset button).
   *  Ignored when `title` is omitted. */
  action?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * Boxed settings sub-section — a bordered panel (optionally with an accent
 * uppercase header) that sets a group of related controls apart inside a
 * settings card. Wraps the `.settings-group` styles so the look stays
 * consistent everywhere it is used (Audio, Appearance, Library, …).
 */
export function SettingsGroup({ title, icon, desc, advanced, action, children }: Props) {
  const { t } = useTranslation();
  return (
    <div className="settings-group">
      {title && (
        <div className="settings-group-title">
          {icon && <span className="settings-group-title-icon">{icon}</span>}
          {title}
          {(advanced || action) && (
            <span className="settings-group-title-end">
              {advanced && (
                <span className="settings-sub-section-advanced-badge">
                  {t('settings.advancedBadge')}
                </span>
              )}
              {action}
            </span>
          )}
        </div>
      )}
      <div className="settings-group-body">
        {desc && <div className="settings-group-desc">{desc}</div>}
        {children}
      </div>
    </div>
  );
}
