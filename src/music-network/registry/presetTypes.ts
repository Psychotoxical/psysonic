// Built-in preset bundle: the declarative manifest plus any app-registered
// (bundled) credentials. Bundled keys live next to their preset — never
// scattered across the codebase — and are consumed only by the registry/runtime
// when materializing an account from a `credentials: 'bundled'` preset.

import type { PresetManifest } from '../contracts/PresetManifest';

export interface BuiltinPreset {
  manifest: PresetManifest;
  /** Present only for `credentials: 'bundled'` presets. */
  bundled?: {
    apiKey: string;
    apiSecret: string;
  };
}
