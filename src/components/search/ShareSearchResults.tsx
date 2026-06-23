import React, { useEffect, useState } from 'react';
import { Disc3, Eye, Link2, ListPlus, Music, Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { SubsonicArtist } from '../../api/subsonicTypes';
import type { ServerProfile } from '../../store/authStoreTypes';
import { songToTrack } from '../../utils/playback/songToTrack';
import { activateShareSearchServer } from '../../utils/share/enqueueShareSearchPayload';
import { sharePayloadTotal, type ShareSearchMatch } from '../../utils/share/shareSearch';
import type { ShareSearchPreviewState } from '../../hooks/useShareSearchPreview';
import { FETCH_QUEUE_BIAS_SEARCH_ARTIST_OVER_ALBUM } from '../CachedImage';
import { AlbumCoverArtImage } from '../../cover/AlbumCoverArtImage';
import { ArtistCoverArtImage } from '../../cover/ArtistCoverArtImage';
import { COVER_DENSE_SEARCH_CSS_PX } from '../../cover/layoutSizes';
import { COVER_SCOPE_ACTIVE, type CoverServerScope } from '../../cover/types';
import { useShareQueuePreview } from '../../hooks/useShareQueuePreview';
import ShareQueuePreviewModal from './ShareQueuePreviewModal';

type ShareSearchResultsProps = {
  variant: 'desktop' | 'mobile';
  shareMatch: ShareSearchMatch;
  /** Saved server display name when the link is from a non-active server. */
  shareServerLabel?: string | null;
  /** Saved server profile for cover art when the link is from a non-active server. */
  shareCoverServer?: ServerProfile | null;
  activeIndex?: number;
  shareQueueBusy: boolean;
  onEnqueue: () => void | Promise<boolean>;
  onOpenAlbum: () => void;
  onOpenArtist: () => void;
  onOpenComposer: () => void;
  onContextMenu?: (e: React.MouseEvent, item: unknown, type: 'song' | 'album' | 'artist') => void;
} & ShareSearchPreviewState;

function shareCoverServerScope(coverServer?: ServerProfile | null): CoverServerScope {
  if (coverServer) {
    return {
      kind: 'server',
      serverId: coverServer.id,
      url: coverServer.url,
      username: coverServer.username,
      password: coverServer.password,
    };
  }
  return COVER_SCOPE_ACTIVE;
}

function ShareAlbumThumb({
  albumId,
  coverArt,
  displayCssPx,
  coverServer,
}: {
  albumId: string;
  coverArt: string;
  displayCssPx: number;
  coverServer?: ServerProfile | null;
}) {
  const cls = displayCssPx >= 64 ? 'mobile-search-thumb' : 'search-result-thumb';
  return (
    <AlbumCoverArtImage
      albumId={albumId}
      coverArt={coverArt}
      serverScope={shareCoverServerScope(coverServer)}
      displayCssPx={displayCssPx}
      surface="dense"
      className={cls}
      alt=""
    />
  );
}

function ShareArtistThumb({
  artist,
  displayCssPx,
  coverServer,
}: {
  artist: Pick<SubsonicArtist, 'id' | 'coverArt'>;
  displayCssPx: number;
  coverServer?: ServerProfile | null;
}) {
  const [failed, setFailed] = useState(false);
  // React Compiler set-state-in-effect rule: local state synced with store/prop inputs when the effect’s dependencies change.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setFailed(false); }, [artist.id, artist.coverArt]);

  if (failed) {
    if (displayCssPx >= 64) {
      return (
        <div className="mobile-search-avatar mobile-search-avatar--circle">
          <Users size={20} />
        </div>
      );
    }
    return (
      <div className="search-result-icon">
        <Users size={14} />
      </div>
    );
  }

  const cls =
    displayCssPx >= 64
      ? 'mobile-search-thumb mobile-search-thumb--artist-round'
      : 'search-result-thumb';
  return (
    <ArtistCoverArtImage
      artistId={artist.id}
      coverArt={artist.coverArt}
      serverScope={shareCoverServerScope(coverServer)}
      displayCssPx={displayCssPx}
      surface="dense"
      className={cls}
      alt=""
      loading="eager"
      fetchQueueBias={FETCH_QUEUE_BIAS_SEARCH_ARTIST_OVER_ALBUM}
      onError={() => setFailed(true)}
    />
  );
}

function StaticIcon({ className, children }: { className: string; children: React.ReactNode }) {
  return <div className={className}>{children}</div>;
}

function withShareServer(
  shareMatch: ShareSearchMatch,
  t: TFunction,
  fn: () => void,
): void {
  if (shareMatch.type === 'unsupported') return;
  if (!activateShareSearchServer(shareMatch.payload.srv, t)) return;
  fn();
}

function shareSubLine(primary: string, serverLabel: string | null | undefined, t: TFunction): string {
  if (!serverLabel) return primary;
  const hint = t('search.shareFromServer', { server: serverLabel });
  return primary ? `${primary} · ${hint}` : hint;
}

export default function ShareSearchResults(props: ShareSearchResultsProps) {
  const {
    variant,
    shareMatch,
    shareServerLabel = null,
    shareCoverServer = null,
    activeIndex = 0,
    shareQueueBusy,
    onEnqueue,
    onOpenAlbum,
    onOpenArtist,
    onOpenComposer,
    onContextMenu,
    shareTrackSong,
    shareTrackResolving,
    shareTrackUnavailable,
    shareAlbum,
    shareAlbumResolving,
    shareAlbumUnavailable,
    shareArtist,
    shareArtistResolving,
    shareArtistUnavailable,
    shareComposer,
    shareComposerResolving,
    shareComposerUnavailable,
  } = props;

  const { t } = useTranslation();
  const desktop = variant === 'desktop';
  const thumbDisplayCssPx = desktop ? COVER_DENSE_SEARCH_CSS_PX : 80;
  const sectionCls = desktop ? 'search-section' : 'mobile-search-section';
  const labelCls = desktop ? 'search-section-label' : 'mobile-search-section-label';
  const mutedCls = desktop ? 'search-result-item search-result-item--muted' : 'mobile-search-item mobile-search-item--muted';
  const iconCls = desktop ? 'search-result-icon' : 'mobile-search-avatar';
  const nameCls = desktop ? 'search-result-name' : 'mobile-search-item-title';
  const subCls = desktop ? 'search-result-sub' : 'mobile-search-item-sub';
  const infoWrap = desktop ? undefined : 'mobile-search-item-info';

  const wrap = (content: React.ReactNode) => (
    <div className={sectionCls}>
      <div className={labelCls}>
        {desktop && <Link2 size={12} />} {t('search.shareLink')}
      </div>
      {content}
    </div>
  );

  const itemCls = (active: boolean) =>
    desktop ? `search-result-item${active ? ' active' : ''}` : 'mobile-search-item';

  const sub = (primary: string) => shareSubLine(primary, shareServerLabel, t);
  const showEntityKindSub = !desktop || !!shareServerLabel;
  const [queuePreviewOpen, setQueuePreviewOpen] = useState(false);
  const queuePayload =
    shareMatch.type === 'queueable' && shareMatch.payload.k === 'queue' ? shareMatch.payload : null;
  const queuePreview = useShareQueuePreview(queuePayload, queuePreviewOpen);

  const unsupportedRow = (
    <div className={mutedCls}>
      <StaticIcon className={iconCls}><Link2 size={desktop ? 14 : 20} /></StaticIcon>
      <div className={infoWrap}>
        <div className={nameCls}>{t('search.shareUnsupportedTitle')}</div>
        <div className={subCls}>{t('search.shareUnsupportedSub')}</div>
      </div>
    </div>
  );

  if (shareMatch.type === 'unsupported') {
    return wrap(unsupportedRow);
  }

  if (shareMatch.type === 'artist') {
    if (shareArtistResolving) {
      return wrap(
        <div className={mutedCls}>
          <StaticIcon className={iconCls}><Users size={desktop ? 14 : 20} /></StaticIcon>
          <div className={infoWrap}>
            <div className={nameCls}>{t('common.loading')}</div>
            <div className={subCls}>{sub(t('search.artists'))}</div>
          </div>
        </div>,
      );
    }
    if (shareArtist) {
      return wrap(
        <button
          type="button"
          className={itemCls(activeIndex === 0)}
          onClick={onOpenArtist}
          onContextMenu={e => {
            e.preventDefault();
            withShareServer(shareMatch, t, () => onContextMenu?.(e, shareArtist, 'artist'));
          }}
          role={desktop ? 'option' : undefined}
          aria-selected={desktop ? activeIndex === 0 : undefined}
        >
          <ShareArtistThumb artist={shareArtist} displayCssPx={thumbDisplayCssPx} coverServer={shareCoverServer} />
          <div className={infoWrap}>
            <div className={nameCls}>{shareArtist.name}</div>
            {showEntityKindSub && <div className={subCls}>{sub(!desktop ? t('search.artists') : '')}</div>}
          </div>
        </button>,
      );
    }
    return wrap(
      <div className={mutedCls}>
        <StaticIcon className={iconCls}><Link2 size={desktop ? 14 : 20} /></StaticIcon>
        <div className={infoWrap}>
          <div className={nameCls}>
            {shareArtistUnavailable ? t('sharePaste.artistUnavailable') : t('sharePaste.genericError')}
          </div>
          <div className={subCls}>{t('search.shareUnsupportedSub')}</div>
        </div>
      </div>,
    );
  }

  if (shareMatch.type === 'composer') {
    if (shareComposerResolving) {
      return wrap(
        <div className={mutedCls}>
          <StaticIcon className={iconCls}><Users size={desktop ? 14 : 20} /></StaticIcon>
          <div className={infoWrap}>
            <div className={nameCls}>{t('common.loading')}</div>
            <div className={subCls}>{sub(t('sidebar.composers'))}</div>
          </div>
        </div>,
      );
    }
    if (shareComposer) {
      return wrap(
        <button
          type="button"
          className={itemCls(activeIndex === 0)}
          onClick={onOpenComposer}
          role={desktop ? 'option' : undefined}
          aria-selected={desktop ? activeIndex === 0 : undefined}
        >
          <ShareArtistThumb artist={shareComposer} displayCssPx={thumbDisplayCssPx} coverServer={shareCoverServer} />
          <div className={infoWrap}>
            <div className={nameCls}>{shareComposer.name}</div>
            {showEntityKindSub && <div className={subCls}>{sub(!desktop ? t('sidebar.composers') : '')}</div>}
          </div>
        </button>,
      );
    }
    return wrap(
      <div className={mutedCls}>
        <StaticIcon className={iconCls}><Link2 size={desktop ? 14 : 20} /></StaticIcon>
        <div className={infoWrap}>
          <div className={nameCls}>
            {shareComposerUnavailable ? t('sharePaste.composerUnavailable') : t('sharePaste.genericError')}
          </div>
          <div className={subCls}>{t('search.shareUnsupportedSub')}</div>
        </div>
      </div>,
    );
  }

  if (shareMatch.type === 'album') {
    if (shareAlbumResolving) {
      return wrap(
        <div className={mutedCls}>
          <StaticIcon className={iconCls}><Disc3 size={desktop ? 14 : 20} /></StaticIcon>
          <div className={infoWrap}>
            <div className={nameCls}>{t('common.loading')}</div>
            <div className={subCls}>{sub(t('search.album'))}</div>
          </div>
        </div>,
      );
    }
    if (shareAlbum) {
      return wrap(
        <button
          type="button"
          className={itemCls(activeIndex === 0)}
          onClick={onOpenAlbum}
          onContextMenu={e => {
            e.preventDefault();
            withShareServer(shareMatch, t, () => onContextMenu?.(e, shareAlbum, 'album'));
          }}
          role={desktop ? 'option' : undefined}
          aria-selected={desktop ? activeIndex === 0 : undefined}
        >
          {shareAlbum.coverArt ? (
            <ShareAlbumThumb albumId={shareAlbum.id} coverArt={shareAlbum.coverArt} displayCssPx={thumbDisplayCssPx} coverServer={shareCoverServer} />
          ) : (
            <StaticIcon className={iconCls}><Disc3 size={desktop ? 14 : 20} /></StaticIcon>
          )}
          <div className={infoWrap}>
            <div className={nameCls}>{shareAlbum.name}</div>
            <div className={subCls}>{sub(shareAlbum.artist)}</div>
          </div>
        </button>,
      );
    }
    return wrap(
      <div className={mutedCls}>
        <StaticIcon className={iconCls}><Link2 size={desktop ? 14 : 20} /></StaticIcon>
        <div className={infoWrap}>
          <div className={nameCls}>
            {shareAlbumUnavailable ? t('sharePaste.albumUnavailable') : t('sharePaste.genericError')}
          </div>
          <div className={subCls}>{t('search.shareUnsupportedSub')}</div>
        </div>
      </div>,
    );
  }

  if (shareMatch.type === 'queueable' && shareMatch.payload.k === 'track') {
    if (shareTrackResolving) {
      return wrap(
        <div className={mutedCls}>
          <StaticIcon className={iconCls}><Music size={desktop ? 14 : 20} /></StaticIcon>
          <div className={infoWrap}>
            <div className={nameCls}>{t('common.loading')}</div>
            <div className={subCls}>{sub(t('search.shareTrackTitle'))}</div>
          </div>
        </div>,
      );
    }
    if (shareTrackSong) {
      return wrap(
        <button
          type="button"
          className={itemCls(activeIndex === 0)}
          onClick={onEnqueue}
          onContextMenu={e => {
            e.preventDefault();
            withShareServer(shareMatch, t, () => onContextMenu?.(e, songToTrack(shareTrackSong), 'song'));
          }}
          disabled={shareQueueBusy}
          role={desktop ? 'option' : undefined}
          aria-selected={desktop ? activeIndex === 0 : undefined}
        >
          {shareTrackSong.coverArt ? (
            <ShareAlbumThumb albumId={shareTrackSong.albumId} coverArt={shareTrackSong.coverArt} displayCssPx={thumbDisplayCssPx} coverServer={shareCoverServer} />
          ) : (
            <StaticIcon className={iconCls}><Music size={desktop ? 14 : 20} /></StaticIcon>
          )}
          <div className={infoWrap}>
            <div className={nameCls}>{shareTrackSong.title}</div>
            <div className={subCls}>
              {shareQueueBusy
                ? sub(t('search.shareQueueing'))
                : sub(`${shareTrackSong.artist}${shareTrackSong.album ? ` · ${shareTrackSong.album}` : ''}`)}
            </div>
          </div>
        </button>,
      );
    }
    return wrap(
      <div className={mutedCls}>
        <StaticIcon className={iconCls}><Link2 size={desktop ? 14 : 20} /></StaticIcon>
        <div className={infoWrap}>
          <div className={nameCls}>
            {shareTrackUnavailable ? t('sharePaste.trackUnavailable') : t('sharePaste.genericError')}
          </div>
          <div className={subCls}>{t('search.shareUnsupportedSub')}</div>
        </div>
      </div>,
    );
  }

  if (shareMatch.type === 'queueable' && shareMatch.payload.k === 'queue') {
    const count = sharePayloadTotal(shareMatch.payload);
    const rowCls = desktop ? 'search-share-queue-row' : 'mobile-search-share-queue-row';
    const handleModalEnqueue = () => {
      void Promise.resolve(onEnqueue()).then(ok => {
        if (ok) setQueuePreviewOpen(false);
      });
    };
    return (
      <>
        {wrap(
          <div
            className={`${rowCls}${activeIndex === 0 ? ' active' : ''}`}
            role={desktop ? 'option' : undefined}
          >
            <button
              type="button"
              className={desktop ? 'search-share-queue-main' : 'mobile-search-item search-share-queue-main'}
              onClick={() => void onEnqueue()}
              disabled={shareQueueBusy}
              aria-selected={desktop ? activeIndex === 0 : undefined}
            >
              <StaticIcon className={iconCls}><ListPlus size={desktop ? 14 : 20} /></StaticIcon>
              <div className={infoWrap}>
                <div className={nameCls}>{t('search.shareQueueTitle', { count })}</div>
                <div className={subCls}>
                  {shareQueueBusy ? sub(t('search.shareQueueing')) : sub(t('search.shareQueueAction'))}
                </div>
              </div>
            </button>
            <button
              type="button"
              className="search-share-queue-preview-btn"
              onClick={e => {
                e.stopPropagation();
                setQueuePreviewOpen(true);
              }}
              aria-label={t('search.shareQueuePreview')}
            >
              <Eye size={desktop ? 16 : 18} />
            </button>
          </div>,
        )}
        <ShareQueuePreviewModal
          open={queuePreviewOpen}
          onClose={() => setQueuePreviewOpen(false)}
          payload={shareMatch.payload}
          preview={queuePreview}
          shareServerLabel={shareServerLabel}
          coverServer={shareCoverServer}
          onEnqueue={handleModalEnqueue}
          enqueueBusy={shareQueueBusy}
        />
      </>
    );
  }

  return null;
}
