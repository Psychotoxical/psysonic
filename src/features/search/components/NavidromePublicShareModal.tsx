import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Music, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { open as openUrl } from '@tauri-apps/plugin-shell';
import type { NavidromePublicShareRef } from '@/lib/share/navidromePublicShareUrl';
import type { NavidromePublicSharePreviewState } from '@/features/search/hooks/useNavidromePublicSharePreview';
import { formatTrackTime } from '@/lib/format/formatDuration';
import OverlayScrollArea from '@/ui/OverlayScrollArea';
import { usePlayerStore } from '@/features/playback';

type NavidromePublicShareModalProps = {
  open: boolean;
  onClose: () => void;
  publicShareRef: NavidromePublicShareRef;
  preview: NavidromePublicSharePreviewState;
  hostLabel?: string | null;
  onPlay: () => void;
  playBusy: boolean;
};

function navidromeShareErrorMessage(
  reason: NonNullable<NavidromePublicSharePreviewState['navidromeShareError']>,
  t: (key: string) => string,
): string {
  switch (reason) {
    case 'not-found':
      return t('sharePaste.navidromeShareNotFound');
    case 'expired':
      return t('sharePaste.navidromeShareExpired');
    case 'unreachable':
      return t('sharePaste.navidromeShareUnreachable');
    default:
      return t('sharePaste.navidromeShareMalformed');
  }
}

function PreviewBody({
  preview,
}: {
  preview: NavidromePublicSharePreviewState;
}) {
  const { t } = useTranslation();

  if (preview.navidromeShareResolving) {
    return <div className="share-queue-preview-modal__status">{t('sharePaste.navidromeShareLoading')}</div>;
  }

  if (preview.navidromeShareError) {
    return (
      <div className="share-queue-preview-modal__status share-queue-preview-modal__status--error">
        {navidromeShareErrorMessage(preview.navidromeShareError, t)}
      </div>
    );
  }

  const info = preview.navidromeShareInfo;
  if (!info) {
    return (
      <div className="share-queue-preview-modal__status share-queue-preview-modal__status--error">
        {t('sharePaste.navidromeShareMalformed')}
      </div>
    );
  }

  return (
    <>
      {info.imageUrl && (
        <div className="share-queue-preview-modal__cover">
          <img src={info.imageUrl} alt="" className="share-queue-preview-modal__cover-img" />
        </div>
      )}
      <OverlayScrollArea
        className="share-queue-preview-modal__list-wrap"
        viewportClassName="share-queue-preview-modal__list-viewport"
        measureDeps={[info.tracks.length]}
        railInset="panel"
      >
        <ul className="share-queue-preview-modal__list">
          {info.tracks.map(track => (
            <li key={track.id} className="share-queue-preview-track">
              <div className="share-queue-preview-track__icon">
                <Music size={16} />
              </div>
              <div className="share-queue-preview-track__meta">
                <div className="share-queue-preview-track__title">{track.title}</div>
                <div className="share-queue-preview-track__sub">
                  {track.artist}{track.album ? ` · ${track.album}` : ''}
                </div>
              </div>
              {track.duration > 0 && (
                <span className="share-queue-preview-track__dur">{formatTrackTime(track.duration)}</span>
              )}
            </li>
          ))}
        </ul>
      </OverlayScrollArea>
    </>
  );
}

export default function NavidromePublicShareModal({
  open,
  onClose,
  publicShareRef: shareRef,
  preview,
  hostLabel,
  onPlay,
  playBusy,
}: NavidromePublicShareModalProps) {
  const { t } = useTranslation();
  const count = preview.navidromeShareInfo?.tracks.length ?? 0;
  const title = preview.navidromeShareInfo?.description?.trim()
    || t('sharePaste.navidromeShareTitle', { count: count || 1 });
  const canPlay = !!preview.navidromeShareInfo && preview.navidromeShareInfo.tracks.length > 0;

  useEffect(() => {
    if (!open) return;
    usePlayerStore.getState().closeContextMenu();
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const blockContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      usePlayerStore.getState().closeContextMenu();
    };
    document.addEventListener('keydown', handler);
    document.addEventListener('contextmenu', blockContextMenu, true);
    return () => {
      document.removeEventListener('keydown', handler);
      document.removeEventListener('contextmenu', blockContextMenu, true);
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="modal-overlay share-queue-preview-modal-overlay"
      role="presentation"
      onContextMenu={e => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onMouseDown={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal-content share-queue-preview-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="navidrome-share-preview-title"
        onContextMenu={e => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onMouseDown={e => e.stopPropagation()}
      >
        <button type="button" className="modal-close" onClick={onClose} aria-label={t('common.close')}>
          <X size={18} />
        </button>

        <header className="share-queue-preview-modal__header">
          <h2 id="navidrome-share-preview-title" className="share-queue-preview-modal__title">
            {title}
          </h2>
          {hostLabel && (
            <p className="share-queue-preview-modal__server">
              {t('search.shareFromServer', { server: hostLabel })}
            </p>
          )}
        </header>

        <div className="share-queue-preview-modal__body">
          <PreviewBody preview={preview} />
        </div>

        <footer className="share-queue-preview-modal__footer">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => void openUrl(shareRef.pageUrl)}
          >
            {t('sharePaste.openInBrowser')}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canPlay || playBusy}
            onClick={() => void onPlay()}
          >
            {playBusy ? t('sharePaste.navidromeSharePlaying') : t('sharePaste.navidromeSharePlay')}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
