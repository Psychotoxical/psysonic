import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DatabaseZap } from 'lucide-react';
import { useAuthStore } from '../../store/authStore';
import { useLibraryIndexStore } from '../../store/libraryIndexStore';
import { showToast } from '../../utils/ui/toast';
import SettingsSubSection from '../SettingsSubSection';
import {
  libraryGetStatus,
  librarySyncCancel,
  librarySyncClearSession,
  subscribeLibrarySyncIdle,
  subscribeLibrarySyncProgress,
  type SyncStateDto,
} from '../../api/library';
import {
  bootstrapAllIndexedServers,
  bootstrapIndexedServer,
  type BindServerResult,
} from '../../utils/library/librarySession';
import { enqueueLibrarySync } from '../../utils/library/librarySyncQueue';
import { syncIngestDisplayCount } from '../../utils/library/libraryReady';
import { serverListDisplayLabel } from '../../utils/server/serverDisplayName';
import LibraryIndexServerRow, { type LibraryServerConnection } from './LibraryIndexServerRow';

const STATUS_POLL_MS = 3000;
const SYNC_POLL_MS = 2500;
const OFFLINE_RETRY_MS = 60_000;

export default function LibraryIndexSection() {
  const { t } = useTranslation();
  const servers = useAuthStore(s => s.servers);
  const activeServerId = useAuthStore(s => s.activeServerId);

  const masterEnabled = useLibraryIndexStore(s => s.masterEnabled);
  const syncExcludedByServer = useLibraryIndexStore(s => s.syncExcludedByServer);
  const setMasterEnabled = useLibraryIndexStore(s => s.setMasterEnabled);
  const setServerSyncExcluded = useLibraryIndexStore(s => s.setServerSyncExcluded);
  const autoReconcile = useLibraryIndexStore(s => s.autoReconcileEnabled);
  const setAutoReconcile = useLibraryIndexStore(s => s.setAutoReconcileEnabled);

  const indexedIds = useMemo(() => {
    if (!masterEnabled) return [];
    return servers.map(s => s.id).filter(id => syncExcludedByServer[id] !== true);
  }, [masterEnabled, syncExcludedByServer, servers]);

  const indexedServers = useMemo(
    () => servers.filter(s => indexedIds.includes(s.id)),
    [servers, indexedIds],
  );

  const excludedServers = useMemo(
    () => servers.filter(s => syncExcludedByServer[s.id] === true),
    [servers, syncExcludedByServer],
  );

  const [statusByServer, setStatusByServer] = useState<Record<string, SyncStateDto | null>>({});
  const [connectionByServer, setConnectionByServer] = useState<Record<string, LibraryServerConnection>>({});
  const [progressByServer, setProgressByServer] = useState<Record<string, string | null>>({});
  const [busyServerId, setBusyServerId] = useState<string | null>(null);
  const [bootstrapping, setBootstrapping] = useState(false);

  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ingestCountRef = useRef<Record<string, number>>({});
  const syncPhaseRef = useRef<Record<string, string | null>>({});

  const applyConnectionResults = useCallback((results: Record<string, BindServerResult>) => {
    setConnectionByServer(prev => {
      const next = { ...prev };
      for (const [id, result] of Object.entries(results)) {
        next[id] = result === 'offline' ? 'offline' : result === 'bound' ? 'online' : 'unknown';
      }
      return next;
    });
  }, []);

  const refreshAllStatuses = useCallback(async () => {
    if (!masterEnabled || indexedServers.length === 0) return;
    const entries = await Promise.all(
      indexedServers.map(async srv => {
        try {
          const fresh = await libraryGetStatus(srv.id);
          syncPhaseRef.current[srv.id] = fresh.syncPhase;
          if (fresh.syncPhase === 'initial_sync') {
            const next = Math.max(ingestCountRef.current[srv.id] ?? 0, syncIngestDisplayCount(fresh));
            ingestCountRef.current[srv.id] = next;
            setProgressByServer(p => ({
              ...p,
              [srv.id]: t('settings.libraryIndexProgressIngest', { count: next }),
            }));
          } else if (fresh.syncPhase === 'ready' || fresh.syncPhase === 'idle') {
            ingestCountRef.current[srv.id] = 0;
          }
          return [srv.id, fresh] as const;
        } catch {
          return [srv.id, null] as const;
        }
      }),
    );
    setStatusByServer(Object.fromEntries(entries));
  }, [masterEnabled, indexedServers, t]);

  const runBootstrap = useCallback(async () => {
    if (!masterEnabled) return;
    setBootstrapping(true);
    try {
      const results = await bootstrapAllIndexedServers();
      applyConnectionResults(results);
      await refreshAllStatuses();
    } finally {
      setBootstrapping(false);
    }
  }, [masterEnabled, applyConnectionResults, refreshAllStatuses]);

  const retryOfflineServers = useCallback(async () => {
    if (!masterEnabled) return;
    const offline = indexedServers.filter(s => connectionByServer[s.id] === 'offline');
    if (offline.length === 0) return;
    const results: Record<string, BindServerResult> = {};
    for (const srv of offline) {
      results[srv.id] = await bootstrapIndexedServer(srv);
    }
    applyConnectionResults(results);
    void refreshAllStatuses();
  }, [masterEnabled, indexedServers, connectionByServer, applyConnectionResults, refreshAllStatuses]);

  useEffect(() => {
    if (!masterEnabled) {
      setStatusByServer({});
      setConnectionByServer({});
      setProgressByServer({});
      setBusyServerId(null);
      return;
    }
    void runBootstrap();
  }, [masterEnabled, indexedIds.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!masterEnabled) return;
    const poll = () => {
      void refreshAllStatuses();
      const anyInitial = indexedServers.some(
        s => syncPhaseRef.current[s.id] === 'initial_sync',
      );
      pollTimer.current = setTimeout(poll, anyInitial ? SYNC_POLL_MS : STATUS_POLL_MS);
    };
    poll();
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
      pollTimer.current = null;
    };
  }, [masterEnabled, indexedServers, refreshAllStatuses]);

  useEffect(() => {
    if (!masterEnabled) return;
    const retryTimer = setInterval(() => {
      void retryOfflineServers();
    }, OFFLINE_RETRY_MS);
    return () => clearInterval(retryTimer);
  }, [masterEnabled, retryOfflineServers]);

  useEffect(() => {
    if (!masterEnabled) return;
    const unsubs: Array<Promise<() => void>> = [
      subscribeLibrarySyncProgress(p => {
        if (!indexedIds.includes(p.serverId)) return;
        setBusyServerId(p.serverId);
        if (p.kind === 'ingest_page') {
          const next = Math.max(ingestCountRef.current[p.serverId] ?? 0, p.ingestedTotal ?? 0);
          ingestCountRef.current[p.serverId] = next;
          setProgressByServer(prev => ({
            ...prev,
            [p.serverId]: t('settings.libraryIndexProgressIngest', { count: next }),
          }));
        } else if (p.kind === 'tombstoned') {
          setProgressByServer(prev => ({
            ...prev,
            [p.serverId]: t('settings.libraryIndexProgressVerify', {
              checked: p.tombstonesChecked ?? 0,
              deleted: p.tombstonesDeleted ?? 0,
            }),
          }));
        } else if (p.kind === 'phase_changed' && p.phase) {
          setProgressByServer(prev => ({ ...prev, [p.serverId]: p.phase ?? null }));
        }
      }),
      subscribeLibrarySyncIdle(p => {
        if (!indexedIds.includes(p.serverId)) return;
        setBusyServerId(cur => (cur === p.serverId ? null : cur));
        ingestCountRef.current[p.serverId] = 0;
        setProgressByServer(prev => ({ ...prev, [p.serverId]: null }));
        void refreshAllStatuses();
        if (!p.ok && p.error) {
          showToast(t('settings.libraryIndexSyncError', { error: p.error }), 5000, 'error');
        }
      }),
    ];
    return () => {
      unsubs.forEach(u => void u.then(fn => fn()));
    };
  }, [masterEnabled, indexedIds, refreshAllStatuses, t]);

  const handleMasterToggle = async (enabled: boolean) => {
    if (enabled) {
      setMasterEnabled(true);
      await runBootstrap();
      return;
    }
    setBootstrapping(true);
    try {
      for (const srv of servers) {
        try {
          await librarySyncClearSession(srv.id);
        } catch {
          /* best-effort */
        }
      }
      setMasterEnabled(false);
      setStatusByServer({});
      setConnectionByServer({});
      setProgressByServer({});
      setBusyServerId(null);
    } finally {
      setBootstrapping(false);
    }
  };

  const runServerAction = async (
    serverId: string,
    action: 'full' | 'delta' | 'verify',
  ) => {
    setBusyServerId(serverId);
    try {
      const kind =
        action === 'verify'
          ? 'verify'
          : action === 'full'
            ? 'full'
            : statusByServer[serverId]?.lastFullSyncAt
              ? 'delta'
              : 'full';
      ingestCountRef.current[serverId] = 0;
      await enqueueLibrarySync({ serverId, kind });
    } catch (e) {
      setBusyServerId(null);
      showToast(t('settings.libraryIndexSyncError', { error: String(e) }), 5000, 'error');
    }
  };

  const handleIncludeServer = async (serverId: string) => {
    setServerSyncExcluded(serverId, false);
    const srv = servers.find(s => s.id === serverId);
    if (srv) {
      setBootstrapping(true);
      try {
        const result = await bootstrapIndexedServer(srv);
        applyConnectionResults({ [serverId]: result });
        await refreshAllStatuses();
      } finally {
        setBootstrapping(false);
      }
    }
  };

  const handleExcludeServer = async (serverId: string) => {
    setBootstrapping(true);
    try {
      await librarySyncClearSession(serverId);
      setServerSyncExcluded(serverId, true);
      setStatusByServer(prev => {
        const next = { ...prev };
        delete next[serverId];
        return next;
      });
      setConnectionByServer(prev => {
        const next = { ...prev };
        delete next[serverId];
        return next;
      });
    } catch (e) {
      showToast(t('settings.libraryIndexBindError', { error: String(e) }), 5000, 'error');
    } finally {
      setBootstrapping(false);
    }
  };

  const handleCancel = async () => {
    try {
      await librarySyncCancel();
    } catch {
      /* best-effort */
    }
  };

  const globalBusy = bootstrapping || busyServerId != null;

  return (
    <SettingsSubSection
      title={t('settings.libraryIndexTitle')}
      icon={<DatabaseZap size={16} />}
    >
      <div className="settings-card">
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: '1rem', lineHeight: 1.5 }}>
          {t('settings.libraryIndexDesc')}
        </p>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: '1rem', lineHeight: 1.5 }}>
          {t('settings.libraryIndexDeltaHint')}
        </p>

        <div className="settings-toggle-row">
          <div>
            <div style={{ fontWeight: 500 }}>{t('settings.libraryIndexEnable')}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {servers.length > 0
                ? t('settings.libraryIndexEnableAllDesc')
                : t('settings.libraryIndexNoServer')}
            </div>
          </div>
          <label className="toggle-switch" aria-label={t('settings.libraryIndexEnable')}>
            <input
              type="checkbox"
              checked={masterEnabled}
              disabled={servers.length === 0 || bootstrapping}
              onChange={e => void handleMasterToggle(e.target.checked)}
            />
            <span className="toggle-track" />
          </label>
        </div>

        {masterEnabled && (
          <>
            <div className="settings-section-divider" />
            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: '0.65rem' }}>
              {t('settings.libraryIndexServerListTitle')}
            </div>
            {indexedServers.length === 0 ? (
              <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                {t('settings.libraryIndexAllExcluded')}
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
                {indexedServers.map(srv => (
                  <LibraryIndexServerRow
                    key={srv.id}
                    server={srv}
                    allServers={servers}
                    isActive={srv.id === activeServerId}
                    status={statusByServer[srv.id] ?? null}
                    connection={connectionByServer[srv.id] ?? 'unknown'}
                    progressLabel={progressByServer[srv.id] ?? null}
                    busy={busyServerId === srv.id}
                    actionsDisabled={globalBusy && busyServerId !== srv.id}
                    onFullSync={() => void runServerAction(srv.id, 'full')}
                    onDeltaSync={() => void runServerAction(srv.id, 'delta')}
                    onVerify={() => void runServerAction(srv.id, 'verify')}
                    onExclude={() => void handleExcludeServer(srv.id)}
                  />
                ))}
              </div>
            )}

            {excludedServers.length > 0 && (
              <>
                <div style={{ fontSize: 13, fontWeight: 500, margin: '1rem 0 0.5rem' }}>
                  {t('settings.libraryIndexExcludedTitle')}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
                  {excludedServers.map(srv => (
                    <div
                      key={srv.id}
                      className="settings-card"
                      style={{ padding: '0.65rem 1rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem' }}
                    >
                      <span style={{ fontSize: 13 }}>{serverListDisplayLabel(srv, servers)}</span>
                      <button
                        type="button"
                        className="btn btn-surface"
                        style={{ fontSize: 12, padding: '4px 10px' }}
                        disabled={bootstrapping}
                        onClick={() => void handleIncludeServer(srv.id)}
                      >
                        {t('settings.libraryIndexIncludeServer')}
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}

            {busyServerId && (
              <div style={{ marginTop: '0.75rem' }}>
                <button type="button" className="btn btn-ghost" onClick={() => void handleCancel()}>
                  {t('settings.libraryIndexCancel')}
                </button>
              </div>
            )}

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
