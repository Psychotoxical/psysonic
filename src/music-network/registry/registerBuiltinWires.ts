// One-time side-effect registration of every built-in wire. Call once at app
// init (and from test setup) before the runtime resolves any account.

import { registerWire } from './wireRegistry';
import { audioscrobblerWire } from '../wires/audioscrobbler/AudioscrobblerWire';
import { listenBrainzWire } from '../wires/listenbrainz/ListenBrainzWire';
import { malojaNativeWire } from '../wires/maloja/MalojaNativeWire';

let registered = false;

export function registerBuiltinWires(): void {
  if (registered) return;
  registered = true;
  registerWire(audioscrobblerWire);
  registerWire(listenBrainzWire);
  registerWire(malojaNativeWire);
}
