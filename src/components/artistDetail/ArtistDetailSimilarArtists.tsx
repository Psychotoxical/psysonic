import React, { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type { SubsonicArtist } from '../../api/subsonicTypes';
import { useIsMobile } from '../../hooks/useIsMobile';

interface Props {
  marginTop: string;
  showAudiomuseSimilar: boolean;
  showLastfmSimilar: boolean;
  similarLoading: boolean;
  similarArtists: SubsonicArtist[];
  serverSimilarArtists: SubsonicArtist[];
  similarCollapsed: boolean;
  setSimilarCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
}

export default function ArtistDetailSimilarArtists({
  marginTop, showAudiomuseSimilar, showLastfmSimilar,
  similarLoading, similarArtists, serverSimilarArtists,
  similarCollapsed, setSimilarCollapsed,
}: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isMobile = useIsMobile();

  return (
    <Fragment>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop, marginBottom: '1rem' }}>
        <h2 className="section-title" style={{ margin: 0 }}>
          {t('artistDetail.similarArtists')}
        </h2>
        {isMobile && (() => {
          const list = showAudiomuseSimilar ? serverSimilarArtists : similarArtists;
          return list.length > 5 ? (
            <button className="btn btn-ghost" style={{ fontSize: 12, padding: '2px 8px' }} onClick={() => setSimilarCollapsed(v => !v)}>
              {similarCollapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
              {similarCollapsed ? t('nowPlaying.readMore') : t('nowPlaying.showLess')}
            </button>
          ) : null;
        })()}
      </div>
      {showLastfmSimilar && similarLoading ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', color: 'var(--text-muted)', fontSize: '0.875rem' }}>
          <div className="spinner" style={{ width: 16, height: 16, borderTopColor: 'currentColor' }} />
          {t('artistDetail.loading')}
        </div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
          {(showAudiomuseSimilar ? serverSimilarArtists : similarArtists)
            .slice(0, isMobile && similarCollapsed ? 5 : undefined)
            .map((a, i) => (
              <button
                key={`${a.id}-${i}`}
                className="artist-ext-link"
                onClick={() => navigate(`/artist/${a.id}`)}
              >
                {a.name}
              </button>
            ))}
        </div>
      )}
    </Fragment>
  );
}
