/** §7 Layout 2 — Artist Spotlight: the #1 artist carries the poster. */

import { splitHoursMinutes } from '../../yearRecapDerive';
import {
  drawFooter,
  drawHeader,
  drawInlineStatRow,
  drawKickerTitle,
  drawSectionLabel,
} from '../components';
import { drawGlowText, fitText, splitTwoLines } from '../draw';
import { drawWaveform } from '../motifs';
import { REWIND_COLORS, REWIND_FONT_DISPLAY, REWIND_FONT_TEXT } from '../tokens';
import type { RewindRenderContext, RewindStrings } from '../types';

const C = REWIND_COLORS;

export function formatShortTime(
  sec: number,
  strings: Pick<RewindStrings, 'hourUnit' | 'minuteUnit'>,
): string {
  const time = splitHoursMinutes(sec);
  if (time.hours > 0) {
    return `${time.hours} ${strings.hourUnit} ${time.minutes} ${strings.minuteUnit}`;
  }
  return `${time.minutes} ${strings.minuteUnit}`;
}

export function renderArtistLayout(rc: RewindRenderContext): void {
  const { ctx, w, pad, strings, data, type } = rc;
  const story = rc.format === 'story';
  const leader = data.recap.topArtists[0];
  if (!leader) return; // The modal never offers this layout without a leader.

  let y = drawHeader(rc);
  y = drawKickerTitle(rc, y, strings.artistTitle.toLocaleUpperCase());

  // Giant "01" with the waveform running behind it across the poster.
  const rankSize = Math.round(type.hero * (story ? 1.6 : 1.1));
  drawWaveform(
    ctx,
    pad + rankSize * 0.85,
    y + rankSize * 0.08,
    w - pad * 1.2 - rankSize * 0.85,
    rankSize * 0.8,
    rc.seed + 21,
  );
  drawGlowText(ctx, '01', pad, y + rankSize * 0.84, `800 ${rankSize}px ${REWIND_FONT_DISPLAY}`, rankSize);
  y += rankSize * 0.94;

  // The artist name — the only hero (§7), up to two lines.
  const nameSize = Math.round(type.hero * (story ? 0.95 : 0.72));
  ctx.font = `800 ${nameSize}px ${REWIND_FONT_DISPLAY}`;
  ctx.fillStyle = C.textPrimary;
  const nameLines = splitTwoLines(ctx, leader.name.toLocaleUpperCase(), w - pad * 2);
  for (const line of nameLines) {
    ctx.fillText(line, pad, y + nameSize * 0.9);
    y += nameSize * 0.98;
  }
  y += Math.round(rc.h * (story ? 0.032 : 0.024));

  y = drawInlineStatRow(rc, y, [
    { value: leader.playCount.toLocaleString(), label: strings.statPlays },
    { value: formatShortTime(leader.listenedSec, strings), label: strings.statListeningTime },
    { value: data.recap.topArtistSessionCount.toLocaleString(), label: strings.statSessions },
  ]);
  y += Math.round(rc.h * (story ? 0.024 : 0.016));

  // Divider + the leader's top tracks.
  ctx.strokeStyle = 'rgba(110, 80, 166, 0.45)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(pad, y);
  ctx.lineTo(w - pad, y);
  ctx.stroke();
  y += Math.round(rc.h * (story ? 0.03 : 0.022));

  const tracks = data.recap.topArtistTracks.slice(0, 5);
  if (tracks.length > 0 && y + type.section + tracks.length * type.listRow <= rc.contentBottom) {
    y = drawSectionLabel(rc, pad, y, strings.topTracks);
    y += story ? 18 : 10;
    const rowGap = Math.round(type.listRow * (story ? 1.7 : 1.4));
    tracks.forEach((track, i) => {
      ctx.font = `700 ${type.listRow}px ${REWIND_FONT_TEXT}`;
      ctx.fillStyle = C.primaryPurple;
      ctx.fillText(String(i + 1).padStart(2, '0'), pad, y + type.listRow);
      ctx.fillStyle = C.textPrimary;
      ctx.fillText(
        fitText(ctx, track.name.toLocaleUpperCase(), w - pad * 2 - 80),
        pad + 80,
        y + type.listRow,
      );
      y += rowGap;
    });
  }

  // Runners-up anchor just above the footer; the connective wave breathes in
  // whatever space is left between them and the track list (§7).
  const runners = data.recap.topArtists.slice(1, 3);
  const runnersY = rc.contentBottom - type.listRow - 26;
  if (story && runnersY - y > 110) {
    const waveH = Math.min(170, runnersY - y - 20);
    drawWaveform(ctx, pad, y + (runnersY - y - waveH) / 2 - 10, w - pad * 2, waveH, rc.seed + 31, 0.9);
  }
  if (runners.length > 0 && runnersY > y) {
    const colW = (w - pad * 2) / 2;
    runners.forEach((artist, i) => {
      const x = pad + i * colW;
      ctx.font = `700 ${type.listRow}px ${REWIND_FONT_TEXT}`;
      ctx.fillStyle = C.primaryPurple;
      const rank = `#${i + 2}`;
      ctx.fillText(rank, x, runnersY + type.listRow);
      const rankW = ctx.measureText(rank).width;
      ctx.fillStyle = C.textPrimary;
      ctx.fillText(
        fitText(ctx, artist.name.toLocaleUpperCase(), colW - rankW - 40),
        x + rankW + 18,
        runnersY + type.listRow,
      );
    });
  }

  drawFooter(rc);
}
