import { Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import { formatTrackTime } from '../../utils/format/formatDuration';
import type { MiniControlAction } from '../../utils/miniPlayerBridge';

interface Props {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  progress: number;
  control: (action: MiniControlAction) => void;
}

export function MiniControls({ isPlaying, currentTime, duration, progress, control }: Props) {
  return (
    <div className="mini-player__bottom" data-tauri-drag-region="false">
      <div className="mini-player__controls">
        <button className="mini-player__btn" onClick={() => control('prev')} data-tauri-drag-region="false">
          <SkipBack size={16} />
        </button>
        <button className="mini-player__btn mini-player__btn--primary" onClick={() => control('toggle')} data-tauri-drag-region="false">
          {isPlaying ? <Pause size={18} /> : <Play size={18} />}
        </button>
        <button className="mini-player__btn" onClick={() => control('next')} data-tauri-drag-region="false">
          <SkipForward size={16} />
        </button>
      </div>

      <div className="mini-player__progress">
        <div className="mini-player__progress-time">{formatTrackTime(currentTime)}</div>
        <div className="mini-player__progress-track">
          <div className="mini-player__progress-fill" style={{ width: `${progress}%` }} />
        </div>
        <div className="mini-player__progress-time">{formatTrackTime(duration)}</div>
      </div>
    </div>
  );
}
