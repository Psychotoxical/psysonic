export const visualizer = {
  title: 'Visualiseur',
  modeBars: 'Spectre',
  modeScope: 'Oscilloscope',
  modeRadial: 'Oscilloscope radial',
  modeStereo: 'Champ stéréo',
  switchMode: 'Changer le mode du visualiseur',
  expand: 'Remplir la fenêtre',
  collapse: 'Quitter la vue étendue',
  radioUnavailableTitle: 'Visualiseur radio indisponible',
  radioUnavailableHint:
    'La visualisation radio devient disponible lorsque cette station se connecte au graphe audio de l’égaliseur. Certains flux ne prennent pas en charge ce chemin.',
  settings: {
    section: 'Visualiseur',
    description:
      'Anime les fréquences du morceau pendant la lecture. L’analyse s’exécute dans le moteur audio uniquement lorsqu’un visualiseur est affiché.',
    enableNowPlaying: 'Afficher dans En cours',
    enableNowPlayingHint: 'Ajoute le visualiseur sous forme de carte sur la page En cours.',
    enableFullscreen: 'Afficher dans le lecteur plein écran',
    enableFullscreenHint: 'Ajoute le visualiseur à tous les styles du lecteur plein écran.',
    mode: 'Mode par défaut',
    sensitivity: 'Sensibilité',
    sensitivityHint: 'Rehausse les passages calmes sans écrêter les passages forts.',
    responsiveness: 'Réactivité',
    responsivenessHint:
      'Détermine la vitesse de retombée des barres. Une valeur élevée suit mieux les transitoires, une valeur basse laisse des traînes plus douces.',
    peaks: 'Repères de crête',
    peaksHint: 'Repères de style Winamp qui restent brièvement sur le maximum récent de chaque bande.',
    colorSource: 'Couleurs',
    colorSourceHint:
      'Pochette utilise sa propre palette, tandis que Thème utilise les accents du thème actif. Les couleurs sont adaptées au fond.',
    colorSourceAlbum: 'Pochette',
    colorSourceTheme: 'Thème',
    frameRate: 'Fréquence d’images',
    frameRateHint: 'Une fréquence plus basse sollicite moins le processeur tout en gardant une animation fluide.',
    radioNote:
      'La radio Internet peut être visualisée après la connexion de la station au graphe audio de l’égaliseur. Certains flux ne prennent pas en charge ce chemin.',
  },
};
