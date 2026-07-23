import { useAuthStore } from '@/store/authStore';
import { findServerByIdOrIndexKey } from '@/lib/server/serverLookup';
import { connectBaseUrlForServer, normalizeServerBaseUrl } from '@/lib/server/serverEndpoint';
import { isNavidromeServer } from '@/lib/server/subsonicServerIdentity';
import type { StreamMaxBitRateKbps, StreamRequestFormat } from '@/lib/audio/streamQuality';

/**
 * The streaming transcode cap in effect for a server RIGHT NOW: the preference
 * stored for the normalized address the connect layer selected, honoured only
 * when that server's identity probe reports Navidrome (`maxBitRate` transcode
 * behaviour is verified for Navidrome; other servers stream untouched).
 * 0 = Original / no cap.
 */
export function effectiveStreamCapKbps(
  serverIdOrIndexKey: string | null | undefined,
): StreamMaxBitRateKbps {
  if (!serverIdOrIndexKey) return 0;
  const state = useAuthStore.getState();
  // Unresolvable key falls back to the active server, mirroring
  // `buildStreamUrl(ForServer)`'s fallback so cap and URL stay in step.
  const server = findServerByIdOrIndexKey(serverIdOrIndexKey) ?? state.getActiveServer();
  if (!server) return 0;
  if (!isNavidromeServer(state.subsonicServerIdentityByServer[server.id])) return 0;
  const address = normalizeServerBaseUrl(connectBaseUrlForServer(server));
  return state.streamQualityByAddress[address] ?? 0;
}

/** Transcode target format for the active address (same Navidrome gating). */
export function effectiveStreamFormat(
  serverIdOrIndexKey: string | null | undefined,
): StreamRequestFormat {
  if (!serverIdOrIndexKey) return 'auto';
  const state = useAuthStore.getState();
  const server = findServerByIdOrIndexKey(serverIdOrIndexKey) ?? state.getActiveServer();
  if (!server) return 'auto';
  if (!isNavidromeServer(state.subsonicServerIdentityByServer[server.id])) return 'auto';
  const address = normalizeServerBaseUrl(connectBaseUrlForServer(server));
  return state.streamFormatByAddress[address] ?? 'auto';
}

/** Whether the current per-address preferences request ANY transcode. */
export function streamRequestsTranscode(serverIdOrIndexKey: string | null | undefined): boolean {
  return effectiveStreamCapKbps(serverIdOrIndexKey) > 0
    || effectiveStreamFormat(serverIdOrIndexKey) !== 'auto';
}
