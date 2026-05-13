import { useTranslation } from 'react-i18next';
import { HardDriveDownload, HardDriveUpload, X } from 'lucide-react';

interface Props {
  isCollapsed: boolean;
  activeJobsCount: number;
  cancelAllDownloads: () => void;
  isSyncing: boolean;
  syncJobDone: number;
  syncJobSkip: number;
  syncJobFail: number;
  syncJobTotal: number;
}

export default function SidebarActiveJobs({
  isCollapsed, activeJobsCount, cancelAllDownloads,
  isSyncing, syncJobDone, syncJobSkip, syncJobFail, syncJobTotal,
}: Props) {
  const { t } = useTranslation();
  return (
    <>
      {activeJobsCount > 0 && (
        <div
          className={`sidebar-offline-queue ${isCollapsed ? 'sidebar-offline-queue--collapsed' : ''}`}
          data-tooltip={isCollapsed ? t('sidebar.downloadingTracks', { n: activeJobsCount }) : undefined}
          data-tooltip-pos="right"
        >
          <HardDriveDownload size={isCollapsed ? 18 : 14} className="spin-slow" />
          {!isCollapsed && (
            <span>{t('sidebar.downloadingTracks', { n: activeJobsCount })}</span>
          )}
          <button
            className="sidebar-offline-cancel"
            onClick={cancelAllDownloads}
            data-tooltip={t('sidebar.cancelDownload')}
            data-tooltip-pos="right"
            aria-label={t('sidebar.cancelDownload')}
          >
            <X size={12} />
          </button>
        </div>
      )}

      {isSyncing && (
        <div
          className={`sidebar-offline-queue sidebar-sync-queue ${isCollapsed ? 'sidebar-offline-queue--collapsed' : ''}`}
          data-tooltip={isCollapsed ? t('sidebar.syncingTracks', { done: syncJobDone + syncJobSkip + syncJobFail, total: syncJobTotal }) : undefined}
          data-tooltip-pos="right"
        >
          <HardDriveUpload size={isCollapsed ? 18 : 14} className="spin-slow" />
          {!isCollapsed && (
            <span>{t('sidebar.syncingTracks', { done: syncJobDone + syncJobSkip + syncJobFail, total: syncJobTotal })}</span>
          )}
        </div>
      )}
    </>
  );
}
