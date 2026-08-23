import {
  isNavidromeServer,
  parseLeadingSemver,
  type SubsonicServerIdentity,
} from '@/lib/server/subsonicServerIdentity';

export type SmartPlaylistSemver = readonly [number, number, number];
export type SmartRuleFieldType = 'string' | 'number' | 'boolean' | 'date' | 'playlist';
export type SmartRuleFieldSource = 'released' | 'tag' | 'role' | 'custom-tag' | 'custom-role';
export type SmartRuleOperator =
  | 'is'
  | 'isNot'
  | 'gt'
  | 'lt'
  | 'before'
  | 'after'
  | 'contains'
  | 'notContains'
  | 'startsWith'
  | 'endsWith'
  | 'inTheRange'
  | 'inTheLast'
  | 'notInTheLast'
  | 'inPlaylist'
  | 'notInPlaylist'
  | 'isMissing'
  | 'isPresent';

export type SmartPlaylistCapability =
  | 'base'
  | 'playlistReferences'
  | 'dynamicFields'
  | 'multiSort'
  | 'percentageLimit'
  | 'annotationFields'
  | 'presenceOperators'
  | 'expandedFields';

export interface SmartPlaylistCapabilityMatrixEntry {
  capability: SmartPlaylistCapability;
  minimumVersion: SmartPlaylistSemver;
}

export const SMART_PLAYLIST_CAPABILITY_MATRIX: readonly SmartPlaylistCapabilityMatrixEntry[] = [
  { capability: 'base', minimumVersion: [0, 48, 0] },
  { capability: 'playlistReferences', minimumVersion: [0, 52, 0] },
  { capability: 'dynamicFields', minimumVersion: [0, 55, 0] },
  { capability: 'multiSort', minimumVersion: [0, 57, 0] },
  { capability: 'percentageLimit', minimumVersion: [0, 61, 0] },
  { capability: 'annotationFields', minimumVersion: [0, 61, 0] },
  { capability: 'presenceOperators', minimumVersion: [0, 62, 0] },
  { capability: 'expandedFields', minimumVersion: [0, 63, 0] },
] as const;

export interface SmartPlaylistCapabilities {
  isNavidrome: boolean;
  version: readonly [number, number, number] | null;
  versionKnown: boolean;
  base: boolean;
  playlistReferences: boolean;
  dynamicFields: boolean;
  multiSort: boolean;
  percentageLimit: boolean;
  annotationFields: boolean;
  presenceOperators: boolean;
  expandedFields: boolean;
}

function semverGte(
  version: readonly [number, number, number],
  minimum: SmartPlaylistSemver,
): boolean {
  for (let i = 0; i < 3; i++) {
    if (version[i] !== minimum[i]) return version[i] > minimum[i];
  }
  return true;
}

/**
 * Resolves only released Navidrome capabilities. Unknown versions stay
 * conservative for structured editing; their raw JSON remains editable.
 */
export function resolveSmartPlaylistCapabilities(
  identityOrVersion: SubsonicServerIdentity | string | undefined,
): SmartPlaylistCapabilities {
  const identity = typeof identityOrVersion === 'string'
    ? { type: 'navidrome', serverVersion: identityOrVersion }
    : identityOrVersion;
  const isNavidrome = isNavidromeServer(identity);
  const version = parseLeadingSemver(identity?.serverVersion);
  const has = (capability: SmartPlaylistCapability): boolean => {
    if (!isNavidrome || !version) return false;
    const entry = SMART_PLAYLIST_CAPABILITY_MATRIX.find(item => item.capability === capability);
    return !!entry && semverGte(version, entry.minimumVersion);
  };

  return {
    isNavidrome,
    version,
    versionKnown: version !== null,
    base: has('base'),
    playlistReferences: has('playlistReferences'),
    dynamicFields: has('dynamicFields'),
    multiSort: has('multiSort'),
    percentageLimit: has('percentageLimit'),
    annotationFields: has('annotationFields'),
    presenceOperators: has('presenceOperators'),
    expandedFields: has('expandedFields'),
  };
}

export interface SmartRuleFieldDefinition {
  name: string;
  label: string;
  type: SmartRuleFieldType;
  source: SmartRuleFieldSource;
  minimumVersion: SmartPlaylistSemver;
  nullable?: boolean;
  filterable?: boolean;
  sortable?: boolean;
  aliasFor?: string;
  min?: number;
  max?: number;
}

