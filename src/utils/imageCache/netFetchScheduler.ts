import { MAX_CONCURRENT_NET_FETCHES } from './constants';

type LoadWaiter = {
  getPriority: () => number;
  resolve: (granted: boolean) => void;
};
const loadWaiters: LoadWaiter[] = [];

let activeNetFetches = 0;

function removeLoadWaiter(waiter: LoadWaiter): void {
  const i = loadWaiters.indexOf(waiter);
  if (i !== -1) loadWaiters.splice(i, 1);
}

/**
 * Slot for remote `fetch` only. IndexedDB reads run before this — cached disk
 * art can render without waiting on in-flight network downloads.
 */
export function acquireNetFetchSlot(signal?: AbortSignal, getPriority?: () => number): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  if (activeNetFetches < MAX_CONCURRENT_NET_FETCHES) {
    activeNetFetches++;
    return Promise.resolve(true);
  }
  return new Promise<boolean>(resolve => {
    let waiter: LoadWaiter;
    const onAbort = () => {
      signal?.removeEventListener('abort', onAbort);
      removeLoadWaiter(waiter);
      resolve(false);
    };
    waiter = {
      getPriority: getPriority ?? (() => 0),
      resolve: (granted: boolean) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(granted);
      },
    };
    loadWaiters.push(waiter);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function pickHighestPriorityWaiterIndex(): number {
  if (loadWaiters.length === 0) return -1;
  let best = 0;
  let bestP = safePriority(loadWaiters[0].getPriority);
  for (let i = 1; i < loadWaiters.length; i++) {
    const p = safePriority(loadWaiters[i].getPriority);
    if (p > bestP) {
      bestP = p;
      best = i;
    }
  }
  return best;
}

function safePriority(fn: () => number): number {
  try {
    return fn();
  } catch {
    return 0;
  }
}

export function releaseNetFetchSlot(): void {
  activeNetFetches = Math.max(0, activeNetFetches - 1);
  if (activeNetFetches >= MAX_CONCURRENT_NET_FETCHES) return;
  const idx = pickHighestPriorityWaiterIndex();
  if (idx === -1) return;
  const [w] = loadWaiters.splice(idx, 1);
  activeNetFetches++;
  w.resolve(true);
}
