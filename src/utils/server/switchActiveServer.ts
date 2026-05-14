import type { ServerProfile } from '../../store/authStoreTypes';
import { pingWithCredentials, scheduleInstantMixProbeForServer } from '../../api/subsonic';
import { useAuthStore } from '../../store/authStore';
import { useOrbitStore } from '../../store/orbitStore';
import { endOrbitSession, leaveOrbitSession } from '../orbit';

export async function switchActiveServer(server: ServerProfile): Promise<boolean> {
  try {
    const ping = await pingWithCredentials(server.url, server.username, server.password);
    if (!ping.ok) return false;

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

    const identity = {
      type: ping.type,
      serverVersion: ping.serverVersion,
      openSubsonic: ping.openSubsonic,
    };
    const auth = useAuthStore.getState();
    auth.setSubsonicServerIdentity(server.id, identity);
    scheduleInstantMixProbeForServer(server.id, server.url, server.username, server.password, identity);
    auth.setActiveServer(server.id);
    auth.setLoggedIn(true);
    return true;
  } catch {
    return false;
  }
}
