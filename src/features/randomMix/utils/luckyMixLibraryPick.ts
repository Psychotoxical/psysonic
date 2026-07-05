import { libraryGetStatus } from '@/lib/api/library';
import { librarySelectionForServer } from '@/lib/api/subsonicClient';
import { useAuthStore } from '@/store/authStore';

/** Libraries above this size are preferred; several large ones are picked at random. */
export const LUCKY_MIX_LARGE_LIBRARY_TRACK_THRESHOLD = 1000;

/** True when the user selected several libraries but not the full server set. */
export function isPartialMultiLibrarySelection(serverId: string): boolean {
  const selection = librarySelectionForServer(serverId);
  if (selection.length <= 1) return false;
  const folderCount = useAuthStore.getState().musicFolders.length;
  if (folderCount <= 1) return false;
  return selection.length < folderCount;
}

export async function pickLuckyMixTargetLibrary(
  serverId: string,
  candidates: string[],
): Promise<string> {
  if (candidates.length === 0) {
    throw new Error('lucky-mix: no library candidates');
  }
  if (candidates.length === 1) return candidates[0];

  const counts = await Promise.all(
    candidates.map(async libraryId => {
      try {
        const status = await libraryGetStatus(serverId, libraryId);
        return { libraryId, count: Math.max(0, status.localTrackCount ?? 0) };
      } catch {
        return { libraryId, count: 0 };
      }
    }),
  );

  const large = counts.filter(c => c.count > LUCKY_MIX_LARGE_LIBRARY_TRACK_THRESHOLD);
  if (large.length > 1) {
    return large[Math.floor(Math.random() * large.length)]!.libraryId;
  }
  if (large.length === 1) {
    return large[0]!.libraryId;
  }

  const maxCount = Math.max(...counts.map(c => c.count));
  const tier = counts.filter(c => c.count === maxCount);
  return tier[Math.floor(Math.random() * tier.length)]!.libraryId;
}
