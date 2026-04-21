import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';
import { open as shellOpen } from '@tauri-apps/plugin-shell';
import { usePlayerStore } from '../store/playerStore';
import { useAuthStore } from '../store/authStore';
import { getArtistInfo, getSong, type SubsonicArtistInfo, type SubsonicSong } from '../api/subsonic';
import { fetchBandsintownEvents, type BandsintownEvent } from '../api/bandsintown';
import CachedImage from './CachedImage';

const TOUR_LIMIT = 5;
const BIO_CLAMP_LINES = 4;

/**
 * Cross-mount caches keyed by stable IDs so jumping between tracks of the same
 * artist / album doesn't refire the network call. Cleared on app restart.
 */
const artistInfoCache = new Map<string, SubsonicArtistInfo | null>();
const songDetailCache = new Map<string, SubsonicSong | null>();

function isoToParts(iso: string): { month: string; day: string; weekday: string; time: string } | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const month = d.toLocaleString(undefined, { month: 'short' });
  const day = String(d.getDate());
  const weekday = d.toLocaleString(undefined, { weekday: 'short' });
  const time = d.toLocaleString(undefined, { hour: '2-digit', minute: '2-digit' });
  return { month, day, weekday, time };
}

interface ContributorRow {
  role: string;
  names: string[];
}

/**
 * Build credits from OpenSubsonic `contributors[]` only. The legacy
 * artist/albumArtist/composer fallback is intentionally dropped — it
 * just repeats what's already shown above the tab.
 */
function buildContributorRows(
  song: SubsonicSong | null | undefined,
  mainArtistName: string,
): ContributorRow[] {
  if (!song?.contributors || song.contributors.length === 0) return [];
  const mainLower = mainArtistName.trim().toLowerCase();
  const rows = new Map<string, Set<string>>();
  for (const c of song.contributors) {
    const role = c.role?.trim();
    const name = c.artist?.name?.trim();
    if (!role || !name) continue;
    const label = c.subRole ? `${role} • ${c.subRole}` : role;
    let bucket = rows.get(label);
    if (!bucket) { bucket = new Set(); rows.set(label, bucket); }
    bucket.add(name);
  }
  // Drop a row that only restates the main artist under the "artist" role.
  const out: ContributorRow[] = [];
  for (const [role, names] of rows.entries()) {
    const list = Array.from(names);
    const isMainArtistOnly =
      role.toLowerCase().startsWith('artist') &&
      list.length === 1 &&
      list[0].toLowerCase() === mainLower;
    if (isMainArtistOnly) continue;
    out.push({ role, names: list });
  }
  return out;
}

