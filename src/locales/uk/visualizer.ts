export const visualizer = {
  title: 'Visualizer',
  modeBars: 'Spectrum',
  modeScope: 'Oscilloscope',
  modeRadial: 'Radial scope',
  modeStereo: 'Stereo field',
  switchMode: 'Switch visualizer mode',
  expand: 'Fill the window',
  collapse: 'Exit full window',
  radioUnavailableTitle: 'Radio visualizer unavailable',
  radioUnavailableHint:
    'Radio visualization becomes available when this station connects to the equalizer audio graph. Some streams do not support that route.',
  settings: {
    section: 'Visualizer',
    description:
      'Animates the frequencies of the track as it plays. Analysis runs in the audio engine and only while a visualizer is on screen.',
    enableNowPlaying: 'Show on Now Playing',
    enableNowPlayingHint: 'Adds the visualizer as a card on the Now Playing page.',
    enableFullscreen: 'Show in the fullscreen player',
    enableFullscreenHint: 'Adds the visualizer to every fullscreen player style.',
    mode: 'Default mode',
    sensitivity: 'Sensitivity',
    sensitivityHint: 'Lifts quiet passages without clipping loud ones.',
    responsiveness: 'Responsiveness',
    responsivenessHint:
      'How quickly the bars fall. Higher is snappier and tracks transients; lower leaves smoother tails.',
    peaks: 'Peak caps',
    peaksHint: 'Winamp-style markers that hang at each band’s recent maximum.',
    colorSource: 'Colours',
    colorSourceHint:
      'Album art pulls the cover’s own palette — its dominant hue, a second hue and its brightest highlight. Theme uses the active theme’s accent ramp. Either way the colours are adapted to the theme background.',
    colorSourceAlbum: 'Album art',
    colorSourceTheme: 'Theme',
    frameRate: 'Frame rate',
    frameRateHint: 'Lower rates cost less CPU. The animation stays smooth either way.',
    radioNote:
      'Internet radio can be visualized after the station connects to the equalizer audio graph. Some streams do not support that route.',
  },
};
