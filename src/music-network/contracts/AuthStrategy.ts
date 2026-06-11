// Music Network — AuthStrategy contract.
//
// Connect flows vary by provider family:
//  - token_poll   : open browser, poll for a session key (Last.fm / GNU FM)
//  - callback     : open browser, receive a callback token (some Libre.fm setups)
//  - api_key_only : no browser; user pastes a token/key (ListenBrainz, Maloja)
//
// A wire delegates its connect() to one of these so the flow logic is shared and
// not duplicated per preset.

import type { ConnectContext, ConnectResult } from './ScrobbleWire';

export interface AuthStrategy {
  readonly id: 'token_poll' | 'callback' | 'api_key_only';
  connect(ctx: ConnectContext): Promise<ConnectResult>;
}
