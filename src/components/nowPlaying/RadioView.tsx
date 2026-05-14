import React, { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Cast, Clock, Radio, SkipForward, Users } from 'lucide-react';
import type { useRadioMetadata } from '../../hooks/useRadioMetadata';
import { usePlayerStore } from '../../store/playerStore';
import { formatTime } from '../../utils/componentHelpers/nowPlayingHelpers';

type NonNullStoreField<K extends keyof ReturnType<typeof usePlayerStore.getState>> =
  NonNullable<ReturnType<typeof usePlayerStore.getState>[K]>;

interface RadioViewProps {
  radioMeta: ReturnType<typeof useRadioMetadata>;
  currentRadio: NonNullStoreField<'currentRadio'>;
  resolvedCover: string;
}

const RadioView = memo(function RadioView({ radioMeta, currentRadio, resolvedCover }: RadioViewProps) {
  const { t } = useTranslation();
  return (
    <div className="np-radio-section">
      <div className="np-hero-card">
        <div className="np-hero-left">
          <div className="np-hero-info">
            <div className="np-title" style={{ color: 'var(--accent)' }}>{currentRadio.name}</div>
            {radioMeta.currentTitle && (
              <div className="np-artist-album">
                {radioMeta.currentArtist && (<><span className="np-link">{radioMeta.currentArtist}</span><span className="np-sep">·</span></>)}
                <span>{radioMeta.currentTitle}</span>
                {radioMeta.currentAlbum && (<><span className="np-sep">·</span><span style={{ opacity: 0.6 }}>{radioMeta.currentAlbum}</span></>)}
              </div>
            )}
            <div className="np-tech-row">
              <span className="np-badge np-badge-live"><Radio size={10} style={{ marginRight: 3 }} />{t('radio.live')}</span>
              {radioMeta.source === 'azuracast' && <span className="np-badge np-badge-azuracast">AzuraCast</span>}
              {radioMeta.listeners != null && (
                <span className="np-badge"><Users size={10} style={{ marginRight: 3 }} />{t('radio.listenerCount', { count: radioMeta.listeners })}</span>
              )}
            </div>
            {radioMeta.source === 'azuracast' && radioMeta.elapsed != null && radioMeta.duration != null && radioMeta.duration > 0 && (
              <div className="np-radio-progress-wrap">
                <span className="np-radio-time">{formatTime(radioMeta.elapsed)}</span>
                <div className="np-radio-progress-bar">
                  <div className="np-radio-progress-fill" style={{ width: `${Math.min(100, (radioMeta.elapsed / radioMeta.duration) * 100)}%` }} />
                </div>
                <span className="np-radio-time">{formatTime(radioMeta.duration)}</span>
              </div>
            )}
          </div>
        </div>
        <div className="np-hero-cover-wrap">
          {resolvedCover
            ? <img src={resolvedCover} alt={currentRadio.name} className="np-cover" />
            : radioMeta.currentArt
              ? <img src={radioMeta.currentArt} alt="" className="np-cover" onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
              : <div className="np-cover np-cover-fallback"><Cast size={52} /></div>}
        </div>
        <div style={{ flex: 1 }} />
      </div>

      {radioMeta.nextSong && (
        <div className="np-info-card">
          <div className="np-card-header">
            <h3 className="np-card-title"><SkipForward size={13} style={{ marginRight: 5 }} />{t('radio.upNext')}</h3>
          </div>
          <div className="np-radio-next-track">
            {radioMeta.nextSong.art && (
              <img src={radioMeta.nextSong.art} alt="" className="np-radio-track-art"
                onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
            )}
            <div className="np-radio-track-info">
              <span className="np-radio-track-title">{radioMeta.nextSong.title}</span>
              {radioMeta.nextSong.artist && <span className="np-radio-track-artist">{radioMeta.nextSong.artist}</span>}
            </div>
          </div>
        </div>
      )}

      {radioMeta.history.length > 0 && (
        <div className="np-info-card">
          <div className="np-card-header">
            <h3 className="np-card-title"><Clock size={13} style={{ marginRight: 5 }} />{t('radio.recentlyPlayed')}</h3>
          </div>
          <div className="np-album-tracklist">
            {radioMeta.history.map((item, idx) => (
              <div key={idx} className="np-album-track">
                {item.song.art && (
                  <img src={item.song.art} alt="" className="np-radio-track-art np-radio-track-art--sm"
                    onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                )}
                <span className="np-album-track-title truncate">
                  {item.song.artist ? `${item.song.artist} — ${item.song.title}` : item.song.title}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
});

export default RadioView;
