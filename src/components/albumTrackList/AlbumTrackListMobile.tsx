import React from 'react';
import { AudioLines } from 'lucide-react';
import type { SubsonicSong } from '../../api/subsonicTypes';
import type { Track } from '../../store/playerStoreTypes';
import { songToTrack } from '../../utils/playback/songToTrack';
import { formatLongDuration } from '../../utils/format/formatDuration';

interface Props {
  discNums: number[];
  discs: Map<number, SubsonicSong[]>;
  isMultiDisc: boolean;
  currentTrackId: string | null;
  isPlaying: boolean;
  contextMenuSongId: string | null;
  setContextMenuSongId: (id: string | null) => void;
  onPlaySong: (song: SubsonicSong) => void;
  onContextMenu: (
    x: number,
    y: number,
    track: Track,
    type: 'song' | 'album' | 'artist' | 'queue-item' | 'album-song',
  ) => void;
}

/**
 * Compact tracklist for narrow viewports. Drops the column grid + column
 * picker + drag selection entirely — just a one-line row per song with
 * disc group separators. Play on tap, context menu on long-press / right
 * click.
 */
export function AlbumTrackListMobile({
  discNums,
  discs,
  isMultiDisc,
  currentTrackId,
  isPlaying,
  contextMenuSongId,
  setContextMenuSongId,
  onPlaySong,
  onContextMenu,
}: Props) {
  return (
    <div className="tracklist-mobile">
      {discNums.map(discNum => (
        <div key={discNum}>
          {isMultiDisc && (
            <div className="disc-header">
              <span className="disc-icon">💿</span> CD {discNum}
            </div>
          )}
          {discs.get(discNum)!.map(song => {
            const isActive = currentTrackId === song.id;
            return (
              <div
                key={song.id}
                className={`tracklist-mobile-row${isActive ? ' active' : ''}${contextMenuSongId === song.id ? ' context-active' : ''}`}
                onClick={() => onPlaySong(song)}
                onContextMenu={e => {
                  e.preventDefault();
                  setContextMenuSongId(song.id);
                  onContextMenu(e.clientX, e.clientY, songToTrack(song), 'album-song');
                }}
              >
                <div className="tracklist-mobile-main">
                  {isActive && isPlaying ? (
                    <span className="tracklist-mobile-eq">
                      <AudioLines className="eq-bars" size={14} />
                    </span>
                  ) : (
                    <span className="tracklist-mobile-num">{song.track ?? ''}</span>
                  )}
                  <span className="tracklist-mobile-title">{song.title}</span>
                </div>
                <span className="tracklist-mobile-duration">{formatLongDuration(song.duration)}</span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
