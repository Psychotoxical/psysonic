/** Canonical local playback index key: `{serverIndexKey}:{trackId}`. */
export function localPlaybackEntryKey(serverIndexKey: string, trackId: string): string {
  return `${serverIndexKey}:${trackId}`;
}

export function parseLocalPlaybackEntryKey(
  key: string,
): { serverIndexKey: string; trackId: string } | null {
  const i = key.indexOf(':');
  if (i <= 0) return null;
  return { serverIndexKey: key.slice(0, i), trackId: key.slice(i + 1) };
}
