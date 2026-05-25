import type { ImgHTMLAttributes } from 'react';
import { DEFAULT_CACHED_IMAGE_PREPARE_MARGIN } from '../components/CachedImage';
import type { CoverArtId, CoverServerScope, CoverSurfaceKind } from './types';
import { coverImgSrc } from './imgSrc';
import { useCoverArt } from './useCoverArt';

export type CoverArtImageProps = {
  coverArtId: CoverArtId | null | undefined;
  displayCssPx: number;
  serverScope?: CoverServerScope;
  surface?: CoverSurfaceKind;
  fullRes?: boolean;
  className?: string;
  alt?: string;
  fetchQueueBias?: number;
  observeRootMargin?: string;
  observeScrollRootId?: string;
} & Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'>;

export function CoverArtImage({
  coverArtId,
  displayCssPx,
  serverScope,
  surface,
  fullRes,
  className,
  alt,
  fetchQueueBias,
  observeRootMargin = DEFAULT_CACHED_IMAGE_PREPARE_MARGIN,
  observeScrollRootId,
  ...rest
}: CoverArtImageProps) {
  const { src, provisional } = useCoverArt(coverArtId, displayCssPx, {
    serverScope,
    surface,
    fullRes,
    fetchQueueBias,
    alt,
  });

  const imgSrc = coverImgSrc(src);

  return (
    <img
      src={imgSrc}
      className={className}
      alt={alt ?? ''}
      data-cover-provisional={provisional ? 'true' : undefined}
      data-observe-root-margin={observeRootMargin}
      data-observe-scroll-root={observeScrollRootId}
      {...rest}
    />
  );
}
