import { useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

interface ThemeDef {
  id: string;
  label: string;
  bg: string;
  card: string;
  accent: string;
}

const THEME_GROUPS: { group: string; themes: ThemeDef[] }[] = [
  {
    group: 'Games',
    themes: [
      { id: 'ascalon',           label: 'Ascalon',           bg: '#1c1a17', card: '#0f0d0b', accent: '#d4af37' },
      { id: 'azerothian-gold',   label: 'Azerothian Gold',   bg: '#1a1a1a', card: '#0a0a0a', accent: '#c19e67' },
      { id: 'grand-theft-audio', label: 'Grand Theft Audio', bg: '#141414', card: '#0a0a0a', accent: '#57b05a' },
      { id: 'lambda-17',         label: 'Lambda 17',         bg: '#14171a', card: '#0a0b0c', accent: '#ff9d00' },
      { id: 'nightcity-2077',    label: 'NightCity 2077',    bg: '#050505', card: '#000000', accent: '#FCEE0A' },
      { id: 'v-tactical',        label: 'V-Tactical',        bg: '#161c22', card: '#090c0e', accent: '#ff8a00' },
    ],
  },
  {
    group: 'Movies',
    themes: [
      { id: 'blade',                label: 'Blade',                bg: '#121212', card: '#050505', accent: '#b30000' },
      { id: 'imperial-sith',        label: 'Imperial Sith',        bg: '#0f0f11', card: '#050505', accent: '#e60000' },
      { id: 'middle-earth',         label: 'Middle Earth',         bg: '#f4e4bc', card: '#2a1d15', accent: '#d4af37' },
      { id: 'morpheus',             label: 'Morpheus',             bg: '#0a0a0a', card: '#000000', accent: '#00ff41' },
      { id: 'order-of-the-phoenix', label: 'Order of the Phoenix', bg: '#181818', card: '#0a0a0a', accent: '#e63900' },
      { id: 'pandora',              label: 'Pandora',              bg: '#0c1b22', card: '#142b35', accent: '#00f2ff' },
      { id: 'stark-hud',            label: 'Stark HUD',            bg: '#0b0f15', card: '#05070a', accent: '#00f2ff' },
    ],
  },
  {
    group: 'Open Source Classics',
    themes: [
      { id: 'nord-aurora',          label: 'Aurora',       bg: '#3b4252', card: '#434c5e', accent: '#b48ead' },
      { id: 'gruvbox-dark-hard',    label: 'Dark Hard',    bg: '#1d2021', card: '#3c3836', accent: '#fabd2f' },
      { id: 'gruvbox-dark-medium',  label: 'Dark Medium',  bg: '#282828', card: '#3c3836', accent: '#fabd2f' },
      { id: 'gruvbox-dark-soft',    label: 'Dark Soft',    bg: '#32302f', card: '#45403d', accent: '#fabd2f' },
      { id: 'frappe',               label: 'Frappé',       bg: '#303446', card: '#414559', accent: '#ca9ee6' },
      { id: 'nord-frost',           label: 'Frost',        bg: '#1e2d3d', card: '#243447', accent: '#88c0d0' },
      { id: 'latte',                label: 'Latte',        bg: '#eff1f5', card: '#ccd0da', accent: '#8839ef' },
      { id: 'gruvbox-light-hard',   label: 'Light Hard',   bg: '#f9f5d7', card: '#f2e5bc', accent: '#b57614' },
      { id: 'gruvbox-light-medium', label: 'Light Medium', bg: '#fbf1c7', card: '#f2e5bc', accent: '#b57614' },
      { id: 'gruvbox-light-soft',   label: 'Light Soft',   bg: '#f2e5bc', card: '#ebdbb2', accent: '#b57614' },
      { id: 'macchiato',            label: 'Macchiato',    bg: '#24273a', card: '#363a4f', accent: '#c6a0f6' },
      { id: 'mocha',                label: 'Mocha',        bg: '#1e1e2e', card: '#313244', accent: '#cba6f7' },
      { id: 'nord',                 label: 'Polar Night',  bg: '#3b4252', card: '#434c5e', accent: '#88c0d0' },
      { id: 'nord-snowstorm',       label: 'Snowstorm',    bg: '#e5e9f0', card: '#eceff4', accent: '#5e81ac' },
    ],
  },
  {
    group: 'Operating Systems',
    themes: [
      { id: 'cupertino-dark',  label: 'Cupertino Dark',  bg: '#1e1e1f', card: '#2d2d2f', accent: '#007aff' },
      { id: 'cupertino-light', label: 'Cupertino Light', bg: '#ffffff', card: '#f2f2f7', accent: '#0071e3' },
      { id: 'aero-glass',      label: 'W7',              bg: '#cddbed', card: '#1d4268', accent: '#1878e8' },
      { id: 'w98',             label: 'W98',             bg: '#008080', card: '#c0c0c0', accent: '#000080' },
      { id: 'luna-teal',       label: 'WXP',             bg: '#ece9d8', card: '#0055e5', accent: '#3c9d29' },
    ],
  },
  {
    group: 'Psysonic Themes',
    themes: [
      { id: 'neon-drift',         label: 'Neon Drift',  bg: '#12132c', card: '#080916', accent: '#00f2ff' },
      { id: 'nucleo',             label: 'Nucleo',      bg: '#f5e4c3', card: '#dfc08f', accent: '#7a5218' },
      { id: 'poison',             label: 'Poison',      bg: '#1f1f1f', card: '#282828', accent: '#1bd655' },
      { id: 'psychowave',         label: 'Psychowave',  bg: '#161428', card: '#1f1c38', accent: '#a06ae0' },
      { id: 'vintage-tube-radio', label: 'Tube Radio',  bg: '#3E2723', card: '#1E110A', accent: '#FF6F00' },
    ],
  },
  {
    group: 'Psysonic Themes — Mediaplayer',
    themes: [
      { id: 'cobalt-media',    label: 'Cobalt Media',    bg: '#3a62a5', card: '#000000', accent: '#45ff00' },
      { id: 'cupertino-beats', label: 'Cupertino Beats', bg: '#1c1c1e', card: '#2c2c2e', accent: '#fa243c' },
      { id: 'dzr0',            label: 'DZR',             bg: '#FFFFFF', card: '#F5F5F7', accent: '#A238FF' },
      { id: 'navy-jukebox',    label: 'Navy Jukebox',    bg: '#d4d8db', card: '#001358', accent: '#0070a0' },
      { id: 'onyx-cinema',     label: 'Onyx Cinema',     bg: '#141414', card: '#000000', accent: '#00aaff' },
      { id: 'spotless',        label: 'Spotless',        bg: '#121212', card: '#181818', accent: '#1ED760' },
      { id: 'wnamp',           label: 'WnAmp',           bg: '#2b2b3a', card: '#000000', accent: '#00ff00' },
    ],
  },
  {
    group: 'Series',
    themes: [
      { id: 'ice-and-fire', label: 'A Theme of Ice and Fire', bg: '#121820', card: '#05070a', accent: '#70a1ff' },
      { id: 'doh-matic',    label: "D'oh-matic",              bg: '#FFFDF0', card: '#FFD90F', accent: '#1F75FE' },
      { id: 'heisenberg',   label: 'Heisenberg',              bg: '#1a1d1a', card: '#0a0c0a', accent: '#3fe0ff' },
    ],
  },
];

interface Props {
  value: string;
  onChange: (id: string) => void;
}

export default function ThemePicker({ value, onChange }: Props) {
  const initialOpen = THEME_GROUPS.find(g => g.themes.some(t => t.id === value))?.group ?? THEME_GROUPS[0].group;
  const [openGroup, setOpenGroup] = useState<string | null>(initialOpen);

  const toggle = (group: string) => setOpenGroup(prev => prev === group ? null : group);

  return (
    <div className="theme-accordion">
      {THEME_GROUPS.map(({ group, themes }) => {
        const isOpen = openGroup === group;
        const hasActive = themes.some(t => t.id === value);
        return (
          <div key={group} className={`theme-accordion-item${isOpen ? ' theme-accordion-open' : ''}`}>
            <button className="theme-accordion-header" onClick={() => toggle(group)}>
              <span>
                {group}
                {hasActive && !isOpen && (
                  <span className="theme-accordion-active-dot" />
                )}
              </span>
              <ChevronDown size={15} className="theme-accordion-chevron" />
            </button>
            {isOpen && (
              <div className="theme-accordion-content">
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
                          <div style={{ background: t.bg, height: '55%' }} />
                          <div style={{ background: t.card, height: '20%' }} />
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
            )}
          </div>
        );
      })}
    </div>
  );
}
