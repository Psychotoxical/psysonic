import { useEffect } from 'react';
import { writeOrbitHeartbeat } from '../utils/orbit';
import { orbitOutboxPlaylistName } from '../api/orbit';

const HEARTBEAT_TICK_MS = 10_000;

/**
 * Shared Orbit outbox heartbeat — used by both the host and guest tick hooks.
 *
 * Refreshes the caller's own outbox playlist comment with a fresh timestamp
 * every 10 s so the host's participant sweep sees the user as alive (and so
 * the host's own outbox is refreshed symmetrically). Host and guest differ
 * only in whose name owns the outbox: `ownName` is `OrbitState.host` for the
 * host and the active server username for a guest.
 *
 * Best-effort — a transient Navidrome outage just skips a beat; the next
 * interval tick retries.
 */
export function useOrbitOutboxHeartbeat(
  active: boolean,
  outboxPlaylistId: string | null,
  sessionId: string | null,
  ownName: string | null | undefined,
): void {
  useEffect(() => {
    if (!active || !outboxPlaylistId || !sessionId || !ownName) return;
    const outboxName = orbitOutboxPlaylistName(sessionId, ownName);

    const beat = async () => {
      try { await writeOrbitHeartbeat(outboxPlaylistId, outboxName); }
      catch { /* best-effort */ }
    };
    void beat();

    const id = window.setInterval(() => { void beat(); }, HEARTBEAT_TICK_MS);
    return () => window.clearInterval(id);
  }, [active, outboxPlaylistId, sessionId, ownName]);
}
