import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, Share2, X } from 'lucide-react';
import { AlbumCoverArtImage } from '@/cover/AlbumCoverArtImage';
import { coverServerScopeForServerId } from '@/cover/serverScope';
import type { PlaySessionRecapItem } from '@/lib/api/library';
import type { YearRecapData } from '@/features/stats/hooks/useYearRecapData';
import {
  completionPercent,
  listeningPersona,
  longestListeningStreak,
  losslessPercent,
  splitHoursMinutes,
} from '@/features/stats/utils/yearRecapDerive';

interface Props {
  data: YearRecapData;
  onClose: () => void;
  /** Opens the poster export modal (story stays mounted underneath). */
  onShare: () => void;
}

interface Slide {
  key: string;
  content: React.ReactNode;
}

function TopList({ items, showCovers }: { items: PlaySessionRecapItem[]; showCovers?: boolean }) {
  const { t } = useTranslation();
  return (
    <ol className="year-recap-toplist">
      {items.map((item, i) => (
        <li key={`${item.name}-${i}`}>
          <span className="year-recap-toplist-rank">{i + 1}</span>
          {showCovers && item.albumId ? (
            <AlbumCoverArtImage
              albumId={item.albumId}
              coverArt={item.coverArtId}
              serverScope={item.serverId ? coverServerScopeForServerId(item.serverId) : undefined}
              displayCssPx={44}
              className="year-recap-toplist-cover"
              alt=""
            />
          ) : null}
          <span className="year-recap-toplist-text">
            <span className="year-recap-toplist-name">{item.name}</span>
            {item.secondary ? (
              <span className="year-recap-toplist-secondary">{item.secondary}</span>
            ) : null}
          </span>
          <span className="year-recap-toplist-count">
            {t('statistics.recapPlays', { count: item.playCount })}
          </span>
        </li>
      ))}
    </ol>
  );
}

