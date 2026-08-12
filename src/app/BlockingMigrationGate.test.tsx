import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useMigrationStore } from '@/store/migrationStore';
import BlockingMigrationGate from './BlockingMigrationGate';

describe('BlockingMigrationGate', () => {
  beforeEach(() => {
    useMigrationStore.setState({
      phase: 'running',
      step: 'canonicalIds',
      progress: { stage: 'legacy stage', table: 'legacy table', done: 8, total: 10 },
      inspect: {
        needsMigration: true,
        canRun: true,
        hasSkippedUnknownServerRows: true,
        warnings: [],
        unmappedEmptyBucket: false,
        library: { totalLegacyRows: 10, skippedUnknownServerRows: 1, tables: {} },
        analysis: { totalLegacyRows: 2, skippedUnknownServerRows: 0, tables: {} },
        mappings: [],
      },
      lastError: null,
    });
  });

  it('does not display stale server-index progress during canonical reconciliation', () => {
    render(<BlockingMigrationGate><div>app</div></BlockingMigrationGate>);

    expect(screen.queryByText('legacy stage - legacy table')).not.toBeInTheDocument();
    expect(screen.queryByText('8 / 10')).not.toBeInTheDocument();
  });
});
