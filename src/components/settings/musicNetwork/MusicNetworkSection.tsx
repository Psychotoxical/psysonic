import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Share2 } from 'lucide-react';
import SettingsSubSection from '../../SettingsSubSection';
import { SettingsGroup } from '../SettingsGroup';
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
    // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
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

  const connect = async (presetId: PresetId, fields: Record<string, string>) => {
    const account = await getMusicNetworkRuntime().connect(presetId, { fields });
    // The wire's connect only checks the credential is present; for paste-auth
    // providers the real validation is the capability probe. Surface a probe
    // error (e.g. an invalid token) so the connect does not look silently OK.
    const scrobble = account.capabilities?.scrobble;
    if (scrobble?.status === 'error') {
      showToast(
        t('musicNetwork.connectProbeFailed', { provider: account.label, message: scrobble.message ?? '' }),
        6000,
        'error',
      );
    }
  };

  const connectedPresetIds = accounts.map(a => a.presetId);

  return (
    <SettingsSubSection title={t('musicNetwork.title')} icon={<Share2 size={16} />}>
      <div className="settings-card">
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: '0.75rem' }}>
          {t('musicNetwork.desc')}
        </p>

        <SettingsGroup title={t('musicNetwork.masterToggle')}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
            <div style={{ minWidth: 0, fontSize: 12, color: 'var(--text-muted)' }}>{t('musicNetwork.masterToggleDesc')}</div>
            <label className="toggle-switch" style={{ flexShrink: 0 }} aria-label={t('musicNetwork.masterToggle')}>
              <input type="checkbox" checked={scrobblingMasterEnabled} onChange={e => setMaster(e.target.checked)} />
              <span className="toggle-track" />
            </label>
          </div>
        </SettingsGroup>

        <EnrichmentPrimarySelect
          accounts={accounts}
          primaryId={enrichmentPrimaryId}
          onChange={setPrimary}
        />

        {accounts.length > 0 && (
          <SettingsGroup>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
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
            <MalojaProxyWarning accounts={accounts} />
          </SettingsGroup>
        )}

        <div style={{ marginTop: 'var(--space-3)' }}>
          <ConnectProviderForm connectedPresetIds={connectedPresetIds} onConnect={connect} />
        </div>
      </div>
    </SettingsSubSection>
  );
}
