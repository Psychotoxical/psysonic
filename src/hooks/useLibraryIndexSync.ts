import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../store/authStore';
import { useLibraryIndexStore } from '../store/libraryIndexStore';
import { showToast } from '../utils/ui/toast';
import {
  libraryGetStatus,
  librarySyncCancel,
  subscribeLibrarySyncIdle,
  subscribeLibrarySyncProgress,
  type SyncStateDto,
} from '../api/library';
import {
  bootstrapAllIndexedServers,
  bootstrapIndexedServer,
  type BindServerResult,
} from '../utils/library/librarySession';
import { enqueueLibrarySync } from '../utils/library/librarySyncQueue';
import { syncIngestDisplayCount } from '../utils/library/libraryReady';

export type LibraryServerConnection = 'online' | 'offline' | 'unknown';

const STATUS_POLL_MS = 3000;
const SYNC_POLL_MS = 2500;
const OFFLINE_RETRY_MS = 60_000;

export function useLibraryIndexSync() {
  const { t } = useTranslation();
  const servers = useAuthStore(s => s.servers);
  const masterEnabled = useLibraryIndexStore(s => s.masterEnabled);

  const indexedServers = useMemo(() => servers, [servers]);
  const indexedIds = useMemo(() => servers.map(s => s.id), [servers]);

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
    if (!masterEnabled || indexedIds.length === 0) return;
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

  const runServerAction = useCallback(async (
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
  }, [statusByServer, t]);

  const handleCancel = useCallback(async () => {
    try {
      await librarySyncCancel();
    } catch {
      /* best-effort */
    }
  }, []);

  const globalBusy = bootstrapping || busyServerId != null;

  return {
    statusByServer,
    connectionByServer,
    progressByServer,
    busyServerId,
    bootstrapping,
    globalBusy,
    runServerAction,
    handleCancel,
  };
}
