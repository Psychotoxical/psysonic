import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  toWixBundleVersion,
  wixVersionOverrideForPackageVersion,
} from './wix-bundle-version.mjs';

describe('toWixBundleVersion', () => {
  it('maps -dev to numeric pre-release 65535', () => {
    assert.equal(toWixBundleVersion('1.50.0-dev'), '1.50.0-65535');
  });

  it('maps -rc.N to numeric pre-release N', () => {
    assert.equal(toWixBundleVersion('1.50.0-rc.3'), '1.50.0-3');
  });

  it('passes through stable versions', () => {
    assert.equal(toWixBundleVersion('1.50.0'), '1.50.0');
  });

  it('passes through numeric pre-release', () => {
    assert.equal(toWixBundleVersion('1.50.0-42'), '1.50.0-42');
  });

  it('passes through numeric build metadata', () => {
    assert.equal(toWixBundleVersion('1.50.0+99'), '1.50.0+99');
  });
});

describe('wixVersionOverrideForPackageVersion', () => {
  it('returns override for dev channel', () => {
    assert.equal(wixVersionOverrideForPackageVersion('1.50.0-dev'), '1.50.0-65535');
  });

  it('returns null for stable', () => {
    assert.equal(wixVersionOverrideForPackageVersion('1.50.0'), null);
  });
});
