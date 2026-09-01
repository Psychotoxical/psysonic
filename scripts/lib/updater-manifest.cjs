'use strict';
// Shared pieces of the Tauri updater manifest (latest.json).
//
// Used by scripts/generate-update-manifest.js (release workflow, macOS entries)
// and scripts/sign-windows-updater.mjs (manual workflow, Windows entry). CommonJS
// so the CI script can keep its plain `require` while the newer script imports it.

const REPO = 'Psysonic/psysonic';

function releaseTag(version) {
  return `app-v${version}`;
}

function assetUrl(tag, filename) {
  return `https://github.com/${REPO}/releases/download/${tag}/${filename}`;
}

// A real minisign .sig file is multi-line and ~200+ chars.
// A public key (single line, ~56 chars) must never appear here. minisign
// public keys start with the algorithm bytes "Ed"; base64 turns that into
// "RW" plus a third character (Q/R/S/T) that depends on the key id.
function validateSignature(sig, platform, sigFile) {
  if (/^RW[QRST][A-Za-z0-9+/]{10,}={0,2}$/.test(sig)) {
    throw new Error(
      `${platform}: .sig file "${sigFile}" contains a PUBLIC KEY instead of a signature.\n` +
      `  Got: ${sig}\n` +
      `  TAURI_SIGNING_PRIVATE_KEY must be the private key, not the public one.`
    );
  }
  if (sig.length < 80) {
    throw new Error(
      `${platform}: .sig file "${sigFile}" looks too short (${sig.length} chars) to be a valid signature.`
    );
  }
}

// Copy of `manifest` with `platforms[key]` set to the given entry. Other
// platforms and the top-level fields are left as they are.
function withPlatform(manifest, key, { signature, url }) {
  return {
    ...manifest,
    platforms: {
      ...(manifest.platforms ?? {}),
      [key]: { signature, url },
    },
  };
}

module.exports = { REPO, releaseTag, assetUrl, validateSignature, withPlatform };
