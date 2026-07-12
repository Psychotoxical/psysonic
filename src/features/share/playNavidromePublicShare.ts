import type { TFunction } from 'i18next';
import type { NavidromePublicShareRef } from '@/lib/share/navidromePublicShareUrl';
import type { NavidromePublicShareInfo } from '@/lib/share/navidromePublicShareTypes';
import { NAVIDROME_PUBLIC_SHARE_SERVER_ID, navidromePublicShareToTracks } from '@/lib/share/navidromePublicSharePlayback';
import { seedQueueResolver, usePlayerStore } from '@/features/playback';
import { showToast } from '@/lib/dom/toast';

export async function playNavidromePublicShare(
  ref: NavidromePublicShareRef,
  info: NavidromePublicShareInfo,
  t: TFunction,
): Promise<boolean> {
  const tracks = navidromePublicShareToTracks(ref, info);
  if (tracks.length === 0) {
    showToast(t('sharePaste.genericError'), 5000, 'error');
    return false;
  }

  usePlayerStore.getState().clearQueue();
  seedQueueResolver(NAVIDROME_PUBLIC_SHARE_SERVER_ID, tracks);
  usePlayerStore.setState({ navidromePublicSharePageUrl: ref.pageUrl });
  usePlayerStore.getState().playTrack(tracks[0]!, tracks);
  showToast(t('sharePaste.openedNavidromePublic', { count: tracks.length }), 3000, 'info');
  return true;
}
