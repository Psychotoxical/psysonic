import { useAuthStore } from '@/store/authStore';
import { serverShareBaseUrl } from '@/lib/server/serverEndpoint';
import { encodeSharePayload, type EntityShareKind } from '@/lib/share/shareLink';
import { copyTextToClipboard } from '@/lib/server/serverMagicString';
import { findServerByIdOrIndexKey } from '@/lib/server/serverLookup';

/** Copies a track / album / artist / composer share link (`psysonic2-`) to the clipboard. */
export async function copyEntityShareLink(
  kind: EntityShareKind,
  id: string,
  representativeServerId?: string,
): Promise<boolean> {
  const server = representativeServerId
    ? findServerByIdOrIndexKey(representativeServerId)
    : useAuthStore.getState().getActiveServer();
  if (!server || !id.trim()) return false;
  // Share URL ≠ connect URL — a guest opening this link is not on our LAN, so
  // a dual-address profile defaults to the public address (overridable via
  // shareUsesLocalUrl when the user explicitly shares into a LAN group).
  const srv = serverShareBaseUrl(server);
  if (!srv) return false;
  return copyTextToClipboard(encodeSharePayload({ srv, k: kind, id: id.trim() }));
}
