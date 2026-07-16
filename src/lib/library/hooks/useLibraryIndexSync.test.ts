import { beforeEach, describe, expect, it } from 'vitest';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';
import { applyLibraryConnectionResults } from './useLibraryIndexSync';

describe('applyLibraryConnectionResults', () => {
  beforeEach(() => {
    useLibraryIndexStore.setState({ connectionByServer: {} });
  });

  it('merges partial retry results without resetting healthy servers', () => {
    useLibraryIndexStore.setState({
      connectionByServer: {
        healthy: 'online',
        retrying: 'offline',
        untouched: 'unknown',
      },
    });

    applyLibraryConnectionResults({ retrying: 'bound' });

    expect(useLibraryIndexStore.getState().connectionByServer).toEqual({
      healthy: 'online',
      retrying: 'online',
      untouched: 'unknown',
    });
  });

  it('replaces the complete bootstrap snapshot and marks missing servers unknown', () => {
    useLibraryIndexStore.setState({
      connectionByServer: { first: 'offline', second: 'online', stale: 'online' },
    });

    applyLibraryConnectionResults({ first: 'bound' }, ['first', 'second']);

    expect(useLibraryIndexStore.getState().connectionByServer).toEqual({
      first: 'online',
      second: 'unknown',
    });
  });
});
