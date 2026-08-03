export const visualizer = {
  title: 'Visualizador',
  modeBars: 'Espectro',
  modeScope: 'Osciloscopio',
  modeRadial: 'Osciloscopio radial',
  modeStereo: 'Campo estéreo',
  switchMode: 'Cambiar el modo del visualizador',
  expand: 'Ocupar la ventana',
  collapse: 'Salir de la vista completa',
  radioUnavailableTitle: 'Visualizador de radio no disponible',
  radioUnavailableHint:
    'La visualización de radio estará disponible cuando esta emisora se conecte al grafo de audio del ecualizador. Algunos flujos no admiten esta ruta.',
  settings: {
    section: 'Visualizador',
    description:
      'Anima las frecuencias de la pista mientras se reproduce. El análisis se ejecuta en el motor de audio y solo cuando hay un visualizador en pantalla.',
    enable: 'Activar el visualizador',
    enableHint: 'Muestra el visualizador en Ahora suena y en el reproductor a pantalla completa.',
    mode: 'Modo predeterminado',
    sensitivity: 'Sensibilidad',
    sensitivityHint: 'Realza los pasajes suaves sin recortar los más fuertes.',
    responsiveness: 'Respuesta',
    responsivenessHint:
      'Controla la rapidez con la que caen las barras. Un valor alto sigue mejor los transitorios; uno bajo deja colas más suaves.',
    peaks: 'Marcadores de pico',
    peaksHint: 'Marcadores al estilo Winamp que conservan brevemente el máximo reciente de cada banda.',
    colorSource: 'Colores',
    colorSourceHint:
      'La carátula usa su propia paleta y Tema usa los colores de acento del tema activo. Ambos se adaptan al fondo.',
    colorSourceAlbum: 'Carátula',
    colorSourceTheme: 'Tema',
    frameRate: 'Frecuencia de fotogramas',
    frameRateHint: 'Las frecuencias más bajas consumen menos CPU. La animación sigue siendo fluida.',
    radioNote:
      'La radio por Internet se puede visualizar cuando la emisora se conecta al grafo de audio del ecualizador. Algunos flujos no admiten esta ruta.',
  },
};