export default function NowPlayingInfo() {
  const { t } = useTranslation();
  const currentTrack = usePlayerStore(s => s.currentTrack);
  const enableBandsintown = useAuthStore(s => s.enableBandsintown);
  const setEnableBandsintown = useAuthStore(s => s.setEnableBandsintown);

  const artistName = currentTrack?.artist || '';
  const artistId = currentTrack?.artistId || '';
  const songId = currentTrack?.id || '';

  const [artistInfo, setArtistInfo] = useState<SubsonicArtistInfo | null>(
    artistId ? artistInfoCache.get(artistId) ?? null : null,
  );
  const [songDetail, setSongDetail] = useState<SubsonicSong | null>(
    songId ? songDetailCache.get(songId) ?? null : null,
  );
  const [tourEvents, setTourEvents] = useState<BandsintownEvent[]>([]);
  const [tourLoading, setTourLoading] = useState(false);
  const [bioExpanded, setBioExpanded] = useState(false);
  const [bioOverflows, setBioOverflows] = useState(false);
  const [showAllTours, setShowAllTours] = useState(false);

  const bioRef = useRef<HTMLParagraphElement | null>(null);

  // Reset per-track UI state when the track changes
  useEffect(() => { setBioExpanded(false); setShowAllTours(false); }, [artistId, songId]);

  // Artist bio + image
  useEffect(() => {
    if (!artistId) { setArtistInfo(null); return; }
    const cached = artistInfoCache.get(artistId);
    if (cached !== undefined) { setArtistInfo(cached); return; }
    let cancelled = false;
    getArtistInfo(artistId)
      .then(info => { if (!cancelled) { artistInfoCache.set(artistId, info ?? null); setArtistInfo(info ?? null); } })
      .catch(() => { if (!cancelled) { artistInfoCache.set(artistId, null); setArtistInfo(null); } });
    return () => { cancelled = true; };
  }, [artistId]);

  // Song detail (for OpenSubsonic contributors[])
  useEffect(() => {
    if (!songId) { setSongDetail(null); return; }
    const cached = songDetailCache.get(songId);
    if (cached !== undefined) { setSongDetail(cached); return; }
    let cancelled = false;
    getSong(songId)
      .then(song => { if (!cancelled) { songDetailCache.set(songId, song ?? null); setSongDetail(song ?? null); } })
      .catch(() => { if (!cancelled) { songDetailCache.set(songId, null); setSongDetail(null); } });
    return () => { cancelled = true; };
  }, [songId]);

  // Bandsintown — only when opt-in toggle is on
  useEffect(() => {
    if (!enableBandsintown || !artistName) { setTourEvents([]); return; }
    let cancelled = false;
    setTourLoading(true);
    fetchBandsintownEvents(artistName)
      .then(events => { if (!cancelled) setTourEvents(events); })
      .finally(() => { if (!cancelled) setTourLoading(false); });
    return () => { cancelled = true; };
  }, [enableBandsintown, artistName]);

  // Detect whether the (clamped) bio actually overflows so we hide the toggle
  // when it would do nothing.
  const bio = artistInfo?.biography?.trim() || '';
  const bioClean = bio.replace(/<a [^>]*>.*?<\/a>\.?/gi, '').trim();
  useLayoutEffect(() => {
    const el = bioRef.current;
    if (!el) { setBioOverflows(false); return; }
    setBioOverflows(el.scrollHeight - el.clientHeight > 1);
  }, [bioClean]);

  const contributorRows = useMemo(
    () => buildContributorRows(songDetail, artistName),
    [songDetail, artistName],
  );

  if (!currentTrack) {
    return (
      <div className="np-info-empty">
        {t('nowPlayingInfo.empty', 'Play something to see info')}
      </div>
    );
  }

  const heroImage = artistInfo?.largeImageUrl || artistInfo?.mediumImageUrl || '';
  const heroCacheKey = artistId ? `artistInfo:${artistId}:hero` : '';

  const visibleTours = showAllTours ? tourEvents : tourEvents.slice(0, TOUR_LIMIT);
  const hiddenTourCount = Math.max(0, tourEvents.length - visibleTours.length);

  return (
    <div className="np-info">
      {/* Artist card */}
      <section className="np-info-section np-info-artist">
        {heroImage && heroCacheKey && (
          <div className="np-info-artist-image-wrap">
            <CachedImage
              src={heroImage}
              cacheKey={heroCacheKey}
              alt={artistName}
              className="np-info-artist-image"
            />
          </div>
        )}
        <div className="np-info-artist-body">
          <div className="np-info-section-title">{t('nowPlayingInfo.artist', 'Artist')}</div>
          <div className="np-info-artist-name">{artistName || t('common.unknownArtist', 'Unknown artist')}</div>
          {bioClean && (
            <>
              <p
                ref={bioRef}
                className={`np-info-artist-bio${bioExpanded ? '' : ' is-clamped'}`}
                style={bioExpanded ? undefined : { WebkitLineClamp: BIO_CLAMP_LINES }}
              >
                {bioClean}
              </p>
              {(bioOverflows || bioExpanded) && (
                <button
                  type="button"
                  className="np-info-link-btn"
                  onClick={() => setBioExpanded(v => !v)}
                >
                  {bioExpanded
                    ? t('nowPlayingInfo.bioReadLess', 'Show less')
                    : t('nowPlayingInfo.bioReadMore', 'Read more')}
                </button>
              )}
            </>
          )}
        </div>
      </section>

      {/* Song info / contributors — only when OpenSubsonic provided real credits */}
      {contributorRows.length > 0 && (
        <section className="np-info-section">
          <div className="np-info-section-title">{t('nowPlayingInfo.songInfo', 'Song info')}</div>
          <ul className="np-info-credits">
            {contributorRows.map(row => (
              <li key={row.role} className="np-info-credit-row">
                <span className="np-info-credit-names">{row.names.join(', ')}</span>
                <span className="np-info-credit-role">{t(`nowPlayingInfo.role.${row.role}`, row.role)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Tour: prompt to opt-in when off, list when on */}
      {!enableBandsintown ? (
        <section className="np-info-section">
          <div className="np-info-bandsintown-prompt">
            <div className="np-info-bandsintown-prompt-title">
              <span>{t('nowPlayingInfo.enableBandsintownPrompt', 'See upcoming tour dates?')}</span>
              <span
                className="np-info-bandsintown-prompt-info"
                data-tooltip={t('nowPlayingInfo.enableBandsintownPrivacy', 'When enabled, the current artist\'s name is sent to the Bandsintown API to fetch tour dates. No personal account information leaves your device.')}
                data-tooltip-pos="bottom"
                data-tooltip-wrap="true"
                aria-label={t('nowPlayingInfo.enableBandsintownPrivacy', 'When enabled, the current artist\'s name is sent to the Bandsintown API to fetch tour dates. No personal account information leaves your device.')}
                tabIndex={0}
              >
                <Info size={13} />
              </span>
            </div>
            <div className="np-info-bandsintown-prompt-desc">
              {t('nowPlayingInfo.enableBandsintownPromptDesc', 'Optional. Loads concerts for the current artist via Bandsintown.')}
            </div>
            <button
              type="button"
              className="np-info-bandsintown-prompt-btn"
              onClick={() => setEnableBandsintown(true)}
            >
              {t('nowPlayingInfo.enableBandsintownAction', 'Enable')}
            </button>
          </div>
        </section>
      ) : (
        <section className="np-info-section">
          <div className="np-info-section-title">{t('nowPlayingInfo.onTour', 'On tour')}</div>
          {tourLoading && tourEvents.length === 0 && (
            <div className="np-info-tour-empty">{t('nowPlayingInfo.tourLoading', 'Loading…')}</div>
          )}
          {!tourLoading && tourEvents.length === 0 && (
            <div className="np-info-tour-empty">{t('nowPlayingInfo.noTourEvents', 'No upcoming shows')}</div>
          )}
          {visibleTours.length > 0 && (
            <ul className="np-info-tour">
              {visibleTours.map((ev, idx) => {
                const parts = isoToParts(ev.datetime);
                const place = [ev.venueCity, ev.venueRegion, ev.venueCountry]
                  .filter(Boolean).join(', ');
                return (
                  <li
                    key={`${ev.datetime}-${ev.venueName}-${idx}`}
                    className="np-info-tour-item"
                    onClick={() => ev.url && shellOpen(ev.url).catch(() => {})}
                    role={ev.url ? 'button' : undefined}
                    tabIndex={ev.url ? 0 : undefined}
                  >
                    {parts && (
                      <div className="np-info-tour-date">
                        <div className="np-info-tour-date-month">{parts.month}</div>
                        <div className="np-info-tour-date-day">{parts.day}</div>
                      </div>
                    )}
                    <div className="np-info-tour-meta">
                      <div className="np-info-tour-venue">{ev.venueName || place}</div>
                      <div className="np-info-tour-place">
                        {parts && (
                          <span className="np-info-tour-when">{parts.weekday}, {parts.time}</span>
                        )}
                        {parts && place && <span className="np-info-tour-sep"> • </span>}
                        <span>{place}</span>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {(hiddenTourCount > 0 || (showAllTours && tourEvents.length > TOUR_LIMIT)) && (
            <button
              type="button"
              className="np-info-tour-more"
              onClick={() => setShowAllTours(v => !v)}
            >
              {showAllTours
                ? t('nowPlayingInfo.showLessTours', 'Show less')
                : t('nowPlayingInfo.showMoreTours', { defaultValue: 'Show {{count}} more', count: hiddenTourCount })}
            </button>
          )}
          <div className="np-info-tour-credit">
            {t('nowPlayingInfo.poweredByBandsintown', 'Tour data via Bandsintown')}
          </div>
        </section>
      )}
    </div>
  );
}
