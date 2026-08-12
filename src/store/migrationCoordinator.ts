import {
  useMigrationStore,
  type MigrationPhase,
  type MigrationStep,
} from './migrationStore';

type ActiveMigrationPhase = Exclude<MigrationPhase, 'completed' | 'error'>;

interface MigrationView {
  phase: ActiveMigrationPhase;
  step: MigrationStep | null;
  needsMigration: boolean;
}

export interface BlockingMigrationContext {
  setView: (view: Partial<MigrationView>) => void;
  setRetry: (retry: () => void) => void;
}

interface BlockingMigrationJob<T> {
  id: string;
  initialView: MigrationView;
  retry: () => void;
  run: (context: BlockingMigrationContext) => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

interface ActiveJob {
  id: string;
  view: MigrationView;
  retry: () => void;
}

interface MigrationFailure {
  id: string;
  step: MigrationStep | null;
  error: string;
  retry: () => void;
}

type BlockingMigrationStatus = 'queued' | 'active' | 'failed';

const queue: BlockingMigrationJob<unknown>[] = [];
const pendingById = new Map<string, Promise<unknown>>();
let failure: MigrationFailure | null = null;
let activeJob: ActiveJob | null = null;
let draining = false;
let blockingBatchActive = false;
let retryingJobId: string | null = null;

function isBlockingPhase(phase: ActiveMigrationPhase): boolean {
  return phase === 'inspecting' || phase === 'running';
}

type PublishedMigrationState = Partial<Pick<
  ReturnType<typeof useMigrationStore.getState>,
  'phase' | 'step' | 'needsMigration' | 'lastError'
>>;

function publishState(state: PublishedMigrationState): void {
  useMigrationStore.setState(current => ({
    ...state,
    ...(state.phase && state.phase !== 'completed' && current.phase === 'completed'
      ? { blockingRevision: current.blockingRevision + 1 }
      : {}),
  }));
}

function publishAggregateState(): void {
  const queuedBlocking = queue.find(job => isBlockingPhase(job.initialView.phase));
  if (activeJob && isBlockingPhase(activeJob.view.phase)) {
    publishState({
      ...activeJob.view,
      lastError: null,
    });
    return;
  }
  if (failure) {
    publishState({
      phase: 'error',
      step: failure.step,
      needsMigration: true,
      lastError: failure.error,
    });
    return;
  }
  if (queuedBlocking) {
    publishState({
      ...queuedBlocking.initialView,
      lastError: null,
    });
    return;
  }
  if (blockingBatchActive && (activeJob || queue.length > 0)) {
    const next = activeJob?.view ?? queue[0]?.initialView;
    publishState({
      phase: 'inspecting',
      step: next?.step ?? null,
      needsMigration: true,
      lastError: null,
    });
    return;
  }
  // Non-blocking inspection jobs stay invisible until they explicitly enter
  // a blocking phase through context.setView(). Publishing their idle view
  // would revoke startup readiness and make bind-time identity inspection loop.
  if (activeJob || queue.length > 0) return;

  blockingBatchActive = false;
  publishState({
    phase: 'completed',
    step: null,
    needsMigration: false,
    lastError: null,
  });
}

async function drainQueue(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length > 0 && !failure) {
      const job = queue.shift()!;
      activeJob = {
        id: job.id,
        view: job.initialView,
        retry: job.retry,
      };
      if (isBlockingPhase(activeJob.view.phase)) blockingBatchActive = true;
      publishAggregateState();

      const context: BlockingMigrationContext = {
        setView: view => {
          if (!activeJob || activeJob.id !== job.id) return;
          activeJob.view = { ...activeJob.view, ...view };
          if (isBlockingPhase(activeJob.view.phase)) blockingBatchActive = true;
          publishAggregateState();
        },
        setRetry: retry => {
          if (!activeJob || activeJob.id !== job.id) return;
          activeJob.retry = retry;
        },
      };

      try {
        const result = await job.run(context);
        job.resolve(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failure = {
          id: job.id,
          step: activeJob.view.step,
          error: message,
          retry: activeJob.retry,
        };
        blockingBatchActive = true;
        job.reject(error);
      } finally {
        pendingById.delete(job.id);
        activeJob = null;
        publishAggregateState();
      }
    }
  } finally {
    draining = false;
    publishAggregateState();
  }
}

export function enqueueBlockingMigration<T>(options: {
  id: string;
  step: MigrationStep | null;
  initialPhase?: ActiveMigrationPhase;
  retry: () => void;
  run: (context: BlockingMigrationContext) => Promise<T>;
}): Promise<T> {
  const existing = pendingById.get(options.id);
  if (existing) return existing as Promise<T>;

  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  pendingById.set(options.id, promise);
  const job: BlockingMigrationJob<unknown> = {
    id: options.id,
    initialView: {
      phase: options.initialPhase ?? 'idle',
      step: options.step,
      needsMigration: false,
    },
    retry: options.retry,
    run: options.run,
    resolve: resolve as (value: unknown) => void,
    reject,
  };
  if (retryingJobId === options.id) queue.unshift(job);
  else queue.push(job);
  publishAggregateState();
  if (!failure) void drainQueue();
  return promise;
}

export function retryCurrentBlockingMigration(): void {
  const failed = failure;
  if (!failed) return;
  failure = null;
  retryingJobId = failed.id;
  failed.retry();
  retryingJobId = null;
  publishAggregateState();
  void drainQueue();
}

export function blockingMigrationStatus(id: string): BlockingMigrationStatus | null {
  if (activeJob?.id === id) return 'active';
  if (queue.some(job => job.id === id)) return 'queued';
  if (failure?.id === id) return 'failed';
  return null;
}

export function resetBlockingMigrationCoordinatorForTests(): void {
  queue.length = 0;
  pendingById.clear();
  failure = null;
  activeJob = null;
  draining = false;
  blockingBatchActive = false;
  retryingJobId = null;
}
