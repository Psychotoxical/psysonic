import { findServerByIdOrIndexKey } from '@/lib/server/serverLookup';
import { COVER_SCOPE_ACTIVE, type CoverServerScope } from './types';

/** Explicit server bucket for cover disk/IDB — use when entity carries `serverId` (e.g. cross-server favorites). */
export function coverServerScopeForServerId(
  serverId: string | null | undefined,
): CoverServerScope {
  if (!serverId?.trim()) return COVER_SCOPE_ACTIVE;
  const server = findServerByIdOrIndexKey(serverId);
  if (!server) return COVER_SCOPE_ACTIVE;
  return {
    kind: 'server',
    serverId: server.id,
    url: server.url,
    username: server.username,
    password: server.password,
  };
}
