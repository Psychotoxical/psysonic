import { describe, expect, it } from 'vitest';

// Boot-registration guard (residual-risk #3 + boot-order QA from the PR #1225 review).
//
// The three core↔feature seams each start at a safe *neutral default* and are
// switched to the real implementation as a MODULE-LOAD side effect — not a render
// step. Importing the real app entry module runs exactly that wiring:
//   - MainApp side-effect-imports `playbackEngineBridgeRegister`         → playback bridge
//   - MainApp imports the `@/features/offline` barrel (`export *`)        → media resolver
//   - MainApp imports AppShell, which imports the `@/features/orbit` barrel → orbit runtime
//
// So this single import exercises the wiring the seams rely on. If anyone later
// drops one of those imports, the corresponding seam stays at its neutral default
// and the matching assertion below fails — catching the regression at CI instead
// of at runtime (a broken seam is silent until the offline / orbit / server-delete
// path is hit). Registration is import-time, so mounting the (heavy) component tree
// would add flakiness without covering anything the import does not.
import '@/app/MainApp';

import { isMediaResolverRegistered } from '@/store/mediaResolver';
import { isOrbitRuntimeRegistered } from '@/store/orbitRuntime';
import { isPlaybackEngineBridgeRegistered } from '@/store/playbackEngineBridge';

describe('seam registration boot smoke', () => {
  it('registers the offline-aware media resolver (not the network-only default)', () => {
    expect(isMediaResolverRegistered()).toBe(true);
  });

  it('registers the orbit runtime (not the neutral no-session snapshot default)', () => {
    expect(isOrbitRuntimeRegistered()).toBe(true);
  });

  it('registers the playback-engine bridge (not the no-op / null default)', () => {
    expect(isPlaybackEngineBridgeRegistered()).toBe(true);
  });
});
