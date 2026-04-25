import React from 'react';
import {
  Disc3, Users, Music4, Radio, Heart, BarChart3,
  HelpCircle, Tags, ListMusic, Cast, TrendingUp,
  FolderOpen, HardDriveUpload, Wand2, Shuffle, Dices, Sparkles,
  AudioLines,
} from 'lucide-react';

export interface NavItemMeta {
  icon: React.ElementType;
  labelKey: string;
  to: string;
  section: 'library' | 'system';
}

// All configurable nav items — order and visibility controlled by sidebarStore.
export const ALL_NAV_ITEMS: Record<string, NavItemMeta> = {
  mainstage:    { icon: Disc3,          labelKey: 'sidebar.mainstage',    to: '/',              section: 'library' },
  newReleases:  { icon: Radio,          labelKey: 'sidebar.newReleases',  to: '/new-releases',  section: 'library' },
  allAlbums:    { icon: Music4,         labelKey: 'sidebar.allAlbums',    to: '/albums',        section: 'library' },
  tracks:       { icon: AudioLines,     labelKey: 'sidebar.tracks',       to: '/tracks',        section: 'library' },
  randomPicker: { icon: Wand2,          labelKey: 'sidebar.randomPicker', to: '/random',        section: 'library' },
  randomMix:    { icon: Shuffle,        labelKey: 'sidebar.randomMix',    to: '/random/mix',    section: 'library' },
  randomAlbums: { icon: Dices,          labelKey: 'sidebar.randomAlbums', to: '/random/albums', section: 'library' },
  luckyMix:     { icon: Sparkles,       labelKey: 'sidebar.feelingLucky', to: '/lucky-mix',     section: 'library' },
  artists:      { icon: Users,          labelKey: 'sidebar.artists',      to: '/artists',       section: 'library' },
  genres:       { icon: Tags,           labelKey: 'sidebar.genres',       to: '/genres',        section: 'library' },
  favorites:    { icon: Heart,          labelKey: 'sidebar.favorites',    to: '/favorites',     section: 'library' },
  playlists:    { icon: ListMusic,      labelKey: 'sidebar.playlists',    to: '/playlists',     section: 'library' },
  mostPlayed:   { icon: TrendingUp,     labelKey: 'sidebar.mostPlayed',   to: '/most-played',   section: 'library' },
  radio:        { icon: Cast,           labelKey: 'sidebar.radio',        to: '/radio',         section: 'library' },
  folderBrowser:{ icon: FolderOpen,     labelKey: 'sidebar.folderBrowser',to: '/folders',       section: 'library' },
  deviceSync:   { icon: HardDriveUpload,labelKey: 'sidebar.deviceSync',   to: '/device-sync',   section: 'library' },
  statistics:   { icon: BarChart3,      labelKey: 'sidebar.statistics',   to: '/statistics',    section: 'system'  },
  help:         { icon: HelpCircle,     labelKey: 'sidebar.help',         to: '/help',          section: 'system'  },
};
