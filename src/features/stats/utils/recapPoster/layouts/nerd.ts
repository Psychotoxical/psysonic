/** §9 Layout 4 — Nerd Stats: local-first listening in numbers. */

import { losslessPercent, splitHoursMinutes } from '../../yearRecapDerive';
import {
  drawCard,
  drawFooter,
  drawGenreBars,
  drawHeader,
  drawHourlyHeatband,
  drawInlineStatRow,
  drawInsightCard,
  drawKickerTitle,
  drawLosslessDonut,
  drawSectionLabel,
} from '../components';
import { drawGlowText, fitText } from '../draw';
import { drawIcon } from '../motifs';
import { REWIND_COLORS, REWIND_FONT_DISPLAY, REWIND_FONT_TEXT } from '../tokens';
import type { RewindRenderContext } from '../types';
import { formatShortTime } from './artist';

const C = REWIND_COLORS;

export function renderNerdLayout(rc: RewindRenderContext): void {
  const { ctx, w, pad, strings, data, type } = rc;
  const story = rc.format === 'story';

  let y = drawHeader(rc);
  y = drawKickerTitle(rc, y, strings.nerdTitle.toLocaleUpperCase());

  // Hero hours left, lossless donut right.
  const time = splitHoursMinutes(data.recap.totalListenedSec);
  const heroSize = Math.round(type.hero * (story ? 0.95 : 0.8));
  const heroValue =
    time.hours > 0 ? `${time.hours.toLocaleString()} ${strings.hourUnit}` : `${time.minutes} ${strings.minuteUnit}`;
  const baseline = y + heroSize * 0.82;
  drawGlowText(
    ctx,
    heroValue.toLocaleUpperCase(),
    pad,
    baseline,
    `800 ${heroSize}px ${REWIND_FONT_DISPLAY}`,
    heroSize,
  );
  ctx.font = `700 ${Math.round(type.section * 1.15)}px ${REWIND_FONT_TEXT}`;
  ctx.fillStyle = C.textPrimary;
  const heroLabelY = baseline + type.section * 1.6;
  ctx.fillText(strings.nerdHeroLabel.toLocaleUpperCase(), pad, heroLabelY);

  const lossless = losslessPercent(data.recap.losslessListenedSec, data.recap.totalListenedSec);
  if (lossless !== null) {
    const donutR = story ? 105 : 88;
    drawLosslessDonut(rc, w - pad - donutR - 14, y + heroSize * 0.45, donutR, lossless, strings.losslessWord);
  }
  y = heroLabelY + (story ? 52 : 32);

  y = drawInlineStatRow(rc, y, [
    { value: data.summary.uniqueTrackCount.toLocaleString(), label: strings.statUniqueTracks },
    { value: data.recap.newArtistCount.toLocaleString(), label: strings.statNewArtists },
    { value: data.summary.listeningDayCount.toLocaleString(), label: strings.statDays },
  ]);
  y += Math.round(rc.h * (story ? 0.026 : 0.02));

  // Hour-of-day heatband.
  const bandRows = story ? 4 : 3;
  if (y + bandRows * 44 + type.section <= rc.contentBottom) {
    y = drawSectionLabel(rc, pad, y, strings.hourlyHeading);
    y = drawHourlyHeatband(rc, pad, y + 4, w - pad * 2, bandRows);
    y += Math.round(rc.h * (story ? 0.026 : 0.018));
  }

  // Persona insight card.
  if (strings.personaTitle && y + 130 <= rc.contentBottom) {
    const cardH = story ? 148 : 118;
    drawInsightCard(rc, pad, y, w - pad * 2, cardH, 'moon', strings.personaTitle, strings.personaBody);
    y += cardH + Math.round(rc.h * (story ? 0.026 : 0.02));
  }

  // Genres left, longest session right.
  const genres = data.recap.topGenres.slice(0, 4);
  const totalGenreSec = data.recap.topGenres.reduce((acc, g) => acc + g.listenedSec, 0);
  const colGap = 24;
  const leftW = Math.round((w - pad * 2 - colGap) * 0.55);
  const rightX = pad + leftW + colGap;
  const rightW = w - pad - rightX;
  const genreRows = genres.map(g => ({
    name: g.name,
    percent: totalGenreSec > 0 ? Math.round((g.listenedSec / totalGenreSec) * 100) : 0,
  }));
  const genreBlockH = type.section + 16 + genreRows.length * (type.statLabel + 37);
  if (genres.length > 0 && y + genreBlockH <= rc.contentBottom) {
    let gy = drawSectionLabel(rc, pad, y, strings.topGenres);
    gy = drawGenreBars(rc, pad, gy + 4, leftW, genreRows);

    // Longest session card beside the genres.
    if (data.recap.longestSessionSec > 0) {
      const cardY = y + type.section + 10;
      const cardH = gy - cardY - 16;
      if (cardH > 120) {
        drawSectionLabel(rc, rightX, y, strings.longestSession);
        drawCard(ctx, rightX, cardY, rightW, cardH);
        const iconSize = Math.min(64, cardH * 0.34);
        drawIcon(
          ctx,
          'hourglass',
          rightX + rightW / 2 - iconSize / 2,
          cardY + cardH * 0.16,
          iconSize,
          C.brightPurple,
        );
        ctx.textAlign = 'center';
        ctx.fillStyle = C.textPrimary;
        ctx.font = `800 ${Math.round(type.statValue * 1.15)}px ${REWIND_FONT_DISPLAY}`;
        ctx.fillText(
          fitText(
            ctx,
            formatShortTime(data.recap.longestSessionSec, strings).toLocaleUpperCase(),
            rightW - 28,
          ),
          rightX + rightW / 2,
          cardY + cardH * 0.16 + iconSize + type.statValue + 18,
        );
        ctx.textAlign = 'left';
      }
    }
    y = gy + (story ? 26 : 14);
  }

  // Local-first message card (§9 — the "why Psysonic" line), anchored to the
  // footer so the poster never trails dead space.
  const cardH = story ? 130 : 104;
  const cardY = Math.max(y, rc.contentBottom - cardH - 8);
  if (cardY + cardH <= rc.contentBottom + 8) {
    drawInsightCard(rc, pad, cardY, w - pad * 2, cardH, 'shield', strings.localFirstTitle, strings.localFirstBody);
  }

  drawFooter(rc);
}
