import React from 'react';
import { Shield, Trash2, User, Wand2 } from 'lucide-react';
import type { i18n as I18nType, TFunction } from 'i18next';
import type { NdLibrary, NdUser } from '../../../api/navidromeAdmin';
import { formatLastSeen } from '../../../utils/userMgmtHelpers';

interface Props {
  user: NdUser;
  libraries: NdLibrary[];
  isSelf: boolean;
  busy: boolean;
  onEdit: (u: NdUser) => void;
  onRequestDelete: (u: NdUser) => void;
  onRequestMagic: (u: NdUser) => void;
  t: TFunction;
  i18n: I18nType;
}

/**
 * Single user list row in the admin user management section.
 *
 * Whole row is keyboard-activatable as a button (Enter / Space → edit
 * mode) since the click target is a `<div>` rather than a real button —
 * we need nested action buttons (magic string, delete) and a `<button>`
 * inside a `<button>` is invalid HTML.
 *
 * The library-names column is built from the union of the user's
 * libraryIds and the live libraries list, so it stays in sync if the
 * admin re-assigns libraries elsewhere.
 */
export function UserMgmtRow({
  user: u,
  libraries,
  isSelf,
  busy,
  onEdit,
  onRequestDelete,
  onRequestMagic,
  t,
  i18n,
}: Props) {
  const libNames = u.isAdmin
    ? null
    : u.libraryIds.length === 0
      ? t('settings.userMgmtNoLibraries')
      : libraries.filter(l => u.libraryIds.includes(l.id)).map(l => l.name).join(', ');
  const lastSeen = formatLastSeen(u.lastAccessAt, i18n.language, t('settings.userMgmtNeverSeen'));
  const lastSeenAbsolute = u.lastAccessAt
    ? new Date(u.lastAccessAt).toLocaleString(i18n.language)
    : '';

  return (
    <div
      className="settings-card user-row"
      role="button"
      tabIndex={0}
      onClick={() => { if (!busy) onEdit(u); }}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !busy) {
          e.preventDefault();
          onEdit(u);
        }
      }}
      style={{
        padding: '6px 10px',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        cursor: busy ? 'default' : 'pointer',
      }}
    >
      <User size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
      <span style={{ fontWeight: 600, fontSize: 13, flexShrink: 0 }}>{u.userName}</span>
      {u.name && u.name !== u.userName && (
        <span style={{ fontSize: 12, color: 'var(--text-muted)', flexShrink: 0 }}>· {u.name}</span>
      )}
      {isSelf && (
        <span style={{ fontSize: 10, background: 'var(--accent)', color: 'var(--ctp-crust)', padding: '1px 6px', borderRadius: 10, fontWeight: 600, flexShrink: 0 }}>
          {t('settings.userMgmtYouBadge')}
        </span>
      )}
      {u.isAdmin && (
        <span
          style={{ fontSize: 10, display: 'inline-flex', alignItems: 'center', gap: 3, padding: '1px 6px', borderRadius: 10, fontWeight: 600, background: 'color-mix(in srgb, var(--color-warning, #f59e0b) 22%, transparent)', color: 'var(--text-primary)', flexShrink: 0 }}
          data-tooltip={t('settings.userMgmtRoleAdmin')}
        >
          <Shield size={10} />
          {t('settings.userMgmtAdminBadge')}
        </span>
      )}
      <span style={{ fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }}>
        {libNames || ''}
      </span>
      {!u.isAdmin && (
        <button
          type="button"
          className="btn btn-ghost"
          style={{ padding: '2px 6px', flexShrink: 0 }}
          onClick={(e) => { e.stopPropagation(); onRequestMagic(u); }}
          disabled={busy}
          data-tooltip={t('settings.userMgmtMagicStringGenerate')}
        >
          <Wand2 size={14} />
        </button>
      )}
      <span
        style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}
        data-tooltip={lastSeenAbsolute || undefined}
      >
        {lastSeen}
      </span>
      <button
        className="btn btn-ghost"
        style={{ color: 'var(--danger)', padding: '2px 6px', flexShrink: 0 }}
        onClick={(e) => { e.stopPropagation(); onRequestDelete(u); }}
        disabled={busy || isSelf}
        data-tooltip={t('settings.userMgmtDelete')}
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}
