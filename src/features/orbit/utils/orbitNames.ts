/**
 * Orbit — random session-name suggester.
 *
 * Combinatorial generator over three patterns:
 *   1. `${adj} ${noun}`        (e.g. "Velvet Orbit")
 *   2. `${phrase} ${noun}`     (e.g. "Late Night Rooftop")
 *   3. `${noun} ${suffix}`     (e.g. "Rooftop Sessions")
 *
 * Pools are hand-curated so that random combinations almost always still
 * read as a coherent, music-themed session name. Total addressable name
 * space is in the tens of thousands — you'd have to reshuffle very hard
 * to see the same one twice.
 */

const ADJECTIVES: readonly string[] = [
  'Velvet', 'Neon', 'Midnight', 'Golden', 'Static', 'Cosmic',
  'Late', 'Lost', 'Deep', 'Slow', 'Quiet', 'Electric',
  'Analog', 'Distant', 'Hidden', 'Frozen', 'Warm', 'Wild',
  'Silver', 'Amber', 'Crystal', 'Endless', 'Hazy', 'Drifting',
  'Restless', 'Secret', 'Weightless', 'Echoing', 'Low', 'Bright',
  'Soft', 'Dusty', 'Foggy', 'Smoky', 'Twilight', 'Dawning',
  'Infinite', 'Eternal', 'Vintage', 'Smooth', 'Silent', 'Faint',
  'Bold', 'Sharp', 'Tender', 'Savage', 'Gentle', 'Reckless',
  'Chill', 'Steaming', 'Burning', 'Icy', 'Muted', 'Vivid',
  'Prismatic', 'Shadowy', 'Liminal', 'Spectral', 'Faded', 'Sleepy',
  'Wandering', 'Roaming', 'Dreaming', 'Floating', 'Buzzing', 'Rolling',
  'Hushed', 'Broken', 'Wired', 'Outer', 'Moonlit', 'Sunlit',
  'Firelit', 'Candlelit', 'Quiet', 'Howling', 'Whispered', 'Shimmering',
  'Dusky', 'Drowsy', 'Plush', 'Opalescent', 'Silken',
];

const NOUNS: readonly string[] = [
  // places
  'Rooftop', 'Kitchen', 'Basement', 'Garage', 'Lounge', 'Diner',
  'Cinema', 'Harbor', 'Highway', 'Hotel', 'Parlor', 'Attic',
  'Balcony', 'Terrace', 'Patio', 'Studio', 'Warehouse', 'Pier',
  'Terminal', 'Platform', 'Corner', 'Boulevard', 'Tower', 'Lighthouse',
  'Chapel', 'Bunker', 'Courtyard', 'Observatory', 'Arcade', 'Alleyway',
  // media / musical
  'Tape', 'Radio', 'Session', 'Rotation', 'Mixtape', 'Transmission',
  'Frequency', 'Broadcast', 'Channel', 'Cassette', 'Reel', 'Loop',
  'Vinyl', 'Sleeve', 'Waveform', 'Echo', 'Reverb', 'Bassline',
  'Bridge', 'Interlude', 'Mix', 'Playlist', 'Chord', 'Groove',
  'Encore', 'Setlist', 'Tracklist', 'Dub', 'Bootleg',
  // celestial / orbit-y
  'Orbit', 'Galaxy', 'Nebula', 'Comet', 'Horizon', 'Signal',
  'Drift', 'Satellite', 'Atmosphere', 'Starfield', 'Eclipse', 'Nova',
  'Moon', 'Void', 'Prism', 'Meteor', 'Solstice', 'Equinox',
  'Zenith', 'Apogee', 'Pulsar', 'Quasar', 'Aurora', 'Supernova',
];

const PHRASES: readonly string[] = [
  'Late Night', 'Deep Space', 'Low-Fi', 'Low-Key', 'Slow Burn',
  'Afterhour', 'Golden Hour', 'Blue Hour', 'Off-Grid', 'Outer Space',
  'Northern Light', 'Velvet Night', 'Neon Drive', 'Midnight Drive',
  'Quiet Storm', 'Slow Motion', 'Electric Dream', 'Analog Dream',
  'Hidden Track', 'Side-B', 'Dark-Side', 'Back-Room', 'Morning-After',
  'Last-Call', 'First-Light', 'Long-Play', 'Cold-Start', 'Warm-Up',
  'Sunset', 'Afterparty',
];

const SUFFIXES: readonly string[] = [
  'Sessions', 'Radio', 'Tapes', 'Transmissions', 'Rotations',
  'Mixes', 'Broadcasts', 'Frequencies', 'Interludes', 'Playback',
  'Nights', 'Hours', 'Signals', 'Takes', 'Bootlegs',
];

function pickRandom<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

/** Returns a fresh combinatorial suggestion. */
export function randomOrbitSessionName(): string {
  const r = Math.random();
  if (r < 0.20) {
    // "Rooftop Sessions"
    return `${pickRandom(NOUNS)} ${pickRandom(SUFFIXES)}`;
  }
  if (r < 0.40) {
    // "Late Night Rooftop"
    return `${pickRandom(PHRASES)} ${pickRandom(NOUNS)}`;
  }
  // Default: "Velvet Orbit"
  return `${pickRandom(ADJECTIVES)} ${pickRandom(NOUNS)}`;
}
