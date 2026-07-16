import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/store/authStore';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';
import { showToast } from '@/lib/dom/toast';
import {
  resolveIndexKey,
  serverIndexKeyForProfile,
  serverIndexOwners,
} from '@/lib/server/serverIndexKey';
import {
  libraryGetStatus,
  librarySyncCancel,
  subscribeLibrarySyncIdle,
  subscribeLibrarySyncProgress,
} from '@/lib/api/library';
import {
  bootstrapAllIndexedServers,
  bootstrapIndexedServer,
  type BindServerResult,
} from '@/lib/library/librarySession';
import { enqueueLibrarySync } from '@/lib/library/librarySyncQueue';
import { syncIngestDisplayCount } from '@/lib/library/libraryReady';

const STATUS_POLL_MS = 3000;
const SYNC_POLL_MS = 2500;
const OFFLINE_RETRY_MS = 60_000;

function connectionUpdates(results: Record<string, BindServerResult>) {
  return Object.fromEntries(Object.entries(results).map(([id, result]) => [
    id,
    result === 'offline' ? 'offline' : result === 'bound' ? 'online' : 'unknown',
  ])) as Record<string, 'online' | 'offline' | 'unknown'>;
}

export function applyLibraryConnectionResults(
  results: Record<string, BindServerResult>,
  indexedKeys?: string[],
): void {
  const updates = connectionUpdates(results);
  if (!indexedKeys) {
    useLibraryIndexStore.getState().mergeConnections(updates);
    return;
  }
  const connections = Object.fromEntries(indexedKeys.map(key => [key, 'unknown'])) as Record<
    string,
    'online' | 'offline' | 'unknown'
  >;
  useLibraryIndexStore.getState().replaceConnections({ ...connections, ...updates });
}

