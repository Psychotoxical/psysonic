/** §6 Layout 1 — Overview: the year in one poster. */

import { losslessPercent, splitHoursMinutes } from '../../yearRecapDerive';
import {
  drawCard,
  drawEqualizerBars,
  drawFooter,
  drawHeader,
  drawHeroStat,
  drawHourlyHeatband,
  drawInsightCard,
  drawKickerTitle,
  drawLosslessDonut,
  drawMiniStatRow,
  drawProgressBar,
  drawRankedList,
  drawSectionLabel,
  drawCoverTile,
} from '../components';
import { fitText } from '../draw';
import { drawIcon } from '../motifs';
import { REWIND_COLORS, REWIND_FONT_TEXT } from '../tokens';
import type { RewindRenderContext } from '../types';

/** The hero label ("Stunden Musik") stacked into up to two balanced lines. */
function heroLabelLines(label: string): string[] {
  const words = label.split(' ');
  if (words.length < 2) return [label];
  const mid = Math.ceil(words.length / 2);
  return [words.slice(0, mid).join(' '), words.slice(mid).join(' ')];
}

export function renderOverviewLayout(rc: RewindRenderContext): void {
  const { ctx, w, pad, strings, data, type } = rc;
  const story = rc.format === 'story';

  let y = drawHeader(rc);
  y = drawKickerTitle(rc, y, strings.overviewTitle);

  const time = splitHoursMinutes(data.recap.totalListenedSec);
  const heroValue = time.hours > 0 ? time.hours.toLocaleString() : String(time.minutes);
  const heroWord = time.hours > 0 ? strings.hoursWord : strings.minutesWord;
  y = drawHeroStat(rc, y, heroValue, heroLabelLines(heroWord));
  y += Math.round(rc.h * (story ? 0.028 : 0.014));

  y = drawMiniStatRow(rc, y, [
    { icon: 'calendar', value: data.summary.listeningDayCount.toLocaleString(), label: strings.statDays },
    { icon: 'headphones', value: data.summary.trackPlayCount.toLocaleString(), label: strings.statPlays },
    { icon: 'person', value: data.recap.newArtistCount.toLocaleString(), label: strings.statNewArtists },
  ]);
  y += Math.round(rc.h * (story ? 0.028 : 0.016));

  // ── Top artists (left card) and top albums (right card) ────────────────
  const artists = data.recap.topArtists.slice(0, 5);
  const albums = data.recap.topAlbums.slice(0, 5);
  const gap = 20;
  const leftW = Math.round((w - pad * 2 - gap) * 0.44);
  const rightW = w - pad * 2 - gap - leftW;
  const panelPad = 24;

  // Card height derives from the ranked-list metrics so both cards match and
  // neither trails dead space below its content.
  const heroRow = Math.round(type.spotlight * 0.82);
  const rowGap = Math.round(type.listRow * (story ? 1.6 : 1.3));
  const listH = heroRow + Math.round(rowGap * 0.55) + Math.max(0, artists.length - 1) * rowGap;
  const labelH = type.section + 16;
  const panelH = labelH + listH + panelPad * 2;

  if (artists.length > 0) {
    drawCard(ctx, pad, y, leftW, panelH);
    const py = drawSectionLabel(rc, pad + panelPad, y + panelPad, strings.topArtists, leftW - panelPad * 2);
    drawRankedList(rc, pad + panelPad, py, leftW - panelPad * 2, artists, { rowGap });
  }

  if (albums.length > 0) {
    const rx = pad + leftW + gap;
    drawCard(ctx, rx, y, rightW, panelH);
    const py = drawSectionLabel(rc, rx + panelPad, y + panelPad, strings.topAlbums, rightW - panelPad * 2);
    const innerW = rightW - panelPad * 2;
    // #1 dominant on the left, up to four smaller tiles in a 2×2 grid that
    // fills the hero tile's height exactly (§5 AlbumGrid).
    const smallGap = 14;
    const bigSize = Math.floor(Math.min((innerW - smallGap) / 2 + smallGap, panelH - (py - y) - panelPad));
    const smallSize = Math.floor((bigSize - smallGap) / 2);
    const gridY = py + Math.max(0, Math.floor((panelH - (py - y) - panelPad - bigSize) / 2));
    drawCoverTile(rc, rx + panelPad, gridY, bigSize, rc.covers.get(0) ?? null, { glow: true });
    for (let i = 1; i < Math.min(5, albums.length); i++) {
      const col = (i - 1) % 2;
      const row = Math.floor((i - 1) / 2);
      drawCoverTile(
        rc,
        rx + panelPad + bigSize + smallGap + col * (smallSize + smallGap),
        gridY + row * (smallSize + smallGap),
        smallSize,
        rc.covers.get(i) ?? null,
      );
    }
  }
  y += panelH + Math.round(rc.h * (story ? 0.03 : 0.016));

  // ── Story only: hour-of-day activity band with day/night markers ───────
  if (story && y + 220 <= rc.contentBottom) {
    const iconCol = 40;
    drawIcon(ctx, 'sun', pad, y + 6, 24, REWIND_COLORS.mutedPurple);
    drawIcon(ctx, 'moon', pad, y + 90, 22, REWIND_COLORS.mutedPurple);
    y = drawHourlyHeatband(rc, pad + iconCol, y, w - pad * 2 - iconCol, 4);
    y += Math.round(rc.h * 0.026);
  }

  // ── Lossless card (+ persona card on story), anchored to the footer ────
  const lossless = losslessPercent(data.recap.losslessListenedSec, data.recap.totalListenedSec);
  const cardH = story ? 156 : 112;
  if (lossless !== null && y + cardH <= rc.contentBottom) {
    y = Math.max(y, rc.contentBottom - cardH - 8);
    const personaFits = story && strings.personaTitle !== null;
    const lossW = personaFits ? Math.round((w - pad * 2 - gap) * 0.62) : w - pad * 2;
    drawCard(ctx, pad, y, lossW, cardH);
    const donutR = cardH * 0.3;
    drawLosslessDonut(rc, pad + 34 + donutR, y + cardH / 2, donutR, lossless, '');
    const textX = pad + 34 + donutR * 2 + 26;
    ctx.fillStyle = REWIND_COLORS.textPrimary;
    ctx.font = `600 ${Math.round(type.body * 0.92)}px ${REWIND_FONT_TEXT}`;
    const sentence = `${lossless}% ${strings.losslessSentence}`;
    const eqW = personaFits ? 0 : 170;
    const sentenceW = lossW - (textX - pad) - 30 - eqW;
    ctx.fillText(fitText(ctx, sentence, sentenceW), textX, y + cardH / 2 - 8);
    drawProgressBar(rc, textX, y + cardH / 2 + 14, sentenceW, lossless);
    if (!personaFits) {
      drawEqualizerBars(ctx, pad + lossW - eqW + 20, y + cardH / 2 - 32, eqW - 50, 64, rc.seed + 41);
    }
    if (personaFits && strings.personaTitle) {
      drawInsightCard(
        rc,
        pad + lossW + gap,
        y,
        w - pad * 2 - lossW - gap,
        cardH,
        'moon',
        strings.personaTitle,
        null,
      );
    }
  }

  drawFooter(rc, { withLock: story });
}
