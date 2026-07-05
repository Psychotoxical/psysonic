import React from 'react';

type AlbumBrowseGridSkeletonProps = {
  slotCount?: number;
};

/** Placeholder album grid while the first scoped SQL page loads. */
export default function AlbumBrowseGridSkeleton({
  slotCount = 12,
}: AlbumBrowseGridSkeletonProps): React.JSX.Element {
  const slots = Array.from({ length: slotCount }, (_, i) => i);
  return (
    <div className="album-grid-wrap" aria-busy="true" aria-label="Loading albums">
      {slots.map(i => (
        <div key={i} className="album-card album-card--skeleton" aria-hidden="true">
          <div className="album-card-cover album-card-cover--skeleton" />
          <div className="album-card-info">
            <div className="album-card-skeleton-line album-card-skeleton-line--title" />
            <div className="album-card-skeleton-line album-card-skeleton-line--artist" />
          </div>
        </div>
      ))}
    </div>
  );
}
