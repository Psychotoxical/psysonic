/**
 * `ArtistCard` characterization — covers the prop surface added when the
 * card became the shared "About the Artist" component for both the
 * NowPlaying page and ArtistDetail (replacing the inline bio block on
 * /artist/:id and the previously-divergent rendering).
 */
import { describe, it, expect, vi } from 'vitest';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import ArtistCard from './ArtistCard';
import type { SubsonicArtistInfo } from '../../api/subsonicTypes';

const infoWithImage: SubsonicArtistInfo = {
  biography: 'Some bio text here.',
  largeImageUrl: 'https://example.test/a-large.jpg',
  similarArtist: [{ id: 'sim-1', name: 'Sister Act' }],
} as unknown as SubsonicArtistInfo;

describe('ArtistCard — optional onNavigate', () => {
  it('hides the "Go to Artist" link when onNavigate is omitted', () => {
    const { container } = renderWithProviders(
      <ArtistCard artistName="A" artistId="art-1" artistInfo={infoWithImage} />,
    );
    expect(container.querySelector('.np-card-link')).toBeNull();
  });

  it('renders the "Go to Artist" link when onNavigate is provided', () => {
    const { container } = renderWithProviders(
      <ArtistCard artistName="A" artistId="art-1" artistInfo={infoWithImage} onNavigate={vi.fn()} />,
    );
    expect(container.querySelector('.np-card-link')).not.toBeNull();
  });
});

describe('ArtistCard — hideArtistName / hideSimilar', () => {
  it('does not render the artist name row when hideArtistName is set', () => {
    const { container } = renderWithProviders(
      <ArtistCard artistName="A" artistId="art-1" artistInfo={infoWithImage} hideArtistName />,
    );
    expect(container.querySelector('.np-dash-artist-name')).toBeNull();
  });

  it('does not render the similar-artists chip row when hideSimilar is set', () => {
    const { container } = renderWithProviders(
      <ArtistCard artistName="A" artistId="art-1" artistInfo={infoWithImage} hideSimilar />,
    );
    expect(container.querySelector('.np-dash-similar')).toBeNull();
  });
});

describe('ArtistCard — coverFallback', () => {
  it('uses coverFallback src + cacheKey when artistInfo has no hero image', () => {
    const noImageInfo = { biography: 'b', similarArtist: [] } as unknown as SubsonicArtistInfo;
    const { container } = renderWithProviders(
      <ArtistCard
        artistName="A"
        artistId="art-1"
        artistInfo={noImageInfo}
        coverFallback={{ src: 'https://fallback.test/cover.jpg', cacheKey: 'fb:art-1:cover' }}
      />,
    );
    const img = container.querySelector<HTMLImageElement>('img.np-dash-artist-image');
    expect(img).not.toBeNull();
    // CachedImage swaps src to a blob URL asynchronously; the initial render
    // shows the fetch URL — assert the *configured* fallback src is in play.
    expect(img!.getAttribute('src') || '').toContain('fallback.test');
  });

  it('prefers info.largeImageUrl over the fallback when both are present', () => {
    const { container } = renderWithProviders(
      <ArtistCard
        artistName="A"
        artistId="art-1"
        artistInfo={infoWithImage}
        coverFallback={{ src: 'https://fallback.test/cover.jpg', cacheKey: 'fb:art-1:cover' }}
      />,
    );
    const img = container.querySelector<HTMLImageElement>('img.np-dash-artist-image');
    expect(img!.getAttribute('src') || '').toContain('a-large.jpg');
  });
});
