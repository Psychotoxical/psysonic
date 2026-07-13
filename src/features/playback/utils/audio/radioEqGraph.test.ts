import { afterEach, describe, expect, it } from 'vitest';
import {
  _resetRadioEqGraphForTest,
  applyRadioEqSettings,
  clampBandGain,
  clampPreGainDb,
  dbToLinear,
  setRadioEqMasterVolume,
  tryAttachRadioEqGraph,
  _radioEqGraphForTest,
} from '@/features/playback/utils/audio/radioEqGraph';

describe('radioEqGraph helpers', () => {
  it('dbToLinear converts 0 dB to unity', () => {
    expect(dbToLinear(0)).toBeCloseTo(1);
    expect(dbToLinear(6)).toBeCloseTo(1.995, 2);
    expect(dbToLinear(-6)).toBeCloseTo(0.501, 2);
  });

  it('clampBandGain matches Rust EQ limits', () => {
    expect(clampBandGain(-20)).toBe(-12);
    expect(clampBandGain(20)).toBe(12);
    expect(clampBandGain(3)).toBe(3);
  });

  it('clampPreGainDb matches eqStore limits', () => {
    expect(clampPreGainDb(-40)).toBe(-30);
    expect(clampPreGainDb(10)).toBe(6);
  });
});

describe('radioEqGraph with mocked Web Audio', () => {
  class MockGain {
    gain = { value: 1 };
    connect() { return this; }
  }

  class MockBiquad {
    type = 'peaking';
    frequency = { value: 1000 };
    Q = { value: 1 };
    gain = { value: 0 };
    connect() { return this; }
  }

  class MockContext {
    state: AudioContextState = 'running';
    sampleRate = 48_000;
    destination = {};
    createGain() { return new MockGain(); }
    createBiquadFilter() { return new MockBiquad(); }
    createMediaElementSource() {
      return { connect() { return undefined; } };
    }
    resume = async () => { this.state = 'running'; };
    close = async () => {};
  }

  afterEach(() => {
    _resetRadioEqGraphForTest();
    delete (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext;
  });

  it('builds graph and routes master volume through headroom gain', async () => {
    (window as unknown as { AudioContext: typeof AudioContext }).AudioContext =
      MockContext as unknown as typeof AudioContext;

    const audio = document.createElement('audio');
    expect(await tryAttachRadioEqGraph(audio)).toBe(true);

    setRadioEqMasterVolume(0.5);
    const g = _radioEqGraphForTest();
    expect(g?.masterGain.gain.value).toBeCloseTo(0.5 * 0.891_254, 5);
  });

  it('applies bypass when EQ disabled', async () => {
    (window as unknown as { AudioContext: typeof AudioContext }).AudioContext =
      MockContext as unknown as typeof AudioContext;

    const audio = document.createElement('audio');
    await tryAttachRadioEqGraph(audio);
    applyRadioEqSettings([6, 6, 6, 0, 0, 0, 0, 0, 0, 0], false, 3);

    const g = _radioEqGraphForTest();
    expect(g?.preGainNode.gain.value).toBe(1);
    for (const band of g?.bands ?? []) {
      expect(band.gain.value).toBe(0);
    }
  });

  it('applies band + pre-gain when enabled', async () => {
    (window as unknown as { AudioContext: typeof AudioContext }).AudioContext =
      MockContext as unknown as typeof AudioContext;

    const audio = document.createElement('audio');
    await tryAttachRadioEqGraph(audio);
    applyRadioEqSettings([4, 0, 0, 0, 0, 0, 0, 0, 0, 0], true, -3);

    const g = _radioEqGraphForTest();
    expect(g?.preGainNode.gain.value).toBeCloseTo(dbToLinear(-3), 5);
    expect(g?.bands[0]?.gain.value).toBe(4);
  });
});
