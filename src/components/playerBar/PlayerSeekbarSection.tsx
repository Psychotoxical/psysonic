import { ArrowLeftRight } from 'lucide-react';
import type { TFunction } from 'i18next';
import type { RadioMetadata } from '../../hooks/useRadioMetadata';
import { useThemeStore } from '../../store/themeStore';
import { formatTime } from '../../utils/playerBarHelpers';
import WaveformSeek from '../WaveformSeek';
import { PlaybackTime, RemainingTime } from './PlaybackClock';

interface Props {
  isRadio: boolean;
  radioMeta: RadioMetadata;
  trackId: string | undefined;
  duration: number;
  localShowRemaining: boolean;
  setLocalShowRemaining: (v: boolean) => void;
  disableWaveformCanvas: boolean;
  t: TFunction;
}

export function PlayerSeekbarSection({
  isRadio, radioMeta, trackId, duration, localShowRemaining, setLocalShowRemaining,
  disableWaveformCanvas, t,
}: Props) {
  return (
    <div className="player-waveform-section">
      {isRadio ? (
        <>
          {radioMeta.source === 'azuracast' && radioMeta.elapsed != null && radioMeta.duration != null && radioMeta.duration > 0 ? (
            <>
              <span className="player-time">{formatTime(radioMeta.elapsed)}</span>
              <div className="player-waveform-wrap">
                <div className="radio-progress-bar">
                  <div
                    className="radio-progress-fill"
                    style={{ width: `${Math.min(100, (radioMeta.elapsed / radioMeta.duration) * 100)}%` }}
                  />
                </div>
              </div>
              <span className="player-time">{formatTime(radioMeta.duration)}</span>
            </>
          ) : (
            <>
              <PlaybackTime className="player-time" />
              <div className="player-waveform-wrap" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span className="radio-live-badge">{t('radio.live')}</span>
              </div>
              <span className="player-time" style={{ opacity: 0 }}>0:00</span>
            </>
          )}
        </>
      ) : (
        <>
          <PlaybackTime className="player-time" />
          <div className="player-waveform-wrap">
            {disableWaveformCanvas
              ? <div className="radio-progress-bar" aria-hidden />
              : <WaveformSeek trackId={trackId} />}
          </div>
          <span
            className="player-time player-time-toggle"
            onClick={() => {
              const newVal = !localShowRemaining;
              setLocalShowRemaining(newVal);
              useThemeStore.getState().setShowRemainingTime(newVal);
            }}
            data-tooltip={localShowRemaining ? t('player.showDuration') : t('player.showRemainingTime')}
          >
            {localShowRemaining ? <RemainingTime duration={duration} /> : formatTime(duration)}
            <ArrowLeftRight size={10} style={{ marginLeft: 4, opacity: 0.6 }} />
          </span>
        </>
      )}
    </div>
  );
}
