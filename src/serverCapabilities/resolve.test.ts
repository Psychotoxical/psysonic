import { describe, expect, it } from 'vitest';
import { buildCapabilityContext } from './context';
import {
  FEATURE_AUDIOMUSE_SIMILAR_TRACKS,
  FEATURE_PLAYBACK_REPORT,
  OP_SIMILAR_TRACKS,
  PLAYBACK_REPORT_EXTENSION,
  PROBE_LEGACY_INSTANT_MIX,
  PROBE_OPENSUBSONIC_EXTENSIONS,
  SERVER_CAPABILITY_CATALOG,
  SONIC_SIMILARITY_EXTENSION,
  getCapabilityDefinition,
} from './catalog';
import {
  isCapabilityActive,
  neededProbeIds,
  pickStrategy,
  resolveCallChain,
  resolveCapability,
} from './resolve';
import type { ProbeOutcome } from './types';

const def = getCapabilityDefinition(FEATURE_AUDIOMUSE_SIMILAR_TRACKS)!;

function ctxFor(version: string | undefined, type = 'navidrome') {
  return buildCapabilityContext(version === undefined && type === ''
    ? undefined
    : { type, serverVersion: version, openSubsonic: true });
}

const extPresent: ProbeOutcome = { status: 'present', extensions: [SONIC_SIMILARITY_EXTENSION] };
const extAbsent: ProbeOutcome = { status: 'present', extensions: [] };

describe('pickStrategy', () => {
  it('chooses sonicSimilarity on Navidrome ≥ 0.62', () => {
    expect(pickStrategy(def, ctxFor('0.62.0'))?.id).toBe('opensubsonic.sonicSimilarity');
  });
  it('chooses legacy getSimilarSongs on Navidrome 0.61', () => {
    expect(pickStrategy(def, ctxFor('0.61.0'))?.id).toBe('subsonic.getSimilarSongs');
  });
  it('is ineligible on non-Navidrome', () => {
    expect(pickStrategy(def, ctxFor('1.0.0', 'gonic'))).toBeNull();
  });
  it('is ineligible on Navidrome older than 0.60', () => {
    expect(pickStrategy(def, ctxFor('0.59.9'))).toBeNull();
  });
});

describe('neededProbeIds', () => {
  it('asks for the extensions probe on 0.62+', () => {
    const ids = neededProbeIds(SERVER_CAPABILITY_CATALOG, ctxFor('0.62.0'));
    expect(ids.has(PROBE_OPENSUBSONIC_EXTENSIONS)).toBe(true);
    expect(ids.has(PROBE_LEGACY_INSTANT_MIX)).toBe(false);
  });
  it('asks for the legacy probe on 0.61, plus the extensions probe for playbackReport', () => {
    const ids = neededProbeIds(SERVER_CAPABILITY_CATALOG, ctxFor('0.61.0'));
    expect(ids.has(PROBE_LEGACY_INSTANT_MIX)).toBe(true);
    // playbackReport detection is OpenSubsonic-generic, so the extensions probe
    // is now needed on any OpenSubsonic server (the fetch is shared).
    expect(ids.has(PROBE_OPENSUBSONIC_EXTENSIONS)).toBe(true);
  });
});

describe('playbackReport capability', () => {
  const pbDef = getCapabilityDefinition(FEATURE_PLAYBACK_REPORT)!;
  const withExt: ProbeOutcome = { status: 'present', extensions: [PLAYBACK_REPORT_EXTENSION] };
  const withoutExt: ProbeOutcome = { status: 'present', extensions: [SONIC_SIMILARITY_EXTENSION] };

  it('is auto-active on any OpenSubsonic server that advertises the extension', () => {
    const r = resolveCapability(pbDef, ctxFor('0.62.0'), { [PROBE_OPENSUBSONIC_EXTENSIONS]: withExt });
    expect(r).toMatchObject({ status: 'present', activation: 'auto', trust: 'high' });
    expect(isCapabilityActive(r, false)).toBe(true);
  });

  it('detects on non-Navidrome OpenSubsonic servers too', () => {
    const r = resolveCapability(pbDef, ctxFor('1.16.1', 'gonic'), { [PROBE_OPENSUBSONIC_EXTENSIONS]: withExt });
    expect(r.status).toBe('present');
  });

  it('is absent when the extension is not advertised', () => {
    const r = resolveCapability(pbDef, ctxFor('0.62.0'), { [PROBE_OPENSUBSONIC_EXTENSIONS]: withoutExt });
    expect(r.status).toBe('absent');
    expect(isCapabilityActive(r, true)).toBe(false);
  });

  it('is ineligible on non-OpenSubsonic servers', () => {
    const r = resolveCapability(pbDef, buildCapabilityContext({ type: 'subsonic', serverVersion: '1.16.1', openSubsonic: false }), {});
    expect(r.status).toBe('ineligible');
  });
});

