import type { PerfProbeFlags } from '@/lib/perf/perfFlags';

export type PerfToggleLeaf = {
  id: string;
  label: string;
  description?: string;
  flag: keyof PerfProbeFlags;
};

export type PerfToggleEngineLeaf = {
  id: string;
  label: string;
  description?: string;
  engine: 'hotCache' | 'normalization' | 'logging';
};

export type PerfToggleGroup = {
  id: string;
  label: string;
  children: PerfToggleNode[];
};

export type PerfToggleNode = PerfToggleLeaf | PerfToggleEngineLeaf | PerfToggleGroup;

export function isPerfToggleGroup(node: PerfToggleNode): node is PerfToggleGroup {
  return 'children' in node;
}

export function isPerfToggleEngineLeaf(node: PerfToggleNode): node is PerfToggleEngineLeaf {
  return 'engine' in node;
}

/** Diagnostic disable toggles as a navigable tree (replaces flat “phases”). */
export const PERF_PROBE_TOGGLE_TREE: PerfToggleGroup[] = [
  {
    id: 'shell',
    label: 'Shell & chrome',
    children: [
      {
        id: 'shell-player',
        label: 'Player bar',
        children: [
          {
            id: 'disableWaveformCanvas',
            label: 'Waveform canvas',
            description: 'Disable only PlayerBar waveform (`WaveformSeek`)',
            flag: 'disableWaveformCanvas',
          },
          {
            id: 'disablePlayerProgressUi',
            label: 'Live progress UI',
            description: 'Disable player time + seek/progress bindings',
            flag: 'disablePlayerProgressUi',
          },
          {
            id: 'disableMarqueeScroll',
            label: 'Marquee scroll',
            description: 'Disable scrolling marquee text',
            flag: 'disableMarqueeScroll',
          },
        ],
      },
      {
        id: 'shell-visual',
        label: 'Visual effects',
        children: [
          {
            id: 'disableBackdropBlur',
            label: 'Backdrop blur',
            flag: 'disableBackdropBlur',
          },
          {
            id: 'disableCssAnimations',
            label: 'CSS animations',
            description: 'Disable CSS animations and transitions',
            flag: 'disableCssAnimations',
          },
        ],
      },
      {
        id: 'shell-layout',
        label: 'Layout & portals',
        children: [
          {
            id: 'disableOverlayScrollbars',
            label: 'Overlay scrollbars',
            description: 'Disable overlay scrollbar engine (JS + rail)',
            flag: 'disableOverlayScrollbars',
          },
          {
            id: 'disableTooltipPortal',
            label: 'Tooltip portal',
            flag: 'disableTooltipPortal',
          },
          {
            id: 'disableQueuePanelMount',
            label: 'Queue panel',
            description: 'Disable QueuePanel mount (desktop right column)',
            flag: 'disableQueuePanelMount',
          },
        ],
      },
      {
        id: 'shell-network',
        label: 'Network & engine',
        children: [
          {
            id: 'disableBackgroundPolling',
            label: 'Background polling',
            description: 'Connection status + radio metadata',
            flag: 'disableBackgroundPolling',
          },
          {
            id: 'hotCache',
            label: 'Hot-cache prefetch',
            description: 'Disable hot-cache prefetch downloads',
            engine: 'hotCache',
          },
          {
            id: 'normalization',
            label: 'Normalization engine',
            description: 'Set normalization to Off',
            engine: 'normalization',
          },
          {
            id: 'logging',
            label: 'Runtime logging',
            description: 'Set runtime logging mode to Off',
            engine: 'logging',
          },
        ],
      },
    ],
  },
  {
    id: 'mainstage',
    label: 'Mainstage (center content)',
    children: [
      {
        id: 'disableMainRouteContentMount',
        label: 'Route content mount',
        description: 'Disable central route content mount',
        flag: 'disableMainRouteContentMount',
      },
      {
        id: 'mainstage-shared',
        label: 'Shared layers',
        children: [
          {
            id: 'disableMainstageStickyHeader',
            label: 'Sticky headers',
            description: 'Tracks + Albums sticky toolbars',
            flag: 'disableMainstageStickyHeader',
          },
        ],
      },
      {
        id: 'mainstage-home',
        label: 'Home (`/`)',
        children: [
          {
            id: 'home-hero',
            label: 'Hero',
            children: [
              {
                id: 'disableMainstageHero',
                label: 'Hero block',
                flag: 'disableMainstageHero',
              },
              {
                id: 'disableMainstageHeroBackdrop',
                label: 'Hero backdrop',
                description: 'Disable backdrop/crossfade only',
                flag: 'disableMainstageHeroBackdrop',
              },
            ],
          },
          {
            id: 'home-rails',
            label: 'Rails',
            children: [
              {
                id: 'disableMainstageRails',
                label: 'All rails',
                description: '`AlbumRow` + `SongRail`',
                flag: 'disableMainstageRails',
              },
              {
                id: 'disableHomeAlbumRows',
                label: 'Album rows only',
                flag: 'disableHomeAlbumRows',
              },
              {
                id: 'disableHomeSongRails',
                label: 'Song rails only',
                flag: 'disableHomeSongRails',
              },
              {
                id: 'disableMainstageRailInteractivity',
                label: 'Rail interactivity',
                description: 'Scroll/nav handlers',
                flag: 'disableMainstageRailInteractivity',
              },
            ],
          },
          {
            id: 'home-artwork',
            label: 'Artwork',
            children: [
              {
                id: 'disableMainstageRailArtwork',
                label: 'Rail artwork (all pages)',
                flag: 'disableMainstageRailArtwork',
              },
              {
                id: 'disableHomeRailArtwork',
                label: 'Rail artwork (Home only)',
                flag: 'disableHomeRailArtwork',
              },
              {
                id: 'disableHomeArtworkFx',
                label: 'Card visual effects',
                description: 'Keep artwork; disable hover/overlay/shadows',
                flag: 'disableHomeArtworkFx',
              },
              {
                id: 'disableHomeArtworkClip',
                label: 'Flatten clipping',
                description: 'No rounded corners/masks on Home cards',
                flag: 'disableHomeArtworkClip',
              },
            ],
          },
          {
            id: 'home-discover',
            label: 'Discover grid',
            children: [
              {
                id: 'disableMainstageGridCards-home',
                label: 'Artist chip grid',
                flag: 'disableMainstageGridCards',
              },
            ],
          },
        ],
      },
      {
        id: 'mainstage-tracks',
        label: 'Tracks (`/tracks`)',
        children: [
          {
            id: 'tracks-hero',
            label: 'Hero block',
            flag: 'disableMainstageHero',
          },
          {
            id: 'tracks-rails',
            label: 'Rails',
            flag: 'disableMainstageRails',
          },
          {
            id: 'tracks-rail-art',
            label: 'Rail artwork',
            flag: 'disableMainstageRailArtwork',
          },
          {
            id: 'tracks-rail-interact',
            label: 'Rail interactivity',
            flag: 'disableMainstageRailInteractivity',
          },
          {
            id: 'disableMainstageVirtualLists',
            label: 'Virtual browse list',
            description: 'Disable `VirtualSongList`',
            flag: 'disableMainstageVirtualLists',
          },
        ],
      },
      {
        id: 'mainstage-albums',
        label: 'Albums (`/albums`)',
        children: [
          {
            id: 'disableMainstageGridCards-albums',
            label: 'Album card grid',
            description: 'Disable `AlbumCard` list',
            flag: 'disableMainstageGridCards',
          },
        ],
      },
    ],
  },
];
