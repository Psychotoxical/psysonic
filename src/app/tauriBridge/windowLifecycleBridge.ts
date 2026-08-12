import { listen, type Event, type UnlistenFn } from '@tauri-apps/api/event';
import { endOrbitSession, leaveOrbitSession, useOrbitStore } from '@/features/orbit';
import { playListenSessionFinalize } from '@/features/playback/store/playListenSession';
import { playbackReportStopped } from '@/features/playback/store/playbackReportSession';
import { flushPlayQueuePosition } from '@/features/playback/store/queueSync';
import {
  exitApp,
  windowLifecycleBegin,
  windowLifecycleFallback,
  windowLifecycleGeneration,
  windowLifecycleHide,
  windowLifecycleReady,
  windowLifecycleUpdateFallbackPolicy,
} from '@/lib/api/platformShell';
import { useAuthStore } from '@/store/authStore';
import { getWindowKind } from '@/app/windowKind';

let setupPromise: Promise<void> | null = null;
let exitPromise: Promise<void> | null = null;
let hideOperation: Promise<void> | null = null;
let hideTransition: number | null = null;
let activeUnlisteners: UnlistenFn[] = [];
const retainedUnlisteners: UnlistenFn[] = [];
let lifecyclePolicyUnsubscribe: (() => void) | null = null;
let lifecyclePolicyUpdatePromise: Promise<void> = Promise.resolve();
let setupGeneration = 0;

const SETUP_MAX_ATTEMPTS = 4;
const SETUP_RETRY_MS = 100;
const SETUP_STEP_TIMEOUT_MS = 1000;
const LIFECYCLE_ACTION_TIMEOUT_MS = 1500;
const SETUP_ATTEMPT_STRIDE = SETUP_MAX_ATTEMPTS + 2;
const SETUP_ATTEMPT_BASE = Date.now() * SETUP_ATTEMPT_STRIDE;

type LifecycleRegistration = {
  generation: number;
  attempt: number;
};

class LifecycleTimeoutError extends Error {}

