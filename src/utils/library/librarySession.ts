import { librarySyncBindSession, libraryGetStatus, librarySyncStart } from '../../api/library';
import { useAuthStore } from '../../store/authStore';
import { useLibraryIndexStore } from '../../store/libraryIndexStore';

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
    await librarySyncBindSession({
      serverId: server.id,
      baseUrl,
      username: server.username,
      password: server.password,
    });
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
 * «Sync now». A library that has never completed a full sync
 * (`!lastFullSyncAt`) (re)starts one with `mode: 'full'`, which resumes from
 * the persisted cursor rather than restarting from zero. Once a full sync has
 * landed this is a no-op, so delta stays the scheduler's job.
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
    const status = await libraryGetStatus(serverId);
    if (!status.lastFullSyncAt) {
      await librarySyncStart({ serverId, mode: 'full' });
    }
  } catch {
    /* best-effort */
  } finally {
    resumeInFlight.delete(serverId);
  }
}
