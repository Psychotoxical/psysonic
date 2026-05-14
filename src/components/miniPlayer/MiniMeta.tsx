import { emit } from '@tauri-apps/api/event';
import CachedImage from '../CachedImage';
import { OpenArtistRefInline } from '../OpenArtistRefInline';
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
        {track?.artists && track.artists.length > 0 ? (
          <div className="mini-player__artist" title={track.artists.map(a => a.name).filter(Boolean).join(' · ')}>
            <OpenArtistRefInline
              refs={track.artists}
              fallbackName={track.artist}
              onGoArtist={id => { void emit('mini:navigate', { to: `/artist/${id}` }); }}
              as="none"
              linkTag="span"
              linkClassName="mini-player__artist-link"
            />
          </div>
        ) : track?.artist ? (
          <div className="mini-player__artist" title={track.artist}>{track.artist}</div>
        ) : null}
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
