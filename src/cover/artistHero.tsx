import { useEffect, useMemo, useState, type CSSProperties, type ImgHTMLAttributes } from 'react';
import type { SubsonicArtistInfo } from '../api/subsonicTypes';
import { isRealArtistImage } from '../utils/componentHelpers/nowPlayingHelpers';
import { CoverArtImage } from './CoverArtImage';
import type { CoverArtRef, CoverSurfaceKind } from './types';

export type ArtistHeroCoverProps = {
  artistId: string;
  artistInfo: SubsonicArtistInfo | null;
  coverFallback?: CoverArtRef | null;
  displayCssPx: number;
  surface?: CoverSurfaceKind;
  className?: string;
  alt?: string;
  style?: CSSProperties;
  onError?: () => void;
} & Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'alt' | 'style' | 'onError'>;

/** Artist hero — external Last.fm/Subsonic URLs with getCoverArt fallback (v1). */
export function ArtistHeroCover({
  artistId,
  artistInfo,
  coverFallback,
  displayCssPx,
  surface = 'sparse',
  className,
  alt,
  style,
  onError,
  ...rest
}: ArtistHeroCoverProps) {
  const [externalUrl, setExternalUrl] = useState('');
  const [externalFailed, setExternalFailed] = useState(false);

  const candidateUrl = useMemo(() => {
    const rawLarge = artistInfo?.largeImageUrl;
    const rawMed = artistInfo?.mediumImageUrl;
    if (isRealArtistImage(rawLarge)) return rawLarge!;
    if (isRealArtistImage(rawMed)) return rawMed!;
    return '';
  }, [artistInfo?.largeImageUrl, artistInfo?.mediumImageUrl]);

  useEffect(() => {
    // React Compiler set-state-in-effect rule: local state synced with store/prop inputs when the effect’s dependencies change.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setExternalFailed(false);
    setExternalUrl('');
    if (!candidateUrl) return;
    let cancelled = false;
    const probe = new Image();
    probe.onload = () => { if (!cancelled) setExternalUrl(candidateUrl); };
    probe.onerror = () => { if (!cancelled) setExternalFailed(true); };
    probe.src = candidateUrl;
    return () => {
      cancelled = true;
      probe.onload = probe.onerror = null;
    };
  }, [candidateUrl, artistId]);

  if (externalUrl && !externalFailed) {
    return (
      <img
        src={externalUrl}
        className={className}
        alt={alt ?? ''}
        style={style}
        onError={() => {
          setExternalFailed(true);
          onError?.();
        }}
        {...rest}
      />
    );
  }

  if (coverFallback?.fetchCoverArtId) {
    return (
      <CoverArtImage
        coverRef={coverFallback}
        displayCssPx={displayCssPx}
        surface={surface}
        className={className}
        alt={alt}
        style={style}
        onError={onError}
        {...rest}
      />
    );
  }

  return null;
}
