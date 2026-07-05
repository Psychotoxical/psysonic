import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import type { Account } from '@/music-network';

/**
 * Shown when a Maloja account is connected AND Last.fm scrobbling is enabled —
 * Maloja can forward scrobbles to Last.fm, so both paths active risks duplicates.
 */
export function MalojaProxyWarning({ accounts }: { accounts: Account[] }) {
  const { t } = useTranslation();
  const hasMaloja = accounts.some(a => a.presetId.startsWith('maloja'));
  const lastfmScrobbling = accounts.some(a => a.presetId === 'lastfm' && a.scrobbleEnabled);
  if (!hasMaloja || !lastfmScrobbling) return null;

  return (
    <div className="settings-privacy-notice" role="note" style={{ marginTop: '0.5rem' }}>
      <AlertTriangle size={16} className="settings-privacy-notice-icon" aria-hidden="true" />
      <div className="settings-privacy-notice-body">{t('musicNetwork.malojaProxyWarning')}</div>
    </div>
  );
}
