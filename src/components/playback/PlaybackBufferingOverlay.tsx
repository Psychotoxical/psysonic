import { Clock } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/** Shown over cover art while an HTTP stream is still opening / buffering. */
export function PlaybackBufferingOverlay() {
  const { t } = useTranslation();
  return (
    <div
      className="playback-buffering-overlay"
      role="status"
      aria-live="polite"
      aria-label={t('player.bufferingStream')}
    >
      <Clock size={26} strokeWidth={2} className="playback-buffering-overlay__icon" aria-hidden />
    </div>
  );
}
