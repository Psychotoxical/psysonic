import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetQueuePlaybackIdleForTest,
  getIdlePullGeneration,
  isIdleQueuePullSuspended,
  isQueueNaturallyEnded,
  markPlaybackActive,
  markQueueNaturallyEnded,
  resumeIdleQueuePull,
  subscribeIdleQueuePullSuspended,
  touchQueueMutationClock,
} from '@/features/playback/store/queuePlaybackIdle';

describe('idle queue pull suspension', () => {
  beforeEach(() => {
    _resetQueuePlaybackIdleForTest();
  });

  it('starts unsuspended', () => {
    expect(isIdleQueuePullSuspended()).toBe(false);
  });

  it('suspends on local queue mutation', () => {
    touchQueueMutationClock();
    expect(isIdleQueuePullSuspended()).toBe(true);
  });

  it('resumes after explicit resume', () => {
    touchQueueMutationClock();
    resumeIdleQueuePull();
    expect(isIdleQueuePullSuspended()).toBe(false);
  });

  it('bumps idle pull generation on mutation', () => {
    expect(getIdlePullGeneration()).toBe(0);
    touchQueueMutationClock();
    expect(getIdlePullGeneration()).toBe(1);
    touchQueueMutationClock();
    expect(getIdlePullGeneration()).toBe(2);
  });

  it('notifies subscribers when suspension toggles', () => {
    let count = 0;
    const unsub = subscribeIdleQueuePullSuspended(() => {
      count += 1;
    });
    touchQueueMutationClock();
    expect(count).toBe(1);
    resumeIdleQueuePull();
    expect(count).toBe(2);
    unsub();
  });
});

describe('natural queue end', () => {
  beforeEach(() => {
    _resetQueuePlaybackIdleForTest();
  });

  it('starts clear and can be marked after queue exhaustion', () => {
    expect(isQueueNaturallyEnded()).toBe(false);
    markQueueNaturallyEnded();
    expect(isQueueNaturallyEnded()).toBe(true);
  });

  it('clears when playback becomes active again', () => {
    markQueueNaturallyEnded();
    markPlaybackActive();
    expect(isQueueNaturallyEnded()).toBe(false);
  });

  it('clears on local queue mutation', () => {
    markQueueNaturallyEnded();
    touchQueueMutationClock();
    expect(isQueueNaturallyEnded()).toBe(false);
  });
});
