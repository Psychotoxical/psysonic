import { beforeEach, describe, expect, it } from 'vitest';
import { onInvoke } from '@/test/mocks/tauri';
import { useOfflineJobStore, cancelledDownloads, type DownloadJob } from './offlineJobStore';

function job(over: Partial<DownloadJob>): DownloadJob {
  return {
    trackId: 't',
    albumId: 'a',
    albumName: 'A',
    trackTitle: 'T',
    trackIndex: 0,
    totalTracks: 1,
    status: 'queued',
    downloadId: 'a-1',
    ...over,
  };
}

beforeEach(() => {
  useOfflineJobStore.setState({ jobs: [], bulkProgress: {} });
  cancelledDownloads.clear();
});

describe('offlineJobStore cancellation', () => {
  it('cancelAllDownloads drops queued + downloading jobs but keeps settled ones', () => {
    const calls: string[][] = [];
    onInvoke('cancel_offline_downloads', (a: unknown) => {
      calls.push((a as { downloadIds: string[] }).downloadIds);
    });
    useOfflineJobStore.setState({
      jobs: [
        job({ trackId: 'q', status: 'queued' }),
        job({ trackId: 'd', status: 'downloading' }),
        job({ trackId: 'done', status: 'done' }),
        job({ trackId: 'err', status: 'error' }),
      ],
      bulkProgress: {},
    });

    useOfflineJobStore.getState().cancelAllDownloads();

    // Only settled jobs survive → the sidebar toast clears.
    expect(useOfflineJobStore.getState().jobs.map(j => j.status).sort()).toEqual(['done', 'error']);
    expect(cancelledDownloads.has('a')).toBe(true);
    // Rust is told to abort the in-flight transfers for this download id.
    expect(calls).toEqual([['a-1']]);
  });

  it('cancelDownload drops every job for one album and leaves others running', () => {
    const calls: string[][] = [];
    onInvoke('cancel_offline_downloads', (a: unknown) => {
      calls.push((a as { downloadIds: string[] }).downloadIds);
    });
    useOfflineJobStore.setState({
      jobs: [
        job({ trackId: 't1', albumId: 'a', status: 'downloading', downloadId: 'a-1' }),
        job({ trackId: 't2', albumId: 'b', status: 'downloading', downloadId: 'b-1' }),
      ],
      bulkProgress: {},
    });

    useOfflineJobStore.getState().cancelDownload('a');

    expect(useOfflineJobStore.getState().jobs.map(j => j.albumId)).toEqual(['b']);
    expect(cancelledDownloads.has('a')).toBe(true);
    expect(calls).toEqual([['a-1']]);
  });

  it('cancelAllDownloads with nothing active does not call into Rust', () => {
    let called = false;
    onInvoke('cancel_offline_downloads', () => {
      called = true;
    });
    useOfflineJobStore.setState({
      jobs: [job({ status: 'done' }), job({ status: 'error' })],
      bulkProgress: {},
    });

    useOfflineJobStore.getState().cancelAllDownloads();

    expect(called).toBe(false);
    expect(useOfflineJobStore.getState().jobs).toHaveLength(2);
  });
});
