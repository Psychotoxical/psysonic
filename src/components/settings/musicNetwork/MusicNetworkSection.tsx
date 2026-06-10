import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import LastfmIcon from '../../LastfmIcon';
import SettingsSubSection from '../../SettingsSubSection';
import { showToast } from '../../../utils/ui/toast';
import { useAuthStore } from '../../../store/authStore';
import {
  errorI18nKey,
  getMusicNetworkRuntime,
  isMusicNetworkError,
  type PresetId,
  type UserProfile,
} from '../../../music-network';
import { useMusicNetworkState } from './useMusicNetworkState';
import { ScrobbleDestinationCard } from './ScrobbleDestinationCard';
import { EnrichmentPrimarySelect } from './EnrichmentPrimarySelect';
import { ConnectProviderForm } from './ConnectProviderForm';
import { MalojaProxyWarning } from './MalojaProxyWarning';

/**
 * Integrations UI for the Music Network framework — replaces the old Last.fm
 * card. Manifest-driven: connected destinations, the enrichment-primary picker,
 * the Maloja proxy warning, and the add-a-service list all come from the
 * registry. Mutations go through the runtime; state is read reactively from the
 * auth store (see useMusicNetworkState).
 */
export function MusicNetworkSection() {
  const { t } = useTranslation();
  const { accounts, enrichmentPrimaryId, scrobblingMasterEnabled } = useMusicNetworkState();
  const [primaryProfile, setPrimaryProfile] = useState<UserProfile | null>(null);

  // Profile stats (scrobbles / member-since) for the enrichment primary.
  useEffect(() => {
    if (!enrichmentPrimaryId) { setPrimaryProfile(null); return; }
    let cancelled = false;
    setPrimaryProfile(null);
    getMusicNetworkRuntime().getUserProfile()
      .then(p => { if (!cancelled) setPrimaryProfile(p); })
      .catch(() => { if (!cancelled) setPrimaryProfile(null); });
    return () => { cancelled = true; };
  }, [enrichmentPrimaryId]);

  const setMaster = (v: boolean) => useAuthStore.getState().setScrobblingMasterEnabled(v);
  const toggleScrobble = (id: string, v: boolean) =>
    getMusicNetworkRuntime().updateAccount(id, { scrobbleEnabled: v });
  const disconnect = (id: string) => getMusicNetworkRuntime().disconnect(id);

  const setPrimary = (id: string | null) => {
    try {
      getMusicNetworkRuntime().setEnrichmentPrimaryId(id);
    } catch (e) {
      showToast(isMusicNetworkError(e) ? t(errorI18nKey(e.code)) : t('musicNetwork.connectFailed'), 4000, 'error');
    }
  };

  const connect = (presetId: PresetId, fields: Record<string, string>) =>
    getMusicNetworkRuntime().connect(presetId, { fields }).then(() => undefined);

  const connectedPresetIds = accounts.map(a => a.presetId);

  return (
    <SettingsSubSection title={t('musicNetwork.title')} icon={<LastfmIcon size={16} />}>
      <div className="settings-card">
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: '0.75rem' }}>
          {t('musicNetwork.desc')}
        </p>

        <div className="settings-toggle-row">
          <div>
            <div style={{ fontWeight: 500 }}>{t('musicNetwork.masterToggle')}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('musicNetwork.masterToggleDesc')}</div>
          </div>
          <label className="toggle-switch" aria-label={t('musicNetwork.masterToggle')}>
            <input type="checkbox" checked={scrobblingMasterEnabled} onChange={e => setMaster(e.target.checked)} />
            <span className="toggle-track" />
          </label>
        </div>

        {accounts.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '1rem' }}>
            {accounts.map(account => (
              <ScrobbleDestinationCard
                key={account.id}
                account={account}
                profile={account.id === enrichmentPrimaryId ? primaryProfile : null}
                onToggleScrobble={v => toggleScrobble(account.id, v)}
                onDisconnect={() => disconnect(account.id)}
              />
            ))}
          </div>
        )}

        <div style={{ marginTop: '1rem' }}>
          <EnrichmentPrimarySelect
            accounts={accounts}
            primaryId={enrichmentPrimaryId}
            onChange={setPrimary}
          />
        </div>

        <MalojaProxyWarning accounts={accounts} />

        <div className="settings-section-divider" />
        <div style={{ paddingTop: '0.75rem' }}>
          <ConnectProviderForm connectedPresetIds={connectedPresetIds} onConnect={connect} />
        </div>
      </div>
    </SettingsSubSection>
  );
}
