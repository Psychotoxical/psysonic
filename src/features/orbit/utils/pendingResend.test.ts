import { beforeEach, describe, expect, it } from 'vitest';

import {
  forgetPendingSuggestion,
  notePendingSuggestion,
  ORBIT_SUGGESTION_GIVE_UP_MS,
  ORBIT_SUGGESTION_RESEND_GRACE_MS,
  pendingResendTrackedCount,
  planPendingResends,
  resetPendingResendState,
} from '@/features/orbit/utils/pendingResend';

const T0 = 1_000_000;
const GRACE = ORBIT_SUGGESTION_RESEND_GRACE_MS;

beforeEach(() => {
  resetPendingResendState();
});

describe('planPendingResends', () => {
  it('does nothing within the grace window', () => {
    notePendingSuggestion('t1', T0);
    const plan = planPendingResends(['t1'], new Set(), T0 + GRACE - 1);
    expect(plan).toEqual({ resend: [], giveUp: [] });
  });

  it('re-sends once per grace window when the host has not recorded it', () => {
    notePendingSuggestion('t1', T0);
    // First window elapsed → one re-send.
    expect(planPendingResends(['t1'], new Set(), T0 + GRACE + 1).resend).toEqual(['t1']);
    // Still inside the second window → no further re-send.
    expect(planPendingResends(['t1'], new Set(), T0 + GRACE + 100).resend).toEqual([]);
    // Second window elapsed → re-send again.
    expect(planPendingResends(['t1'], new Set(), T0 + GRACE * 2 + 1).resend).toEqual(['t1']);
  });

  it('leaves a host-recorded suggestion alone even past the grace window', () => {
    notePendingSuggestion('t1', T0);
    const plan = planPendingResends(['t1'], new Set(['t1']), T0 + GRACE * 3);
    expect(plan).toEqual({ resend: [], giveUp: [] });
  });

  it('gives up once past the give-up window', () => {
    notePendingSuggestion('t1', T0);
    const plan = planPendingResends(['t1'], new Set(), T0 + ORBIT_SUGGESTION_GIVE_UP_MS + 1);
    expect(plan.giveUp).toEqual(['t1']);
    expect(plan.resend).toEqual([]);
  });

  it('seeds tracking for a suggestion it sees for the first time, acting next tick', () => {
    // No prior note — first plan call just starts the clock.
    const first = planPendingResends(['t1'], new Set(), T0);
    expect(first).toEqual({ resend: [], giveUp: [] });
    expect(pendingResendTrackedCount()).toBe(1);
    // A grace window after that seed → re-send.
    expect(planPendingResends(['t1'], new Set(), T0 + GRACE + 1).resend).toEqual(['t1']);
  });

  it('forget + reset clear tracking', () => {
    notePendingSuggestion('t1', T0);
    notePendingSuggestion('t2', T0);
    expect(pendingResendTrackedCount()).toBe(2);
    forgetPendingSuggestion('t1');
    expect(pendingResendTrackedCount()).toBe(1);
    resetPendingResendState();
    expect(pendingResendTrackedCount()).toBe(0);
  });
});
