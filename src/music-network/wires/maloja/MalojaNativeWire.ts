// Maloja native wire — scrobble only.
//
// Posts to /apis/mlj_1/newscrobble with the flat JSON body documented by Maloja
// (artists[], title, album, length, time; key carried in the body). Maloja has
// no now-playing endpoint, so updateNowPlaying is a safe no-op and the nowPlaying
// capability is reported as `no`. Auth is the pasted Maloja API key.

import { type CapabilitySet, markNoEnrichment } from '../../core/capabilities';
import type { ScrobbleEvent, WireId } from '../../core/types';
import type {
  ConnectContext,
  ConnectResult,
  ScrobbleWire,
  WireContext,
} from '../../contracts/ScrobbleWire';
import { apiKeyOnlyStrategy } from '../shared/apiKeyOnly';
import { malojaCall } from './client';

class MalojaNativeWireImpl implements ScrobbleWire {
  readonly wireId: WireId = 'maloja_native';
  readonly supportsEnrichment = false;

  connect(ctx: ConnectContext): Promise<ConnectResult> {
    return apiKeyOnlyStrategy.connect(ctx);
  }

  disconnect(): void {
    // API key is store-side; nothing to revoke remotely.
  }

  async scrobble(ctx: WireContext, event: ScrobbleEvent): Promise<void> {
    const body: Record<string, unknown> = {
      key: ctx.sessionKey,
      artists: [event.artist],
      title: event.title,
      time: Math.floor(event.timestamp / 1000),
    };
    if (event.album) body.album = event.album;
    if (event.duration) body.length = Math.round(event.duration);
    await malojaCall({ baseUrl: ctx.baseUrl }, '/apis/mlj_1/newscrobble', body);
  }

  async updateNowPlaying(): Promise<void> {
    // Maloja has no now-playing endpoint — intentional no-op.
  }

  async probe(): Promise<CapabilitySet> {
    // Maloja exposes no token-validation endpoint; trust the key and surface
    // errors on the first scrobble. Scrobble is static-yes, everything else no.
    const caps: CapabilitySet = {
      scrobble: { status: 'yes' },
      nowPlaying: { status: 'no' },
    };
    return markNoEnrichment(caps);
  }
}

export const malojaNativeWire: ScrobbleWire = new MalojaNativeWireImpl();
