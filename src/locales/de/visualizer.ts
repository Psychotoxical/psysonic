export const visualizer = {
  title: 'Visualizer',
  modeBars: 'Spektrum',
  modeScope: 'Oszilloskop',
  modeRadial: 'Radiales Oszilloskop',
  modeStereo: 'Stereofeld',
  switchMode: 'Visualizer-Modus wechseln',
  expand: 'Fenster ausfüllen',
  collapse: 'Vollfenster verlassen',
  radioUnavailableTitle: 'Radio-Visualizer nicht verfügbar',
  radioUnavailableHint:
    'Die Radio-Visualisierung wird verfügbar, sobald dieser Sender mit dem Audio-Graphen des Equalizers verbunden ist. Einige Streams unterstützen diesen Pfad nicht.',
  settings: {
    section: 'Visualizer',
    description:
      'Animiert die Frequenzen des laufenden Titels. Die Analyse läuft in der Audio-Engine und nur, solange ein Visualizer sichtbar ist.',
    enable: 'Visualizer aktivieren',
    enableHint: 'Zeigt den Visualizer unter „Aktueller Titel“ und im Vollbild-Player.',
    mode: 'Standardmodus',
    sensitivity: 'Empfindlichkeit',
    sensitivityHint: 'Hebt leise Passagen an, ohne laute zu übersteuern.',
    responsiveness: 'Reaktionsgeschwindigkeit',
    responsivenessHint:
      'Wie schnell die Balken abfallen. Höher reagiert direkter auf Transienten, niedriger erzeugt weichere Ausläufe.',
    peaks: 'Spitzenmarkierungen',
    peaksHint: 'Markierungen im Winamp-Stil, die kurz am letzten Maximum jedes Bands stehen bleiben.',
    colorSource: 'Farben',
    colorSourceHint:
      'Albumcover nutzt die Farben des Covers, Theme die Akzentpalette des aktiven Themes. Beide werden an den Hintergrund angepasst.',
    colorSourceAlbum: 'Albumcover',
    colorSourceTheme: 'Theme',
    frameRate: 'Bildrate',
    frameRateHint: 'Niedrigere Werte benötigen weniger CPU. Die Animation bleibt dennoch flüssig.',
    radioNote:
      'Internetradio kann visualisiert werden, sobald der Sender mit dem Audio-Graphen des Equalizers verbunden ist. Einige Streams unterstützen diesen Pfad nicht.',
  },
};
