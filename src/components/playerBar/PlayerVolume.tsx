import React from 'react';
import { Volume2, VolumeX } from 'lucide-react';
import type { TFunction } from 'i18next';

interface Props {
  volume: number;
  setVolume: (v: number) => void;
  premuteVolumeRef: React.MutableRefObject<number>;
  showVolPct: boolean;
  setShowVolPct: (v: boolean) => void;
  handleVolume: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleVolumeWheel: (e: React.WheelEvent<HTMLElement>) => void;
  volumeStyle: React.CSSProperties;
  inputId: string;
  /** 'menu' adds the --menu modifier to the outer section (used inside the
   *  overflow menu so the layout adapts). Defaults to no modifier. */
  sectionModifier?: 'menu';
  /** 'menu-only' adds the --menu-only modifier to the slider wrap, widening
   *  it when the menu is in volume-only mode. */
  wrapModifier?: 'menu-only';
  t: TFunction;
}

export function PlayerVolume({
  volume, setVolume, premuteVolumeRef, showVolPct, setShowVolPct,
  handleVolume, handleVolumeWheel, volumeStyle, inputId,
  sectionModifier, wrapModifier, t,
}: Props) {
  const sectionClass = `player-volume-section${sectionModifier ? ` player-volume-section--${sectionModifier}` : ''}`;
  const wrapClass = `player-volume-slider-wrap${wrapModifier ? ` player-volume-slider-wrap--${wrapModifier}` : ''}`;
  return (
    <div className={sectionClass}>
      <button
        className="player-btn player-btn-sm"
        onClick={() => {
          if (volume === 0) {
            setVolume(premuteVolumeRef.current);
          } else {
            premuteVolumeRef.current = volume;
            setVolume(0);
          }
        }}
        aria-label={t('player.volume')}
        style={{ color: 'var(--text-muted)', flexShrink: 0 }}
      >
        {volume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
      </button>
      <div className={wrapClass} onWheel={handleVolumeWheel}>
        {showVolPct && (
          <span className="player-volume-pct" style={{ left: `${volume * 100}%` }}>
            {Math.round(volume * 100)}%
          </span>
        )}
        <input
          type="range"
          id={inputId}
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={handleVolume}
          style={volumeStyle}
          aria-label={t('player.volume')}
          className="player-volume-slider"
          onMouseEnter={() => setShowVolPct(true)}
          onMouseLeave={() => setShowVolPct(false)}
        />
      </div>
    </div>
  );
}
