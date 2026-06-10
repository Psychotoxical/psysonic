// Music Network — ScrobbleWire contract.
//
// A wire is a transport + protocol adapter. Every provider that can receive
// plays implements ScrobbleWire. Enrichment-capable wires additionally implement
// EnrichmentWire. The registry maps an account to its wire; the orchestrator and
// enrichment router only ever talk to these interfaces — never to a concrete
// provider.

import type { CapabilitySet } from '../core/capabilities';
import type { PersistedAccount } from '../core/accounts';
import type { ScrobbleEvent, WireId } from '../core/types';

/**
 * Per-call context resolved from a connected account. Wires read endpoints and
 * credentials from here; they never reach into the auth store directly.
 */
export interface WireContext {
  account: PersistedAccount;
  /** Resolved API base URL (preset endpoint or user-supplied origin). */
  baseUrl: string;
  /** Resolved profile base URL, for synchronous URL builders. '' when none. */
  profileBase: string;
  apiKey: string;
  apiSecret: string;
  sessionKey: string;
  username: string;
}

/** Context for an initial connect attempt (before a session exists). */
export interface ConnectContext {
  presetId: PersistedAccount['presetId'];
  wireId: WireId;
  /** Resolved API base URL. */
  baseUrl: string;
  /** Resolved browser-auth base URL (token-poll/callback flows). '' when none. */
  authBase: string;
  apiKey: string;
  apiSecret: string;
  /** User-pasted token (ListenBrainz) or extra fields, by field name. */
  fields: Record<string, string>;
  /** Opens an external URL (Tauri shell). Used by token-poll/callback flows. */
  openExternal: (url: string) => Promise<void>;
  /** Resolves when the user cancels the connect dialog. */
  signal?: AbortSignal;
}

/** Result of a successful connect. Persisted into the account record. */
export interface ConnectResult {
  sessionKey: string;
  username: string;
  /** Optional resolved base URL override (e.g. normalized trailing slash). */
  baseUrl?: string;
  /** Optional initial capabilities if the connect flow already probed. */
  capabilities?: CapabilitySet;
}

export interface ScrobbleWire {
  readonly wireId: WireId;
  readonly supportsEnrichment: boolean;

  connect(ctx: ConnectContext): Promise<ConnectResult>;
  disconnect(ctx: WireContext): void;

  scrobble(ctx: WireContext, event: ScrobbleEvent): Promise<void>;
  updateNowPlaying(ctx: WireContext, event: ScrobbleEvent): Promise<void>;

  probe(ctx: WireContext): Promise<CapabilitySet>;
}
