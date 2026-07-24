import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Volume2, VolumeX } from 'lucide-react';
import { useVolumeToggle } from '@/features/playback';

type FsVolumeProps = {
  /** Container class (per mode). Prism uses it to hover-reveal the slider; Minimal/Immersive render it always-visible. */
  className?: string;
  /** Mute-toggle button class (per fullscreen mode's button idiom). */
  buttonClassName?: string;
  /** Range-input class (per fullscreen mode's slider idiom). */
  sliderClassName?: string;
  /** Icon size, matched to the mode's other transport buttons. */
  iconSize?: number;
  /** Show a hover tooltip on the mute button (modes whose transport buttons use `data-tooltip`). */
  showTooltip?: boolean;
};

/**
 * Shared fullscreen-player volume control — the mute toggle + level slider used
 * by every fullscreen style (Minimal, Immersive, Prism). One `useVolumeToggle`
 * call site and one a11y pattern; each mode passes its own class names so the
 * control keeps that mode's visual language (Prism's `fsp2-*`, Minimal's
 * `fsp-*`, Immersive's `fs-*`).
 */
export const FsVolume = memo(function FsVolume({
  className,
  buttonClassName,
  sliderClassName,
  iconSize = 18,
  showTooltip = false,
}: FsVolumeProps) {
  const { t } = useTranslation();
  const { volume, setVolume, muted, toggleMute } = useVolumeToggle();
  const label = muted ? t('player.unmute') : t('player.mute');
  return (
    <div className={className}>
      <button
        className={buttonClassName}
        aria-label={label}
        data-tooltip={showTooltip ? label : undefined}
        onClick={toggleMute}
      >
        {muted ? <VolumeX size={iconSize} /> : <Volume2 size={iconSize} />}
      </button>
      <input
        className={sliderClassName}
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={volume}
        onChange={e => setVolume(parseFloat(e.target.value))}
        aria-label={t('player.volume')}
        aria-valuetext={`${Math.round(volume * 100)}%`}
      />
    </div>
  );
});
