import { useAuthStore } from '@/store/authStore';
import type { ServerProfile } from '@/store/authStoreTypes';
import { serverIndexOwnerForKey } from '@/lib/server/serverIndexKey';

export function findServerByIdOrIndexKey(serverIdOrKey: string): ServerProfile | undefined {
  const state = useAuthStore.getState();
  const servers = state.servers;
  const direct = servers.find(s => s.id === serverIdOrKey);
  if (direct) return direct;
  return serverIndexOwnerForKey(state, serverIdOrKey);
}

export function resolveServerIdForIndexKey(serverIdOrKey: string): string {
  const state = useAuthStore.getState();
  const { servers } = state;
  const direct = servers.find(s => s.id === serverIdOrKey);
  if (direct) return direct.id;
  return serverIndexOwnerForKey(state, serverIdOrKey)?.id ?? serverIdOrKey;
}
