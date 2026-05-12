import { beforeEach, describe, expect, it, vi } from 'vitest';

const { orbitState } = vi.hoisted(() => ({
  orbitState: {
    role: null as 'host' | 'guest' | null,
    phase: 'idle' as 'idle' | 'starting' | 'joining' | 'active' | 'ending' | 'ended' | 'error',
  },
}));

vi.mock('./orbitStore', () => ({
  useOrbitStore: { getState: () => orbitState },
}));

import { isInOrbitSession } from './orbitSession';

beforeEach(() => {
  orbitState.role = null;
  orbitState.phase = 'idle';
});

describe('isInOrbitSession', () => {
  it('returns false when role is null', () => {
    expect(isInOrbitSession()).toBe(false);
  });

  it.each(['active', 'joining', 'starting'] as const)(
    "returns true for role='host', phase='%s'",
    phase => {
      orbitState.role = 'host';
      orbitState.phase = phase;
      expect(isInOrbitSession()).toBe(true);
    },
  );

  it.each(['active', 'joining', 'starting'] as const)(
    "returns true for role='guest', phase='%s'",
    phase => {
      orbitState.role = 'guest';
      orbitState.phase = phase;
      expect(isInOrbitSession()).toBe(true);
    },
  );

  it.each(['idle', 'ending', 'ended', 'error'] as const)(
    "returns false for transient/inactive phase='%s'",
    phase => {
      orbitState.role = 'host';
      orbitState.phase = phase;
      expect(isInOrbitSession()).toBe(false);
    },
  );
});
