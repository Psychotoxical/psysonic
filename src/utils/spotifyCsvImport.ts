import Papa from 'papaparse';

export interface SpotifyCsvTrack {
  trackName: string;
  artistName: string;
  artistNames: string[];  // Array of all artists for better matching
  albumName: string;
  isrc?: string;
  score?: number;           // Match score when track not found
  thresholdNeeded?: number; // Threshold required to pass
}

// Header mapping to canonical fields (supports English and Spanish)
const HEADER_MAPPINGS: Record<string, string> = {
  // Track name
  'track name': 'trackName',
  'track name(s)': 'trackName',
  'track': 'trackName',
  'name': 'trackName',
  'nombre de la cancion': 'trackName',
  'nombre de cancion': 'trackName',
  'nombre de la canci\u00f3n': 'trackName',
  'nombre cancion': 'trackName',
  't\u00edtulo': 'trackName',
  'titulo': 'trackName',
  // Artist name
  'artist name': 'artistName',
  'artist name(s)': 'artistName',
  'artists name': 'artistName',
  'artists name(s)': 'artistName',
  'artist': 'artistName',
  'artists': 'artistName',
  'nombre del artista': 'artistName',
  'nombres del artista': 'artistName',
  'nombre artista': 'artistName',
  'artista': 'artistName',
  // Album name
  'album name': 'albumName',
  'album name(s)': 'albumName',
  'album': 'albumName',
  'nombre del album': 'albumName',
  'nombre del \u00e1lbum': 'albumName',
  'nombre album': 'albumName',
  // ISRC
  'isrc': 'isrc',
  'isrc code': 'isrc',
  'codigo isrc': 'isrc',
  'c\u00f3digo isrc': 'isrc',
};

function normalizeHeader(header: string): string {
  return header
    .toLowerCase()
    .replace(/\(s\)/g, '')
    .replace(/[()]/g, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function findColumnField(header: string): string | undefined {
  const normalized = normalizeHeader(header);
  return HEADER_MAPPINGS[normalized];
}

function parseArtists(artistField: string): string[] {
  // Spotify uses commas in extended format, semicolons in simple format
  const separator = artistField.includes(';') ? ';' : ',';
  return artistField
    .split(separator)
    .map(a => a.trim())
    .filter(a => a.length > 0);
}

function extractFeaturedArtists(title: string): string[] {
  const patterns = [
    /\(feat\.?\s+([^)]+)\)/i,
    /\(ft\.?\s+([^)]+)\)/i,
    /\(featuring\s+([^)]+)\)/i,
    /\(with\s+([^)]+)\)/i,
  ];
  for (const regex of patterns) {
    const match = title.match(regex);
    if (match) {
      return match[1].split(/,|\sand\s|\s&\s/).map(s => s.trim()).filter(Boolean);
    }
  }
  return [];
}

export function parseSpotifyCsv(csvContent: string): SpotifyCsvTrack[] {
  // Strip BOM and parse with Papa Parse
  const cleanContent = csvContent.replace(/^\uFEFF/, '');

  const parseResult = Papa.parse(cleanContent, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header: string) => {
      const field = findColumnField(header);
      return field || header;
    },
  });

  if (parseResult.errors.length > 0) {
    console.warn('CSV parse warnings:', parseResult.errors);
  }

  const data = parseResult.data as Record<string, string>[];

  // Verify required columns
  if (!data.length || !data[0].trackName || !data[0].artistName) {
    console.error('CSV columns not found. Available headers:', Object.keys(data[0] || {}));
    return [];
  }

  console.log('CSV parsed with Papa Parse:', {
    rows: data.length,
    sample: data[0],
  });

  const tracks: SpotifyCsvTrack[] = [];
  for (const row of data) {
    const trackName = row.trackName?.trim();
    const artistField = row.artistName?.trim() || '';

    if (!trackName || !artistField) continue;

    // Parse multiple artists from field + extract collaborators from title
    const artistNames = parseArtists(artistField);
    const featuredArtists = extractFeaturedArtists(trackName);
    const allArtists = [...new Set([...artistNames, ...featuredArtists])];
    const primaryArtist = allArtists[0] || '';

    tracks.push({
      trackName,
      artistName: primaryArtist,
      artistNames: allArtists,
      albumName: row.albumName?.trim() || '',
      isrc: row.isrc?.trim() || undefined,
    });
  }

  return tracks;
}
