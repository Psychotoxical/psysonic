import { getPlaylistForServer, updatePlaylistForServer } from '@/lib/api/subsonicPlaylists';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import { usePlaylistMembershipStore } from '@/store/playlistMembershipStore';

function takeCounts(ids: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  ids.forEach(id => counts.set(id, (counts.get(id) ?? 0) + 1));
  return counts;
}

export function reconcilePlaylistMembership(
  fullIds: readonly string[],
  previousVisibleIds: readonly string[],
  nextVisibleIds: readonly string[],
): string[] {
  const remainingVisible = takeCounts(previousVisibleIds);
  const visibleIndices: number[] = [];

  fullIds.forEach((id, index) => {
    const remaining = remainingVisible.get(id) ?? 0;
    if (remaining <= 0) return;
    visibleIndices.push(index);
    remainingVisible.set(id, remaining - 1);
  });

  const retainedCounts = takeCounts(nextVisibleIds);
  const retainedIndices: number[] = [];
  const removedIndices = new Set<number>();

  visibleIndices.forEach(index => {
    const id = fullIds[index];
    const remaining = retainedCounts.get(id) ?? 0;
    if (remaining > 0) {
      retainedIndices.push(index);
      retainedCounts.set(id, remaining - 1);
    } else {
      removedIndices.add(index);
    }
  });

  const previousCounts = takeCounts(previousVisibleIds);
  const retainedVisibleIds: string[] = [];
  const addedIds: string[] = [];
  nextVisibleIds.forEach(id => {
    const remaining = previousCounts.get(id) ?? 0;
    if (remaining > 0) {
      retainedVisibleIds.push(id);
      previousCounts.set(id, remaining - 1);
    } else {
      addedIds.push(id);
    }
  });

  const retainedByIndex = new Map(retainedIndices.map((index, i) => [index, retainedVisibleIds[i]]));
  const nextFullIds = fullIds.flatMap((id, index) => {
    if (removedIndices.has(index)) return [];
    return [retainedByIndex.get(index) ?? id];
  });
  return [...nextFullIds, ...retainedVisibleIds.slice(retainedIndices.length), ...addedIds];
}

interface UpdatePlaylistMembershipOptions {
  playlistId: string;
  ownerServerId: string;
  previousVisibleSongs: readonly SubsonicSong[];
  nextVisibleSongs: readonly SubsonicSong[];
}

export async function updatePlaylistMembership(options: UpdatePlaylistMembershipOptions): Promise<void> {
  const { playlistId, ownerServerId, previousVisibleSongs, nextVisibleSongs } = options;
  const membershipStore = usePlaylistMembershipStore.getState();
  let fullIds = membershipStore.getPlaylistSongIds(playlistId, ownerServerId);
  if (!fullIds) {
    const loaded = await getPlaylistForServer(ownerServerId, playlistId);
    fullIds = loaded.songs.map(song => song.id);
  }

  const nextFullIds = reconcilePlaylistMembership(
    fullIds,
    previousVisibleSongs.map(song => song.id),
    nextVisibleSongs.map(song => song.id),
  );
  await updatePlaylistForServer(ownerServerId, playlistId, nextFullIds, fullIds.length);
  membershipStore.replacePlaylistSongIds(playlistId, nextFullIds, ownerServerId);
}
