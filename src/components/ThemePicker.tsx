import { useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

interface ThemeDef {
  id: string;
  label: string;
  bg: string;
  card: string;
  accent: string;
}

export const THEME_GROUPS: { group: string; themes: ThemeDef[] }[] = [
  {
    group: 'Games',
    themes: [
      { id: 'gw1',               label: 'GW1',               bg: '#0e0b08', card: '#1a1208', accent: '#c8960c' },
      { id: 'grand-theft-audio', label: 'Grand Theft Audio', bg: '#141414', card: '#0a0a0a', accent: '#57b05a' },
      { id: 'lambda-17',         label: 'Lambda 17',         bg: '#14171a', card: '#0a0b0c', accent: '#ff9d00' },
      { id: 'nightcity-2077',    label: 'NightCity 2077',    bg: '#06060f', card: '#0a0a1a', accent: '#FCEE0A' },
      { id: 'tetrastack',        label: 'TetraStack',        bg: '#060614', card: '#0c0c20', accent: '#00f0f0' },
      { id: 'v-tactical',        label: 'V-Tactical',        bg: '#161c22', card: '#090c0e', accent: '#ff8a00' },
      { id: 'horde',             label: 'Horde',             bg: '#1a0500', card: '#2e0a02', accent: '#cc2200' },
      { id: 'alliance',          label: 'Alliance',          bg: '#06101e', card: '#0c1e34', accent: '#3388cc' },
    ],
  },
  {
    group: 'Movies',
    themes: [
      { id: 'blade',                label: 'Blade',                bg: '#121212', card: '#050505', accent: '#b30000' },
      { id: 'dune',                 label: 'Dune',                 bg: '#1c1408', card: '#0e0c1a', accent: '#c8780a' },
      { id: 'hill-valley-85',       label: 'Hill Valley 85',       bg: '#0d0b18', card: '#141120', accent: '#ff8c00' },
      { id: 'middle-earth',         label: 'Middle Earth',         bg: '#f0e0b0', card: '#241a0e', accent: '#d4a820' },
      { id: 'morpheus',             label: 'Morpheus',             bg: '#050905', card: '#0a120a', accent: '#00ff41' },
      { id: 'spider-tech',          label: 'Spider-Tech',          bg: '#0e0c18', card: '#181428', accent: '#E62429' },
      { id: 'stark-hud',            label: 'Stark HUD',            bg: '#0b0f15', card: '#05070a', accent: '#00f2ff' },
      { id: 't-800',                label: 'T-800',                bg: '#140e0e', card: '#1a0a0a', accent: '#ff2000' },
      { id: 'barb-and-ken',         label: 'Barb & Ken',           bg: '#1a000f', card: '#2e0019', accent: '#FF1B8D' },
      { id: 'toy-tale',             label: 'Toy Tale',             bg: '#1a1208', card: '#2a1c10', accent: '#FFD600' },
    ],
  },
  {
    group: 'Open Source Classics',
    themes: [
      { id: 'nord-aurora',          label: 'Aurora',       bg: '#3b4252', card: '#434c5e', accent: '#b48ead' },
      { id: 'carbonfox',            label: 'Carbonfox',    bg: '#161616', card: '#1c1c1c', accent: '#be95ff' },
      { id: 'gruvbox-dark-hard',    label: 'Dark Hard',    bg: '#1d2021', card: '#3c3836', accent: '#fabd2f' },
      { id: 'gruvbox-dark-medium',  label: 'Dark Medium',  bg: '#282828', card: '#3c3836', accent: '#fabd2f' },
      { id: 'gruvbox-dark-soft',    label: 'Dark Soft',    bg: '#32302f', card: '#45403d', accent: '#fabd2f' },
      { id: 'dracula',              label: 'Dracula',      bg: '#282a36', card: '#44475a', accent: '#bd93f9' },
      { id: 'dawnfox',              label: 'Dawnfox',      bg: '#faf4ed', card: '#ebe0df', accent: '#907aa9' },
      { id: 'dayfox',               label: 'Dayfox',       bg: '#f6f2ee', card: '#dbd1dd', accent: '#2848a9' },
      { id: 'duskfox',              label: 'Duskfox',      bg: '#232136', card: '#2d2a45', accent: '#c4a7e7' },
      { id: 'frappe',               label: 'Frappé',       bg: '#303446', card: '#414559', accent: '#ca9ee6' },
      { id: 'nord-frost',           label: 'Frost',        bg: '#1e2d3d', card: '#243447', accent: '#88c0d0' },
      { id: 'latte',                label: 'Latte',        bg: '#eff1f5', card: '#ccd0da', accent: '#8839ef' },
      { id: 'gruvbox-light-hard',   label: 'Light Hard',   bg: '#f9f5d7', card: '#f2e5bc', accent: '#b57614' },
      { id: 'gruvbox-light-medium', label: 'Light Medium', bg: '#fbf1c7', card: '#f2e5bc', accent: '#b57614' },
      { id: 'gruvbox-light-soft',   label: 'Light Soft',   bg: '#f2e5bc', card: '#ebdbb2', accent: '#b57614' },
      { id: 'macchiato',            label: 'Macchiato',    bg: '#24273a', card: '#363a4f', accent: '#c6a0f6' },
      { id: 'mocha',                label: 'Mocha',        bg: '#1e1e2e', card: '#313244', accent: '#cba6f7' },
      { id: 'nightfox',             label: 'Nightfox',     bg: '#192330', card: '#212e3f', accent: '#719cd6' },
      { id: 'nordfox',              label: 'Nordfox',      bg: '#2e3440', card: '#39404f', accent: '#81a1c1' },
      { id: 'nord',                 label: 'Polar Night',  bg: '#3b4252', card: '#434c5e', accent: '#88c0d0' },
      { id: 'nord-snowstorm',       label: 'Snowstorm',    bg: '#e5e9f0', card: '#eceff4', accent: '#5e81ac' },
      { id: 'terafox',              label: 'Terafox',      bg: '#152528', card: '#1d3337', accent: '#a1cdd8' },
    ],
  },
  {
    group: 'Operating Systems',
    themes: [
      { id: 'ubuntu-ambiance', label: 'Ubuntu',          bg: '#f4efea', card: '#3d1f3d', accent: '#e95420' },
      { id: 'aqua-quartz',     label: 'Aqua Quartz',     bg: '#f6f6f6', card: '#ffffff',  accent: '#3876f7' },
      { id: 'cupertino-light', label: 'Cupertino Light', bg: '#ffffff', card: '#f2f2f7', accent: '#0071e3' },
      { id: 'cupertino-dark',  label: 'Cupertino Dark',  bg: '#1e1e1f', card: '#2d2d2f', accent: '#007aff' },
      { id: 'dos',             label: 'DOS',             bg: '#0000AA', card: '#000080', accent: '#FFFF55' },
      { id: 'unix',            label: 'Unix',            bg: '#000000', card: '#111111', accent: '#22C55E' },
      { id: 'w3-1',            label: 'W3.1',            bg: '#c0c0c0', card: '#ffffff',  accent: '#000080' },
      { id: 'w98',             label: 'W98',             bg: '#008080', card: '#d4d0c8', accent: '#000080' },
      { id: 'luna-teal',       label: 'WXP',             bg: '#ece9d8', card: '#1248b8', accent: '#3c9d29' },
      { id: 'wista',           label: 'Wista',           bg: '#eef3fc', card: '#0e1e3e', accent: '#1565c8' },
      { id: 'aero-glass',      label: 'W7',              bg: '#b8cfe8', card: '#05080f', accent: '#1878e8' },
      { id: 'w10',             label: 'W10',             bg: '#f3f3f3', card: '#ffffff',  accent: '#0078d4' },
      { id: 'w11',             label: 'W11',             bg: '#202020', card: '#2c2c2c', accent: '#0078d4' },
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
    group: 'COMMUNITY',
    themes: [
      { id: 'amber-night', label: 'Amber Night', bg: '#1a1410', card: '#201a12', accent: '#d4a96a' },
      { id: 'amoled-black-pure', label: 'AMOLED Black Pure', bg: '#000000', card: '#000000', accent: '#ffffff' },
      { id: 'ice-blue', label: 'Ice Blue', bg: '#0e1d28', card: '#132430', accent: '#7dd3e8' },
      { id: 'midnight-blue', label: 'Midnight Blue', bg: '#0d1420', card: '#111a28', accent: '#60a5fa' },
      { id: 'monochrome', label: 'Monochrome Dark', bg: '#161616', card: '#1c1c1c', accent: '#c0c0c0' },
      { id: 'phosphor-green', label: 'Phosphor Green', bg: '#0d1a0d', card: '#111f11', accent: '#4ade80' },
      { id: 'rose-dark', label: 'Rose Dark', bg: '#1a0d14', card: '#20111a', accent: '#f472b6' },
      { id: 'sepia-dark', label: 'Sepia Dark', bg: '#1e1a14', card: '#252018', accent: '#c8b89a' },
    ],
  },
  {
    group: 'Mediaplayer',
    themes: [
      { id: 'winmedplayer',    label: 'WinMedPlayer',    bg: '#3a62a5', card: '#000000', accent: '#45ff00' },
      { id: 'cupertino-beats', label: 'Cupertino Beats', bg: '#1c1c1e', card: '#2c2c2e', accent: '#fa243c' },
      { id: 'dzr0',            label: 'DZR',             bg: '#FFFFFF', card: '#F5F5F7', accent: '#A238FF' },
      { id: 'muma-jukebox',    label: 'MuMa Jukebox',    bg: '#d4d8db', card: '#001358', accent: '#0070a0' },
      { id: 'p-dvd',           label: 'P-DVD',           bg: '#141414', card: '#000000', accent: '#00aaff' },
      { id: 'spotless',        label: 'Spotless',        bg: '#121212', card: '#181818', accent: '#1ED760' },
      { id: 'jayfin',          label: 'Jayfin',          bg: '#141414', card: '#1e1e1e', accent: '#AA5CC3' },
      { id: 'wnamp',           label: 'WnAmp',           bg: '#2b2b3a', card: '#000000', accent: '#d4cc46' },
    ],
  },
  {
    group: 'Series',
    themes: [
      { id: 'ice-and-fire', label: 'A Theme of Ice and Fire', bg: '#100c08', card: '#090c10', accent: '#c41e1e' },
      { id: 'doh-matic',    label: "D'oh-matic",              bg: '#FFFDF0', card: '#FFD90F', accent: '#1F75FE' },
      { id: 'heisenberg',   label: 'Heisenberg',              bg: '#0b0e12', card: '#141a22', accent: '#35d4f8' },
      { id: 'turtle-power', label: 'Turtle Power',            bg: '#1a1a1a', card: '#0a0a0a', accent: '#33cc33' },
      { id: 'north-park',   label: 'North Park',              bg: '#F5F1E8', card: '#FFFFFF',  accent: '#FF8C00' },
    ],
  },
  {
    group: 'Famous Albums',
    themes: [
      { id: 'dark-side-of-the-moon', label: 'Dark Side of the Moon (inspired)', bg: '#050505', card: '#0D0D0D', accent: '#9B30FF' },
      { id: 'powerslave',            label: 'Powerslave (inspired)',            bg: '#F0DFB0', card: '#2A1808', accent: '#C8960C' },
    ],
  },
  {
    group: 'Accessibility',
    themes: [
      { id: 'vision-dark',  label: 'Vision Dark',  bg: '#0d0b12', card: '#16131e', accent: '#ffd700' },
      { id: 'vision-navy',  label: 'Vision Navy',  bg: '#0a1628', card: '#112038', accent: '#ffd700' },
    ],
  },
  {
    group: 'Social Media',
    themes: [
      { id: 'insta',    label: 'Insta',    bg: '#121212', card: '#000000', accent: '#E1306C' },
      { id: 'readit',   label: 'ReadIt',   bg: '#030303', card: '#1A1A1B', accent: '#FF4500' },
      { id: 'the-book', label: 'The Book', bg: '#F0F2F5', card: '#FFFFFF',  accent: '#1877F2' },
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
                        className="theme-card-btn"
                        onClick={() => onChange(t.id)}
                      >
                        <div className={`theme-card-preview${isActive ? ' is-active' : ''}`}>
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
                        <span className={`theme-card-label${isActive ? ' is-active' : ''}`}>
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
