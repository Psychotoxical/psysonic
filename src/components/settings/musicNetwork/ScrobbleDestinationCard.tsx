import { useTranslation } from 'react-i18next';
import { getPreset, type Account, type UserProfile } from '../../../music-network';
import { renderPresetIcon } from './presetIcon';

/**
 * One connected account: icon, label, status, optional profile stats (for the
 * enrichment primary), the per-account scrobble toggle, and disconnect.
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.75rem 1rem', borderRadius: '10px', background: 'color-mix(in srgb, var(--accent) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--accent) 20%, transparent)' }}>
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
        <button
          className="btn btn-ghost"
          style={{ fontSize: 12, padding: '4px 10px', flexShrink: 0 }}
          onClick={onDisconnect}
        >
          {t('musicNetwork.disconnect')}
        </button>
      </div>
      <div className="settings-toggle-row">
        <div style={{ fontWeight: 500 }}>{t('musicNetwork.scrobbleHere')}</div>
        <label className="toggle-switch" aria-label={t('musicNetwork.scrobbleHere')}>
          <input
            type="checkbox"
            checked={account.scrobbleEnabled}
            onChange={e => onToggleScrobble(e.target.checked)}
          />
          <span className="toggle-track" />
        </label>
      </div>
    </div>
  );
}