type FieldSeed = Omit<SmartRuleFieldDefinition, 'label' | 'source' | 'minimumVersion'> & {
  label?: string;
  source?: SmartRuleFieldSource;
  minimumVersion?: SmartPlaylistSemver;
};

const V048 = [0, 48, 0] as const;
const V052 = [0, 52, 0] as const;
const V055 = [0, 55, 0] as const;
const V061 = [0, 61, 0] as const;
const V063 = [0, 63, 0] as const;

const FIELD_NAME_WORDS = [
  'musicbrainz', 'compilation', 'subtitle', 'comment',
  'catalog', 'settings', 'movement', 'explicit', 'original', 'release',
  'average', 'country', 'status', 'version', 'encoder', 'encoded',
  'bitrate', 'channels', 'duration', 'library', 'number', 'rating',
  'played', 'loved', 'rated', 'added', 'modified', 'artist', 'album',
  'track', 'disc', 'date', 'last', 'year', 'title', 'sort', 'cover',
  'work', 'name', 'total', 'label', 'record', 'depth', 'gain', 'peak',
  'rate', 'size', 'file', 'path', 'type', 'has', 'art', 'bit', 'play',
  'count', 'by', 'id', 'rg', 'dj', 'bpm', 'isrc', 'r128', 'codec',
  'lyrics', 'genre', 'playlist', 'random', 'website', 'copyright',
  'language', 'license', 'media', 'grouping', 'mood', 'key', 'asin',
  'barcode', 'script', 'performer', 'composer', 'lyricist', 'conductor',
  'director', 'arranger', 'producer', 'engineer', 'mixer', 'remixer',
  'group', 'recording', 'sample', 'replaygain', 'mbz',
].sort((left, right) => right.length - left.length);

const FIELD_WORD_LABELS: Record<string, string> = {
  mbz: 'MusicBrainz',
  musicbrainz: 'MusicBrainz',
  id: 'ID',
  bpm: 'BPM',
  isrc: 'ISRC',
  rg: 'ReplayGain',
  replaygain: 'ReplayGain',
  r128: 'R128',
  dj: 'DJ',
};

