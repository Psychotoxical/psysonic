// ListenBrainz wire — scrobble + now playing only (no enrichment in v1).
//
// One implementation backs two presets: the direct api.listenbrainz.org host
// and the Maloja /apis/listenbrainz compat surface; they differ only by
// baseUrl. Auth is a pasted user token (api_key_only). Read/stats APIs are out
// of scope for v1 (spec §2.3), so this is a plain ScrobbleWire.

import { type CapabilitySet, markNoEnrichment } from '../../core/capabilities';
import type { ScrobbleEvent, WireId } from '../../core/types';
import type {
  ConnectContext,
  ConnectResult,
  ScrobbleWire,
  WireContext,
} from '../../contracts/ScrobbleWire';
import { apiKeyOnlyStrategy } from '../shared/apiKeyOnly';
import { listenBrainzCall } from './client';

function trackMetadata(event: ScrobbleEvent) {
  const md: Record<string, unknown> = {
    artist_name: event.artist,
    track_name: event.title,
  };
  if (event.album) md.release_name = event.album;
  if (event.duration) {
    md.additional_info = { duration_ms: Math.round(event.duration * 1000) };
  }
  return md;
}

function endpoint(ctx: WireContext) {
  return { baseUrl: ctx.baseUrl, authToken: ctx.sessionKey };
}

class ListenBrainzWireImpl implements ScrobbleWire {
  readonly wireId: WireId = 'listenbrainz';
  readonly supportsEnrichment = false;

  connect(ctx: ConnectContext): Promise<ConnectResult> {
    return apiKeyOnlyStrategy.connect(ctx);
  }

  disconnect(): void {
    // Token is store-side; nothing to revoke remotely.
  }

  async scrobble(ctx: WireContext, event: ScrobbleEvent): Promise<void> {
    await listenBrainzCall(endpoint(ctx), '/1/submit-listens', {
      listen_type: 'single',
      payload: [{
        listened_at: Math.floor(event.timestamp / 1000),
        track_metadata: trackMetadata(event),
      }],
    });
  }

  async updateNowPlaying(ctx: WireContext, event: ScrobbleEvent): Promise<void> {
    await listenBrainzCall(endpoint(ctx), '/1/submit-listens', {
      listen_type: 'playing_now',
      payload: [{ track_metadata: trackMetadata(event) }],
    });
  }

  async probe(ctx: WireContext): Promise<CapabilitySet> {
    const caps: CapabilitySet = {};
    try {
      const data = await listenBrainzCall(endpoint(ctx), '/1/validate-token');
      const valid = (data as { valid?: boolean })?.valid === true;
      caps.scrobble = { status: valid ? 'yes' : 'error', message: valid ? undefined : 'Token invalid' };
      caps.nowPlaying = { status: valid ? 'yes' : 'error' };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      caps.scrobble = { status: 'error', message };
      caps.nowPlaying = { status: 'error', message };
    }
    return markNoEnrichment(caps);
  }
}

export const listenBrainzWire: ScrobbleWire = new ListenBrainzWireImpl();
