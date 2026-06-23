import { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Save, Trash2, RotateCcw } from 'lucide-react';
import CustomSelect from './CustomSelect';
import { useEqStore, EQ_BANDS, BUILTIN_PRESETS } from '../store/eqStore';
import { useThemeStore } from '../store/themeStore';
import { drawCurve } from '../utils/audio/eqCurve';
import VerticalFader from './equalizer/VerticalFader';
import AutoEqSection from './equalizer/AutoEqSection';

export default function Equalizer() {
  const { t } = useTranslation();
  const gains = useEqStore(s => s.gains);
  const enabled = useEqStore(s => s.enabled);
  const preGain = useEqStore(s => s.preGain);
  const activePreset = useEqStore(s => s.activePreset);
  const customPresets = useEqStore(s => s.customPresets);
  const { setBandGain, setEnabled, setPreGain, applyPreset, saveCustomPreset, deleteCustomPreset } = useEqStore();

  const [saveName, setSaveName] = useState('');
  const [showSave, setShowSave] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const theme = useThemeStore(s => s.theme);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const style = getComputedStyle(document.documentElement);
    const accent = style.getPropertyValue('--accent').trim() || 'rgb(203, 166, 247)';
    const bg = style.getPropertyValue('--bg-app').trim() || '#1e1e2e';
    const text = style.getPropertyValue('--text-muted').trim() || 'rgba(255,255,255,0.4)';
    drawCurve(canvas, gains, accent, bg, text);
    // theme is an intentional re-create trigger: redraw reads the live CSS custom
    // properties via getComputedStyle, so it must re-run when the theme changes
    // even though the `theme` value itself is not referenced here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gains, theme]);

  useEffect(() => { redraw(); }, [redraw]);

  useEffect(() => {
    const ro = new ResizeObserver(redraw);
    if (canvasRef.current) ro.observe(canvasRef.current);
    return () => ro.disconnect();
  }, [redraw]);

  // ResizeObserver does not always fire for the `display: none → block`
  // transition the surrounding <details> causes when toggled, leaving the
  // canvas blank on the second open. Redraw explicitly when the parent
  // <details> opens; rAF waits one frame for the canvas to take its size.
  useEffect(() => {
    const details = canvasRef.current?.closest('details');
    if (!details) return;
    const onToggle = () => {
      if (details.open) requestAnimationFrame(redraw);
    };
    details.addEventListener('toggle', onToggle);
    return () => details.removeEventListener('toggle', onToggle);
  }, [redraw]);

  const isCustomSaved = activePreset !== null && customPresets.some(p => p.name === activePreset);
  const isBuiltin = activePreset !== null && BUILTIN_PRESETS.some(p => p.name === activePreset);
  // AutoEQ profiles store the headphone name in activePreset, which is neither a
  // built-in nor a saved custom preset — surface it in the picker so the active
  // profile name stays visible after the lookup clears.
  const isAutoEq = activePreset !== null && !isBuiltin && !isCustomSaved;
  const selectValue = activePreset ?? '__custom__';

  const handleSave = () => {
    const name = saveName.trim();
    if (!name) return;
    saveCustomPreset(name);
    setSaveName('');
    setShowSave(false);
  };

  return (
    <div className="eq-wrap">
      {/* Controls bar */}
      <div className="eq-controls-bar">
        <label className="eq-toggle-label">
          <span>{t('settings.eqEnabled')}</span>
          <label className="toggle-switch" style={{ marginLeft: 8 }}>
            <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
            <span className="toggle-track" />
          </label>
        </label>

        <div className="eq-preset-row">
          <CustomSelect
            className="eq-preset-select"
            value={selectValue}
            onChange={v => applyPreset(v)}
            options={[
              ...(activePreset === null ? [{ value: '__custom__', label: t('settings.eqPresetCustom'), disabled: true }] : []),
              ...(isAutoEq ? [{ value: activePreset!, label: activePreset!, group: t('settings.eqPresetAutoEqGroup') }] : []),
              ...BUILTIN_PRESETS.map(p => ({ value: p.name, label: p.name, group: t('settings.eqPresetBuiltin') })),
              ...customPresets.map(p => ({ value: p.name, label: p.name, group: t('settings.eqPresetCustomGroup') })),
            ]}
          />

          {isCustomSaved && (
            <button className="eq-ctrl-btn" onClick={() => deleteCustomPreset(activePreset!)} data-tooltip={t('settings.eqDeletePreset')}>
              <Trash2 size={13} />
            </button>
          )}
          <button className="eq-ctrl-btn" onClick={() => applyPreset('Flat')} data-tooltip={t('settings.eqResetBands')}>
            <RotateCcw size={13} />
          </button>
          <button className="eq-ctrl-btn" onClick={() => setShowSave(v => !v)} data-tooltip={t('settings.eqSavePreset')}>
            <Save size={13} />
          </button>
        </div>
      </div>

      {showSave && (
        <div className="eq-save-row">
          <input
            type="text" className="input" placeholder={t('settings.eqPresetName')}
            value={saveName} onChange={e => setSaveName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSave()}
            autoFocus style={{ flex: 1, padding: '6px 12px', fontSize: 13 }}
          />
          <button className="btn btn-primary" onClick={handleSave} disabled={!saveName.trim()}>{t('common.save')}</button>
          <button className="btn btn-ghost" onClick={() => { setShowSave(false); setSaveName(''); }}>{t('common.cancel')}</button>
        </div>
      )}

      <AutoEqSection />

      {/* EQ panel */}
      <div className={`eq-panel ${!enabled ? 'eq-panel--off' : ''}`}>
        {/* Frequency response */}
        <canvas ref={canvasRef} className="eq-canvas" />

        {/* Fader area */}
        <div className="eq-faders">
          {/* dB scale */}
          <div className="eq-db-scale">
            {[12, 6, 0, -6, -12].map(db => (
              <span key={db} className="eq-db-tick">
                {db > 0 ? `+${db}` : db}
              </span>
            ))}
          </div>

          {/* Bands */}
          {EQ_BANDS.map((band, i) => (
            <div key={band.freq} className="eq-band">
              <span className="eq-gain-val">
                {gains[i] > 0 ? '+' : ''}{gains[i].toFixed(1)}
              </span>
              <div className="eq-fader-track">
                <div className="eq-zero-mark" />
                <VerticalFader
                  value={gains[i]}
                  disabled={!enabled}
                  onChange={v => setBandGain(i, v)}
                />
              </div>
              <span className="eq-freq-label">{band.label}</span>
            </div>
          ))}
        </div>

        {/* Pre-gain row */}
        <div className="eq-pregain-row">
          <span className="eq-pregain-label">{t('settings.eqPreGain')}</span>
          <input
            type="range"
            className="eq-pregain-slider"
            min={-30} max={6} step={0.1}
            value={preGain}
            disabled={!enabled}
            onChange={e => setPreGain(parseFloat(e.target.value))}
          />
          <span className="eq-pregain-val">
            {preGain > 0 ? '+' : ''}{preGain.toFixed(1)} dB
          </span>
          {preGain !== 0 && (
            <button className="eq-ctrl-btn" onClick={() => setPreGain(0)} data-tooltip={t('settings.eqResetPreGain')} style={{ marginLeft: 4 }}>
              <RotateCcw size={11} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
