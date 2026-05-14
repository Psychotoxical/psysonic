import { useConfirmModalStore } from '../../store/confirmModalStore';

/** Psysonic smart playlists (Navidrome); not valid targets for manual add-to-playlist. */
export const SMART_PLAYLIST_PREFIX = 'psy-smart-';

export function isSmartPlaylistName(name: string | undefined | null): boolean {
  return (name ?? '').toLowerCase().startsWith(SMART_PLAYLIST_PREFIX);
}

export function sanitizeFilename(name: string): string {
  return name
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .substring(0, 200) || 'download';
}

/** Fisher-Yates in-place shuffle — returns a new array, does not mutate the input. */
export function shuffleArray<T>(arr: T[]): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/** Ask user before re-adding songs to a playlist when *all* selected ids are
 *  already present. Returns true → caller should append them as duplicates,
 *  false → caller should keep today's silent-skip toast behavior. */
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
