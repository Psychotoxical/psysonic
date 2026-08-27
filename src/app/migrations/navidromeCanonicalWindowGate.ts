import {
  NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY,
  navidromeCanonicalBootstrapIsActive,
} from '@/lib/server/navidromeCanonicalCheckpointStatus';

type WindowLockTarget = Pick<Window, 'addEventListener' | 'removeEventListener'>;

export function installNavidromeCanonicalWindowGate(options: {
  onLock: () => void;
  onUnlock?: () => void;
  storage?: Storage;
  target?: WindowLockTarget;
}): {
  engageIfActive: () => boolean;
  dispose: () => void;
} {
  const storage = options.storage ?? localStorage;
  const target = options.target ?? window;
  let engaged = false;
  const engage = () => {
    if (engaged) return;
    engaged = true;
    options.onLock();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY) return;
    if (event.newValue !== null) engage();
    else if (engaged) {
      engaged = false;
      options.onUnlock?.();
    }
  };
  target.addEventListener('storage', onStorage as EventListener);
  return {
    engageIfActive: () => {
      if (!navidromeCanonicalBootstrapIsActive(storage)) return false;
      engage();
      return true;
    },
    dispose: () => target.removeEventListener('storage', onStorage as EventListener),
  };
}
