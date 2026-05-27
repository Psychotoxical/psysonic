import type { DiskCoverIdHints } from './diskPeekIds';

/** Merge Subsonic hints with library row fields (library wins when Subsonic omitted albumId). */
export function mergeDiskIdHints(
  fromSubsonic?: DiskCoverIdHints,
  fromLibrary?: DiskCoverIdHints,
): DiskCoverIdHints | undefined {
  if (!fromSubsonic && !fromLibrary) return undefined;
  return {
    albumId: fromSubsonic?.albumId?.trim() || fromLibrary?.albumId?.trim() || undefined,
    songId: fromSubsonic?.songId?.trim() || fromLibrary?.songId?.trim() || undefined,
    rawCoverArt: fromSubsonic?.rawCoverArt?.trim() || fromLibrary?.rawCoverArt?.trim() || undefined,
    albumCoverArt:
      fromSubsonic?.albumCoverArt?.trim() || fromLibrary?.albumCoverArt?.trim() || undefined,
  };
}
