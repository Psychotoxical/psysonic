import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Music, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import type { ServerProfile } from '@/store/authStoreTypes';
import { formatTrackTime } from '@/lib/format/formatDuration';
import type { ShareQueuePreviewState } from '@/features/search/hooks/useShareQueuePreview';
import { sharePayloadTotal, type QueueableShareSearchPayload } from '@/lib/share/shareSearch';
import OverlayScrollArea from '@/ui/OverlayScrollArea';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { COVER_DENSE_SEARCH_CSS_PX } from '@/cover/layoutSizes';
import { COVER_SCOPE_ACTIVE, type CoverServerScope } from '@/cover/types';
import { AlbumCoverArtImage } from '@/cover/AlbumCoverArtImage';

type ShareQueuePreviewModalProps = {
  open: boolean;
  onClose: () => void;
  payload: Extract<QueueableShareSearchPayload, { k: 'queue' }>;
  preview: ShareQueuePreviewState;
  shareServerLabel?: string | null;
  coverServer?: ServerProfile | null;
  onEnqueue: () => void;
  enqueueBusy: boolean;
  confirmLabel?: string;
  confirmBusyLabel?: string;
};

function shareCoverServerScope(coverServer?: ServerProfile | null): CoverServerScope {
  if (coverServer) {
    return {
      kind: 'server',
      serverId: coverServer.id,
      url: coverServer.url,
      username: coverServer.username,
      password: coverServer.password,
    };
  }
  return COVER_SCOPE_ACTIVE;
}

function QueuePreviewTrackRow({
  song,
  coverServer,
}: {
  song: SubsonicSong;
  coverServer?: ServerProfile | null;
}) {
  const coverId = song.coverArt || song.id;

  return (
    <li className="share-queue-preview-track">
      {song.coverArt ? (
        <AlbumCoverArtImage
          albumId={song.albumId ?? coverId}
          coverArt={song.coverArt}
          serverScope={shareCoverServerScope(coverServer)}
          displayCssPx={COVER_DENSE_SEARCH_CSS_PX}
          surface="dense"
          className="share-queue-preview-track__thumb"
          alt=""
        />
      ) : (
        <div className="share-queue-preview-track__icon">
          <Music size={16} />
        </div>
      )}
      <div className="share-queue-preview-track__meta">
        <div className="share-queue-preview-track__title">{song.title}</div>
        <div className="share-queue-preview-track__sub">
          {song.artist}{song.album ? ` · ${song.album}` : ''}
        </div>
      </div>
      <span className="share-queue-preview-track__dur">{formatTrackTime(song.duration)}</span>
    </li>
  );
}

function PreviewBody({
  preview,
  coverServer,
}: {
  preview: ShareQueuePreviewState;
  coverServer?: ServerProfile | null;
}) {
  const { t } = useTranslation();

  if (preview.status === 'loading' || preview.status === 'idle') {
    return <div className="share-queue-preview-modal__status">{t('search.shareQueuePreviewLoading')}</div>;
  }

  if (preview.status === 'error') {
    const msg =
      preview.result.type === 'not-logged-in'
        ? t('sharePaste.notLoggedIn')
        : preview.result.type === 'no-matching-server'
          ? t('sharePaste.noMatchingServer', { url: preview.result.url })
          : preview.result.type === 'all-unavailable'
            ? t('search.shareQueuePreviewEmpty')
            : t('sharePaste.genericError');
    return <div className="share-queue-preview-modal__status share-queue-preview-modal__status--error">{msg}</div>;
  }

  return (
    <>
      {preview.skipped > 0 && (
        <p className="share-queue-preview-modal__skipped">
          {t('search.shareQueuePreviewSkipped', { skipped: preview.skipped, total: preview.total })}
        </p>
      )}
      <OverlayScrollArea
        className="share-queue-preview-modal__list-wrap"
        viewportClassName="share-queue-preview-modal__list-viewport"
        measureDeps={[preview.songs.length, preview.skipped]}
        railInset="panel"
      >
        <ul className="share-queue-preview-modal__list">
          {preview.songs.map(song => (
            <QueuePreviewTrackRow key={song.id} song={song} coverServer={coverServer} />
          ))}
        </ul>
      </OverlayScrollArea>
    </>
  );
}

export default function ShareQueuePreviewModal({
  open,
  onClose,
  payload,
  preview,
  shareServerLabel,
  coverServer,
  onEnqueue,
  enqueueBusy,
  confirmLabel,
  confirmBusyLabel,
}: ShareQueuePreviewModalProps) {
  const { t } = useTranslation();
  const actionLabel = confirmLabel ?? t('search.shareQueueAction');
  const actionBusyLabel = confirmBusyLabel ?? t('search.shareQueueing');

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

  const count = sharePayloadTotal(payload);
  const canEnqueue = preview.status === 'ok' && preview.songs.length > 0;

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
        aria-labelledby="share-queue-preview-title"
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
          <h2 id="share-queue-preview-title" className="share-queue-preview-modal__title">
            {t('search.shareQueueTitle', { count })}
          </h2>
          {shareServerLabel && (
            <p className="share-queue-preview-modal__server">
              {t('search.shareFromServer', { server: shareServerLabel })}
            </p>
          )}
        </header>

        <div className="share-queue-preview-modal__body">
          <PreviewBody preview={preview} coverServer={coverServer} />
        </div>

        <footer className="share-queue-preview-modal__footer">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canEnqueue || enqueueBusy}
            onClick={() => void onEnqueue()}
          >
            {enqueueBusy ? actionBusyLabel : actionLabel}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
