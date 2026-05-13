import CachedImage from '../CachedImage';
import type { MiniTrackInfo } from '../../utils/miniPlayerBridge';

interface Props {
  track: MiniTrackInfo | null;
  miniCoverSrc: string;
  miniCoverKey: string;
}

export function MiniMeta({ track, miniCoverSrc, miniCoverKey }: Props) {
  return (
    <div className="mini-player__meta">
      <div className="mini-player__art">
        {track?.coverArt ? (
          <CachedImage
            src={miniCoverSrc}
            cacheKey={miniCoverKey}
            alt={track.album}
          />
        ) : (
          <div className="mini-player__art-fallback" />
        )}
      </div>

      <div className="mini-player__meta-text" data-tauri-drag-region="false">
        <div className="mini-player__title" title={track?.title}>
          {track?.title ?? '—'}
        </div>
        {track?.artist && (
          <div className="mini-player__artist" title={track.artist}>{track.artist}</div>
        )}
        {track?.album && (
          <div className="mini-player__album" title={track.album}>{track.album}</div>
        )}
        {track?.year && (
          <div className="mini-player__year">{track.year}</div>
        )}
      </div>
    </div>
  );
}