export function useLibraryIndexSync(enabled = true) {
  const { t } = useTranslation();
  const servers = useAuthStore(s => s.servers);
  const musicLibraryServerIds = useAuthStore(s => s.musicLibraryServerIds);
  const masterEnabled = useLibraryIndexStore(s => s.masterEnabled);

  const serverKeyById = useMemo(
    () => Object.fromEntries(servers.map(s => [s.id, serverIndexKeyForProfile(s)])),
    [servers],
  );
  const indexedKeys = useMemo(
    () => Array.from(new Set(Object.values(serverKeyById))),
    [serverKeyById],
  );
  const indexedServers = useMemo(() => {
    return serverIndexOwners({ servers, musicLibraryServerIds })
      .map(server => ({ key: serverKeyById[server.id], server }));
  }, [servers, musicLibraryServerIds, serverKeyById]);

  const statusByServer = useLibraryIndexStore(s => s.statusByServer);
  const connectionByServer = useLibraryIndexStore(s => s.connectionByServer);
  const [progressByServer, setProgressByServer] = useState<Record<string, string | null>>({});
  const [busyServerId, setBusyServerId] = useState<string | null>(null);
  const [bootstrapping, setBootstrapping] = useState(false);

  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ingestCountRef = useRef<Record<string, number>>({});
  const syncPhaseRef = useRef<Record<string, string | null>>({});

  const applyConnectionResults = useCallback((results: Record<string, BindServerResult>) => {
    applyLibraryConnectionResults(results, indexedKeys);
  }, [indexedKeys]);

  const refreshAllStatuses = useCallback(async () => {
    if (!masterEnabled || indexedServers.length === 0) return;
    const entries = await Promise.all(
      indexedServers.map(async ({ key }) => {
        try {
          const fresh = await libraryGetStatus(key);
          syncPhaseRef.current[key] = fresh.syncPhase;
          if (fresh.syncPhase === 'initial_sync') {
            const next = Math.max(ingestCountRef.current[key] ?? 0, syncIngestDisplayCount(fresh));
            ingestCountRef.current[key] = next;
            setProgressByServer(p => ({
              ...p,
              [key]: t('settings.libraryIndexProgressIngest', { count: next }),
            }));
          } else if (fresh.syncPhase === 'ready' || fresh.syncPhase === 'idle') {
            ingestCountRef.current[key] = 0;
          }
          return [key, fresh] as const;
        } catch {
          return [key, null] as const;
        }
      }),
    );
    useLibraryIndexStore.getState().replaceStatuses(Object.fromEntries(entries));
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
    const offline = indexedServers.filter(s => connectionByServer[s.key] === 'offline');
    if (offline.length === 0) return;
    const results: Record<string, BindServerResult> = {};
    for (const srv of offline) {
      results[srv.key] = await bootstrapIndexedServer(srv.server);
    }
    applyLibraryConnectionResults(results);
    void refreshAllStatuses();
  }, [masterEnabled, indexedServers, connectionByServer, refreshAllStatuses]);

  useEffect(() => {
    if (!enabled || !masterEnabled || indexedKeys.length === 0) return;
    // React Compiler set-state-in-effect rule: state set from a timer/animation callback.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void runBootstrap();
  }, [enabled, masterEnabled, indexedKeys.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!enabled || (masterEnabled && indexedKeys.length > 0)) return;
    useLibraryIndexStore.getState().replaceStatuses({});
    useLibraryIndexStore.getState().replaceConnections({});
  }, [enabled, masterEnabled, indexedKeys.length]);

  useEffect(() => {
    if (!enabled || !masterEnabled) return;
    const retryNow = () => {
      void retryOfflineServers();
    };
    window.addEventListener('online', retryNow);
    return () => window.removeEventListener('online', retryNow);
  }, [enabled, masterEnabled, retryOfflineServers]);

  useEffect(() => {
    if (!enabled || !masterEnabled) return;
    const poll = () => {
      void refreshAllStatuses();
      const anyInitial = indexedKeys.some(
        key => syncPhaseRef.current[key] === 'initial_sync',
      );
      pollTimer.current = setTimeout(poll, anyInitial ? SYNC_POLL_MS : STATUS_POLL_MS);
    };
    poll();
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
      pollTimer.current = null;
    };
    // indexedKeys is derived from indexedServers (already a dep); the poll loop is
    // keyed on the server set, not on the recomputed key array, to avoid
    // restarting the poll on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, masterEnabled, indexedServers, refreshAllStatuses]);

  useEffect(() => {
    if (!enabled || !masterEnabled) return;
    const retryTimer = setInterval(() => {
      void retryOfflineServers();
    }, OFFLINE_RETRY_MS);
    return () => clearInterval(retryTimer);
  }, [enabled, masterEnabled, retryOfflineServers]);

  useEffect(() => {
    if (!enabled || !masterEnabled) return;
    const unsubs: Array<Promise<() => void>> = [
      subscribeLibrarySyncProgress(p => {
        const key = resolveIndexKey(p.serverId);
        if (!indexedKeys.includes(key)) return;
        setBusyServerId(key);
        if (p.kind === 'ingest_page') {
          const next = Math.max(ingestCountRef.current[key] ?? 0, p.ingestedTotal ?? 0);
          ingestCountRef.current[key] = next;
          setProgressByServer(prev => ({
            ...prev,
            [key]: t('settings.libraryIndexProgressIngest', { count: next }),
          }));
        } else if (p.kind === 'tombstoned') {
          setProgressByServer(prev => ({
            ...prev,
            [key]: t('settings.libraryIndexProgressVerify', {
              checked: p.tombstonesChecked ?? 0,
              deleted: p.tombstonesDeleted ?? 0,
            }),
          }));
        } else if (p.kind === 'phase_changed' && p.phase) {
          setProgressByServer(prev => ({ ...prev, [key]: p.phase ?? null }));
        }
      }),
      subscribeLibrarySyncIdle(p => {
        const key = resolveIndexKey(p.serverId);
        if (!indexedKeys.includes(key)) return;
        setBusyServerId(cur => (cur === key ? null : cur));
        ingestCountRef.current[key] = 0;
        setProgressByServer(prev => ({ ...prev, [key]: null }));
        void refreshAllStatuses();
        if (!p.ok && p.error) {
          showToast(t('settings.libraryIndexSyncError', { error: p.error }), 5000, 'error');
        }
      }),
    ];
    return () => {
      unsubs.forEach(u => void u.then(fn => fn()));
    };
  }, [enabled, masterEnabled, indexedKeys, refreshAllStatuses, t]);

  const runServerAction = useCallback(async (
    serverId: string,
    action: 'full' | 'delta' | 'verify',
  ) => {
    const key = resolveIndexKey(serverId);
    setBusyServerId(key);
    try {
      const kind =
        action === 'verify'
          ? 'verify'
          : action === 'full'
            ? 'full'
            : statusByServer[key]?.lastFullSyncAt
              ? 'delta'
              : 'full';
      ingestCountRef.current[key] = 0;
      await enqueueLibrarySync({ serverId: key, kind });
    } catch (e) {
      setBusyServerId(null);
      showToast(t('settings.libraryIndexSyncError', { error: e instanceof Error ? e.message : String(e) }), 5000, 'error');
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
