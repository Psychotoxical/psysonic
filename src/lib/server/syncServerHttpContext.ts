import { commands } from '@/generated/bindings';
import type { ServerProfile } from '@/store/authStoreTypes';
import { serverHttpContextWireForProfile } from '@/lib/server/serverHttpHeaders';
import { serverIndexKeyForProfile } from '@/lib/server/serverIndexKey';

export async function syncServerHttpContextForProfile(server: ServerProfile): Promise<void> {
  const wire = serverHttpContextWireForProfile(server);
  const res = await commands.serverHttpContextSync(wire);
  if (res.status === 'error') throw new Error(res.error);
}

export async function syncAllServerHttpContexts(servers: ServerProfile[]): Promise<void> {
  if (servers.length === 0) return;
  const res = await commands.serverHttpContextSyncAll(servers.map(s => serverHttpContextWireForProfile(s)));
  if (res.status === 'error') throw new Error(res.error);
}

export async function clearServerHttpContext(server: Pick<ServerProfile, 'id' | 'url'>): Promise<void> {
  const indexKey = serverIndexKeyForProfile(server);
  const res = await commands.serverHttpContextClear(indexKey, server.id);
  if (res.status === 'error') throw new Error(res.error);
}
