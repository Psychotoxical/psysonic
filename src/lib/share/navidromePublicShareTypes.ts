export type NavidromePublicShareTrack = {
  id: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
};

export type NavidromePublicShareInfo = {
  id: string;
  description: string;
  downloadable: boolean;
  tracks: NavidromePublicShareTrack[];
  imageUrl?: string;
};

export type FetchNavidromePublicShareError =
  | 'not-found'
  | 'expired'
  | 'unreachable'
  | 'malformed';

export type FetchNavidromePublicShareResult =
  | { type: 'ok'; info: NavidromePublicShareInfo }
  | { type: 'error'; reason: FetchNavidromePublicShareError };
