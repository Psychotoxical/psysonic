import type { ServerProfile } from '../../store/authStoreTypes';
import { scheduleInstantMixProbeForServer } from '@/lib/api/subsonic';
import {
  coverTrafficBeginServerSwitch,
  coverTrafficEndServerSwitch,
} from '../../cover/coverTraffic';
import { useAuthStore } from '../../store/authStore';
import { useOrbitStore } from '@/features/orbit';
import { flushPlayQueueForServer } from '@/features/playback/store/queueSync';
import { markQueueHandoffPending } from '@/features/playback/store/queueSyncUiState';
import { endOrbitSession, leaveOrbitSession } from '@/features/orbit';
import { ensureConnectUrlResolved } from '@/lib/server/serverEndpoint';
import { syncServerHttpContextForProfile } from '@/lib/server/syncServerHttpContext';

export async function switchActiveServer(server: ServerProfile): Promise<boolean> {
  coverTrafficBeginServerSwitch();
  try {
    // Resolve the reachable endpoint (LAN-first, sticky cached); this also
    // populates the connect cache so the sync `getBaseUrl()` lookup serves the
    // probed URL on the very next read. Single-address profiles fall through
    // to one ping, identical to the legacy behaviour.
    const probe = await ensureConnectUrlResolved(server);
    if (!probe.ok) return false;

    // Tear down any active Orbit session before we actually switch. The
    // session's playlists live on the *old* server — once we flip the
    // active server, every API call from the orbit hooks would hit the
    // wrong backend, heartbeats would silently fail, and the next
    // app-start cleanup would prune the still-live session as stale.
    // Capped at 1.5 s so a slow network doesn't freeze the UI.
    const role = useOrbitStore.getState().role;
    if (role === 'host' || role === 'guest') {
      const teardown = role === 'host' ? endOrbitSession() : leaveOrbitSession();
      await Promise.race([
        teardown.catch(() => {}),
        new Promise<void>(r => setTimeout(r, 1500)),
      ]);
      // Ensure local store is idle even if the remote call timed out.
      useOrbitStore.getState().reset();
    }

    const auth = useAuthStore.getState();
    const oldActiveId = auth.activeServerId;
    if (oldActiveId && oldActiveId !== server.id) {
      await flushPlayQueueForServer(oldActiveId);
    }

    const identity = {
      type: probe.ping.type,
      serverVersion: probe.ping.serverVersion,
      openSubsonic: probe.ping.openSubsonic,
    };
    auth.setSubsonicServerIdentity(server.id, identity);
    scheduleInstantMixProbeForServer(server.id, probe.baseUrl, server.username, server.password, identity);
    auth.setActiveServer(server.id);
    auth.setLoggedIn(true);
    if (oldActiveId && oldActiveId !== server.id) {
      markQueueHandoffPending();
    }
    void syncServerHttpContextForProfile(server);
    return true;
  } catch {
    return false;
  } finally {
    coverTrafficEndServerSwitch();
  }
}
