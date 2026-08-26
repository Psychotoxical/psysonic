import { describe, it, expect } from 'vitest';
import { resolveCoverSource } from './coverSources';

describe('resolveCoverSource', () => {
  it('returns the first resolved src', () => {
    expect(resolveCoverSource([{ src: '', pending: false }, { src: 'https://a/img.jpg' }]))
      .toBe('https://a/img.jpg');
  });
  it('holds on a pending candidate instead of flashing a lower one', () => {
    expect(resolveCoverSource([{ src: 'https://a/img.jpg' }, { src: '', pending: true }]))
      .toBe('https://a/img.jpg');
    expect(resolveCoverSource([{ src: '', pending: true }, { src: 'https://b/x.jpg' }]))
      .toBeNull();
  });
  it('steps past a confirmed miss', () => {
    expect(resolveCoverSource([{ src: '', pending: false }, { src: 'https://c/x.jpg' }]))
      .toBe('https://c/x.jpg');
  });
  it('returns null when nothing resolves', () => {
    expect(resolveCoverSource([{ src: '', pending: false }])).toBeNull();
    expect(resolveCoverSource([])).toBeNull();
  });
});
