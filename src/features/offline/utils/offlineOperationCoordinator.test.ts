import { expect, it, vi } from 'vitest';
import {
  beginOfflineTrackTransfer,
  beginOfflineServerOperation,
  registerOfflineServerKeyRemaps,
  resolveOfflineServerOperationKey,
  runOfflineServerMaintenance,
  runOfflineServerMaintenanceBatch,
  runOfflineTrackCleanup,
  runOfflineTrackDeletionBatch,
  waitForAllOfflineTransfers,
} from '@/features/offline/utils/offlineOperationCoordinator';

it('waits for every active transfer before resolving the global drain', async () => {
  const finishA = await beginOfflineTrackTransfer('drain-a.test', 'track-1');
  const finishB = await beginOfflineTrackTransfer('drain-b.test', 'track-2');
  let drained = false;
  const drain = waitForAllOfflineTransfers().then(() => { drained = true; });

  finishA();
  await Promise.resolve();
  expect(drained).toBe(false);

  finishB();
  await drain;
  expect(drained).toBe(true);
});

it('lets nested track work reuse an outer server lease while maintenance waits', async () => {
  const serverLease = await beginOfflineServerOperation('leased.test');
  let maintenanceStarted = false;
  const maintenance = runOfflineServerMaintenance('leased.test', async () => {
    maintenanceStarted = true;
  });
  await Promise.resolve();
  expect(maintenanceStarted).toBe(false);

  const finishTrack = await beginOfflineTrackTransfer('leased.test', 'track-1', serverLease);
  finishTrack();
  expect(maintenanceStarted).toBe(false);

  serverLease();
  await maintenance;
  expect(maintenanceStarted).toBe(true);
});

it('keeps server maintenance exclusive with track operations in both directions', async () => {
  const finishTransfer = await beginOfflineTrackTransfer('a.test', 'track-1');
  let maintenanceStarted = false;
  const maintenance = runOfflineServerMaintenance('a.test', async () => {
    maintenanceStarted = true;
  });
  await Promise.resolve();
  expect(maintenanceStarted).toBe(false);

  finishTransfer();
  await maintenance;
  expect(maintenanceStarted).toBe(true);

  let releaseMaintenance!: () => void;
  const heldMaintenance = runOfflineServerMaintenance('a.test', () => new Promise<void>(resolve => {
    releaseMaintenance = resolve;
  }));
  await vi.waitFor(() => expect(releaseMaintenance).toBeTypeOf('function'));
  let transferStarted = false;
  const waitingTransfer = beginOfflineTrackTransfer('a.test', 'track-2').then(finish => {
    transferStarted = true;
    finish();
  });
  await Promise.resolve();
  expect(transferStarted).toBe(false);

  releaseMaintenance();
  await Promise.all([heldMaintenance, waitingTransfer]);
  expect(transferStarted).toBe(true);
});

it('does not start a track operation inside an active deletion barrier', async () => {
  let releaseDeletion!: () => void;
  const deletion = runOfflineTrackDeletionBatch(
    [{ serverIndexKey: 'a.test', trackId: 'track-1' }],
    () => new Promise<void>(resolve => {
      releaseDeletion = resolve;
    }),
  );
  await vi.waitFor(() => expect(releaseDeletion).toBeTypeOf('function'));

  let transferStarted = false;
  const transfer = beginOfflineTrackTransfer('a.test', 'track-1').then(finish => {
    transferStarted = true;
    finish();
  });
  await Promise.resolve();
  expect(transferStarted).toBe(false);

  releaseDeletion();
  await Promise.all([deletion, transfer]);
  expect(transferStarted).toBe(true);
});

it('lets active transfers finish while cleanup blocks new transfers', async () => {
  const finishActiveTransfer = await beginOfflineTrackTransfer('a.test', 'track-1');
  let releaseCleanup!: () => void;
  let cleanupStarted = false;
  const cleanup = runOfflineTrackCleanup(
    'a.test',
    'track-1',
    () => new Promise<void>(resolve => {
      cleanupStarted = true;
      releaseCleanup = resolve;
    }),
  );
  await Promise.resolve();
  expect(cleanupStarted).toBe(false);

  let waitingTransferStarted = false;
  const waitingTransfer = beginOfflineTrackTransfer('a.test', 'track-1').then(finish => {
    waitingTransferStarted = true;
    finish();
  });
  finishActiveTransfer();
  await vi.waitFor(() => expect(cleanupStarted).toBe(true));
  expect(waitingTransferStarted).toBe(false);

  releaseCleanup();
  await Promise.all([cleanup, waitingTransfer]);
  expect(waitingTransferStarted).toBe(true);
});

it('holds every requested server while batch maintenance runs', async () => {
  let releaseMaintenance!: () => void;
  const maintenance = runOfflineServerMaintenanceBatch(
    ['b.test', 'a.test', 'a.test'],
    () => new Promise<void>(resolve => {
      releaseMaintenance = resolve;
    }),
  );
  await vi.waitFor(() => expect(releaseMaintenance).toBeTypeOf('function'));

  const started: string[] = [];
  const transfers = ['a.test', 'b.test'].map(serverIndexKey => (
    beginOfflineTrackTransfer(serverIndexKey, 'track-1').then(finish => {
      started.push(serverIndexKey);
      finish();
    })
  ));
  await Promise.resolve();
  expect(started).toEqual([]);

  releaseMaintenance();
  await Promise.all([maintenance, ...transfers]);
  expect(started.sort()).toEqual(['a.test', 'b.test']);
});

it('routes operations through a registered server-key remap', async () => {
  await runOfflineServerMaintenanceBatch(['old.test', 'new.test'], async () => {
    registerOfflineServerKeyRemaps([{ oldKey: 'old.test', newKey: 'new.test' }]);
  });

  expect(resolveOfflineServerOperationKey('old.test')).toBe('new.test');
  const finish = await beginOfflineTrackTransfer('old.test', 'track-1');
  let maintenanceStarted = false;
  const maintenance = runOfflineServerMaintenance('new.test', async () => {
    maintenanceStarted = true;
  });
  await Promise.resolve();
  expect(maintenanceStarted).toBe(false);

  finish();
  await maintenance;
  expect(maintenanceStarted).toBe(true);

  registerOfflineServerKeyRemaps([{ oldKey: 'new.test', newKey: 'old.test' }]);
  expect(resolveOfflineServerOperationKey('new.test')).toBe('old.test');
});

it('keeps reverse remaps inside the active maintenance barrier', async () => {
  await runOfflineServerMaintenanceBatch(['reverse-old.test', 'reverse-new.test'], async () => {
    registerOfflineServerKeyRemaps([{
      oldKey: 'reverse-old.test',
      newKey: 'reverse-new.test',
    }]);
  });

  let transferStarted = false;
  let waitingTransfer: Promise<void> | null = null;
  await runOfflineServerMaintenanceBatch(
    ['reverse-new.test', 'reverse-old.test'],
    async () => {
      registerOfflineServerKeyRemaps([{
        oldKey: 'reverse-new.test',
        newKey: 'reverse-old.test',
      }]);
      waitingTransfer = beginOfflineTrackTransfer('reverse-new.test', 'track-1').then(finish => {
        transferStarted = true;
        finish();
      });
      await Promise.resolve();
      expect(transferStarted).toBe(false);
    },
  );

  await waitingTransfer;
  expect(transferStarted).toBe(true);
});
