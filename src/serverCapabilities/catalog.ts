import type { CapabilityDefinition } from './types';

/**
 * Declarative map of server-side features, the strategies that can provide them
 * per server generation, how to detect each, and which endpoint to route to.
 *
 * To add a feature with a new server path:
 *   1. (optional) register a probe in `probes.ts` and map it in the orchestrator
 *      (`api/subsonic.ts`) + read facade (`storeView.ts`).
 *   2. add a `CapabilityDefinition` here with one strategy per server generation.
 *   3. consumers read it via `storeView` (UI) and the call router (runtime).
 * No version `if` checks belong in UI or call sites — they live here.
 */

export const SONIC_SIMILARITY_EXTENSION = 'sonicSimilarity';
export const PLAYBACK_REPORT_EXTENSION = 'playbackReport';

export const FEATURE_AUDIOMUSE_SIMILAR_TRACKS = 'audiomuse.similarTracks';
export const FEATURE_PLAYBACK_REPORT = 'opensubsonic.playbackReport';

export const PROBE_OPENSUBSONIC_EXTENSIONS = 'opensubsonic.extensions';
export const PROBE_LEGACY_INSTANT_MIX = 'navidrome.instantMix.legacy';

/** Operation names used by the call router. */
export const OP_SIMILAR_TRACKS = 'similarTracks';
export const OP_REPORT_PLAYBACK = 'reportPlayback';

export const SERVER_CAPABILITY_CATALOG: CapabilityDefinition[] = [
  {
    feature: FEATURE_AUDIOMUSE_SIMILAR_TRACKS,
    labelKey: 'settings.audiomuseTitle',
    badgeLabelKey: 'settings.audiomuseBadge',
    strategies: [
      {
        // Navidrome ≥ 0.62: AudioMuse plugin advertised via OpenSubsonic.
        id: 'opensubsonic.sonicSimilarity',
        priority: 100,
        when: (ctx) => ctx.isNavidrome && ctx.semverGte([0, 62, 0]),
        detection: {
          kind: 'extension',
          probeId: PROBE_OPENSUBSONIC_EXTENSIONS,
          extension: SONIC_SIMILARITY_EXTENSION,
        },
        trust: 'high',
        activation: 'auto',
        calls: {
          [OP_SIMILAR_TRACKS]: { endpoint: 'getSonicSimilarTracks.view', transport: 'opensubsonic' },
        },
        labelKey: 'settings.audiomuseStrategySonic',
      },
      {
        // Navidrome ≥ 0.60: legacy Instant Mix via getSimilarSongs (agents/plugin).
        id: 'subsonic.getSimilarSongs',
        priority: 50,
        when: (ctx) => ctx.isNavidrome && ctx.semverGte([0, 60, 0]),
        detection: {
          kind: 'functional',
          probeId: PROBE_LEGACY_INSTANT_MIX,
          presentWhen: (outcome) => outcome.status === 'present',
        },
        trust: 'low',
        activation: 'manual',
        alwaysCallable: true,
        calls: {
          [OP_SIMILAR_TRACKS]: { endpoint: 'getSimilarSongs.view', transport: 'subsonic' },
        },
        labelKey: 'settings.audiomuseStrategyLegacy',
      },
    ],
  },
  {
    // OpenSubsonic `playbackReport` (Navidrome ≥ 0.62): rich live now-playing via
    // a small playback FSM. Auto-on wherever the server advertises the extension;
    // call sites fall back to legacy `scrobble.view?submission=false` presence when
    // it is absent. Detection is server-agnostic (any OpenSubsonic server may add it).
    feature: FEATURE_PLAYBACK_REPORT,
    labelKey: 'nowPlaying.title',
    strategies: [
      {
        id: 'opensubsonic.playbackReport',
        priority: 100,
        when: (ctx) => ctx.openSubsonic,
        detection: {
          kind: 'extension',
          probeId: PROBE_OPENSUBSONIC_EXTENSIONS,
          extension: PLAYBACK_REPORT_EXTENSION,
        },
        trust: 'high',
        activation: 'auto',
        calls: {
          [OP_REPORT_PLAYBACK]: { endpoint: 'reportPlayback.view', transport: 'opensubsonic' },
        },
        labelKey: 'nowPlaying.title',
      },
    ],
  },
];

export function getCapabilityDefinition(feature: string): CapabilityDefinition | undefined {
  return SERVER_CAPABILITY_CATALOG.find((d) => d.feature === feature);
}
