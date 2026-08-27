import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY } from '@/lib/server/navidromeCanonicalCheckpointStatus';
import { installNavidromeCanonicalWindowGate } from './navidromeCanonicalWindowGate';

describe('installNavidromeCanonicalWindowGate', () => {
  beforeEach(() => localStorage.clear());

  it('detects a lock that became active before the final mount check', () => {
    const onLock = vi.fn();
    const gate = installNavidromeCanonicalWindowGate({ onLock });
    localStorage.setItem(NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY, '1');

    expect(gate.engageIfActive()).toBe(true);
    expect(onLock).toHaveBeenCalledOnce();
    gate.dispose();
  });

  it('engages synchronously once for a cross-window lock event', () => {
    const onLock = vi.fn();
    const gate = installNavidromeCanonicalWindowGate({ onLock });

    window.dispatchEvent(new StorageEvent('storage', {
      key: NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY,
      newValue: '1',
    }));
    window.dispatchEvent(new StorageEvent('storage', {
      key: NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY,
      newValue: '1',
    }));

    expect(onLock).toHaveBeenCalledOnce();
    gate.dispose();
  });

  it('notifies an engaged blocked window when the lock clears', () => {
    localStorage.setItem(NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY, '1');
    const onUnlock = vi.fn();
    const gate = installNavidromeCanonicalWindowGate({ onLock: vi.fn(), onUnlock });
    gate.engageIfActive();

    window.dispatchEvent(new StorageEvent('storage', {
      key: NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY,
      oldValue: '1',
      newValue: null,
    }));

    expect(onUnlock).toHaveBeenCalledOnce();
    gate.dispose();
  });

  it('can engage again after a lock clears', () => {
    const onLock = vi.fn();
    const gate = installNavidromeCanonicalWindowGate({ onLock, onUnlock: vi.fn() });

    window.dispatchEvent(new StorageEvent('storage', {
      key: NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY,
      newValue: '1',
    }));
    window.dispatchEvent(new StorageEvent('storage', {
      key: NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY,
      oldValue: '1',
      newValue: null,
    }));
    window.dispatchEvent(new StorageEvent('storage', {
      key: NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY,
      newValue: '2',
    }));

    expect(onLock).toHaveBeenCalledTimes(2);
    gate.dispose();
  });
});
