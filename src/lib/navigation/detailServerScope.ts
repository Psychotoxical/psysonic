import { useAuthStore } from '@/store/authStore';

/** Resolve `?server=` on album/artist detail routes; falls back when absent or unknown. */
export function readDetailServerId(
  searchParams: URLSearchParams,
  fallback: string | null | undefined,
): string | null {
  const raw = searchParams.get('server');
  if (!raw) return fallback ?? null;
  const servers = useAuthStore.getState().servers;
  if (servers.some(s => s.id === raw)) return raw;
  return fallback ?? null;
}

/** Append or merge `server=` into an existing album/artist link query string. */
export function appendServerQuery(
  base: string | undefined,
  serverId: string | undefined,
): string | undefined {
  if (!serverId) return base;
  const serverPart = `server=${encodeURIComponent(serverId)}`;
  if (!base) return serverPart;
  const normalized = base.startsWith('?') ? base.slice(1) : base;
  return `${normalized}&${serverPart}`;
}
