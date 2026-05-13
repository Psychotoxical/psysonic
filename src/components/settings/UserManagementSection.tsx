import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RotateCcw, UserPlus, Users } from 'lucide-react';
import type { NdUser } from '../../api/navidromeAdmin';
import ConfirmModal from '../ConfirmModal';
import { useUserMgmtData } from '../../hooks/useUserMgmtData';
import { useUserMgmtActions } from '../../hooks/useUserMgmtActions';
import { UserForm } from './UserForm';
import { UserMgmtRow } from './userMgmt/UserMgmtRow';
import { MagicStringModal } from './userMgmt/MagicStringModal';

export function UserManagementSection({
  serverUrl,
  token,
  currentUsername,
}: {
  serverUrl: string;
  token: string;
  currentUsername: string;
}) {
  const { t, i18n } = useTranslation();
  const { users, libraries, loading, loadError, load } = useUserMgmtData(serverUrl, token, t);
  const [editing, setEditing] = useState<NdUser | 'new' | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<NdUser | null>(null);
  const [magicRowUser, setMagicRowUser] = useState<NdUser | null>(null);
  const { busy, handleSave, handleSaveAndGetMagic, performDelete } = useUserMgmtActions({
    serverUrl, token, libraries, editing, setEditing, reload: load, t,
  });

  return (
    <section className="settings-section">
      <div className="settings-section-header">
        <Users size={18} />
        <h2>{t('settings.userMgmtTitle')}</h2>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
        {t('settings.userMgmtDesc')}
      </div>

      {loading && (
        <div className="settings-card" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div className="spinner" style={{ width: 14, height: 14 }} />
          <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>…</span>
        </div>
      )}

      {!loading && loadError && (
        <div
          className="settings-card"
          style={{
            color: 'var(--danger)',
            fontSize: 13,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{t('settings.userMgmtLoadFriendly')}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', wordBreak: 'break-word' }}>{loadError}</div>
          </div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void load()}
            style={{ flexShrink: 0 }}
          >
            <RotateCcw size={14} /> {t('settings.userMgmtRetry')}
          </button>
        </div>
      )}

      {!loading && !loadError && (
        <>
          {editing ? (
            <UserForm
              initial={editing === 'new' ? null : editing}
              libraries={libraries}
              shareServerUrl={serverUrl}
              ndToken={token}
              onUsersDirty={load}
              onSave={handleSave}
              onSaveAndGetMagic={editing === 'new' ? handleSaveAndGetMagic : undefined}
              onCancel={() => setEditing(null)}
              busy={busy}
            />
          ) : (
            <button
              className="btn btn-surface"
              style={{ marginBottom: '0.75rem' }}
              onClick={() => setEditing('new')}
              disabled={busy}
            >
              <UserPlus size={16} /> {t('settings.userMgmtAddUser')}
            </button>
          )}

          {users.length === 0 ? (
            <div className="settings-card" style={{ color: 'var(--text-muted)', fontSize: 14 }}>
              {t('settings.userMgmtEmpty')}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {users.map(u => (
                <UserMgmtRow
                  key={u.id}
                  user={u}
                  libraries={libraries}
                  isSelf={u.userName === currentUsername}
                  busy={busy}
                  onEdit={setEditing}
                  onRequestDelete={setConfirmingDelete}
                  onRequestMagic={setMagicRowUser}
                  t={t}
                  i18n={i18n}
                />
              ))}
            </div>
          )}
        </>
      )}
      <ConfirmModal
        open={!!confirmingDelete}
        title={t('settings.userMgmtDelete')}
        message={confirmingDelete
          ? t('settings.userMgmtConfirmDelete', { username: confirmingDelete.userName })
          : ''}
        confirmLabel={t('settings.userMgmtDelete')}
        cancelLabel={t('settings.userMgmtCancel')}
        danger
        onConfirm={() => {
          if (!confirmingDelete) return;
          const target = confirmingDelete;
          setConfirmingDelete(null);
          void performDelete(target);
        }}
        onCancel={() => setConfirmingDelete(null)}
      />
      {magicRowUser && (
        <MagicStringModal
          user={magicRowUser}
          serverUrl={serverUrl}
          token={token}
          onClose={() => setMagicRowUser(null)}
          onSuccess={load}
          t={t}
        />
      )}
    </section>
  );
}
