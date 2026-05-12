import { afterEach, describe, expect, it } from 'vitest';
import {
  _resetEngineStateForTest,
  bumpPlayGeneration,
  getIsAudioPaused,
  getPlayGeneration,
  setIsAudioPaused,
} from './engineState';

afterEach(() => {
  _resetEngineStateForTest();
});

describe('isAudioPaused', () => {
  it('starts false', () => {
    expect(getIsAudioPaused()).toBe(false);
  });

  it('round-trips through get/set', () => {
    setIsAudioPaused(true);
    expect(getIsAudioPaused()).toBe(true);
    setIsAudioPaused(false);
    expect(getIsAudioPaused()).toBe(false);
  });
});

describe('playGeneration', () => {
  it('starts at 0', () => {
    expect(getPlayGeneration()).toBe(0);
  });

  it('bumpPlayGeneration increments + returns the new value', () => {
    expect(bumpPlayGeneration()).toBe(1);
    expect(bumpPlayGeneration()).toBe(2);
    expect(getPlayGeneration()).toBe(2);
  });

  it('captures a snapshot that a later bump invalidates', () => {
    const snap = bumpPlayGeneration();
    bumpPlayGeneration();
    expect(getPlayGeneration()).not.toBe(snap);
  });
});

describe('_resetEngineStateForTest', () => {
  it('resets both fields', () => {
    setIsAudioPaused(true);
    bumpPlayGeneration();
    bumpPlayGeneration();
    _resetEngineStateForTest();
    expect(getIsAudioPaused()).toBe(false);
    expect(getPlayGeneration()).toBe(0);
  });
});