export default function YearRecapStory({ data, onClose, onShare }: Props) {
  const { t, i18n } = useTranslation();
  const [index, setIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const { recap, summary, heatmap, year } = data;

  const slides = useMemo<Slide[]>(() => {
    const out: Slide[] = [];
    const time = splitHoursMinutes(recap.totalListenedSec);
    const streak = longestListeningStreak(heatmap.map(d => d.date));
    const persona = listeningPersona(recap.hourlyPlayCounts);
    const lossless = losslessPercent(recap.losslessListenedSec, recap.totalListenedSec);
    const completion = completionPercent(summary.fullCount, summary.partialCount);
    const maxHourly = Math.max(...recap.hourlyPlayCounts, 1);

    out.push({
      key: 'intro',
      content: (
        <>
          <p className="year-recap-kicker">{t('statistics.recapIntroKicker')}</p>
          <h2 className="year-recap-big-title">{t('statistics.recapCardTitle', { year })}</h2>
          <p className="year-recap-huge">{time.hours.toLocaleString()}</p>
          <p className="year-recap-label">{t('statistics.recapStatHours')}</p>
        </>
      ),
    });

    out.push({
      key: 'days',
      content: (
        <>
          <h2 className="year-recap-slide-title">{t('statistics.recapRhythmTitle')}</h2>
          <div className="year-recap-stat-grid">
            <div>
              <p className="year-recap-huge">{summary.listeningDayCount.toLocaleString()}</p>
              <p className="year-recap-label">{t('statistics.recapStatDays')}</p>
            </div>
            <div>
              <p className="year-recap-huge">{summary.trackPlayCount.toLocaleString()}</p>
              <p className="year-recap-label">{t('statistics.recapStatPlays')}</p>
            </div>
          </div>
          {streak > 1 ? (
            <p className="year-recap-line">{t('statistics.recapStreak', { count: streak })}</p>
          ) : null}
          {recap.busiestDay ? (
            <p className="year-recap-line">
              {t('statistics.recapBusiestDay', {
                date: new Date(`${recap.busiestDay.date}T12:00:00`).toLocaleDateString(
                  i18n.language,
                  { month: 'long', day: 'numeric' },
                ),
                hours: splitHoursMinutes(recap.busiestDay.listenedSec).hours,
                minutes: splitHoursMinutes(recap.busiestDay.listenedSec).minutes,
              })}
            </p>
          ) : null}
        </>
      ),
    });

    if (recap.topArtists.length > 0) {
      out.push({
        key: 'artists',
        content: (
          <>
            <h2 className="year-recap-slide-title">{t('statistics.recapTopArtists')}</h2>
            <TopList items={recap.topArtists} />
          </>
        ),
      });
    }

    if (recap.topAlbums.length > 0) {
      out.push({
        key: 'albums',
        content: (
          <>
            <h2 className="year-recap-slide-title">{t('statistics.recapTopAlbums')}</h2>
            <TopList items={recap.topAlbums} showCovers />
          </>
        ),
      });
    }

    if (recap.topTracks.length > 0) {
      out.push({
        key: 'tracks',
        content: (
          <>
            <h2 className="year-recap-slide-title">{t('statistics.recapTopTracks')}</h2>
            <TopList items={recap.topTracks} />
          </>
        ),
      });
    }

    if (recap.topGenres.length > 0) {
      const maxGenre = Math.max(...recap.topGenres.map(g => g.listenedSec), 1);
      out.push({
        key: 'genres',
        content: (
          <>
            <h2 className="year-recap-slide-title">{t('statistics.recapTopGenres')}</h2>
            <div className="year-recap-genres">
              {recap.topGenres.map(g => (
                <div key={g.name} className="year-recap-genre-row">
                  <span className="year-recap-genre-name">{g.name}</span>
                  <div className="year-recap-genre-bar">
                    <div style={{ width: `${(g.listenedSec / maxGenre) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </>
        ),
      });
    }

    if (persona) {
      out.push({
        key: 'persona',
        content: (
          <>
            <h2 className="year-recap-slide-title">{t('statistics.recapPersonaTitle')}</h2>
            <p className="year-recap-big-title">
              {t(`statistics.recapPersona${persona[0].toUpperCase()}${persona.slice(1)}`)}
            </p>
            <div className="year-recap-hours" aria-hidden="true">
              {recap.hourlyPlayCounts.map((n, h) => (
                <div key={h} style={{ height: `${8 + (n / maxHourly) * 92}%` }} />
              ))}
            </div>
            {completion !== null ? (
              <p className="year-recap-line">
                {t('statistics.recapCompletion', { percent: completion })}
              </p>
            ) : null}
          </>
        ),
      });
    }

    if (recap.newArtistCount > 0) {
      out.push({
        key: 'discoveries',
        content: (
          <>
            <h2 className="year-recap-slide-title">{t('statistics.recapDiscoveriesTitle')}</h2>
            <p className="year-recap-huge">{recap.newArtistCount.toLocaleString()}</p>
            <p className="year-recap-label">
              {t('statistics.recapDiscoveriesBody', { count: recap.newArtistCount })}
            </p>
            <p className="year-recap-line">
              {t('statistics.recapUniqueTracks', { count: summary.uniqueTrackCount })}
            </p>
          </>
        ),
      });
    }

    if (lossless !== null && lossless > 0) {
      out.push({
        key: 'lossless',
        content: (
          <>
            <h2 className="year-recap-slide-title">{t('statistics.recapLosslessTitle')}</h2>
            <p className="year-recap-huge">{lossless}%</p>
            <p className="year-recap-label">{t('statistics.recapLosslessBody')}</p>
            <div className="year-recap-lossless-bar" aria-hidden="true">
              <div style={{ width: `${lossless}%` }} />
            </div>
          </>
        ),
      });
    }

    out.push({
      key: 'finale',
      content: (
        <>
          <h2 className="year-recap-big-title">{t('statistics.recapFinaleTitle', { year })}</h2>
          <button type="button" className="btn btn-primary year-recap-share-btn" onClick={onShare}>
            <Share2 size={16} />
            {t('statistics.recapShareCta')}
          </button>
          <p className="year-recap-privacy">{t('statistics.recapPrivacy')}</p>
        </>
      ),
    });

    return out;
  }, [recap, summary, heatmap, year, t, i18n.language, onShare]);

  const clampedIndex = Math.min(index, slides.length - 1);

  const goNext = useCallback(() => {
    setIndex(i => Math.min(i + 1, slides.length - 1));
  }, [slides.length]);
  const goPrev = useCallback(() => {
    setIndex(i => Math.max(i - 1, 0));
  }, []);

  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight' || e.key === ' ') goNext();
      else if (e.key === 'ArrowLeft') goPrev();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, goNext, goPrev]);

  return createPortal(
    <div
      ref={rootRef}
      className="year-recap-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t('statistics.recapCardTitle', { year })}
      tabIndex={-1}
    >
      <div className="year-recap-progress" aria-hidden="true">
        {slides.map((s, i) => (
          <span key={s.key} className={i <= clampedIndex ? 'is-done' : undefined} />
        ))}
      </div>

      <button
        type="button"
        className="year-recap-close"
        onClick={onClose}
        aria-label={t('statistics.recapClose')}
      >
        <X size={20} />
      </button>

      <div className="year-recap-slide" key={slides[clampedIndex].key}>
        {slides[clampedIndex].content}
      </div>

      <button
        type="button"
        className="year-recap-nav year-recap-nav-prev"
        onClick={goPrev}
        disabled={clampedIndex === 0}
        aria-label={t('statistics.recapPrev')}
      >
        <ChevronLeft size={22} />
      </button>
      <button
        type="button"
        className="year-recap-nav year-recap-nav-next"
        onClick={goNext}
        disabled={clampedIndex === slides.length - 1}
        aria-label={t('statistics.recapNext')}
      >
        <ChevronRight size={22} />
      </button>
    </div>,
    document.body,
  );
}
