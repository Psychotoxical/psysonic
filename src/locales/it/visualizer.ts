export const visualizer = {
  title: 'Visualizzatore',
  modeBars: 'Spettro',
  modeScope: 'Oscilloscopio',
  modeRadial: 'Oscilloscopio radiale',
  modeStereo: 'Campo stereo',
  switchMode: 'Cambia modalità del visualizzatore',
  expand: 'Riempi la finestra',
  collapse: 'Esci dalla vista estesa',
  radioUnavailableTitle: 'Visualizzatore radio non disponibile',
  radioUnavailableHint:
    'La visualizzazione radio diventa disponibile quando la stazione si collega al grafo audio dell’equalizzatore. Alcuni flussi non supportano questo percorso.',
  settings: {
    section: 'Visualizzatore',
    description:
      'Anima le frequenze del brano durante la riproduzione. L’analisi viene eseguita nel motore audio solo quando un visualizzatore è visibile.',
    enableNowPlaying: 'Mostra in In Riproduzione',
    enableNowPlayingHint: 'Aggiunge il visualizzatore come scheda nella pagina In Riproduzione.',
    enableFullscreen: 'Mostra nel lettore a schermo intero',
    enableFullscreenHint: 'Aggiunge il visualizzatore a tutti gli stili del lettore a schermo intero.',
    mode: 'Modalità predefinita',
    sensitivity: 'Sensibilità',
    sensitivityHint: 'Amplifica i passaggi silenziosi senza tagliare quelli più forti.',
    responsiveness: 'Reattività',
    responsivenessHint:
      'Determina la velocità di discesa delle barre. Un valore alto segue meglio i transienti, uno basso lascia code più morbide.',
    peaks: 'Indicatori di picco',
    peaksHint: 'Indicatori in stile Winamp che mantengono brevemente il massimo recente di ogni banda.',
    colorSource: 'Colori',
    colorSourceHint:
      'Copertina usa la tavolozza della copertina, Tema usa gli accenti del tema attivo. I colori vengono adattati allo sfondo.',
    colorSourceAlbum: 'Copertina',
    colorSourceTheme: 'Tema',
    frameRate: 'Frequenza fotogrammi',
    frameRateHint: 'Valori più bassi usano meno CPU mantenendo comunque fluida l’animazione.',
    radioNote:
      'La radio Internet può essere visualizzata dopo il collegamento della stazione al grafo audio dell’equalizzatore. Alcuni flussi non supportano questo percorso.',
  },
};
