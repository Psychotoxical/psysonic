import { useAuthStore } from '@/store/authStore';
import type { ServerProfile } from '@/store/authStoreTypes';
import { serverIndexKeyForProfile, serverIndexKeyFromUrl } from '@/lib/server/serverIndexKey';

export function findServerByIdOrIndexKey(serverIdOrKey: string): ServerProfile | undefined {
  const servers = useAuthStore.getState().servers;
  const direct = servers.find(s => s.id === serverIdOrKey);
  if (direct) return direct;
  return servers.find(s => serverIndexKeyForProfile(s) === serverIdOrKey);
}

export function resolveServerIdForIndexKey(serverIdOrKey: string): string {
  const { servers, activeServerId } = useAuthStore.getState();
  const direct = servers.find(s => s.id === serverIdOrKey);
  if (direct) return direct.id;
  const active = servers.find(
    s => s.id === activeServerId && serverIndexKeyFromUrl(s.url) === serverIdOrKey,
  );
  if (active) return active.id;
  const fallback = servers.find(s => serverIndexKeyFromUrl(s.url) === serverIdOrKey);
  return fallback?.id ?? serverIdOrKey;
}
