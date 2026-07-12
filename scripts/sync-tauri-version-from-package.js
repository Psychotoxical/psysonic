#!/usr/bin/env node
/**
 * Align src-tauri/Cargo.toml, src-tauri/tauri.conf.json, and workspace entries in
 * src-tauri/Cargo.lock with package.json "version".
 * Used after npm version in promote workflows so bundle names match release semver.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const version = require(path.join(root, 'package.json')).version;
if (!version || typeof version !== 'string') {
  console.error('package.json version missing');
  process.exit(1);
}

const cargoPath = path.join(root, 'src-tauri', 'Cargo.toml');
let cargo = fs.readFileSync(cargoPath, 'utf8');
if (!/^version = "[^"]*"$/m.test(cargo)) {
  console.error('Cargo.toml: expected a package-level line: version = "..."');
  process.exit(1);
}
cargo = cargo.replace(/^version = "[^"]*"$/m, `version = "${version}"`);
fs.writeFileSync(cargoPath, cargo);
console.log(`Cargo.toml -> ${version}`);

const confPath = path.join(root, 'src-tauri', 'tauri.conf.json');
const conf = JSON.parse(fs.readFileSync(confPath, 'utf8'));
conf.version = version;
fs.writeFileSync(confPath, JSON.stringify(conf, null, 2) + '\n');
console.log(`tauri.conf.json -> ${version}`);

/** @param {string} lockText */
function syncCargoLockWorkspaceVersions(lockText, targetVersion) {
  return lockText.replace(
    /^(name = "psysonic[^"]*"\nversion = ")[^"]+"/gm,
    `$1${targetVersion}"`,
  );
}

const lockPath = path.join(root, 'src-tauri', 'Cargo.lock');
let lock = fs.readFileSync(lockPath, 'utf8');
const updatedLock = syncCargoLockWorkspaceVersions(lock, version);
if (updatedLock !== lock) {
  fs.writeFileSync(lockPath, updatedLock);
  console.log(`Cargo.lock workspace crates -> ${version}`);
} else {
  console.log(`Cargo.lock workspace crates already at ${version}`);
}

require('child_process').execSync('node scripts/sync-wix-bundle-version.mjs', {
  cwd: root,
  stdio: 'inherit',
});
