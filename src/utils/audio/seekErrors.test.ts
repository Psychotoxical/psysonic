import { describe, expect, it } from 'vitest';
import { isRecoverableSeekError } from './seekErrors';

describe('isRecoverableSeekError', () => {
  it.each([
    'not seekable',
    'audio sink not ready',
    'audio seek busy',
    'audio seek timeout',
  ])('classifies "%s" as recoverable', msg => {
    expect(isRecoverableSeekError(msg)).toBe(true);
  });

  it('matches when the marker is embedded in a longer message', () => {
    expect(isRecoverableSeekError('seek failed: audio sink not ready yet')).toBe(true);
    expect(isRecoverableSeekError('error: audio seek timeout after 6000ms')).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isRecoverableSeekError('decoder failed')).toBe(false);
    expect(isRecoverableSeekError('file not found')).toBe(false);
    expect(isRecoverableSeekError('')).toBe(false);
  });

  it('is case-sensitive (Rust messages are stable)', () => {
    expect(isRecoverableSeekError('Audio Sink Not Ready')).toBe(false);
  });
});
