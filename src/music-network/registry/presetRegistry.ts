// Preset registry — the built-in provider catalogue.
//
// Data only: each entry is a manifest (+ bundled credentials where applicable).
// The Integrations UI is driven entirely off this list; the orchestrator never
// branches on a preset id. Adding a provider = add its preset file here.

import type { PresetId } from '../core/types';
import type { BuiltinPreset } from './presetTypes';

import { lastfmPreset } from '../wires/audioscrobbler/presets/lastfm';
import { librefmPreset } from '../wires/audioscrobbler/presets/librefm';
import { rockskyPreset } from '../wires/audioscrobbler/presets/rocksky';
import { customGnufmPreset } from '../wires/audioscrobbler/presets/customGnufm';
import { malojaCompatPreset } from '../wires/audioscrobbler/presets/malojaCompat';
import { listenbrainzPreset } from '../wires/listenbrainz/presets/listenbrainz';
import { malojaListenbrainzPreset } from '../wires/listenbrainz/presets/malojaListenbrainz';
import { malojaNativePreset } from '../wires/maloja/presets/malojaNative';
import { koitoPreset } from '../wires/listenbrainz/presets/koito';

const PRESETS: readonly BuiltinPreset[] = [
  lastfmPreset,
  librefmPreset,
  rockskyPreset,
  customGnufmPreset,
  listenbrainzPreset,
  malojaNativePreset,
  malojaCompatPreset,
  malojaListenbrainzPreset,
  koitoPreset,
];

const byId = new Map<PresetId, BuiltinPreset>(
  PRESETS.map(p => [p.manifest.presetId, p]),
);

export function listPresets(): readonly BuiltinPreset[] {
  return PRESETS;
}

export function getPreset(id: PresetId): BuiltinPreset | undefined {
  return byId.get(id);
}

export function requirePreset(id: PresetId): BuiltinPreset {
  const p = byId.get(id);
  if (!p) throw new Error(`Unknown preset "${id}"`);
  return p;
}
