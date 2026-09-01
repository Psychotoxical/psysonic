#!/usr/bin/env node
// Adds the Windows entry to a release's latest.json for the Tauri updater.
//
// The Windows installer that ships is built and code-signed outside CI and
// uploaded to the release by hand, replacing the unsigned CI build under the
// same name. The updater only installs a download whose minisign signature
// matches the exact bytes it fetched, so that signature has to be made over the
// hand-uploaded file. This script runs in the "Sign Windows updater" workflow:
//
//   1. downloads Psysonic_<version>_x64-setup.exe and latest.json from the release
//   2. refuses to continue unless the installer carries an Authenticode
//      signature — the CI build is unsigned, so this catches "forgot to upload"
//   3. signs the installer with the updater key (`tauri signer sign` → .sig)
//   4. writes platforms["windows-x86_64"] into latest.json
//   5. uploads latest.json and the .sig back to the release (--clobber)
//
// Re-running is safe (the entry is replaced). Run it again whenever the
// installer asset changes.
//
// Required env: GH_TOKEN, TAURI_SIGNING_PRIVATE_KEY, TAURI_SIGNING_PRIVATE_KEY_PASSWORD
// Usage: node scripts/sign-windows-updater.mjs --tag app-v1.53.0 [--dry-run]

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { REPO, assetUrl, validateSignature, withPlatform } = require('./lib/updater-manifest.cjs');

// Updater target key. `bundle_type()` is unknown for an exe built with
// `--no-bundle`, so the plugin looks up plain `<os>-<arch>` — never the
// `windows-x86_64-nsis` variant.
export const WINDOWS_TARGET = 'windows-x86_64';

export function versionFromTag(tag) {
  const m = /^app-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)$/.exec(tag);
  if (!m) throw new Error(`unexpected release tag "${tag}" — expected app-vX.Y.Z or app-vX.Y.Z-rc.N`);
  return m[1];
}

export function windowsInstallerName(version) {
  return `Psysonic_${version}_x64-setup.exe`;
}

// Size of the Authenticode certificate table of a PE file, 0 when unsigned.
// Layout per the PE format specification (learn.microsoft.com, "PE Format"):
// e_lfanew at 0x3c → "PE\0\0" → 20-byte COFF header → optional header whose
// magic is 0x10b (PE32) or 0x20b (PE32+); the data directories start 96 (PE32)
// or 112 (PE32+) bytes into the optional header, 8 bytes each, and the
// Certificate Table is entry 4. Its first field is a file offset, not an RVA.
export function authenticodeSignatureSize(buf) {
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) {
    throw new Error('not a PE file (missing MZ header)');
  }
  const peOffset = buf.readUInt32LE(0x3c);
  if (peOffset + 24 > buf.length || buf.readUInt32LE(peOffset) !== 0x00004550) {
    throw new Error('not a PE file (missing PE signature)');
  }
  const optionalHeader = peOffset + 24;
  const magic = buf.readUInt16LE(optionalHeader);
  const directoriesOffset = magic === 0x10b ? 96 : magic === 0x20b ? 112 : null;
  if (directoriesOffset === null) {
    throw new Error(`unknown PE optional header magic 0x${magic.toString(16)}`);
  }
  const entry = optionalHeader + directoriesOffset + 4 * 8;
  if (entry + 8 > buf.length) throw new Error('truncated PE optional header');
  const offset = buf.readUInt32LE(entry);
  const size = buf.readUInt32LE(entry + 4);
  return offset > 0 && size > 0 ? size : 0;
}

function parseArgs(argv) {
  const out = { tag: '', dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--tag' && argv[i + 1]) out.tag = argv[++i];
    else if (argv[i] === '--dry-run') out.dryRun = true;
    else throw new Error(`unknown argument "${argv[i]}"`);
  }
  if (!out.tag) throw new Error('--tag <app-vX.Y.Z> is required');
  return out;
}

function run(cmd, args) {
  // npm/npx are .cmd shims on Windows: spawning them needs a shell there.
  const res = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited with ${res.status}`);
}

function requireEnv(name) {
  if (!process.env[name]) throw new Error(`${name} is not set`);
}

export async function main(argv = process.argv) {
  const { tag, dryRun } = parseArgs(argv);
  requireEnv('TAURI_SIGNING_PRIVATE_KEY');
  requireEnv('TAURI_SIGNING_PRIVATE_KEY_PASSWORD');

  const version = versionFromTag(tag);
  const installer = windowsInstallerName(version);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'psysonic-windows-updater-'));

  run('gh', [
    'release', 'download', tag, '--repo', REPO,
    '--pattern', installer, '--pattern', 'latest.json',
    '--dir', workDir, '--clobber',
  ]);
  const installerPath = path.join(workDir, installer);
  const manifestPath = path.join(workDir, 'latest.json');
  for (const p of [installerPath, manifestPath]) {
    if (!fs.existsSync(p)) throw new Error(`${path.basename(p)} is not attached to ${tag}`);
  }

  const bytes = fs.readFileSync(installerPath);
  const certSize = authenticodeSignatureSize(bytes);
  if (certSize === 0) {
    throw new Error(
      `${installer} on ${tag} carries no Authenticode signature. ` +
      'That is the unsigned CI build — upload the code-signed installer first, then run this again.'
    );
  }
  console.log(`✓ ${installer}: ${bytes.length} bytes, Authenticode certificate table present (${certSize} bytes)`);

  // Reads TAURI_SIGNING_PRIVATE_KEY(+_PASSWORD) from the environment; writes <file>.sig
  run('npx', ['@tauri-apps/cli', 'signer', 'sign', installerPath]);
  const sigPath = `${installerPath}.sig`;
  const signature = fs.readFileSync(sigPath, 'utf8').trim();
  validateSignature(signature, WINDOWS_TARGET, path.basename(sigPath));

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.version !== version) {
    throw new Error(`latest.json on ${tag} is for version ${manifest.version}, expected ${version}`);
  }
  const next = withPlatform(manifest, WINDOWS_TARGET, { signature, url: assetUrl(tag, installer) });
  fs.writeFileSync(manifestPath, JSON.stringify(next, null, 2));
  console.log(`✓ latest.json platforms: ${Object.keys(next.platforms).join(', ')}`);

  if (dryRun) {
    console.log(`dry run — nothing uploaded; files are in ${workDir}`);
    return;
  }
  run('gh', ['release', 'upload', tag, '--repo', REPO, manifestPath, sigPath, '--clobber']);
  console.log(`✓ uploaded latest.json and ${path.basename(sigPath)} to ${tag}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error(`sign-windows-updater: ${err.message}`);
    process.exit(1);
  });
}
