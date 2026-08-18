import { ArrowLeftRight } from 'lucide-react';
import type { TFunction } from 'i18next';
import type { RadioMetadata } from '@/features/radio';
import { useThemeStore } from '@/store/themeStore';
import { formatTrackTime, playbarMinuteFieldWidth } from '@/lib/format/formatDuration';
import { WaveformSeek } from '@/features/waveform';
import { PlaybackTime, ToggleClock } from '@/features/playback/components/playerBar/PlaybackClock';

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
  const minuteFieldWidth = playbarMinuteFieldWidth(duration);
  const playbarClockStyle = {
    '--playbar-clock-body-ch': minuteFieldWidth + 3,
    '--playbar-clock-signed-ch': minuteFieldWidth + 4,
  } as React.CSSProperties;

  return (
    <div className="player-waveform-section" style={playbarClockStyle}>
      {isRadio ? (
        <>
          {radioMeta.source === 'azuracast' && radioMeta.elapsed != null && radioMeta.duration != null && radioMeta.duration > 0 ? (
            <>
              <span className="player-time">{formatTrackTime(radioMeta.elapsed)}</span>
              <div className="player-waveform-wrap">
                <div className="radio-progress-bar">
                  <div
                    className="radio-progress-fill"
                    style={{ width: `${Math.min(100, (radioMeta.elapsed / radioMeta.duration) * 100)}%` }}
                  />
                </div>
              </div>
              <span className="player-time">{formatTrackTime(radioMeta.duration)}</span>
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
          <PlaybackTime className="player-time" minuteFieldWidth={minuteFieldWidth} />
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
            <ToggleClock
              className="player-time-toggle__label"
              duration={duration}
              minuteFieldWidth={minuteFieldWidth}
              remaining={localShowRemaining}
            />
            <ArrowLeftRight className="player-time-toggle__icon" size={10} aria-hidden />
          </span>
        </>
      )}
    </div>
  );
}
