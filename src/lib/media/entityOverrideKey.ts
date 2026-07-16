export function entityOverrideKey(serverId: string | null | undefined, entityId: string): string {
  return `${serverId ?? ''}\x1f${entityId}`;
}

export function readEntityOverride<T>(
  overrides: Record<string, T>,
  serverId: string | null | undefined,
  entityId: string,
): T | undefined {
  return overrides[entityOverrideKey(serverId, entityId)];
}

export function hasEntityOverride<T>(
  overrides: Record<string, T>,
  serverId: string | null | undefined,
  entityId: string,
): boolean {
  return entityOverrideKey(serverId, entityId) in overrides;
}
