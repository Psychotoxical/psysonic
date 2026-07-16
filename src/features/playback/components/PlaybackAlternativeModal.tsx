import { useRef } from 'react';
import { createPortal } from 'react-dom';
import { Server, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { usePlaybackAlternativeStore } from '@/features/playback/store/playbackAlternativeStore';
import { useModalFocus } from '@/lib/hooks/useModalFocus';

export default function PlaybackAlternativeModal() {
  const { t } = useTranslation();
  const firstActionRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const { isOpen, status, detail, alternatives, close, choose } = usePlaybackAlternativeStore(
    useShallow(state => ({
      isOpen: state.isOpen,
      status: state.status,
      detail: state.detail,
      alternatives: state.alternatives,
      close: state.close,
      choose: state.choose,
    })),
  );

  useModalFocus({
    open: isOpen,
    containerRef: dialogRef,
    onEscape: close,
    initialFocusRef: closeRef,
  });

  if (!isOpen) return null;
  return createPortal(
    <div
      className="modal-overlay playback-alternative-overlay"
      onClick={close}
    >
      <div
        ref={dialogRef}
        className="modal-content playback-alternative-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="playback-alternative-title"
        aria-describedby="playback-alternative-description"
        tabIndex={-1}
        onClick={event => event.stopPropagation()}
      >
        <button ref={closeRef} type="button" className="modal-close" onClick={close} aria-label={t('player.playbackAlternativeClose')}>
          <X size={18} />
        </button>
        <div className="playback-alternative-modal__heading">
          <Server size={20} aria-hidden="true" />
          <h2 id="playback-alternative-title" className="modal-title">
            {t('player.playbackAlternativeTitle')}
          </h2>
        </div>
        <p id="playback-alternative-description" className="playback-alternative-modal__description">
          {t('player.playbackAlternativeDescription')}
        </p>
        {detail && <p className="playback-alternative-modal__detail">{detail}</p>}

        <div className="playback-alternative-modal__actions" aria-live="polite">
          {status === 'loading' && <p>{t('player.playbackAlternativeLoading')}</p>}
          {status === 'empty' && <p>{t('player.playbackAlternativeNone')}</p>}
          {status === 'error' && <p>{t('player.playbackAlternativeResolveError')}</p>}
          {status === 'ready' && alternatives.map((alternative, index) => (
            <button
              key={`${alternative.source.serverId}:${alternative.source.id}`}
              ref={index === 0 ? firstActionRef : undefined}
              type="button"
              className="btn btn-primary playback-alternative-modal__choice"
              onClick={() => { void choose(alternative); }}
            >
              {t('player.playbackAlternativePlayFrom', { server: alternative.serverName })}
              {alternative.local && (
                <span className="playback-alternative-modal__local">
                  {t('player.playbackAlternativeLocal')}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
