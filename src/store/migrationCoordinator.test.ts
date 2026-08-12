import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useMigrationStore } from './migrationStore';
import {
  blockingMigrationStatus,
  enqueueBlockingMigration,
  resetBlockingMigrationCoordinatorForTests,
  retryCurrentBlockingMigration,
} from './migrationCoordinator';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(res => { resolve = res; });
  return { promise, resolve };
}

describe('migrationCoordinator', () => {
  beforeEach(() => {
    resetBlockingMigrationCoordinatorForTests();
    useMigrationStore.setState({
      phase: 'completed',
      step: null,
      needsMigration: false,
      lastError: null,
      blockingRevision: 0,
    });
  });

  it('serializes ordinary and canonical jobs without publishing idle or completed between them', async () => {
    const ordinary = deferred();
    const canonical = deferred();
    const phases: string[] = [];
    const unsubscribe = useMigrationStore.subscribe(state => phases.push(state.phase));

    const ordinaryRun = enqueueBlockingMigration({
      id: 'ordinary-migrations',
      step: 'serverIndex',
      initialPhase: 'running',
      retry: vi.fn(),
      run: async () => ordinary.promise,
    });
    const canonicalRun = enqueueBlockingMigration({
      id: 'canonical-ids:a.test',
      step: 'canonicalIds',
      initialPhase: 'inspecting',
      retry: vi.fn(),
      run: async context => {
        context.setView({ phase: 'running', needsMigration: true });
        await canonical.promise;
      },
    });

    await vi.waitFor(() => expect(useMigrationStore.getState().step).toBe('serverIndex'));
    ordinary.resolve();
    await vi.waitFor(() => expect(useMigrationStore.getState().step).toBe('canonicalIds'));
    expect(useMigrationStore.getState().phase).toBe('running');
    expect(phases.slice(phases.indexOf('running'))).not.toContain('idle');
    expect(phases.slice(phases.indexOf('running'))).not.toContain('completed');

    canonical.resolve();
    await Promise.all([ordinaryRun, canonicalRun]);
    expect(useMigrationStore.getState()).toMatchObject({
      phase: 'completed',
      step: null,
      needsMigration: false,
    });
    unsubscribe();
  });

  it('keeps non-blocking inspection invisible until it enters a blocking phase', async () => {
    const inspection = deferred();
    const run = enqueueBlockingMigration({
      id: 'canonical-ids:a.test',
      step: 'canonicalIds',
      initialPhase: 'idle',
      retry: vi.fn(),
      run: async () => inspection.promise,
    });

    await vi.waitFor(() => expect(blockingMigrationStatus('canonical-ids:a.test')).toBe('active'));
    expect(useMigrationStore.getState()).toMatchObject({
      phase: 'completed',
      blockingRevision: 0,
    });

    inspection.resolve();
    await run;
    expect(useMigrationStore.getState()).toMatchObject({
      phase: 'completed',
      blockingRevision: 0,
    });
  });

  it('stops after the first failure, retries that owner, then resumes queued jobs', async () => {
    let firstAttempts = 0;
    let secondAttempts = 0;
    const enqueueFirst = (): Promise<void> => enqueueBlockingMigration({
      id: 'canonical-ids:a.test',
      step: 'canonicalIds',
      retry: () => { void enqueueFirst().catch(() => {}); },
      run: async context => {
        context.setView({ phase: 'running', needsMigration: true });
        firstAttempts += 1;
        if (firstAttempts === 1) throw new Error('server A unresolved');
      },
    });

    const first = enqueueFirst();
    const second = enqueueBlockingMigration({
      id: 'canonical-ids:b.test',
      step: 'canonicalIds',
      retry: vi.fn(),
      run: async context => {
        context.setView({ phase: 'running', needsMigration: true });
        secondAttempts += 1;
      },
    });

    await expect(first).rejects.toThrow('server A unresolved');
    expect(secondAttempts).toBe(0);
    expect(blockingMigrationStatus('canonical-ids:b.test')).toBe('queued');
    expect(useMigrationStore.getState()).toMatchObject({
      phase: 'error',
      step: 'canonicalIds',
      lastError: 'server A unresolved',
    });
    expect(blockingMigrationStatus('canonical-ids:a.test')).toBe('failed');

    retryCurrentBlockingMigration();
    await vi.waitFor(() => expect(firstAttempts).toBe(2));
    await second;
    expect(secondAttempts).toBe(1);
    await vi.waitFor(() => expect(useMigrationStore.getState().phase).toBe('completed'));
  });
});