function withTimeout<T>(
  work: Promise<T>,
  context: string,
  timeoutMs = SETUP_STEP_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new LifecycleTimeoutError(`${context} timed out`));
    }, timeoutMs);
    work.then(
      value => {
        window.clearTimeout(timer);
        resolve(value);
      },
      error => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function clearUnlisteners(unlisteners: UnlistenFn[]): void {
  for (const unlisten of unlisteners.splice(0).reverse()) unlisten();
}

async function listenWithTimeout<T>(
  event: string,
  handler: (event: Event<T>) => void,
): Promise<UnlistenFn> {
  const pending = listen(event, handler);
  try {
    return await withTimeout(pending, `listen(${event})`);
  } catch (error) {
    // Tauri listener registration cannot be cancelled. If it resolves after our
    // timeout, remove that late listener instead of leaking a duplicate handler.
    void pending.then(unlisten => unlisten()).catch(() => {});
    throw error;
  }
}

async function runBestEffort(work: Promise<unknown>): Promise<void> {
  await Promise.race([
    work,
    new Promise(resolve => setTimeout(resolve, 1500)),
  ]).catch(() => {});
}

function performExit(): Promise<void> {
  if (exitPromise) return exitPromise;
  exitPromise = (async () => {
    await runBestEffort(playListenSessionFinalize('close'));
    await runBestEffort(playbackReportStopped());
    await runBestEffort(flushPlayQueuePosition());
    const role = useOrbitStore.getState().role;
    if (role === 'host' || role === 'guest') {
      const teardown = role === 'host' ? endOrbitSession() : leaveOrbitSession();
      await runBestEffort(teardown);
    }
    await withTimeout(exitApp(), 'native exit', LIFECYCLE_ACTION_TIMEOUT_MS);
  })().finally(() => {
    exitPromise = null;
  });
  return exitPromise;
}

function reportLifecycleError(context: string, error: unknown): void {
  console.error(`[window-lifecycle] ${context}`, error);
}

function queueLifecyclePolicyUpdate(
  generation: number,
  minimizeToTray: boolean,
): Promise<void> {
  lifecyclePolicyUpdatePromise = lifecyclePolicyUpdatePromise.catch(() => {}).then(() => (
    windowLifecycleUpdateFallbackPolicy({ generation, minimizeToTray })
  ));
  return lifecyclePolicyUpdatePromise;
}

async function waitForLifecyclePolicyUpdates(): Promise<void> {
  let pending = lifecyclePolicyUpdatePromise;
  while (true) {
    await pending;
    if (pending === lifecyclePolicyUpdatePromise) return;
    pending = lifecyclePolicyUpdatePromise;
  }
}

function startLifecyclePolicySync(generation: number): Promise<void> {
  lifecyclePolicyUnsubscribe?.();
  const pushPolicy = (minimizeToTray: boolean) => {
    void queueLifecyclePolicyUpdate(generation, minimizeToTray).catch(error => {
      reportLifecycleError('native lifecycle policy update failed', error);
    });
  };
  lifecyclePolicyUnsubscribe = useAuthStore.subscribe((state, previous) => {
    if (state.minimizeToTray !== previous.minimizeToTray) {
      pushPolicy(state.minimizeToTray);
    }
  });
  queueLifecyclePolicyUpdate(
    generation,
    useAuthStore.getState().minimizeToTray,
  );
  return waitForLifecyclePolicyUpdates();
}

async function handleCloseRequested(transition: number): Promise<void> {
  if (!useAuthStore.getState().minimizeToTray) {
    await performExit();
    return;
  }

  if (!hideOperation || hideTransition !== transition) {
    const operation = (async () => {
      const generation = window.__psyLifecycleGeneration
        ?? await withTimeout(windowLifecycleGeneration(), 'window lifecycle generation');
      window.__psyLifecycleGeneration = generation;
      await windowLifecycleHide({ generation, transition });
    })();
    const trackedOperation = operation.finally(() => {
      if (hideOperation === trackedOperation) {
        hideOperation = null;
        hideTransition = null;
      }
    });
    hideTransition = transition;
    hideOperation = trackedOperation;
  }
  await withTimeout(hideOperation, 'native hide', LIFECYCLE_ACTION_TIMEOUT_MS);
}

async function beginWindowLifecycleRegistration(
  setupToken: number,
  ordinal: number,
): Promise<LifecycleRegistration> {
  const generation = await withTimeout(
    windowLifecycleGeneration(),
    'window lifecycle generation',
  );
  const attempt = SETUP_ATTEMPT_BASE + (setupToken * SETUP_ATTEMPT_STRIDE) + ordinal;
  await withTimeout(
    windowLifecycleBegin({ generation, attempt }),
    'window lifecycle registration',
  );
  // A newer accepted attempt makes a late readiness call from the previous
  // attempt stale, so its listeners can now be removed without an event gap.
  clearUnlisteners(retainedUnlisteners);
  window.__psyLifecycleGeneration = generation;
  return { generation, attempt };
}

async function registerWindowLifecycleListeners(
  setupToken: number,
  registration: LifecycleRegistration,
): Promise<boolean> {
  const unlisteners: UnlistenFn[] = [];
  try {
    unlisteners.push(await listenWithTimeout<number>('window:close-requested', event => {
      void handleCloseRequested(event.payload).catch(error => {
        reportLifecycleError('close request failed', error);
      });
    }));

    unlisteners.push(await listenWithTimeout('app:force-quit', () => {
      void performExit().catch(error => {
        reportLifecycleError('force quit failed', error);
      });
    }));
    const readiness = windowLifecycleReady({
      ...registration,
      minimizeToTray: useAuthStore.getState().minimizeToTray,
    });
    try {
      await withTimeout(readiness, 'window lifecycle readiness');
    } catch (error) {
      if (error instanceof LifecycleTimeoutError) {
        // The native command may already have marked this attempt ready. Keep
        // its listeners until Rust accepts a newer attempt or native fallback.
        retainedUnlisteners.push(...unlisteners.splice(0));
      }
      throw error;
    }
    if (setupToken !== setupGeneration) {
      clearUnlisteners(unlisteners);
      return false;
    }
    activeUnlisteners = unlisteners;
    void startLifecyclePolicySync(registration.generation).catch(error => {
      reportLifecycleError('native lifecycle policy sync failed', error);
    });
    return true;
  } catch (error) {
    clearUnlisteners(unlisteners);
    throw error;
  }
}

async function registerWindowLifecycleListenersWithRetry(setupToken: number): Promise<void> {
  let fallbackRegistration: LifecycleRegistration | null = null;
  for (let attempt = 1; attempt <= SETUP_MAX_ATTEMPTS && setupToken === setupGeneration; attempt += 1) {
    try {
      const registration = await beginWindowLifecycleRegistration(setupToken, attempt);
      fallbackRegistration = registration;
      if (await registerWindowLifecycleListeners(setupToken, registration)) return;
      return;
    } catch (error) {
      if (attempt === SETUP_MAX_ATTEMPTS) {
        console.error('[window-lifecycle] setup failed; enabling native fallback', error);
        break;
      }
      console.warn('[window-lifecycle] setup failed; retrying', error);
      await new Promise(resolve => setTimeout(resolve, SETUP_RETRY_MS * (2 ** (attempt - 1))));
    }
  }

  if (setupToken !== setupGeneration) return;
  const fallbackGeneration = fallbackRegistration?.generation ?? await withTimeout(
    windowLifecycleGeneration(),
    'native fallback generation',
  ).catch(error => {
    reportLifecycleError('native fallback generation failed', error);
    return null;
  });
  if (fallbackGeneration === null) return;
  const fallbackAttempt = SETUP_ATTEMPT_BASE
    + (setupToken * SETUP_ATTEMPT_STRIDE)
    + SETUP_MAX_ATTEMPTS
    + 1;
  try {
    await withTimeout(
      startLifecyclePolicySync(fallbackGeneration),
      'native fallback policy preparation',
    );
  } catch (error) {
    reportLifecycleError('native fallback policy preparation failed', error);
  }
  const fallback = windowLifecycleFallback({
    generation: fallbackGeneration,
    attempt: fallbackAttempt,
    minimizeToTray: useAuthStore.getState().minimizeToTray,
  });
  await withTimeout(fallback, 'window lifecycle fallback').then(() => {
    clearUnlisteners(retainedUnlisteners);
  }).catch(error => {
    // If the response is merely late, remove retained listeners after native
    // fallback actually acknowledges activation. Otherwise they remain as the
    // only safe delivery path for a readiness command that may have applied.
    void fallback.then(() => clearUnlisteners(retainedUnlisteners)).catch(() => {});
    reportLifecycleError('native fallback setup failed', error);
  });
}

/** Register lifecycle listeners before React mounts and acknowledge queued closes. */
export function setupWindowLifecycleBridge(): Promise<void> {
  if (getWindowKind() !== 'main') return Promise.resolve();
  setupPromise ??= registerWindowLifecycleListenersWithRetry(setupGeneration);
  return setupPromise;
}

export function _resetWindowLifecycleBridgeForTest(): void {
  setupGeneration += 1;
  clearUnlisteners(activeUnlisteners);
  clearUnlisteners(retainedUnlisteners);
  lifecyclePolicyUnsubscribe?.();
  lifecyclePolicyUnsubscribe = null;
  lifecyclePolicyUpdatePromise = Promise.resolve();
  setupPromise = null;
  exitPromise = null;
  hideOperation = null;
  hideTransition = null;
}
