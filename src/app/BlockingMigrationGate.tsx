import type { ReactNode } from 'react';
import { retryServerIndexMigration } from '../hooks/useMigrationOrchestrator';
import { useMigrationStore } from '../store/migrationStore';

function MigrationModal() {
  const phase = useMigrationStore(s => s.phase);
  const progress = useMigrationStore(s => s.progress);
  const inspect = useMigrationStore(s => s.inspect);
  const error = useMigrationStore(s => s.lastError);

  const migratedRows = (inspect?.library.totalLegacyRows ?? 0) + (inspect?.analysis.totalLegacyRows ?? 0);
  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      background: 'rgba(0, 0, 0, 0.65)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 99999,
    }}
    >
      <div style={{
        width: 'min(560px, 92vw)',
        background: 'var(--bg-card)',
        borderRadius: 14,
        padding: '1.5rem 1.75rem',
        color: 'var(--text)',
      }}
      >
        {phase === 'inspecting' && (
          <>
            <h3>Preparing data update…</h3>
            <p style={{ color: 'var(--text-muted)' }}>Looking at your library and analysis cache…</p>
          </>
        )}
        {phase === 'running' && (
          <>
            <h3>Migrating data</h3>
            <p style={{ color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
              {progress ? `${progress.stage} - ${progress.table}` : 'running'}
            </p>
            <p style={{ color: 'var(--text-muted)' }}>
              {progress ? `${progress.done} / ${progress.total}` : 'working…'}
            </p>
            {inspect?.hasSkippedUnknownServerRows ? (
              <p style={{ color: 'var(--text-muted)', marginTop: '0.5rem' }}>
                Rows for removed servers were skipped and old backup DB will be removed after successful switch.
              </p>
            ) : null}
          </>
        )}
        {phase === 'error' && (
          <>
            <h3>Migration failed</h3>
            <p style={{ color: 'var(--text-muted)' }}>{String(error ?? '').slice(0, 200)}</p>
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button className="btn-primary" onClick={() => retryServerIndexMigration()}>Retry</button>
              <button className="btn-surface" onClick={() => navigator.clipboard.writeText(String(error ?? ''))}>
                Copy details
              </button>
            </div>
          </>
        )}
        {phase === 'completed' && (
          <>
            <h3>Update complete</h3>
            <p style={{ color: 'var(--text-muted)' }}>{migratedRows} rows migrated</p>
          </>
        )}
      </div>
    </div>
  );
}

export default function BlockingMigrationGate({ children }: { children: ReactNode }) {
  const phase = useMigrationStore(s => s.phase);
  const isBlocking = phase === 'inspecting' || phase === 'running' || phase === 'error';
  return (
    <>
      {children}
      {isBlocking ? <MigrationModal /> : null}
    </>
  );
}
