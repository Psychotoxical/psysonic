/** §8 Layout 3 — Album Spotlight: cover first, data second. */

import {
  drawCoverTile,
  drawFooter,
  drawHeader,
  drawInlineStatRow,
  drawKickerTitle,
  drawSectionLabel,
} from '../components';
import { fitText, splitTwoLines } from '../draw';
import { drawWaveform } from '../motifs';
import { REWIND_COLORS, REWIND_FONT_DISPLAY } from '../tokens';
import type { RewindRenderContext } from '../types';
import { formatShortTime } from './artist';

const C = REWIND_COLORS;

export function renderAlbumLayout(rc: RewindRenderContext): void {
  const { ctx, w, pad, strings, data, type } = rc;
  const story = rc.format === 'story';
  const leader = data.recap.topAlbums[0];
  if (!leader) return; // The modal never offers this layout without a leader.

  let y = drawHeader(rc);
  y = drawKickerTitle(rc, y, strings.albumTitle.toLocaleUpperCase());

  // The dominant #1 cover, centred, glowing (§8).
  const coverSize = Math.round(Math.min(w - pad * 2, story ? w * 0.62 : w * 0.34));
  const coverX = Math.round((w - coverSize) / 2);
  y += story ? 14 : 4;
  drawCoverTile(rc, coverX, y, coverSize, rc.covers.get(0) ?? null, { glow: true, radius: 18 });
  y += coverSize + (story ? 48 : 28);

  // Rank + album + artist, visually differentiated (§4 level 2).
  const rankSize = Math.round(type.spotlight * 0.9);
  ctx.font = `800 ${rankSize}px ${REWIND_FONT_DISPLAY}`;
  ctx.fillStyle = C.primaryPurple;
  ctx.fillText('01', pad, y + rankSize * 0.9);
  y += rankSize + 6;
  const titleSize = Math.round(type.spotlight * (story ? 1.0 : 0.85));
  ctx.font = `800 ${titleSize}px ${REWIND_FONT_DISPLAY}`;
  ctx.fillStyle = C.textPrimary;
  for (const line of splitTwoLines(ctx, leader.name.toLocaleUpperCase(), w - pad * 2)) {
    ctx.fillText(line, pad, y + titleSize * 0.9);
    y += titleSize * 0.98;
  }
  if (leader.secondary) {
    ctx.font = `700 ${Math.round(titleSize * 0.62)}px ${REWIND_FONT_DISPLAY}`;
    ctx.fillStyle = C.mutedPurple;
    ctx.fillText(
      fitText(ctx, leader.secondary.toLocaleUpperCase(), w - pad * 2),
      pad,
      y + titleSize * 0.6,
    );
    y += titleSize * 0.72;
  }
  y += story ? 36 : 20;

  y = drawInlineStatRow(rc, y, [
    { value: leader.playCount.toLocaleString(), label: strings.statPlaysShort },
    { value: formatShortTime(leader.listenedSec, strings), label: strings.statListeningTime },
  ]);
  y += story ? 34 : 18;

  // Remaining top albums as smaller artwork (§8), pushed toward the footer so
  // the poster carries no dead band; the wave breathes just above the footer.
  const rest = data.recap.topAlbums.slice(1, 5);
  const smallSize = Math.round((w - pad * 2 - 3 * 18) / 4);
  const waveH = story ? 96 : 0;
  const blockH = type.section + 22 + smallSize + type.statLabel + 16;
  if (rest.length > 0 && y + blockH <= rc.contentBottom) {
    const blockY = Math.max(y, rc.contentBottom - waveH - 24 - blockH);
    let by = drawSectionLabel(rc, pad, blockY, strings.topAlbums);
    by += 6;
    rest.forEach((album, i) => {
      const x = pad + i * (smallSize + 18);
      drawCoverTile(rc, x, by, smallSize, rc.covers.get(i + 1) ?? null, {
        label: `${String(i + 2).padStart(2, '0')}  ${album.name}`,
      });
    });
    y = by + smallSize + type.statLabel + 16;
  }

  if (story && y + waveH <= rc.contentBottom + 10) {
    drawWaveform(ctx, pad, y, w - pad * 2, waveH, rc.seed + 51, 0.7);
  }

  drawFooter(rc);
}
