import { libraryGetTracksBatch, type LibraryTrackDto, type TrackRefDto } from '../../api/library';
import { useAuthStore } from '../../store/authStore';
import { usePlayerStore } from '../../store/playerStore';
import type { Track } from '../../store/playerStoreTypes';
import { songToTrack } from '../playback/songToTrack';
import { trackToSong } from './advancedSearchLocal';
import { libraryIsReady } from './libraryReady';

/** `library_get_tracks_batch` cap (spec §8.6 — max 100 refs/call). */
const BATCH = 100;

/**
 * F5 — full-queue restore. The player store rehydrates a *windowed* `queue`
 * plus a full `queueRefs` id list. When the library index is ready for the
 * queue's server, hydrate the entire queue from the index
 * (`library_get_tracks_batch`, ≤100 refs/call) and swap it in, re-locating the
 * current track so the playback position stays correct even if some refs were
 * dropped (unknown to the index).
 *
 * Best-effort: missing refs / index not ready / any failure leave the windowed
 * `queue` untouched — no regression when the index is off (the P6 default).
 * Clears `queueRefs` once a full hydrate succeeds so it runs at most once.
 */
export async function hydrateQueueFromIndex(): Promise<void> {
  const player = usePlayerStore.getState();
  const refs = player.queueRefs;
  if (!refs || refs.length === 0) return;

  const serverId = player.queueServerId ?? useAuthStore.getState().activeServerId;
  if (!serverId) {
    usePlayerStore.setState({ queueRefs: undefined, queueRefsIndex: undefined });
    return;
  }
  // Keep the windowed fallback (and the refs, for a later ready startup) when
  // the index can't serve the queue yet.
  if (!(await libraryIsReady(serverId))) return;

  try {
    const dtos: LibraryTrackDto[] = [];
    for (let i = 0; i < refs.length; i += BATCH) {
      const chunk: TrackRefDto[] = refs.slice(i, i + BATCH).map(trackId => ({ serverId, trackId }));
      dtos.push(...(await libraryGetTracksBatch(chunk)));
    }
    if (dtos.length === 0) return; // index has none of them → keep fallback

    const hydrated: Track[] = dtos.map(d => songToTrack(trackToSong(d)));
    // Re-locate the current track so queueIndex stays aligned with playback.
    const cur = usePlayerStore.getState().currentTrack;
    const idx = cur ? hydrated.findIndex(t => t.id === cur.id) : -1;
    if (cur && idx < 0) return; // can't align playback → keep windowed fallback

    usePlayerStore.setState({
      queue: hydrated,
      queueIndex: idx >= 0 ? idx : 0,
      queueRefs: undefined,
      queueRefsIndex: undefined,
    });
  } catch {
    // best-effort; the windowed fallback stays in place
  }
}
