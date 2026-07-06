/** Hide Tracks browse hero / Highly Rated / Random Pick discovery rails. */
export function tracksBrowseDiscoveryChromeHidden(args: {
  offlineBrowseActive: boolean;
  tracksSearchActive: boolean;
  leaveRestorePendingWithQuery: boolean;
}): boolean {
  return args.offlineBrowseActive
    || args.tracksSearchActive
    || args.leaveRestorePendingWithQuery;
}
