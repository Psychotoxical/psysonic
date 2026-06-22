import { invoke } from '@tauri-apps/api/core';
import type { ServerProfile } from '../../store/authStoreTypes';
import { serverHttpContextWireForProfile } from './serverHttpHeaders';
import { serverIndexKeyForProfile } from './serverIndexKey';

export async function syncServerHttpContextForProfile(server: ServerProfile): Promise<void> {
  const wire = serverHttpContextWireForProfile(server);
  await invoke('server_http_context_sync', { wire });
}

export async function syncAllServerHttpContexts(servers: ServerProfile[]): Promise<void> {
  if (servers.length === 0) return;
  await invoke('server_http_context_sync_all', {
    entries: servers.map(s => serverHttpContextWireForProfile(s)),
  });
}

export async function clearServerHttpContext(server: Pick<ServerProfile, 'id' | 'url'>): Promise<void> {
  const indexKey = serverIndexKeyForProfile(server);
  await invoke('server_http_context_clear', { serverId: indexKey, appServerId: server.id });
}
