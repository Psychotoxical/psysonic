import { useTranslation } from 'react-i18next';
import { HardDriveDownload, HardDriveUpload, X } from 'lucide-react';

interface Props {
  isCollapsed: boolean;
  activeJobsCount: number;
  activePinName: string | null;
  queuedPinCount: number;
  cancelAllDownloads: () => void;
  isSyncing: boolean;
  syncJobDone: number;
  syncJobSkip: number;
  syncJobFail: number;
  syncJobTotal: number;
}

export default function SidebarActiveJobs({
  isCollapsed, activeJobsCount, activePinName, queuedPinCount, cancelAllDownloads,
  isSyncing, syncJobDone, syncJobSkip, syncJobFail, syncJobTotal,
}: Props) {
  const { t } = useTranslation();
  const showPinQueue = !!activePinName || queuedPinCount > 0;
  const offlineQueueLabel = showPinQueue
    ? (queuedPinCount > 0
      ? t('sidebar.offlinePinActiveQueued', { name: activePinName ?? '', queued: queuedPinCount })
      : t('sidebar.offlinePinActive', { name: activePinName ?? '' }))
    : t('sidebar.downloadingTracks', { n: activeJobsCount });
  const syncLabel = t('sidebar.syncingTracks', {
    done: syncJobDone + syncJobSkip + syncJobFail,
    total: syncJobTotal,
  });

  return (
    <>
      {(activeJobsCount > 0 || showPinQueue) && (
        <div
          className={`sidebar-offline-queue ${isCollapsed ? 'sidebar-offline-queue--collapsed' : ''}`}
          data-tooltip={offlineQueueLabel}
          data-tooltip-pos="right"
        >
          <HardDriveDownload size={isCollapsed ? 18 : 14} className="spin-slow" />
          {!isCollapsed && (
            <span>{offlineQueueLabel}</span>
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
          data-tooltip={syncLabel}
          data-tooltip-pos="right"
        >
          <HardDriveUpload size={isCollapsed ? 18 : 14} className="spin-slow" />
          {!isCollapsed && (
            <span>{syncLabel}</span>
          )}
        </div>
      )}
    </>
  );
}
