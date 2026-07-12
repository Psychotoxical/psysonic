import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  toWixBundleVersion,
  wixVersionOverrideForPackageVersion,
} from './wix-bundle-version.mjs';

describe('wixVersionOverrideForPackageVersion', () => {
  it('maps -dev to major.minor.patch.65535', () => {
    assert.equal(wixVersionOverrideForPackageVersion('1.50.0-dev'), '1.50.0.65535');
  });

  it('maps -rc.N to major.minor.patch.N', () => {
    assert.equal(wixVersionOverrideForPackageVersion('1.50.0-rc.3'), '1.50.0.3');
  });

  it('returns null for stable', () => {
    assert.equal(wixVersionOverrideForPackageVersion('1.50.0'), null);
  });

  it('returns null for numeric pre-release (Tauri converts app version)', () => {
    assert.equal(wixVersionOverrideForPackageVersion('1.50.0-42'), null);
  });
});

describe('toWixBundleVersion', () => {
  it('returns WiX dot format for dev channel', () => {
    assert.equal(toWixBundleVersion('1.50.0-dev'), '1.50.0.65535');
  });

  it('returns base triplet for stable', () => {
    assert.equal(toWixBundleVersion('1.50.0'), '1.50.0');
  });
});
