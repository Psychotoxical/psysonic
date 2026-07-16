import { useState, useEffect, useCallback, useRef, useMemo, useSyncExternalStore } from 'react';
import { useAuthStore } from '@/store/authStore';
import { scheduleInstantMixProbeForServer } from '@/lib/api/subsonic';
import { serverListDisplayLabel } from '@/lib/server/serverDisplayName';
import {
  ensureConnectUrlResolved,
  invalidateReachableEndpointCache,
  isLanUrl,
  type ServerEndpointKind,
} from '@/lib/server/serverEndpoint';
import {
  getConnectionStatus,
  setActiveServerReachable,
  setConnectionStatus,
  subscribeConnectionStatus,
  type ConnectionStatus,
} from '@/lib/network/activeServerReachability';
import { isNavigatorOfflineHint } from '@/lib/network/navigatorOnlineHint';
import { usePerfProbeFlags } from '@/lib/perf/perfFlags';
import {
  isDevOfflineBrowseForced,
  useDevOfflineBrowseStore,
} from '@/store/devOfflineBrowseStore';

// Backward-compatible re-export for call sites that still import from the hook.
export { isLanUrl };
export type { ConnectionStatus };

export function useConnectionStatus() {
  const perfFlags = usePerfProbeFlags();
  const devForceOffline = useDevOfflineBrowseStore(s => s.forceOffline);
  const status = useSyncExternalStore(subscribeConnectionStatus, getConnectionStatus, getConnectionStatus);
  const [isRetrying, setIsRetrying] = useState(false);
  // Tracks the kind of endpoint the last successful probe answered on so the
  // badge reflects the *active* connection, not just whatever the user typed
  // as the primary URL. A LAN-tagged primary that has fallen over to its
  // public alternate must read as 'public', not 'local'.
  const [activeEndpointKind, setActiveEndpointKind] = useState<ServerEndpointKind | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevDevForceOfflineRef = useRef<boolean | null>(null);
  const activeServerId = useAuthStore(s => s.activeServerId);
  const prevActiveServerIdRef = useRef<string | null | undefined>(undefined);

  const check = useCallback(async () => {
    if (isDevOfflineBrowseForced()) {
      setActiveServerReachable(false);
      setConnectionStatus('disconnected');
      return;
    }

    const server = useAuthStore.getState().getActiveServer();
    if (!server) {
      setActiveServerReachable(false);
      setConnectionStatus('disconnected');
      return;
    }

    if (isNavigatorOfflineHint()) {
      setActiveServerReachable(false);
      setConnectionStatus('disconnected');
      return;
    }

    // Dual-address: probe LAN-first via the shared cache. On every poll the
    // sticky entry is tried first; on failure the full sequence runs and the
    // cache flips to whichever endpoint actually answers — so a laptop moving
    // off WiFi smoothly transitions from LAN to public without a manual retry.
    const probe = await ensureConnectUrlResolved(server);
    if (probe.ok) {
      const sid = useAuthStore.getState().activeServerId;
      if (sid) {
        const identity = {
          type: probe.ping.type,
          serverVersion: probe.ping.serverVersion,
          openSubsonic: probe.ping.openSubsonic,
        };
        useAuthStore.getState().setSubsonicServerIdentity(sid, identity);
        scheduleInstantMixProbeForServer(sid, probe.baseUrl, server.username, server.password, identity);
      }
      setActiveEndpointKind(probe.endpoint.kind);
    } else {
      setActiveEndpointKind(null);
    }
    setActiveServerReachable(probe.ok);
    setConnectionStatus(probe.ok ? 'connected' : 'disconnected');
  }, []);

  const retry = useCallback(async () => {
    setIsRetrying(true);
    // Manual retry: drop the sticky cache so the next probe starts in the
    // natural LAN-first order instead of revalidating whatever last worked.
    const sid = useAuthStore.getState().activeServerId;
    if (sid) invalidateReachableEndpointCache(sid);
    await check();
    setIsRetrying(false);
  }, [check]);

  // Active server changed (switch server / login / logout): the previous
  // probe's endpoint kind belongs to the *old* server, so the LAN/public badge
  // would otherwise stay stuck on it — a LAN-only server keeps reading 'local'
  // after switching to a public one, and vice versa — until the 120-s tick. Reset
  // the kind (badge falls back to the new server's own URL classification) and
  // re-probe now. Mount is skipped: the polling effect already probes on mount.
  useEffect(() => {
    if (prevActiveServerIdRef.current === undefined) {
      prevActiveServerIdRef.current = activeServerId;
      return;
    }
    if (prevActiveServerIdRef.current === activeServerId) return;
    prevActiveServerIdRef.current = activeServerId;
    if (perfFlags.disableBackgroundPolling) return;
    // React Compiler set-state-in-effect rule: reset stale kind, then re-probe.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActiveEndpointKind(null);
    void check();
  }, [activeServerId, check, perfFlags.disableBackgroundPolling]);

  // DEV offline toggle: react to transitions only — the polling effect already
  // probes on mount; an unconditional check() here doubled probes and ignored
  // disableBackgroundPolling (PlayerBar tests, perf-flagged runs).
  useEffect(() => {
    if (!import.meta.env.DEV) return;

    if (prevDevForceOfflineRef.current === null) {
      prevDevForceOfflineRef.current = devForceOffline;
      if (devForceOffline) {
        setActiveServerReachable(false);
        setConnectionStatus('disconnected');
      }
      return;
    }

    if (prevDevForceOfflineRef.current === devForceOffline) return;
    prevDevForceOfflineRef.current = devForceOffline;

    if (devForceOffline) {
      setActiveServerReachable(false);
      setConnectionStatus('disconnected');
      return;
    }
    if (!perfFlags.disableBackgroundPolling) {
      // React Compiler set-state-in-effect rule: probe after DEV offline toggle clears.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void check();
    }
  }, [devForceOffline, check, perfFlags.disableBackgroundPolling]);

  useEffect(() => {
    if (perfFlags.disableBackgroundPolling) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (isDevOfflineBrowseForced()) {
        setActiveServerReachable(false);
        setConnectionStatus('disconnected');
      } else {
        setActiveServerReachable(true);
        setConnectionStatus('connected');
      }
      return;
    }
    // React Compiler set-state-in-effect rule: initial probe + polling interval on mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    check();
    intervalRef.current = setInterval(check, 120_000);

    const handleOnline = () => {
      // Network just came back — the sticky entry is from a different network
      // moment and may be wrong. Flush, then re-probe LAN-first.
      const sid = useAuthStore.getState().activeServerId;
      if (sid) invalidateReachableEndpointCache(sid);
      check();
    };
    const handleOffline = () => {
      // WebKitGTK can spuriously fire `offline` while HTTP still works — re-probe
      // on desktop instead of hard-disconnecting (see navigatorOnlineHint).
      if (isNavigatorOfflineHint()) {
        setActiveServerReachable(false);
        setConnectionStatus('disconnected');
        return;
      }
      void check();
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [check, devForceOffline, perfFlags.disableBackgroundPolling]);

  const server = useAuthStore(s => s.getActiveServer());
  const servers = useAuthStore(s => s.servers);
  const serverName = useMemo(
    () => (server ? serverListDisplayLabel(server, servers) : ''),
    [server, servers],
  );

  return {
    status,
    isRetrying,
    retry,
    // Active endpoint kind preferred; until the first probe completes we
    // fall back to the primary url's classification so the badge has
    // *something* to render at mount time. Once a probe has resolved,
    // `activeEndpointKind` is the source of truth.
    isLan:
      activeEndpointKind !== null
        ? activeEndpointKind === 'local'
        : server
        ? isLanUrl(server.url)
        : false,
    serverName,
  };
}
