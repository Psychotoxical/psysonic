import React, { memo, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Calendar, Info } from 'lucide-react';
import { open as shellOpen } from '@tauri-apps/plugin-shell';
import type { BandsintownEvent } from '../../api/bandsintown';
import { isoToParts } from '../../utils/componentHelpers/nowPlayingHelpers';

interface TourCardProps {
  artistName: string;
  enabled: boolean;
  loading: boolean;
  events: BandsintownEvent[];
  onEnable: () => void;
}

const TourCard = memo(function TourCard({ artistName, enabled, loading, events, onEnable }: TourCardProps) {
  const { t } = useTranslation();
  const [showAll, setShowAll] = useState(false);
  useEffect(() => { setShowAll(false); }, [artistName]);
  const TOUR_LIMIT = 5;
  const visible = showAll ? events : events.slice(0, TOUR_LIMIT);
  const hidden = Math.max(0, events.length - visible.length);

  return (
    <div className="np-info-card np-dash-card">
      <div className="np-card-header">
        <h3 className="np-card-title">
          <Calendar size={13} style={{ marginRight: 5, verticalAlign: '-2px' }} />
          {t('nowPlayingInfo.onTour', 'On tour')}
        </h3>
      </div>

      {!enabled ? (
        <div className="np-info-bandsintown-prompt">
          <div className="np-info-bandsintown-prompt-title">
            <span>{t('nowPlayingInfo.enableBandsintownPrompt', 'See upcoming tour dates?')}</span>
            <span className="np-info-bandsintown-prompt-info"
              data-tooltip={t('nowPlayingInfo.enableBandsintownPrivacy', 'When enabled, the current artist\'s name is sent to the Bandsintown API to fetch tour dates. No personal account information leaves your device.')}
              data-tooltip-pos="bottom"
              data-tooltip-wrap="true"
              tabIndex={0}>
              <Info size={13} />
            </span>
          </div>
          <div className="np-info-bandsintown-prompt-desc">
            {t('nowPlayingInfo.enableBandsintownPromptDesc', 'Optional. Loads concerts for the current artist via Bandsintown.')}
          </div>
          <button className="np-info-bandsintown-prompt-btn" onClick={onEnable}>
            {t('nowPlayingInfo.enableBandsintownAction', 'Enable')}
          </button>
        </div>
      ) : (
        <>
          {loading && events.length === 0 && (
            <div className="np-info-tour-empty">{t('nowPlayingInfo.tourLoading', 'Loading…')}</div>
          )}
          {!loading && events.length === 0 && (
            <div className="np-info-tour-empty">{t('nowPlayingInfo.noTourEvents', 'No upcoming shows')}</div>
          )}
          {visible.length > 0 && (
            <ul className="np-info-tour">
              {visible.map((ev, idx) => {
                const parts = isoToParts(ev.datetime);
                const place = [ev.venueCity, ev.venueRegion, ev.venueCountry].filter(Boolean).join(', ');
                return (
                  <li key={`${ev.datetime}-${ev.venueName}-${idx}`}
                    className="np-info-tour-item"
                    onClick={() => ev.url && shellOpen(ev.url).catch(() => {})}
                    role={ev.url ? 'button' : undefined}
                    tabIndex={ev.url ? 0 : undefined}>
                    {parts && (
                      <div className="np-info-tour-date">
                        <div className="np-info-tour-date-month">{parts.month}</div>
                        <div className="np-info-tour-date-day">{parts.day}</div>
                      </div>
                    )}
                    <div className="np-info-tour-meta">
                      <div className="np-info-tour-venue">{ev.venueName || place}</div>
                      <div className="np-info-tour-place">
                        {parts && <span className="np-info-tour-when">{parts.weekday}, {parts.time}</span>}
                        {parts && place && <span className="np-info-tour-sep"> • </span>}
                        <span>{place}</span>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {(hidden > 0 || (showAll && events.length > TOUR_LIMIT)) && (
            <button className="np-info-tour-more" onClick={() => setShowAll(v => !v)}>
              {showAll
                ? t('nowPlayingInfo.showLessTours', 'Show less')
                : t('nowPlayingInfo.showMoreTours', { defaultValue: 'Show {{count}} more', count: hidden })}
            </button>
          )}
          <div className="np-info-tour-credit">{t('nowPlayingInfo.poweredByBandsintown', 'Tour data via Bandsintown')}</div>
        </>
      )}
    </div>
  );
});

export default TourCard;
