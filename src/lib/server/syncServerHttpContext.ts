import { commands } from '@/generated/bindings';
import type { ServerProfile } from '@/store/authStoreTypes';
import { serverHttpContextWireForProfile } from '@/lib/server/serverHttpHeaders';
import { serverIndexKeyForProfile } from '@/lib/server/serverBaseUrl';
import type { SubsonicServerIdentity } from '@/lib/server/subsonicServerIdentity';

type ServerIdentityById = Record<string, SubsonicServerIdentity>;

let identitySource: () => ServerIdentityById = () => ({});

/** Store-to-lib injection keeps this module free of a runtime auth-store import. */
export function setServerHttpContextIdentitySource(source: () => ServerIdentityById): void {
  identitySource = source;
}

export async function syncServerHttpContextForProfile(
  server: ServerProfile,
  identity = identitySource()[server.id],
): Promise<void> {
  const wire = serverHttpContextWireForProfile(server, identity);
  const res = await commands.serverHttpContextSync(wire);
  if (res.status === 'error') throw new Error(res.error);
}

export async function syncAllServerHttpContexts(
  servers: ServerProfile[],
  identities = identitySource(),
): Promise<void> {
  if (servers.length === 0) return;
  const res = await commands.serverHttpContextSyncAll(
    servers.map(server => serverHttpContextWireForProfile(server, identities[server.id])),
  );
  if (res.status === 'error') throw new Error(res.error);
}

export async function clearServerHttpContext(server: Pick<ServerProfile, 'id' | 'url'>): Promise<void> {
  const indexKey = serverIndexKeyForProfile(server);
  const res = await commands.serverHttpContextClear(indexKey, server.id);
  if (res.status === 'error') throw new Error(res.error);
}
