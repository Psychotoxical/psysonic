export const visualizer = {
  title: 'ビジュアライザー',
  modeBars: 'スペクトラム',
  modeScope: 'オシロスコープ',
  modeRadial: 'ラジアルスコープ',
  modeStereo: 'ステレオフィールド',
  switchMode: 'ビジュアライザーのモードを切り替え',
  expand: 'ウィンドウ全体に表示',
  collapse: '拡大表示を終了',
  radioUnavailableTitle: 'ラジオのビジュアライザーを利用できません',
  radioUnavailableHint:
    'この局がイコライザーのオーディオグラフに接続されると、ラジオのビジュアライザーを利用できます。一部のストリームはこの経路に対応していません。',
  settings: {
    section: 'ビジュアライザー',
    description:
      '再生中の曲の周波数をアニメーション表示します。解析はオーディオエンジン内で、ビジュアライザーが画面に表示されている間だけ実行されます。',
    enable: 'ビジュアライザーを有効にする',
    enableHint: '再生中ページと全画面プレーヤーにビジュアライザーを表示します。',
    mode: '既定のモード',
    sensitivity: '感度',
    sensitivityHint: '大きな音をクリップせずに静かな部分を持ち上げます。',
    responsiveness: '反応速度',
    responsivenessHint:
      'バーが下がる速さです。高いほど瞬間的な変化に素早く反応し、低いほど滑らかな余韻になります。',
    peaks: 'ピークマーカー',
    peaksHint: '各帯域の直近の最大値を一時的に保持する Winamp 風のマーカーです。',
    colorSource: '色',
    colorSourceHint:
      'アルバムアートはジャケットの配色を、テーマは現在のテーマのアクセント色を使用します。どちらも背景に合わせて調整されます。',
    colorSourceAlbum: 'アルバムアート',
    colorSourceTheme: 'テーマ',
    frameRate: 'フレームレート',
    frameRateHint: '低い値ほど CPU 使用量を抑えられます。アニメーションは滑らかに保たれます。',
    radioNote:
      'インターネットラジオは、局がイコライザーのオーディオグラフに接続された後に表示できます。一部のストリームはこの経路に対応していません。',
  },
};
