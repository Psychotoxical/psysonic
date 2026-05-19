import { librarySyncBindSession } from '../../api/library';
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
