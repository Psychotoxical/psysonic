import { StrictMode } from 'react';
import ReactDOM, { type Root } from 'react-dom/client';
import i18n from '@/lib/i18n';
import { getWindowKind } from './app/windowKind';
import {
  observeNavidromeCanonicalSuccessfulPing,
  runNavidromeCanonicalMigrationCoordinator,
  type NavidromeCanonicalMigrationProgress,
} from './app/migrations/navidromeCanonicalCoordinator';
import { installNavidromeCanonicalWindowGate } from './app/migrations/navidromeCanonicalWindowGate';
import {
  installImportedBackupCoordinator,
} from '@/features/settings/utils/backup';
import { reconcileFullBackupImportRecoveryForWindow } from './app/fullBackupRecoveryStartup';
import {
  armNavidromeCanonicalBackupImport,
  captureNavidromeCanonicalBackupRecoveryState,
  disarmNavidromeCanonicalBackupImport,
  normalizeNavidromeCanonicalBackupStores,
  prepareNavidromeCanonicalDatabaseImport,
  restoreNavidromeCanonicalBackupRecoveryState,
} from './app/migrations/navidromeCanonicalBackup';
import {
  installNavidromeCanonicalHistoryNormalizer,
  rewriteNavidromeCanonicalHistoryForReadyServers,
} from './app/migrations/navidromeCanonicalHistory';
import './styles/themes/index.css';
import './styles/layout/index.css';
import './styles/components/index.css';
import './styles/tracks/index.css';

const rootElement = document.getElementById('root')!;
let applicationRoot: Root | null = null;

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  })[character]!);
}

function renderMigrationShell(
  progress?: NavidromeCanonicalMigrationProgress,
  error?: unknown,
): void {
  const phase = progress?.phase === 'probing' ? i18n.t('migration.preparing') : i18n.t('migration.migrating');
  const detail = error
    ? String(error instanceof Error ? error.message : error).slice(0, 500)
    : progress?.step ?? i18n.t('migration.working');
  const safeTitle = escapeHtml(error ? i18n.t('migration.failed') : phase);
  const safeDetail = escapeHtml(detail);
  rootElement.innerHTML = `
    <main style="min-height:100vh;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--text)">
      <section role="${error ? 'alert' : 'status'}" aria-live="${error ? 'assertive' : 'polite'}" style="width:min(560px,92vw);padding:24px 28px;border-radius:14px;background:var(--bg-card);box-shadow:var(--shadow-lg)">
        <h2 style="margin:0 0 12px">${safeTitle}</h2>
        <p style="margin:0;color:var(--text-muted);overflow-wrap:anywhere">${safeDetail}</p>
        ${error ? `
          <div style="display:flex;gap:8px;margin-top:16px">
            <button id="canonical-migration-retry" class="btn-primary">${escapeHtml(i18n.t('migration.retry'))}</button>
            <button id="canonical-migration-copy" class="btn-surface">${escapeHtml(i18n.t('migration.copyDetails'))}</button>
          </div>
        ` : ''}
      </section>
    </main>
  `;
  if (error) {
    const retry = document.getElementById('canonical-migration-retry');
    retry?.addEventListener('click', () => window.location.reload());
    document.getElementById('canonical-migration-copy')?.addEventListener('click', () => {
      void navigator.clipboard.writeText(detail).catch(() => {});
    });
    retry?.focus();
  }
}

function freezeApplication(): void {
  applicationRoot?.unmount();
  applicationRoot = null;
  renderMigrationShell({
    serverId: null,
    phase: 'pending',
    step: null,
    completed: 0,
    total: 0,
  });
}

async function mountApplication(): Promise<void> {
  const windowKind = getWindowKind();
  const windowGate = installNavidromeCanonicalWindowGate({
    onLock: () => {
      const hadMountedApplication = applicationRoot !== null;
      freezeApplication();
      if (hadMountedApplication) window.location.reload();
    },
    onUnlock: () => {
      if (applicationRoot === null) window.location.reload();
    },
  });
  if (windowKind === 'mini' && windowGate.engageIfActive()) return;
  renderMigrationShell({ serverId: null, phase: 'probing', step: null, completed: 0, total: 0 });
  installImportedBackupCoordinator({
    arm: () => armNavidromeCanonicalBackupImport(),
    disarm: () => disarmNavidromeCanonicalBackupImport(),
    captureRecoveryState: () => captureNavidromeCanonicalBackupRecoveryState(),
    restoreRecoveryState: snapshot => restoreNavidromeCanonicalBackupRecoveryState(snapshot),
    normalizeStores: stores => normalizeNavidromeCanonicalBackupStores(stores),
    prepareDatabaseImport: stores => prepareNavidromeCanonicalDatabaseImport(stores),
  });
  await reconcileFullBackupImportRecoveryForWindow(windowKind);
  const result = await runNavidromeCanonicalMigrationCoordinator({
    windowKind,
    onProgress: progress => renderMigrationShell(progress),
  });
  if (result.blocked) {
    renderMigrationShell({ serverId: null, phase: 'pending', step: null, completed: 0, total: 0 });
    window.setTimeout(() => window.location.reload(), 2_000);
    return;
  }

  rewriteNavidromeCanonicalHistoryForReadyServers();
  installNavidromeCanonicalHistoryNormalizer();

  const { installSuccessfulPingObserver } = await import('@/lib/server/serverEndpoint');
  installSuccessfulPingObserver(async (profile, successfulProbe, isCurrent) => {
    let reloadRequired: boolean;
    try {
      reloadRequired = await observeNavidromeCanonicalSuccessfulPing({
        profile,
        ping: successfulProbe.ping,
        isCurrent,
        beforeAdmission: async () => {
          freezeApplication();
          const [{ useOfflineJobStore }, { waitForAllOfflineTransfers }] = await Promise.all([
            import('@/features/offline/store/offlineJobStore'),
            import('@/features/offline/utils/offlineOperationCoordinator'),
          ]);
          useOfflineJobStore.getState().cancelAllDownloads();
          await waitForAllOfflineTransfers();
        },
      });
    } catch (error) {
      if (applicationRoot === null) renderMigrationShell(undefined, error);
      throw error;
    }
    if (!reloadRequired) return;
    window.location.reload();
    await new Promise<void>(() => {});
  });
  if (windowGate.engageIfActive()) return;

  const [{ runPreReactBootstrap }, { default: App }] = await Promise.all([
    import('./app/bootstrap'),
    import('./App'),
  ]);
  if (windowGate.engageIfActive()) return;
  runPreReactBootstrap();
  if (windowGate.engageIfActive()) return;
  applicationRoot = ReactDOM.createRoot(rootElement);
  applicationRoot.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void mountApplication().catch(error => renderMigrationShell(undefined, error));
