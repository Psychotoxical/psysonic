// Resolves a persisted account (+ its preset) into the WireContext a wire needs.
// Endpoints fall back to the preset manifest for fixed-host presets; bundled
// credentials are already copied onto the account at connect time.

import type { PersistedAccount } from '../core/accounts';
import type { WireContext } from '../contracts/ScrobbleWire';
import { getPreset } from '../registry/presetRegistry';

export function resolveWireContext(account: PersistedAccount): WireContext {
  const endpoints = getPreset(account.presetId)?.manifest.endpoints;
  return {
    account,
    baseUrl: account.baseUrl || endpoints?.apiBase || '',
    profileBase: endpoints?.profileBase ?? '',
    apiKey: account.apiKey,
    apiSecret: account.apiSecret,
    sessionKey: account.sessionKey,
    username: account.username,
  };
}
