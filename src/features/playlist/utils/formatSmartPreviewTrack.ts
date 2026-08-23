export type SmartPreviewTrack = {
  id?: string;
  title?: string;
  name?: string;
  album?: string;
  albumArtist?: string;
  albumartist?: string;
  artist?: string;
};

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Album artist, then album, then title — skip empty parts. */
export function formatSmartPreviewTrackLabel(track: SmartPreviewTrack): string {
  const albumArtist = text(track.albumArtist) || text(track.albumartist) || text(track.artist);
  const album = text(track.album);
  const title = text(track.title) || text(track.name) || text(track.id);
  return [albumArtist, album, title].filter(Boolean).join(' - ');
}
