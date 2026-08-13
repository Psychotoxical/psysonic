import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import BlockingMigrationGate from './BlockingMigrationGate';
import { useMigrationStore } from '@/store/migrationStore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/app/hooks/useMigrationOrchestrator', () => ({
  retryBlockingMigration: vi.fn(),
}));

describe('BlockingMigrationGate', () => {
  beforeEach(() => {
    useMigrationStore.setState({ phase: 'idle', step: null, lastError: null });
  });

  it('blocks the initial idle frame before the first inspect resolves', () => {
    render(
      <BlockingMigrationGate>
        <div>normal app</div>
      </BlockingMigrationGate>,
    );

    expect(screen.queryByText('normal app')).toBeNull();
    expect(screen.getByText('migration.preparing')).toBeInTheDocument();
  });

  it('does not mount normal application children while migration is blocking', () => {
    useMigrationStore.setState({ phase: 'running', step: 'navidromeCanonical' });

    render(
      <BlockingMigrationGate>
        <div>normal app</div>
      </BlockingMigrationGate>,
    );

    expect(screen.queryByText('normal app')).toBeNull();
    expect(screen.getByText('migration.migrating')).toBeInTheDocument();
  });

  it('mounts normal application children only after migration completes', () => {
    useMigrationStore.setState({ phase: 'completed', step: null });

    render(
      <BlockingMigrationGate>
        <div>normal app</div>
      </BlockingMigrationGate>,
    );

    expect(screen.getByText('normal app')).toBeInTheDocument();
  });
});
