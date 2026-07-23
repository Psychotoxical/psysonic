import { useSyncExternalStore } from 'react';
import {
  setActiveServerReachable,
  setConnectionStatus,
} from './activeServerReachability';

export type ServerReachability = 'available' | 'unavailable' | 'unknown';
export type SharedServerConnectionStatus = 'online' | 'offline' | 'unknown';

const reachabilityByServer = new Map<string, ServerReachability>();
const listeners = new Set<() => void>();
let unavailableServerIds: ReadonlySet<string> = new Set();
let reachabilitySnapshot: ReadonlyMap<string, ServerReachability> = new Map();
const disabledReachabilitySnapshot: ReadonlyMap<string, ServerReachability> = new Map();

function publish(): void {
  reachabilitySnapshot = new Map(reachabilityByServer);
  const nextUnavailableServerIds = new Set(
    [...reachabilityByServer.entries()]
      .filter(([, reachability]) => reachability === 'unavailable')
      .map(([serverId]) => serverId),
  );
  if (
    nextUnavailableServerIds.size !== unavailableServerIds.size
    || [...nextUnavailableServerIds].some(serverId => !unavailableServerIds.has(serverId))
  ) {
    unavailableServerIds = nextUnavailableServerIds;
  }
  listeners.forEach(listener => listener());
}

export function setServerReachability(serverId: string, reachability: ServerReachability): void {
  const current = reachabilityByServer.get(serverId) ?? 'unknown';
  if (current === reachability) return;
  if (reachability === 'unknown') reachabilityByServer.delete(serverId);
  else reachabilityByServer.set(serverId, reachability);
  publish();
}

/** Publish profile reachability and optionally align the active-server status channel. */
export function publishServerConnectionStatus(
  serverId: string,
  status: SharedServerConnectionStatus,
  isActive = false,
): void {
  setServerReachability(
    serverId,
    status === 'online' ? 'available' : status === 'offline' ? 'unavailable' : 'unknown',
  );
  if (!isActive) return;
  const reachable = status === 'unknown' ? null : status === 'online';
  setActiveServerReachable(reachable);
  setConnectionStatus(
    status === 'unknown' ? 'checking' : status === 'online' ? 'connected' : 'disconnected',
  );
}

export function getServerReachabilitySnapshot(): ReadonlyMap<string, ServerReachability> {
  return reachabilitySnapshot;
}

export function getUnavailableServerIds(): ReadonlySet<string> {
  return unavailableServerIds;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function subscribeDisabled(): () => void {
  return () => {};
}

function getDisabledReachabilitySnapshot(): ReadonlyMap<string, ServerReachability> {
  return disabledReachabilitySnapshot;
}

export function useUnavailableServerIds(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, getUnavailableServerIds, getUnavailableServerIds);
}

export function useServerReachabilitySnapshot(
  enabled = true,
): ReadonlyMap<string, ServerReachability> {
  return useSyncExternalStore(
    enabled ? subscribe : subscribeDisabled,
    enabled ? getServerReachabilitySnapshot : getDisabledReachabilitySnapshot,
    enabled ? getServerReachabilitySnapshot : getDisabledReachabilitySnapshot,
  );
}

export function resetServerReachabilitySnapshot(): void {
  if (reachabilityByServer.size === 0) return;
  reachabilityByServer.clear();
  publish();
}
