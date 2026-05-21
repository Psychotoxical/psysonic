import { librarySyncBindSession, libraryGetStatus, librarySyncStart } from '../../api/library';
import { useAuthStore } from '../../store/authStore';
import { useLibraryIndexStore } from '../../store/libraryIndexStore';
import { libraryDevEnabled, logLibraryStatus, logLibrarySync, timed } from './libraryDevLog';

/**
 * Re-bind the Rust sync session for the active server when the index
 * toggle is on.
 *
 * The session (credentials + Navidrome bearer) lives in Rust process
 * memory only and is gone on app exit, while the per-server toggle
 * persists in `libraryIndexStore`. Without a re-bind on startup /
 * server switch, `library_sync_start` and the background scheduler
 * report "no bound session" even though the UI shows the index as
 * enabled (PR-5 kickoff Q5: "on server connect if index already on").
 *
 * Best-effort: a bind failure here stays silent — the Settings toggle
 * surfaces the real error when the user interacts. Returns whether a
 * bind was attempted (false = no active server / index off).
 */
export async function ensureActiveServerSessionBound(): Promise<boolean> {
  const auth = useAuthStore.getState();
  const server = auth.servers.find(s => s.id === auth.activeServerId);
  if (!server) return false;
  if (!useLibraryIndexStore.getState().isIndexEnabled(server.id)) return false;
  const baseUrl = auth.getBaseUrl();
  if (!baseUrl) return false;
  try {
    const t0 = performance.now();
    await librarySyncBindSession({
      serverId: server.id,
      baseUrl,
      username: server.username,
      password: server.password,
    });
    if (libraryDevEnabled()) {
      const { result: status, ms } = await timed(() => libraryGetStatus(server.id));
      logLibrarySync({
        at: new Date().toISOString(),
        kind: 'bind_session',
        serverId: server.id,
        ingestStrategy: status.ingestStrategy ?? null,
        ingestPhase: status.ingestPhase ?? null,
        syncPhase: status.syncPhase,
        n1BulkUnreliable: status.n1BulkUnreliable ?? null,
        durationMs: Math.round(performance.now() - t0),
        message: `status fetch ${ms}ms`,
      });
      logLibraryStatus(server.id, status, 'bind_session');
    }
  } catch {
    /* best-effort — Settings shows the real error on explicit toggle */
  }
  return true;
}

/**
 * Resume an interrupted initial sync on startup / server switch.
 *
 * The background scheduler is delta-only (PR-5b), so a full sync killed
 * mid-run (app restart) would otherwise sit at `idle` until the user clicks
 * «Sync now». When `syncPhase === 'initial_sync'`, (re)start with
 * `mode: 'full'` — the Rust side resumes from the persisted cursor.
 * A finished library (`ready` / `lastFullSyncAt`) or an idle library that
 * already has indexed tracks must not be restarted on every launch.
 *
 * Best-effort: errors stay silent — Settings surfaces them on explicit action.
 *
 * De-duped per server: React StrictMode (and rapid re-binds) fire the startup
 * effect twice, and a second `library_sync_start` would cancel the first
 * (`set_current_job` is cancel-and-replace) — harmless but wasteful and noisy.
 */
const resumeInFlight = new Set<string>();

export async function resumeInitialSyncIfIncomplete(serverId: string): Promise<void> {
  if (resumeInFlight.has(serverId)) return;
  resumeInFlight.add(serverId);
  try {
    const { result: status, ms: statusMs } = await timed(() => libraryGetStatus(serverId));
    if (status.syncPhase === 'ready' || status.lastFullSyncAt) return;
    if (status.syncPhase !== 'initial_sync') return;
    const resumeT0 = performance.now();
    await librarySyncStart({ serverId, mode: 'full' });
    if (libraryDevEnabled()) {
      logLibrarySync({
        at: new Date().toISOString(),
        kind: 'resume_initial_sync',
        serverId,
        ingestStrategy: status.ingestStrategy ?? null,
        ingestPhase: status.ingestPhase ?? null,
        syncPhase: status.syncPhase,
        n1BulkUnreliable: status.n1BulkUnreliable ?? null,
        localTrackCount: status.localTrackCount ?? null,
        serverTrackCount: status.serverTrackCount ?? null,
        durationMs: Math.round(performance.now() - resumeT0),
        message: `status ${statusMs}ms`,
      });
      logLibraryStatus(serverId, status, 'resume_initial_sync');
    }
  } catch {
    /* best-effort */
  } finally {
    resumeInFlight.delete(serverId);
  }
}
