import { libraryGetTracksBatch, type LibraryTrackDto, type TrackRefDto } from '../../api/library';
import { useAuthStore } from '../../store/authStore';
import { usePlayerStore } from '../../store/playerStore';
import type { Track } from '../../store/playerStoreTypes';
import { songToTrack } from '../playback/songToTrack';
import { toQueueItemRefs } from './queueItemRef';
import { trackToSong } from './advancedSearchLocal';
import { libraryIsReady } from './libraryReady';

/** `library_get_tracks_batch` cap (spec §8.6 — max 100 refs/call). */
const BATCH = 100;

/**
 * Full-queue restore. The player store rehydrates a *windowed* `queue` plus a
 * full thin-ref list. When the library index is ready for the queue's server,
 * hydrate the entire queue from the index (`library_get_tracks_batch`, ≤100
 * refs/call) and swap it in, re-locating the current track so the playback
 * position stays correct even if some refs were dropped (unknown to the index).
 *
 * Phase 1: prefers `queueItems` (per-item serverId + queue-only flags) and
 * carries those flags onto the hydrated tracks; falls back to the legacy
 * `queueRefs` string list for stores persisted before Phase 1.
 *
 * Best-effort: missing refs / index not ready / any failure leave the windowed
 * `queue` untouched — no regression when the index is off (the P6 default).
 * Clears the restore-pending sentinel once a full hydrate succeeds so it runs at
 * most once; `queueItems` stays the canonical in-memory mirror (Phase 1b).
 */
export async function hydrateQueueFromIndex(): Promise<void> {
  const player = usePlayerStore.getState();

  // Restore-pending sentinel: `partialize` writes `queueItemsIndex` alongside the
  // full `queueItems` on every persist, so a fresh rehydrate carries it back.
  // Normal in-memory mutations keep `queueItems` canonical but never set the
  // index, so its presence — not a non-empty `queueItems` — marks "the windowed
  // queue still needs a full hydrate". Legacy pre-Phase-1 blobs use `queueRefs`.
  // Without a pending restore (steady state / later server switch) there is
  // nothing to do.
  const restorePending =
    player.queueItemsIndex !== undefined || (player.queueRefs?.length ?? 0) > 0;
  if (!restorePending) return;

  const items = player.queueItems;
  let refs: TrackRefDto[] | null = null;
  if (items?.length) {
    refs = items.map(it => ({ serverId: it.serverId, trackId: it.trackId }));
  } else if (player.queueRefs?.length) {
    const sid = player.queueServerId ?? useAuthStore.getState().activeServerId;
    if (sid) refs = player.queueRefs.map(trackId => ({ serverId: sid, trackId }));
  }
  if (!refs || refs.length === 0) return;

  // Clear only the restore-pending sentinel + legacy refs; `queueItems` stays the
  // canonical mirror.
  const clearRefs = () =>
    usePlayerStore.setState({
      queueItemsIndex: undefined,
      queueRefs: undefined, queueRefsIndex: undefined,
    });

  // v1 is single-server; gate readiness on the queue's server.
  const serverId = refs[0].serverId || player.queueServerId || useAuthStore.getState().activeServerId;
  if (!serverId) {
    clearRefs();
    return;
  }
  // Keep the windowed fallback (and the refs, for a later ready startup) when
  // the index can't serve the queue yet.
  if (!(await libraryIsReady(serverId))) return;

  try {
    const dtos: LibraryTrackDto[] = [];
    for (let i = 0; i < refs.length; i += BATCH) {
      dtos.push(...(await libraryGetTracksBatch(refs.slice(i, i + BATCH))));
    }
    if (dtos.length === 0) return; // index has none of them → keep fallback

    // The index doesn't store queue-only flags (radio/auto/play-next dividers),
    // so carry them from the refs onto the hydrated tracks.
    const flags = new Map(items?.map(it => [it.trackId, it]));
    const hydrated: Track[] = dtos.map(d => {
      const t = songToTrack(trackToSong(d));
      const f = flags.get(t.id);
      if (f?.autoAdded) t.autoAdded = true;
      if (f?.radioAdded) t.radioAdded = true;
      if (f?.playNextAdded) t.playNextAdded = true;
      return t;
    });

    // Re-locate the current track so queueIndex stays aligned with playback.
    const cur = usePlayerStore.getState().currentTrack;
    const idx = cur ? hydrated.findIndex(t => t.id === cur.id) : -1;
    if (cur && idx < 0) return; // can't align playback → keep windowed fallback

    usePlayerStore.setState({
      queue: hydrated,
      queueIndex: idx >= 0 ? idx : 0,
      // queueItems becomes the canonical mirror of the now-whole queue; only the
      // restore-pending sentinel + legacy refs are cleared.
      queueItems: toQueueItemRefs(serverId, hydrated),
      queueItemsIndex: undefined,
      queueRefs: undefined, queueRefsIndex: undefined,
    });
  } catch {
    // best-effort; the windowed fallback stays in place
  }
}
