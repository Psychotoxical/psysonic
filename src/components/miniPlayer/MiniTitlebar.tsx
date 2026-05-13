import { Maximize2, Pin, PinOff, X } from 'lucide-react';
import type { TFunction } from 'i18next';
import { IS_LINUX } from '../../utils/platform';

interface Props {
  trackTitle: string | undefined;
  alwaysOnTop: boolean;
  toggleOnTop: () => void;
  showMain: () => void;
  closeMini: () => void;
  t: TFunction;
}

export function MiniTitlebar({
  trackTitle, alwaysOnTop, toggleOnTop, showMain, closeMini, t,
}: Props) {
  return (
    <div
      className={`mini-player__titlebar${!IS_LINUX ? ' mini-player__titlebar--mac' : ''}`}
      {...(!IS_LINUX ? {} : { 'data-tauri-drag-region': true })}
    >
      {IS_LINUX ? (
        <span className="mini-player__titlebar-title" data-tauri-drag-region>
          {trackTitle ?? 'Psysonic Mini'}
        </span>
      ) : (
        // macOS/Windows already render a native titlebar with the window
        // title + close button; we just need a flexible spacer so the
        // action buttons sit right.
        <span className="mini-player__titlebar-spacer" />
      )}
      <button
        type="button"
        className={`mini-player__titlebar-btn${alwaysOnTop ? ' mini-player__titlebar-btn--active' : ''}`}
        onClick={toggleOnTop}
        data-tauri-drag-region="false"
        data-tooltip={alwaysOnTop ? t('miniPlayer.pinOff') : t('miniPlayer.pinOnTop')}
        aria-label={alwaysOnTop ? t('miniPlayer.pinOff') : t('miniPlayer.pinOnTop')}
      >
        {alwaysOnTop ? <Pin size={13} /> : <PinOff size={13} />}
      </button>
      <button
        type="button"
        className="mini-player__titlebar-btn"
        onClick={showMain}
        data-tauri-drag-region="false"
        data-tooltip={t('miniPlayer.openMainWindow')}
        aria-label={t('miniPlayer.openMainWindow')}
      >
        <Maximize2 size={13} />
      </button>
      {/* macOS + Windows already provide Close via the native titlebar —
          skip the duplicate so the in-app titlebar stays minimal. */}
      {IS_LINUX && (
        <button
          type="button"
          className="mini-player__titlebar-btn mini-player__titlebar-btn--close"
          onClick={closeMini}
          data-tauri-drag-region="false"
          data-tooltip={t('miniPlayer.close')}
          aria-label={t('miniPlayer.close')}
        >
          <X size={13} />
        </button>
      )}
    </div>
  );
}
