import { beforeEach, describe, expect, it } from 'vitest';
import {
  getActiveServerReachable,
  isActiveServerReachable,
  setActiveServerReachable,
} from './activeServerReachability';

describe('activeServerReachability', () => {
  beforeEach(() => {
    setActiveServerReachable(null);
  });

  it('isActiveServerReachable requires an explicit successful probe', () => {
    expect(isActiveServerReachable()).toBe(false);
    setActiveServerReachable(true);
    expect(isActiveServerReachable()).toBe(true);
    setActiveServerReachable(false);
    expect(isActiveServerReachable()).toBe(false);
  });

  it('exposes the last probe result', () => {
    setActiveServerReachable(true);
    expect(getActiveServerReachable()).toBe(true);
  });
});
