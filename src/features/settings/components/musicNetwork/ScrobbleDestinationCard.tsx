import { useTranslation } from 'react-i18next';
import { getPreset, type Account, type UserProfile } from '@/music-network';
import { renderPresetIcon } from '@/music-network';

/**
 * One connected account as a single self-contained block: header (icon, label,
 * status, optional profile stats for the enrichment primary) on top, and a
 * footer row holding the per-account scrobble toggle + disconnect — so it is
 * unambiguous which account the toggle belongs to.
 */
export function ScrobbleDestinationCard({
  account,
  profile,
  onToggleScrobble,
  onDisconnect,
}: {
  account: Account;
  profile: UserProfile | null;
  onToggleScrobble: (enabled: boolean) => void;
  onDisconnect: () => void;
}) {
  const { t } = useTranslation();
  const preset = getPreset(account.presetId);
  const icon = preset?.manifest.icon ?? 'custom';

  return (
    <div
      style={{
        borderRadius: '10px',
        background: 'color-mix(in srgb, var(--accent) 8%, transparent)',
        border: '1px solid color-mix(in srgb, var(--accent) 20%, transparent)',
        overflow: 'hidden',
      }}
    >
      {/* Header: identity + status + profile stats */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.75rem 1rem' }}>
        <div style={{ flexShrink: 0 }} aria-hidden="true">{renderPresetIcon(icon, 20)}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontWeight: 600, fontSize: 14 }}>
            {account.label}
            <span
              className={`connection-led connection-led--${account.sessionError ? 'disconnected' : 'connected'}`}
              data-tooltip={account.sessionError ? t('musicNetwork.statusError') : t('musicNetwork.statusConnected')}
            />
          </div>
          {account.username && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>@{account.username}</div>
          )}
          {profile && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2, display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
              <span>{t('musicNetwork.scrobbles', { n: profile.playcount.toLocaleString() })}</span>
              {profile.registeredAt > 0 && (
                <span>{t('musicNetwork.memberSince', { year: new Date(profile.registeredAt * 1000).getFullYear() })}</span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Footer: the scrobble toggle (clearly inside this account's block) + disconnect */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '0.75rem',
          padding: '0.6rem 1rem',
          borderTop: '1px solid color-mix(in srgb, var(--accent) 15%, transparent)',
        }}
      >
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>
          <span className="toggle-switch" style={{ flexShrink: 0 }}>
            <input
              type="checkbox"
              checked={account.scrobbleEnabled}
              onChange={e => onToggleScrobble(e.target.checked)}
              aria-label={t('musicNetwork.scrobbleHere')}
            />
            <span className="toggle-track" />
          </span>
          {t('musicNetwork.scrobbleHere')}
        </label>
        <button
          className="btn btn-ghost"
          style={{ fontSize: 12, padding: '4px 10px', flexShrink: 0 }}
          onClick={onDisconnect}
        >
          {t('musicNetwork.disconnect')}
        </button>
      </div>
    </div>
  );
}
