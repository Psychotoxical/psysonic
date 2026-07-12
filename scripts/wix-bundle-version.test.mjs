import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  WIX_BUILD,
  wixMappedBuildNumber,
  wixVersionOverrideForPackageVersion,
} from './wix-bundle-version.mjs';

describe('wixVersionOverrideForPackageVersion', () => {
  it('maps -dev to lowest build band', () => {
    assert.equal(wixVersionOverrideForPackageVersion('1.50.0-dev'), '1.50.0.1');
  });

  it('maps -rc.N to RC base + N', () => {
    assert.equal(wixVersionOverrideForPackageVersion('1.50.0-rc.3'), '1.50.0.10003');
  });

  it('maps stable to highest build band', () => {
    assert.equal(wixVersionOverrideForPackageVersion('1.50.0'), '1.50.0.65534');
  });

  it('maps numeric pre-release to RC band', () => {
    assert.equal(wixVersionOverrideForPackageVersion('1.50.0-42'), '1.50.0.10042');
  });
});

describe('monotonic promotion builds within X.Y.Z', () => {
  it('dev < rc.1 < rc.2 < stable', () => {
    const chain = ['1.50.0-dev', '1.50.0-rc.1', '1.50.0-rc.2', '1.50.0'];
    let prev = -1;
    for (const v of chain) {
      const build = wixMappedBuildNumber(v);
      assert.ok(build > prev, `${v} build ${build} must exceed ${prev}`);
      prev = build;
    }
    assert.equal(prev, WIX_BUILD.STABLE);
  });
});
