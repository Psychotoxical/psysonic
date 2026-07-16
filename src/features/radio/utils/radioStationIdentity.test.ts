import { describe, expect, it } from 'vitest';
import { qualifyStoredRadioIds } from './radioStationIdentity';

const stations = [
  { id: 'shared', serverId: 'home', name: 'Home FM', streamUrl: 'https://home.test' },
  { id: 'shared', serverId: 'office', name: 'Office FM', streamUrl: 'https://office.test' },
  { id: 'unique', serverId: 'office', name: 'Unique FM', streamUrl: 'https://unique.test' },
];

describe('qualifyStoredRadioIds', () => {
  it('preserves already-qualified favorites and order entries', () => {
    expect(qualifyStoredRadioIds(['office:shared'], stations, 'home')).toEqual(['office:shared']);
  });

  it('upgrades a legacy id to the active server when ids collide', () => {
    expect(qualifyStoredRadioIds(['shared'], stations, 'home')).toEqual(['home:shared']);
  });

  it('upgrades an unambiguous legacy id without an active-server match', () => {
    expect(qualifyStoredRadioIds(['unique'], stations, 'home')).toEqual(['office:unique']);
  });

  it('keeps identities for temporarily unreachable sources', () => {
    expect(qualifyStoredRadioIds(['offline:r1'], stations, 'home')).toEqual(['offline:r1']);
  });
});
