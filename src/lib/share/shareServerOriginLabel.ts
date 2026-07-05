import type { ServerProfile } from '@/store/authStoreTypes';
import { serverListDisplayLabel } from '@/lib/server/serverDisplayName';
import { serverIndexKeyFromUrl } from '@/lib/server/serverIndexKey';
import { findServerIdForShareUrl } from '@/lib/share/shareLink';
import type { ShareSearchMatch } from '@/lib/share/shareSearch';

/**
 * Display name for the share link's origin server when it differs from the
 * active server. Returns null when the link targets the active server, is
 * unsupported, or does not match any saved server profile.
 */
export function shareServerOriginLabel(
  shareMatch: ShareSearchMatch | null,
  servers: ServerProfile[],
  activeServerId: string | null,
): string | null {
  if (!shareMatch || shareMatch.type === 'unsupported') return null;

  const shareServerId = findServerIdForShareUrl(servers, shareMatch.payload.srv);
  if (!shareServerId || shareServerId === activeServerId) return null;

  const server = servers.find(s => s.id === shareServerId)
    ?? servers.find(s => serverIndexKeyFromUrl(s.url) === shareServerId);
  if (!server) return null;

  return serverListDisplayLabel(server, servers);
}

/** Server label and profile for queue preview when the link targets another saved server. */
export function shareQueueServerContext(
  shareSrv: string,
  servers: ServerProfile[],
  activeServerId: string | null,
): { label: string | null; coverServer: ServerProfile | null } {
  const match: ShareSearchMatch = {
    type: 'queueable',
    payload: { srv: shareSrv, k: 'queue', ids: [] },
  };
  const label = shareServerOriginLabel(match, servers, activeServerId);
  const serverId = findServerIdForShareUrl(servers, shareSrv);
  const coverServer =
    serverId && serverId !== activeServerId
      ? servers.find(s => s.id === serverId)
        ?? servers.find(s => serverIndexKeyFromUrl(s.url) === serverId)
        ?? null
      : null;
  return { label, coverServer };
}
