#!/usr/bin/env node
/**
 * Build src/generated/releaseNotesBundle.ts for production bundles.
 * -dev channel: embed full WHATS_NEW.md + CHANGELOG.md (workspace fallback).
 * RC/stable: embed only the slice for package.json version.
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findReleaseSection } from './extract-release-section.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const isDevChannel = /-dev(?:\b|$)/i.test(version);

const whatsNewPath = join(root, 'WHATS_NEW.md');
const changelogPath = join(root, 'CHANGELOG.md');
const whatsNewFull = readFileSync(whatsNewPath, 'utf8');
const changelogFull = readFileSync(changelogPath, 'utf8');

function sliceOrFull(full, fileLabel) {
  if (isDevChannel) return full;
  const entry = findReleaseSection(full, version);
  if (!entry?.body) {
    console.warn(`warn: no section in ${fileLabel} for ${version} — embedding empty slice`);
    return '';
  }
  const dateSuffix = entry.date ? ` - ${entry.date}` : '';
  return `## [${entry.headerVersion}]${dateSuffix}\n\n${entry.body}`;
}

const whatsNewRaw = sliceOrFull(whatsNewFull, 'WHATS_NEW.md');
const changelogRaw = sliceOrFull(changelogFull, 'CHANGELOG.md');

const outDir = join(root, 'src/generated');
mkdirSync(outDir, { recursive: true });

const ts = `/** @generated — run: node scripts/generate-release-notes-bundle.mjs */
export const IS_DEV_CHANNEL_BUNDLE: boolean = ${isDevChannel};

export const WHATS_NEW_RAW: string = ${JSON.stringify(whatsNewRaw)};

export const CHANGELOG_RAW: string = ${JSON.stringify(changelogRaw)};
`;

writeFileSync(join(outDir, 'releaseNotesBundle.ts'), ts, 'utf8');
console.log(`wrote src/generated/releaseNotesBundle.ts (${isDevChannel ? 'full dev channel' : 'sliced'} for ${version})`);
