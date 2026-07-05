import { describe, it, expect, vi, afterEach } from 'vitest';
import { createSafeJSONStorage } from '@/lib/util/safeStorage';

describe('createSafeJSONStorage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('swallows a QuotaExceededError from setItem instead of throwing', () => {
    const storage = createSafeJSONStorage<{ a: number }>()!;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('exceeded', 'QuotaExceededError');
    });
    // Must NOT throw — zustand calls this from inside set(); a throw here would
    // abort the calling action (this is what killed playback on huge queues).
    expect(() => storage.setItem('k', { state: { a: 1 }, version: 0 })).not.toThrow();
  });

  it('round-trips a value through localStorage when there is room', () => {
    const storage = createSafeJSONStorage<{ a: number }>()!;
    storage.setItem('k2', { state: { a: 5 }, version: 0 });
    expect(storage.getItem('k2')).toEqual({ state: { a: 5 }, version: 0 });
  });

  it('does not throw across repeated quota failures (write stays a no-op)', () => {
    const storage = createSafeJSONStorage<{ a: number }>()!;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('exceeded', 'QuotaExceededError');
    });
    expect(() => {
      for (let i = 0; i < 5; i++) {
        storage.setItem('quota-throttle-key', { state: { a: i }, version: 0 });
      }
    }).not.toThrow();
  });

  it('returns null from getItem if the underlying read throws', () => {
    const storage = createSafeJSONStorage<{ a: number }>()!;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(storage.getItem('missing')).toBeNull();
  });
});