describe('resolveCapability', () => {
  it('present when sonicSimilarity extension is advertised', () => {
    const r = resolveCapability(def, ctxFor('0.62.0'), { [PROBE_OPENSUBSONIC_EXTENSIONS]: extPresent });
    expect(r).toMatchObject({ strategyId: 'opensubsonic.sonicSimilarity', status: 'present', trust: 'high', activation: 'auto' });
  });
  it('absent when extensions list lacks sonicSimilarity', () => {
    const r = resolveCapability(def, ctxFor('0.62.0'), { [PROBE_OPENSUBSONIC_EXTENSIONS]: extAbsent });
    expect(r.status).toBe('absent');
  });
  it('error propagates from probe', () => {
    const r = resolveCapability(def, ctxFor('0.62.0'), { [PROBE_OPENSUBSONIC_EXTENSIONS]: { status: 'error' } });
    expect(r.status).toBe('error');
  });
  it('unknown when not yet probed', () => {
    expect(resolveCapability(def, ctxFor('0.62.0'), {}).status).toBe('unknown');
  });
  it('legacy present when functional probe ok', () => {
    const r = resolveCapability(def, ctxFor('0.61.0'), { [PROBE_LEGACY_INSTANT_MIX]: { status: 'present' } });
    expect(r).toMatchObject({ strategyId: 'subsonic.getSimilarSongs', status: 'present', trust: 'low', activation: 'manual' });
  });
  it('ineligible on non-Navidrome', () => {
    expect(resolveCapability(def, ctxFor('1.0.0', 'gonic'), {}).status).toBe('ineligible');
  });
});

describe('isCapabilityActive', () => {
  it('auto feature on iff detected present', () => {
    const present = resolveCapability(def, ctxFor('0.62.0'), { [PROBE_OPENSUBSONIC_EXTENSIONS]: extPresent });
    const absent = resolveCapability(def, ctxFor('0.62.0'), { [PROBE_OPENSUBSONIC_EXTENSIONS]: extAbsent });
    expect(isCapabilityActive(present, false)).toBe(true);
    expect(isCapabilityActive(absent, true)).toBe(false);
  });
  it('manual feature follows opt-in unless proven absent', () => {
    const ok = resolveCapability(def, ctxFor('0.61.0'), { [PROBE_LEGACY_INSTANT_MIX]: { status: 'present' } });
    const empty = resolveCapability(def, ctxFor('0.61.0'), { [PROBE_LEGACY_INSTANT_MIX]: { status: 'absent' } });
    expect(isCapabilityActive(ok, true)).toBe(true);
    expect(isCapabilityActive(ok, false)).toBe(false);
    expect(isCapabilityActive(empty, true)).toBe(false);
  });
});

describe('resolveCallChain (prefer sonic, fallback legacy)', () => {
  it('0.62 with plugin → sonic then legacy', () => {
    const chain = resolveCallChain(def, ctxFor('0.62.0'), { [PROBE_OPENSUBSONIC_EXTENSIONS]: extPresent }, OP_SIMILAR_TRACKS);
    expect(chain.map(r => r.endpoint)).toEqual(['getSonicSimilarTracks.view', 'getSimilarSongs.view']);
  });
  it('0.62 without plugin → legacy only', () => {
    const chain = resolveCallChain(def, ctxFor('0.62.0'), { [PROBE_OPENSUBSONIC_EXTENSIONS]: extAbsent }, OP_SIMILAR_TRACKS);
    expect(chain.map(r => r.endpoint)).toEqual(['getSimilarSongs.view']);
  });
  it('0.61 → legacy only', () => {
    const chain = resolveCallChain(def, ctxFor('0.61.0'), {}, OP_SIMILAR_TRACKS);
    expect(chain.map(r => r.endpoint)).toEqual(['getSimilarSongs.view']);
  });
  it('non-Navidrome → empty', () => {
    expect(resolveCallChain(def, ctxFor('1.0.0', 'gonic'), {}, OP_SIMILAR_TRACKS)).toEqual([]);
  });
});
