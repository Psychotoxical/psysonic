import type { ImgHTMLAttributes } from 'react';
import type { CoverArtId, CoverServerScope, CoverSurfaceKind } from './types';
import { useCoverArt } from './useCoverArt';

export type CoverArtImageProps = {
  coverArtId: CoverArtId | null | undefined;
  displayCssPx: number;
  serverScope?: CoverServerScope;
  surface?: CoverSurfaceKind;
  fullRes?: boolean;
  className?: string;
  alt?: string;
} & Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'>;

/** Phase A stub */
export function CoverArtImage({
  coverArtId,
  displayCssPx,
  serverScope,
  surface,
  fullRes,
  className,
  alt,
  ...rest
}: CoverArtImageProps) {
  const { src } = useCoverArt(coverArtId, displayCssPx, { serverScope, surface, fullRes, alt });
  return <img src={src} className={className} alt={alt ?? ''} {...rest} />;
}
