import { addSongsToPlaylist, getPlaylist } from '@/lib/api/subsonicPlaylists';
import { useConfirmModalStore } from '@/store/confirmModalStore';
import { showToast } from '@/lib/dom/toast';
import { usePlaylistMembershipStore } from '@/store/playlistMembershipStore';

export type AddTracksDedupOutcome = 'added' | 'added_duplicates' | 'partial' | 'skipped';

export interface AddTracksDedupResult {
  outcome: AddTracksDedupOutcome;
  addedCount: number;
  skippedCount: number;
}

/** Ask before re-adding songs when *all* selected ids are already present.
 *  Returns true → append as duplicates, false → keep the silent-skip behavior. */
export async function confirmAddAllDuplicates(
  playlistName: string,
  count: number,
  t: (key: string, opts?: Record<string, unknown>) => string,
): Promise<boolean> {
  return useConfirmModalStore.getState().request({
    title: t('playlists.duplicateConfirmTitle'),
    message: t('playlists.duplicateConfirmMessage', { count, playlist: playlistName }),
    confirmLabel: t('playlists.duplicateConfirmAction'),
    cancelLabel: t('common.cancel'),
  });
}

/** Add tracks with dedup; membership from cache or one getPlaylist on cache miss (GET response, not long URL). */
export async function addTracksToPlaylistWithDedup(
  playlistId: string,
  playlistName: string,
  trackIds: readonly string[],
  t: (key: string, opts?: Record<string, unknown>) => string,
): Promise<AddTracksDedupResult> {
  if (trackIds.length === 0) {
    return { outcome: 'skipped', addedCount: 0, skippedCount: 0 };
  }

  // Dedup reads the membership snapshot, awaits the write, then appends. Concurrent
  // adds to the same playlist could interleave on this read-modify-append; the risk is
  // a rare missed dedup, self-healing on the next full load. Acceptable for a UI action.
  const store = usePlaylistMembershipStore.getState();
  const existingIds = new Set(
    await resolvePlaylistSongIds(playlistId, async () => {
      const { songs } = await getPlaylist(playlistId);
      return songs.map(s => s.id);
    }),
  );
  const newIds = trackIds.filter(id => !existingIds.has(id));

  try {
    if (newIds.length > 0) {
      await addSongsToPlaylist(playlistId, newIds);
      store.appendPlaylistSongIds(playlistId, newIds);
      return {
        outcome: newIds.length === trackIds.length ? 'added' : 'partial',
        addedCount: newIds.length,
        skippedCount: trackIds.length - newIds.length,
      };
    }

    const accepted = await confirmAddAllDuplicates(playlistName, trackIds.length, t);
    if (!accepted) {
      return { outcome: 'skipped', addedCount: 0, skippedCount: trackIds.length };
    }

    await addSongsToPlaylist(playlistId, [...trackIds]);
    store.appendPlaylistSongIds(playlistId, trackIds);
    return { outcome: 'added_duplicates', addedCount: trackIds.length, skippedCount: 0 };
  } catch (err) {
    // A batched write may have partially landed — drop the cache so the next read refetches truth.
    store.invalidatePlaylistSongIds(playlistId);
    throw err;
  }
}

export function showAddTracksDedupToast(
  t: (key: string, opts?: Record<string, unknown>) => string,
  playlistName: string,
  result: AddTracksDedupResult,
): void {
  switch (result.outcome) {
    case 'added':
      showToast(t('playlists.addSuccess', { count: result.addedCount, playlist: playlistName }));
      break;
    case 'partial':
      showToast(
        t('playlists.addPartial', {
          added: result.addedCount,
          skipped: result.skippedCount,
          playlist: playlistName,
        }),
        4000,
        'info',
      );
      break;
    case 'added_duplicates':
      showToast(
        t('playlists.addedAsDuplicates', { count: result.addedCount, playlist: playlistName }),
        3000,
        'info',
      );
      break;
    case 'skipped':
      showToast(
        t('playlists.addAllSkipped', { count: result.skippedCount, playlist: playlistName }),
        3000,
        'info',
      );
      break;
  }
}

/** Resolve song ids for a playlist: in-memory cache first, network fallback (then cached). */
export async function resolvePlaylistSongIds(
  playlistId: string,
  fetch: () => Promise<readonly string[]>,
): Promise<readonly string[]> {
  const cached = usePlaylistMembershipStore.getState().getPlaylistSongIds(playlistId);
  if (cached !== undefined) return cached;
  const ids = await fetch();
  usePlaylistMembershipStore.getState().setPlaylistSongIds(playlistId, ids);
  return ids;
}

/** Collect song ids to merge into target, using cached membership when available. */
export async function collectMergeSongIds(
  targetPlaylistId: string,
  sourcePlaylistIds: readonly string[],
): Promise<string[]> {
  const targetIds = new Set(
    await resolvePlaylistSongIds(targetPlaylistId, async () => {
      const { songs } = await getPlaylist(targetPlaylistId);
      return songs.map(s => s.id);
    }),
  );
  const idsToAdd: string[] = [];
  for (const sourceId of sourcePlaylistIds) {
    const sourceIds = await resolvePlaylistSongIds(sourceId, async () => {
      const { songs } = await getPlaylist(sourceId);
      return songs.map(s => s.id);
    });
    for (const songId of sourceIds) {
      if (!targetIds.has(songId)) {
        targetIds.add(songId);
        idsToAdd.push(songId);
      }
    }
  }
  return idsToAdd;
}
