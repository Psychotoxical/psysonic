export function resolveGenreHeaderCount(args: {
  loading: boolean;
  hasMore: boolean;
  loadedAlbumCount: number;
  albumCount: number | null;
}): number | null {
  if (!args.loading && !args.hasMore && args.loadedAlbumCount > 0) return args.loadedAlbumCount;
  return args.albumCount;
}