function titleCaseWord(word: string): string {
  return FIELD_WORD_LABELS[word] ?? `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
}

function segmentFieldName(chunk: string): string[] {
  const words: string[] = [];
  let rest = chunk.toLowerCase();
  while (rest) {
    const match = FIELD_NAME_WORDS.find(word => rest.startsWith(word));
    if (match) {
      words.push(match);
      rest = rest.slice(match.length);
      continue;
    }
    words.push(rest);
    break;
  }
  return words;
}

/** Turns Navidrome field keys into Title Case labels: albumplaycount → Album Play Count. */
export function titleCaseSmartFieldName(name: string): string {
  return name
    .split(/[_.-]+/)
    .filter(Boolean)
    .flatMap(segmentFieldName)
    .map(titleCaseWord)
    .join(' ');
}

function fields(
  names: readonly string[],
  type: SmartRuleFieldType,
  overrides: Omit<FieldSeed, 'name' | 'type'> = {},
): FieldSeed[] {
  return names.map(name => ({ name, type, ...overrides }));
}

const RELEASED_FIELD_SEEDS: FieldSeed[] = [
  ...fields([
    'title', 'album', 'discsubtitle', 'comment', 'lyrics', 'sorttitle', 'sortalbum',
    'sortartist', 'sortalbumartist', 'albumcomment', 'catalognumber', 'filepath',
    'filetype', 'albumtype',
  ], 'string'),
  ...fields(['genre'], 'string', { source: 'tag' }),
  // Default mappings.yaml tags/roles (Navidrome 0.55+). Not columns in
  // fields.go — AddTagNames / AddRoles register them at startup.
  ...fields([
    'mood', 'grouping', 'key', 'isrc', 'language', 'license', 'media',
    'movementname', 'movement', 'recordlabel', 'copyright', 'encodedby',
    'encodersettings', 'asin', 'barcode', 'subtitle', 'website', 'work',
    'releasecountry', 'releasestatus', 'script', 'albumversion', 'releasetype',
    'musicbrainz_discid', 'musicbrainz_workid',
  ], 'string', { source: 'tag', minimumVersion: V055 }),
  ...fields(['movementtotal'], 'number', { source: 'tag', minimumVersion: V055, min: 0 }),
  ...fields(
    ['r128_album_gain', 'r128_track_gain'],
    'number',
    { source: 'tag', minimumVersion: V055 },
  ),
  ...fields(['artist', 'albumartist'], 'string', { source: 'role' }),
  ...fields([
    'composer', 'lyricist', 'conductor', 'director', 'arranger', 'producer',
    'engineer', 'mixer', 'djmixer', 'remixer', 'performer',
  ], 'string', { source: 'role', minimumVersion: V055 }),
  ...fields([
    'year',
  ], 'number'),
  ...fields([
    'tracknumber', 'discnumber', 'size', 'duration', 'bitrate', 'bpm',
    'channels', 'playcount',
  ], 'number', { min: 0 }),
  ...fields(['rating'], 'number', { min: 0, max: 5 }),
  ...fields(['hascoverart', 'compilation', 'loved'], 'boolean'),
  ...fields(['dateadded', 'datemodified', 'dateloved', 'lastplayed'], 'date'),

  ...fields([
    'date', 'originaldate', 'releasedate',
  ], 'date', { minimumVersion: V055 }),
  ...fields([
    'originalyear', 'releaseyear',
  ], 'number', { minimumVersion: V055 }),

  ...fields(['albumplaycount', 'artistplaycount'], 'number', { minimumVersion: V061, min: 0 }),
  ...fields(
    ['albumrating', 'artistrating', 'averagerating'],
    'number',
    { minimumVersion: V061, min: 0, max: 5 },
  ),
  ...fields(['albumloved', 'artistloved'], 'boolean', { minimumVersion: V061 }),
  ...fields([
    'albumlastplayed', 'albumdateloved', 'albumdaterated', 'artistlastplayed',
    'artistdateloved', 'artistdaterated', 'daterated',
  ], 'date', { minimumVersion: V061 }),

  ...fields([
    'explicitstatus', 'codec', 'mbz_album_id', 'mbz_album_artist_id', 'mbz_artist_id',
    'mbz_recording_id', 'mbz_release_track_id', 'mbz_release_group_id',
  ], 'string', { minimumVersion: V063 }),
  ...fields(['library_id'], 'number', { minimumVersion: V063, min: 0 }),
  ...fields(['bitdepth', 'samplerate'], 'number', { minimumVersion: V063, min: 0 }),
  ...fields(
    ['rgalbumgain', 'rgalbumpeak', 'rgtrackgain', 'rgtrackpeak'],
    'number',
    { minimumVersion: V063 },
  ),
  ...fields(['missing'], 'boolean', { minimumVersion: V063 }),

  {
    name: 'replaygain_album_gain',
    type: 'number',
    minimumVersion: V063,
    aliasFor: 'rgalbumgain',
  },
  {
    name: 'replaygain_album_peak',
    type: 'number',
    minimumVersion: V063,
    aliasFor: 'rgalbumpeak',
  },
  {
    name: 'replaygain_track_gain',
    type: 'number',
    minimumVersion: V063,
    aliasFor: 'rgtrackgain',
  },
  {
    name: 'replaygain_track_peak',
    type: 'number',
    minimumVersion: V063,
    aliasFor: 'rgtrackpeak',
  },
  {
    name: 'random',
    label: 'Random',
    type: 'string',
    filterable: false,
    sortable: true,
  },
  {
    name: 'playlist',
    label: 'Playlist',
    type: 'playlist',
    filterable: true,
    sortable: false,
    minimumVersion: V052,
  },
];

const NULLABLE_RELEASED_FIELDS = new Set([
  'album', 'discsubtitle', 'comment', 'lyrics', 'sorttitle', 'sortalbum',
  'sortartist', 'sortalbumartist', 'albumcomment', 'catalognumber', 'explicitstatus',
  'bitdepth', 'bpm', 'mbz_album_id', 'mbz_album_artist_id', 'mbz_artist_id',
  'mbz_recording_id', 'mbz_release_track_id', 'mbz_release_group_id',
  'rgalbumgain', 'rgalbumpeak', 'rgtrackgain', 'rgtrackpeak',
  'replaygain_album_gain', 'replaygain_album_peak', 'replaygain_track_gain',
  'replaygain_track_peak',
  'mood', 'grouping', 'key', 'isrc', 'language', 'license', 'media',
  'movementname', 'movement', 'movementtotal', 'recordlabel', 'copyright',
  'encodedby', 'encodersettings', 'asin', 'barcode', 'subtitle', 'website',
  'work', 'releasecountry', 'releasestatus', 'script', 'albumversion',
  'releasetype', 'musicbrainz_discid', 'musicbrainz_workid',
  'r128_album_gain', 'r128_track_gain',
  'composer', 'lyricist', 'conductor', 'director', 'arranger', 'producer',
  'engineer', 'mixer', 'djmixer', 'remixer', 'performer',
]);

/** Static fields present in the latest released Navidrome criteria registry (v0.63.x). */
export const RELEASED_SMART_RULE_FIELDS: readonly SmartRuleFieldDefinition[] =
  RELEASED_FIELD_SEEDS.map(seed => ({
    label: seed.label ?? titleCaseSmartFieldName(seed.name),
    source: seed.source ?? 'released',
    minimumVersion: seed.minimumVersion ?? V048,
    filterable: seed.filterable ?? true,
    sortable: seed.sortable ?? true,
    nullable: seed.nullable ?? NULLABLE_RELEASED_FIELDS.has(seed.name),
    ...seed,
  }));

const RELEASED_FIELD_MAP = new Map(
  RELEASED_SMART_RULE_FIELDS.map(field => [field.name.toLowerCase(), field]),
);

export interface CustomSmartRuleFieldInput {
  name: string;
  label?: string;
  type: Exclude<SmartRuleFieldType, 'playlist'>;
  kind: 'tag' | 'role';
  nullable?: boolean;
  sortable?: boolean;
}

const RESERVED_FIELD_NAMES = new Set(['all', 'any', 'limit', 'limitpercent', 'offset', 'order', 'sort']);
const CUSTOM_FIELD_NAME = /^[A-Za-z][A-Za-z0-9_.-]*$/;

/** Creates an explicitly typed server-configured tag/role for structured editing. */
export function createCustomSmartRuleField(
  input: CustomSmartRuleFieldInput,
): SmartRuleFieldDefinition {
  const name = input.name.trim();
  if (!CUSTOM_FIELD_NAME.test(name) || RESERVED_FIELD_NAMES.has(name.toLowerCase())) {
    throw new Error(`Invalid custom smart-playlist field name: ${input.name}`);
  }
  return {
    name,
    label: input.label?.trim() || titleCaseSmartFieldName(name),
    type: input.type,
    source: input.kind === 'tag' ? 'custom-tag' : 'custom-role',
    minimumVersion: V055,
    nullable: input.nullable ?? true,
    filterable: true,
    sortable: input.sortable ?? true,
  };
}

export function resolveCustomSmartRuleFields(
  settings: readonly CustomSmartRuleFieldInput[],
): SmartRuleFieldDefinition[] {
  const fields: SmartRuleFieldDefinition[] = [];
  const seen = new Set<string>();
  for (const setting of settings) {
    try {
      const field = createCustomSmartRuleField(setting);
      const key = field.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      fields.push(field);
    } catch {
      // Skip invalid persisted rows so Settings/editor stay usable.
    }
  }
  return fields;
}

export function findSmartRuleField(
  name: string,
  customFields: readonly SmartRuleFieldDefinition[] = [],
): SmartRuleFieldDefinition | undefined {
  const key = name.toLowerCase();
  return customFields.find(field => field.name.toLowerCase() === key) ?? RELEASED_FIELD_MAP.get(key);
}

export interface SmartRuleOperatorDefinition {
  name: SmartRuleOperator;
  minimumVersion: SmartPlaylistSemver;
  valueType: 'field' | 'number' | 'boolean' | 'playlist';
}

export const RELEASED_SMART_RULE_OPERATORS: readonly SmartRuleOperatorDefinition[] = [
  { name: 'is', minimumVersion: V048, valueType: 'field' },
  { name: 'isNot', minimumVersion: V048, valueType: 'field' },
  { name: 'gt', minimumVersion: V048, valueType: 'number' },
  { name: 'lt', minimumVersion: V048, valueType: 'number' },
  { name: 'before', minimumVersion: V048, valueType: 'field' },
  { name: 'after', minimumVersion: V048, valueType: 'field' },
  { name: 'contains', minimumVersion: V048, valueType: 'field' },
  { name: 'notContains', minimumVersion: V048, valueType: 'field' },
  { name: 'startsWith', minimumVersion: V048, valueType: 'field' },
  { name: 'endsWith', minimumVersion: V048, valueType: 'field' },
  { name: 'inTheRange', minimumVersion: V048, valueType: 'field' },
  { name: 'inTheLast', minimumVersion: V048, valueType: 'number' },
  { name: 'notInTheLast', minimumVersion: V048, valueType: 'number' },
  { name: 'inPlaylist', minimumVersion: [0, 52, 0], valueType: 'playlist' },
  { name: 'notInPlaylist', minimumVersion: [0, 52, 0], valueType: 'playlist' },
  { name: 'isMissing', minimumVersion: [0, 62, 0], valueType: 'boolean' },
  { name: 'isPresent', minimumVersion: [0, 62, 0], valueType: 'boolean' },
] as const;

const OPERATOR_MAP = new Map(
  RELEASED_SMART_RULE_OPERATORS.map(operator => [operator.name.toLowerCase(), operator]),
);

export function findSmartRuleOperator(name: string): SmartRuleOperatorDefinition | undefined {
  return OPERATOR_MAP.get(name.toLowerCase());
}

function fieldAvailable(
  field: SmartRuleFieldDefinition,
  capabilities: SmartPlaylistCapabilities,
): boolean {
  if (!capabilities.base || !capabilities.version) return false;
  if ((field.source === 'custom-tag' || field.source === 'custom-role') && !capabilities.dynamicFields) {
    return false;
  }
  return semverGte(capabilities.version, field.minimumVersion);
}

export function getAvailableSmartRuleFields(
  capabilities: SmartPlaylistCapabilities,
  customFields: readonly SmartRuleFieldDefinition[] = [],
): SmartRuleFieldDefinition[] {
  return [...RELEASED_SMART_RULE_FIELDS, ...customFields]
    .filter(field => fieldAvailable(field, capabilities));
}

export function searchSmartRuleFields(
  query: string,
  capabilities: SmartPlaylistCapabilities,
  customFields: readonly SmartRuleFieldDefinition[] = [],
): SmartRuleFieldDefinition[] {
  const needle = query.trim().toLocaleLowerCase();
  return getAvailableSmartRuleFields(capabilities, customFields)
    .filter(field => !needle
      || field.name.toLocaleLowerCase().includes(needle)
      || field.label.toLocaleLowerCase().includes(needle))
    .sort((left, right) => left.label.localeCompare(right.label));
}

function operatorsForType(field: SmartRuleFieldDefinition): SmartRuleOperator[] {
  switch (field.type) {
    case 'boolean':
      return ['is', 'isNot'];
    case 'number':
      return ['is', 'isNot', 'gt', 'lt', 'inTheRange'];
    case 'date':
      return ['is', 'isNot', 'before', 'after', 'inTheRange', 'inTheLast', 'notInTheLast'];
    case 'playlist':
      return ['inPlaylist', 'notInPlaylist'];
    case 'string':
      return ['is', 'isNot', 'contains', 'notContains', 'startsWith', 'endsWith'];
  }
}

/**
 * Returns field-specific operators. Presence is limited to dynamic fields and
 * released nullable fields; ranges are not offered for multi-valued tags/roles.
 */
export function getSmartRuleOperatorsForField(
  field: SmartRuleFieldDefinition,
  capabilities: SmartPlaylistCapabilities,
): SmartRuleOperatorDefinition[] {
  if (!fieldAvailable(field, capabilities)) return [];
  let names = operatorsForType(field);
  if ((field.source === 'tag' || field.source === 'role'
      || field.source === 'custom-tag' || field.source === 'custom-role')) {
    names = names.filter(name => name !== 'inTheRange');
  }
  if (capabilities.presenceOperators && (
    field.nullable
    || field.source === 'tag'
    || field.source === 'role'
    || field.source === 'custom-tag'
    || field.source === 'custom-role'
  )) {
    names = [...names, 'isMissing', 'isPresent'];
  }
  return names
    .map(name => findSmartRuleOperator(name))
    .filter((operator): operator is SmartRuleOperatorDefinition => !!operator);
}

export function isSmartRuleFieldAvailable(
  field: SmartRuleFieldDefinition,
  capabilities: SmartPlaylistCapabilities,
): boolean {
  return fieldAvailable(field, capabilities);
}

export function isSmartRuleNumberInBounds(
  value: number,
  bounds: Pick<SmartRuleFieldDefinition, 'min' | 'max'>,
): boolean {
  if (bounds.min != null && value < bounds.min) return false;
  if (bounds.max != null && value > bounds.max) return false;
  return true;
}

export function clampSmartRuleNumber(
  value: number,
  bounds: Pick<SmartRuleFieldDefinition, 'min' | 'max'>,
): number {
  let next = value;
  if (bounds.min != null) next = Math.max(bounds.min, next);
  if (bounds.max != null) next = Math.min(bounds.max, next);
  return next;
}
