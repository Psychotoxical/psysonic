import { useEffect, useMemo, useRef } from 'react';
import { useAuthStore } from '@/store/authStore';
import { ensureConnectUrlResolved, invalidateReachableEndpointCache } from '@/lib/server/serverEndpoint';
import {
  getServerReachabilitySnapshot,
  getUnavailableServerIds,
  useServerReachabilitySnapshot,
  useUnavailableServerIds,
} from '@/lib/network/serverReachability';
import { deriveEffectiveLibraryBrowseServerIds } from '@/lib/library/libraryBrowseScope';
import { bootstrapIndexedServer } from '@/lib/library/librarySession';
import {
  describeMultiServerError,
  emitMultiServerDebug,
  summarizeMultiServerProfiles,
} from '@/lib/library/multiServerDebug';
import { usePerfProbeFlags } from '@/lib/perf/perfFlags';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';
import { switchActiveServer } from '@/utils/server/switchActiveServer';

const SERVER_REACHABILITY_POLL_MS = 120_000;

/** Probe selected servers, align the active profile to scope priority, and invalidate effective reads. */
export function useLibraryServerReachability(): void {
  const isLoggedIn = useAuthStore(state => state.isLoggedIn);
  const servers = useAuthStore(state => state.servers);
  const activeServerId = useAuthStore(state => state.activeServerId);
  const libraryBrowseServerIds = useAuthStore(state => state.libraryBrowseServerIds);
  const loggingMode = useAuthStore(state => state.loggingMode);
  const debugLoggingDepth = useAuthStore(state => state.debugLoggingDepth);
  const unavailableServerIds = useUnavailableServerIds();
  const verboseDiagnosticsEnabled = loggingMode === 'debug' && debugLoggingDepth === 3;
  const reachabilitySnapshot = useServerReachabilitySnapshot(verboseDiagnosticsEnabled);
  const perfFlags = usePerfProbeFlags();
  const selectedProfiles = useMemo(() => {
    const selected = new Set(libraryBrowseServerIds);
    return servers.filter(server => selected.has(server.id));
  }, [libraryBrowseServerIds, servers]);
  const effectiveLibraryServerIds = useMemo(() => deriveEffectiveLibraryBrowseServerIds({
    servers,
    activeServerId,
    libraryBrowseServerIds,
  }, unavailableServerIds), [activeServerId, libraryBrowseServerIds, servers, unavailableServerIds]);
  const desiredActiveServerId = effectiveLibraryServerIds[0] ?? null;
  const libraryBrowsePriorityKey = libraryBrowseServerIds.join('\u0000');
  const previousUnavailableServerIdsRef = useRef(unavailableServerIds);
  const desiredActiveServerIdRef = useRef(desiredActiveServerId);
  const activeSwitchInFlightRef = useRef(false);
  // React Compiler refs rule: the in-flight loop must always observe the latest priority head.
  // eslint-disable-next-line react-hooks/refs
  desiredActiveServerIdRef.current = desiredActiveServerId;

  useEffect(() => {
    if (!verboseDiagnosticsEnabled) return;
    emitMultiServerDebug('reachability_scope_snapshot', {
      isLoggedIn,
      activeServerId,
      configuredServerIds: libraryBrowseServerIds,
      effectiveServerIds: effectiveLibraryServerIds,
      desiredActiveServerId,
      unavailableServerIds: [...unavailableServerIds],
      reachability: Object.fromEntries(servers.map(server => [
        server.id,
        reachabilitySnapshot.get(server.id) ?? 'unknown',
      ])),
      selectedProfiles: summarizeMultiServerProfiles(selectedProfiles),
      allProfiles: summarizeMultiServerProfiles(servers),
      backgroundPollingDisabled: perfFlags.disableBackgroundPolling,
    });
  }, [
    activeServerId,
    desiredActiveServerId,
    effectiveLibraryServerIds,
    isLoggedIn,
    libraryBrowseServerIds,
    perfFlags.disableBackgroundPolling,
    reachabilitySnapshot,
    selectedProfiles,
    servers,
    unavailableServerIds,
    verboseDiagnosticsEnabled,
  ]);

  useEffect(() => {
    const state = useAuthStore.getState();
    const currentEffectiveServerIds = deriveEffectiveLibraryBrowseServerIds(
      state,
      getUnavailableServerIds(),
    );
    if (!isLoggedIn || !desiredActiveServerId || activeSwitchInFlightRef.current) {
      emitMultiServerDebug('active_scope_alignment_skip', {
        reason: !isLoggedIn
          ? 'not_logged_in'
          : !desiredActiveServerId
            ? 'no_effective_server'
            : 'switch_already_in_flight',
        activeServerId: state.activeServerId,
        desiredActiveServerId,
        configuredServerIds: state.libraryBrowseServerIds,
        effectiveServerIds: currentEffectiveServerIds,
      });
      return;
    }
    activeSwitchInFlightRef.current = true;
    emitMultiServerDebug('active_scope_alignment_start', {
      activeServerId: state.activeServerId,
      desiredActiveServerId,
      configuredServerIds: state.libraryBrowseServerIds,
      effectiveServerIds: currentEffectiveServerIds,
    });

    void (async () => {
      try {
        while (true) {
          const targetId = desiredActiveServerIdRef.current;
          const state = useAuthStore.getState();
          if (!targetId || state.activeServerId === targetId) return;
          const target = state.servers.find(server => server.id === targetId);
          if (!target) {
            emitMultiServerDebug('active_scope_alignment_abort', {
              reason: 'target_profile_missing',
              targetId,
              currentActiveServerId: state.activeServerId,
              savedServerIds: state.servers.map(server => server.id),
            });
            return;
          }
          const switchStartedAt = performance.now();
          emitMultiServerDebug('active_scope_switch_start', {
            targetId,
            currentActiveServerId: state.activeServerId,
          });
          try {
            const switched = await switchActiveServer(target);
            emitMultiServerDebug('active_scope_switch_done', {
              targetId,
              switched,
              durationMs: Math.round(performance.now() - switchStartedAt),
              resultingActiveServerId: useAuthStore.getState().activeServerId,
              latestDesiredActiveServerId: desiredActiveServerIdRef.current,
            });
            if (!switched && desiredActiveServerIdRef.current === targetId) return;
          } catch (error) {
            emitMultiServerDebug('active_scope_switch_error', {
              targetId,
              durationMs: Math.round(performance.now() - switchStartedAt),
              error: describeMultiServerError(error),
            });
            throw error;
          }
        }
      } finally {
        activeSwitchInFlightRef.current = false;
        emitMultiServerDebug('active_scope_alignment_finish', {
          activeServerId: useAuthStore.getState().activeServerId,
          desiredActiveServerId: desiredActiveServerIdRef.current,
        });
      }
    })();
  }, [desiredActiveServerId, isLoggedIn, libraryBrowsePriorityKey]);

  useEffect(() => {
    const previousUnavailableServerIds = previousUnavailableServerIdsRef.current;
    previousUnavailableServerIdsRef.current = unavailableServerIds;
    if (previousUnavailableServerIds === unavailableServerIds) return;
    const state = useAuthStore.getState();
    if (isLoggedIn) {
      for (const serverId of previousUnavailableServerIds) {
        if (unavailableServerIds.has(serverId)) continue;
        const recovered = state.servers.find(server => server.id === serverId);
        if (recovered && useLibraryIndexStore.getState().isIndexEnabled(recovered.id)) {
          const bootstrapStartedAt = performance.now();
          emitMultiServerDebug('recovered_server_bootstrap_start', { serverId });
          void bootstrapIndexedServer(recovered)
            .then(result => emitMultiServerDebug('recovered_server_bootstrap_done', {
              serverId,
              result,
              durationMs: Math.round(performance.now() - bootstrapStartedAt),
            }))
            .catch(error => emitMultiServerDebug('recovered_server_bootstrap_error', {
              serverId,
              durationMs: Math.round(performance.now() - bootstrapStartedAt),
              error: describeMultiServerError(error),
            }));
        }
      }
    }
    const previousEffectiveScopeKey = deriveEffectiveLibraryBrowseServerIds(
      state,
      previousUnavailableServerIds,
    ).join('\u0000');
    const effectiveScopeKey = deriveEffectiveLibraryBrowseServerIds(
      state,
      unavailableServerIds,
    ).join('\u0000');
    emitMultiServerDebug('reachability_effective_scope_change', {
      previousUnavailableServerIds: [...previousUnavailableServerIds],
      unavailableServerIds: [...unavailableServerIds],
      previousEffectiveServerIds: previousEffectiveScopeKey ? previousEffectiveScopeKey.split('\u0000') : [],
      effectiveServerIds: effectiveScopeKey ? effectiveScopeKey.split('\u0000') : [],
      scopeVersionWillBump: previousEffectiveScopeKey !== effectiveScopeKey,
    });
    if (previousEffectiveScopeKey === effectiveScopeKey) return;
    useAuthStore.setState(state => ({
      libraryBrowseScopeVersion: state.libraryBrowseScopeVersion + 1,
    }));
  }, [isLoggedIn, unavailableServerIds]);

  useEffect(() => {
    if (!isLoggedIn || perfFlags.disableBackgroundPolling || selectedProfiles.length === 0) {
      emitMultiServerDebug('reachability_polling_skip', {
        reason: !isLoggedIn
          ? 'not_logged_in'
          : perfFlags.disableBackgroundPolling
            ? 'background_polling_disabled'
            : 'no_selected_profiles',
        selectedServerIds: selectedProfiles.map(server => server.id),
      });
      return;
    }
    let cancelled = false;

    const probeSelectedServers = async () => {
      for (const server of selectedProfiles) {
        if (cancelled) return;
        const probeStartedAt = performance.now();
        emitMultiServerDebug('reachability_probe_start', {
          serverId: server.id,
          currentReachability: getServerReachabilitySnapshot().get(server.id) ?? 'unknown',
        });
        try {
          const result = await ensureConnectUrlResolved(server);
          emitMultiServerDebug('reachability_probe_done', {
            serverId: server.id,
            durationMs: Math.round(performance.now() - probeStartedAt),
            ok: result.ok,
            ...(result.ok
              ? { endpointKind: result.endpoint.kind, serverType: result.ping.type ?? null }
              : { reason: result.reason }),
          });
        } catch (error) {
          emitMultiServerDebug('reachability_probe_error', {
            serverId: server.id,
            durationMs: Math.round(performance.now() - probeStartedAt),
            error: describeMultiServerError(error),
          });
          throw error;
        }
      }
    };
    const handleOnline = () => {
      for (const server of selectedProfiles) invalidateReachableEndpointCache(server.id);
      void probeSelectedServers();
    };

    void probeSelectedServers();
    const interval = setInterval(() => void probeSelectedServers(), SERVER_REACHABILITY_POLL_MS);
    window.addEventListener('online', handleOnline);
    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener('online', handleOnline);
      emitMultiServerDebug('reachability_polling_cleanup', {
        selectedServerIds: selectedProfiles.map(server => server.id),
      });
    };
  }, [isLoggedIn, perfFlags.disableBackgroundPolling, selectedProfiles]);
}
