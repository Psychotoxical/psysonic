#!/usr/bin/env node
/**
 * Write bundle.windows.wix.version in tauri.conf.json from package.json.
 * Keeps the top-level app version unchanged (About, updater metadata, filenames).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { wixVersionOverrideForPackageVersion } from './wix-bundle-version.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
if (!version || typeof version !== 'string') {
  console.error('package.json version missing');
  process.exit(1);
}

const confPath = path.join(root, 'src-tauri', 'tauri.conf.json');
const conf = JSON.parse(fs.readFileSync(confPath, 'utf8'));
conf.bundle ??= {};
conf.bundle.windows ??= {};
conf.bundle.windows.wix ??= {};

const wixVersion = wixVersionOverrideForPackageVersion(version);
conf.bundle.windows.wix.version = wixVersion;
console.log(`tauri.conf wix.version -> ${wixVersion} (package ${version})`);

fs.writeFileSync(confPath, `${JSON.stringify(conf, null, 2)}\n`);
