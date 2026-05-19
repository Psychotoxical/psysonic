import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DatabaseZap } from 'lucide-react';
import { useAuthStore } from '../../store/authStore';
import { useLibraryIndexStore } from '../../store/libraryIndexStore';
import { showToast } from '../../utils/ui/toast';
import SettingsSubSection from '../SettingsSubSection';
import {
  libraryGetStatus,
  librarySyncBindSession,
  librarySyncCancel,
  librarySyncClearSession,
  librarySyncStart,
  librarySyncVerifyIntegrity,
  subscribeLibrarySyncIdle,
  subscribeLibrarySyncProgress,
  type SyncStateDto,
} from '../../api/library';

const STATUS_POLL_MS = 3000;

/**
 * Settings → Library: local library index controls (spec §7.3, MVP).
 * Per-server enable toggle (binds / clears the Rust sync session),
 * read-only status, Sync now / Cancel / Verify integrity buttons,
 * auto-reconcile toggle. Advanced toggles (search-all-servers,
 * threshold input) stay out of v1 per §7.3.
 */
export default function LibraryIndexSection() {
  const { t } = useTranslation();
  const activeServer = useAuthStore(s => s.servers.find(srv => srv.id === s.activeServerId));
  const serverId = activeServer?.id ?? null;

  const indexEnabled = useLibraryIndexStore(s => s.isIndexEnabled(serverId));
  const setIndexEnabled = useLibraryIndexStore(s => s.setIndexEnabled);
  const autoReconcile = useLibraryIndexStore(s => s.autoReconcileEnabled);
  const setAutoReconcile = useLibraryIndexStore(s => s.setAutoReconcileEnabled);

  const [status, setStatus] = useState<SyncStateDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [progressLabel, setProgressLabel] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshStatus = useCallback(async () => {
    if (!serverId) return;
    try {
      setStatus(await libraryGetStatus(serverId));
    } catch {
      /* status read is best-effort — leave the last value */
    }
  }, [serverId]);

  // Poll status while the section is mounted + index is on.
  useEffect(() => {
    if (!serverId || !indexEnabled) {
      setStatus(null);
      return;
    }
    void refreshStatus();
    pollTimer.current = setInterval(() => void refreshStatus(), STATUS_POLL_MS);
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
      pollTimer.current = null;
    };
  }, [serverId, indexEnabled, refreshStatus]);

  // Live progress + idle events for the active server.
  useEffect(() => {
    if (!serverId || !indexEnabled) return;
    const unsubs: Array<Promise<() => void>> = [
      subscribeLibrarySyncProgress(p => {
        if (p.serverId !== serverId) return;
        if (p.kind === 'ingest_page' && typeof p.ingestedTotal === 'number') {
          setProgressLabel(t('settings.libraryIndexProgressIngest', { count: p.ingestedTotal }));
        } else if (p.kind === 'tombstoned') {
          setProgressLabel(
            t('settings.libraryIndexProgressVerify', {
              checked: p.tombstonesChecked ?? 0,
              deleted: p.tombstonesDeleted ?? 0,
            }),
          );
        } else if (p.kind === 'phase_changed' && p.phase) {
          setProgressLabel(p.phase);
        }
      }),
      subscribeLibrarySyncIdle(p => {
        if (p.serverId !== serverId) return;
        setBusy(false);
        setProgressLabel(null);
        void refreshStatus();
        if (!p.ok && p.error) {
          showToast(t('settings.libraryIndexSyncError', { error: p.error }), 5000, 'error');
        }
      }),
    ];
    return () => {
      unsubs.forEach(u => void u.then(fn => fn()));
    };
  }, [serverId, indexEnabled, refreshStatus, t]);

  const handleToggle = async (enabled: boolean) => {
    if (!activeServer || !serverId) return;
    setBusy(true);
    try {
      if (enabled) {
        // `getBaseUrl()` adds the http:// scheme + strips the trailing
        // slash — `server.url` is stored bare (e.g. `nas.example.com`),
        // which reqwest rejects with "relative URL without a base".
        const baseUrl = useAuthStore.getState().getBaseUrl();
        await librarySyncBindSession({
          serverId,
          baseUrl,
          username: activeServer.username,
          password: activeServer.password,
        });
        setIndexEnabled(serverId, true);
        await refreshStatus();
      } else {
        await librarySyncClearSession(serverId);
        setIndexEnabled(serverId, false);
        setStatus(null);
      }
    } catch (e) {
      showToast(t('settings.libraryIndexBindError', { error: String(e) }), 5000, 'error');
      // Roll the toggle back so UI reflects reality.
      setIndexEnabled(serverId, !enabled);
    } finally {
      setBusy(false);
    }
  };

  const handleSyncNow = async (mode: 'full' | 'delta') => {
    if (!serverId) return;
    setBusy(true);
    try {
      await librarySyncStart({ serverId, mode });
    } catch (e) {
      setBusy(false);
      showToast(t('settings.libraryIndexSyncError', { error: String(e) }), 5000, 'error');
    }
  };

  const handleVerify = async () => {
    if (!serverId) return;
    setBusy(true);
    try {
      // One pass per click — budget 200 tombstone checks (§6.7).
      // Large libraries need repeated clicks; the status line shows
      // how many were checked so the user knows to continue.
      await librarySyncVerifyIntegrity({ serverId });
    } catch (e) {
      setBusy(false);
      showToast(t('settings.libraryIndexSyncError', { error: String(e) }), 5000, 'error');
    }
  };

  const handleCancel = async () => {
    try {
      await librarySyncCancel();
    } catch {
      /* best-effort */
    }
  };

  const phaseLabel = (() => {
    if (!status) return t('settings.libraryIndexStatusIdle');
    switch (status.syncPhase) {
      case 'initial_sync':
        return t('settings.libraryIndexStatusInitial');
      case 'ready':
        return t('settings.libraryIndexStatusReady', {
          count: status.localTrackCount ?? 0,
        });
      case 'error':
        return t('settings.libraryIndexStatusError');
      case 'probing':
        return t('settings.libraryIndexStatusProbing');
      default:
        return t('settings.libraryIndexStatusIdle');
    }
  })();

  return (
    <SettingsSubSection
      title={t('settings.libraryIndexTitle')}
      icon={<DatabaseZap size={16} />}
    >
      <div className="settings-card">
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: '1rem', lineHeight: 1.5 }}>
          {t('settings.libraryIndexDesc')}
        </p>

        <div className="settings-toggle-row">
          <div>
            <div style={{ fontWeight: 500 }}>{t('settings.libraryIndexEnable')}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {activeServer
                ? t('settings.libraryIndexEnableDesc')
                : t('settings.libraryIndexNoServer')}
            </div>
          </div>
          <label className="toggle-switch" aria-label={t('settings.libraryIndexEnable')}>
            <input
              type="checkbox"
              checked={indexEnabled}
              disabled={!activeServer || busy}
              onChange={e => void handleToggle(e.target.checked)}
            />
            <span className="toggle-track" />
          </label>
        </div>

        {indexEnabled && (
          <>
            <div className="settings-section-divider" />
            <div style={{ fontSize: 13 }}>
              <span style={{ fontWeight: 500 }}>{t('settings.libraryIndexStatus')}: </span>
              <span style={{ color: 'var(--text-secondary)' }}>
                {progressLabel ?? phaseLabel}
              </span>
            </div>

            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem', flexWrap: 'wrap' }}>
              <button
                className="btn btn-surface"
                disabled={busy}
                onClick={() => void handleSyncNow('delta')}
              >
                {t('settings.libraryIndexSyncNow')}
              </button>
              <button
                className="btn btn-surface"
                disabled={busy}
                onClick={() => void handleVerify()}
              >
                {t('settings.libraryIndexVerify')}
              </button>
              {busy && (
                <button className="btn btn-ghost" onClick={() => void handleCancel()}>
                  {t('settings.libraryIndexCancel')}
                </button>
              )}
            </div>

            <div className="settings-section-divider" />
            <div className="settings-toggle-row">
              <div>
                <div style={{ fontWeight: 500 }}>{t('settings.libraryIndexAutoReconcile')}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {t('settings.libraryIndexAutoReconcileDesc')}
                </div>
              </div>
              <label className="toggle-switch" aria-label={t('settings.libraryIndexAutoReconcile')}>
                <input
                  type="checkbox"
                  checked={autoReconcile}
                  onChange={e => setAutoReconcile(e.target.checked)}
                />
                <span className="toggle-track" />
              </label>
            </div>
          </>
        )}
      </div>
    </SettingsSubSection>
  );
}
