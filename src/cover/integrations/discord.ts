import { buildCoverArtUrlForServer } from '@/lib/api/subsonicStreamUrl';
import { serverShareBaseUrl } from '@/lib/server/serverEndpoint';
import { useAuthStore } from '../../store/authStore';
import type { CoverArtRef } from '../types';

/**
 * Discord large image — an https:// URL Discord's own servers can reach.
 *
 * Unlike every other cover fetch we must NOT use the connect URL: that prefers
 * the LAN address (fast for the app itself), but Discord fetches the image
 * remotely, so a `http://192.168.x.x` address is unreachable and falls back to
 * the app icon. Discord is an external consumer just like a share link, so use
 * `serverShareBaseUrl` (public address preferred when both are set).
 *
 * Resolve the profile straight from the store: a `playback`/`active` scope
 * always means the active server (a cross-server track gets an explicit
 * `server` scope), so we never route through `getPlaybackServerId()`, whose
 * empty-string / index-key returns previously yielded a null cover URL on
 * locally-cached tracks.
 */
export async function coverArtUrlForDiscord(ref: CoverArtRef): Promise<string | null> {
  const { serverScope, fetchCoverArtId } = ref;
  const auth = useAuthStore.getState();

  const profile =
    serverScope.kind === 'server'
      ? auth.servers.find(s => s.id === serverScope.serverId)
      : auth.servers.find(s => s.id === auth.activeServerId);

  if (profile) {
    return buildCoverArtUrlForServer(
      serverShareBaseUrl(profile),
      profile.username,
      profile.password,
      fetchCoverArtId,
      800,
    ) || null;
  }

  // Server scope carries its own URL/creds even when not a saved profile.
  if (serverScope.kind === 'server') {
    return buildCoverArtUrlForServer(
      serverShareBaseUrl({ url: serverScope.url }),
      serverScope.username,
      serverScope.password,
      fetchCoverArtId,
      800,
    ) || null;
  }

  return null;
}
