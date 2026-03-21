import { Check } from 'lucide-react';

interface ThemeDef {
  id: string;
  label: string;
  bg: string;
  card: string;
  accent: string;
}

const THEME_GROUPS: { group: string; themes: ThemeDef[] }[] = [
  {
    group: 'Psysonic Themes',
    themes: [
      { id: 'poison',              label: 'Poison',         bg: '#1f1f1f', card: '#282828', accent: '#1bd655' },
      { id: 'nucleo',              label: 'Nucleo',         bg: '#f5e4c3', card: '#dfc08f', accent: '#7a5218' },
      { id: 'psychowave',          label: 'Psychowave',     bg: '#161428', card: '#1f1c38', accent: '#a06ae0' },
      { id: 'vintage-tube-radio',  label: 'Tube Radio',     bg: '#3E2723', card: '#1E110A', accent: '#FF6F00' },
      { id: 'neon-drift',          label: 'Neon Drift',     bg: '#12132c', card: '#080916', accent: '#00f2ff' },
    ],
  },
  {
    group: 'Psysonic Themes — Mediaplayer',
    themes: [
      { id: 'wnamp',         label: 'WnAmp',        bg: '#2b2b3a', card: '#000000', accent: '#00ff00' },
      { id: 'navy-jukebox',  label: 'Navy Jukebox', bg: '#d4d8db', card: '#001358', accent: '#0070a0' },
      { id: 'cobalt-media',  label: 'Cobalt Media', bg: '#3a62a5', card: '#000000', accent: '#45ff00' },
      { id: 'onyx-cinema',   label: 'Onyx Cinema',  bg: '#141414', card: '#000000', accent: '#00aaff' },
    ],
  },
  {
    group: 'Betriebssysteme',
    themes: [
      { id: 'cupertino-light', label: 'Cupertino Light', bg: '#ffffff', card: '#f2f2f7', accent: '#0071e3' },
      { id: 'cupertino-dark',  label: 'Cupertino Dark',  bg: '#1e1e1f', card: '#2d2d2f', accent: '#007aff' },
      { id: 'aero-glass',      label: 'Aero Glass',      bg: '#cddbed', card: '#1d4268', accent: '#1878e8' },
      { id: 'luna-teal',       label: 'Luna Teal',        bg: '#ece9d8', card: '#0055e5', accent: '#3c9d29' },
    ],
  },
  {
    group: 'Catppuccin',
    themes: [
      { id: 'mocha',     label: 'Mocha',     bg: '#1e1e2e', card: '#313244', accent: '#cba6f7' },
      { id: 'macchiato', label: 'Macchiato', bg: '#24273a', card: '#363a4f', accent: '#c6a0f6' },
      { id: 'frappe',    label: 'Frappé',    bg: '#303446', card: '#414559', accent: '#ca9ee6' },
      { id: 'latte',     label: 'Latte',     bg: '#eff1f5', card: '#ccd0da', accent: '#8839ef' },
    ],
  },
  {
    group: 'Nord',
    themes: [
      { id: 'nord',           label: 'Polar Night', bg: '#3b4252', card: '#434c5e', accent: '#88c0d0' },
      { id: 'nord-snowstorm', label: 'Snowstorm',   bg: '#e5e9f0', card: '#eceff4', accent: '#5e81ac' },
      { id: 'nord-frost',     label: 'Frost',       bg: '#1e2d3d', card: '#243447', accent: '#88c0d0' },
      { id: 'nord-aurora',    label: 'Aurora',      bg: '#3b4252', card: '#434c5e', accent: '#b48ead' },
    ],
  },
  {
    group: 'Retro',
    themes: [
      { id: 'gruvbox-dark-hard',    label: 'Dark Hard',    bg: '#1d2021', card: '#3c3836', accent: '#fabd2f' },
      { id: 'gruvbox-dark-medium',  label: 'Dark Medium',  bg: '#282828', card: '#3c3836', accent: '#fabd2f' },
      { id: 'gruvbox-dark-soft',    label: 'Dark Soft',    bg: '#32302f', card: '#45403d', accent: '#fabd2f' },
      { id: 'gruvbox-light-hard',   label: 'Light Hard',   bg: '#f9f5d7', card: '#f2e5bc', accent: '#b57614' },
      { id: 'gruvbox-light-medium', label: 'Light Medium', bg: '#fbf1c7', card: '#f2e5bc', accent: '#b57614' },
      { id: 'gruvbox-light-soft',   label: 'Light Soft',   bg: '#f2e5bc', card: '#ebdbb2', accent: '#b57614' },
    ],
  },
  {
    group: 'Tokyo Night',
    themes: [
      { id: 'tokyo-night',       label: 'Standard', bg: '#1a1b26', card: '#24283b', accent: '#7aa2f7' },
      { id: 'tokyo-night-storm', label: 'Storm',    bg: '#24283b', card: '#2f334d', accent: '#7aa2f7' },
      { id: 'tokyo-night-light', label: 'Light',    bg: '#d5d6db', card: '#e9e9ec', accent: '#34548a' },
    ],
  },
];

interface Props {
  value: string;
  onChange: (id: string) => void;
}

export default function ThemePicker({ value, onChange }: Props) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {THEME_GROUPS.map(({ group, themes }) => (
        <div key={group}>
          <div style={{
            fontSize: '11px',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            color: 'var(--text-muted)',
            marginBottom: '10px',
          }}>
            {group}
          </div>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(72px, 1fr))',
            gap: '10px',
          }}>
            {themes.map((t) => {
              const isActive = value === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => onChange(t.id)}
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    cursor: 'pointer',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: '6px',
                  }}
                >
                  <div style={{
                    width: '100%',
                    height: '46px',
                    borderRadius: '8px',
                    overflow: 'hidden',
                    outline: isActive ? '2px solid var(--accent)' : '2px solid transparent',
                    outlineOffset: '2px',
                    position: 'relative',
                    boxShadow: isActive ? '0 0 8px var(--accent-glow, rgba(0,0,0,0.2))' : '0 1px 3px rgba(0,0,0,0.3)',
                    transition: 'outline-color 0.15s, box-shadow 0.15s',
                  }}>
                    {/* main bg */}
                    <div style={{ background: t.bg, height: '55%' }} />
                    {/* card tone */}
                    <div style={{ background: t.card, height: '20%' }} />
                    {/* accent bar */}
                    <div style={{ background: t.accent, height: '25%' }} />
                    {isActive && (
                      <div style={{
                        position: 'absolute',
                        top: '4px',
                        right: '4px',
                        width: '14px',
                        height: '14px',
                        borderRadius: '50%',
                        background: t.accent,
                        border: '1.5px solid rgba(255,255,255,0.7)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}>
                        <Check size={8} strokeWidth={3} color="white" />
                      </div>
                    )}
                  </div>
                  <span style={{
                    fontSize: '11px',
                    color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                    fontWeight: isActive ? 600 : 400,
                    textAlign: 'center',
                    lineHeight: 1.2,
                    wordBreak: 'break-word',
                  }}>
                    {t.label}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
