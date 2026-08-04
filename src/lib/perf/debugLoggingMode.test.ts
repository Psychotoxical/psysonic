import { beforeEach, describe, expect, it } from 'vitest';
import {
  isDebugLoggingModeActive,
  setDebugLoggingModeSource,
  setRuntimeDebugLoggingOverride,
} from './debugLoggingMode';

describe('debug logging runtime override', () => {
  beforeEach(() => {
    setDebugLoggingModeSource(() => false);
    setRuntimeDebugLoggingOverride(false);
  });

  it('enables instrumentation without changing the configured source', () => {
    setRuntimeDebugLoggingOverride(true);
    expect(isDebugLoggingModeActive()).toBe(true);

    setRuntimeDebugLoggingOverride(false);
    expect(isDebugLoggingModeActive()).toBe(false);
  });
});
