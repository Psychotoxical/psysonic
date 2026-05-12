import type { LoudnessLufsPreset } from '../../store/authStoreTypes';

const LOUDNESS_LUFS_BUTTON_ORDER: LoudnessLufsPreset[] = [-10, -12, -14, -16];

export function LoudnessLufsButtonGroup(props: {
  value: LoudnessLufsPreset;
  onSelect: (v: LoudnessLufsPreset) => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', flexWrap: 'wrap' }}>
      {LOUDNESS_LUFS_BUTTON_ORDER.map(v => (
        <button
          key={v}
          type="button"
          className={`btn ${props.value === v ? 'btn-primary' : 'btn-ghost'}`}
          style={{ fontSize: 12, padding: '3px 12px' }}
          onClick={() => props.onSelect(v)}
        >
          {v}
        </button>
      ))}
    </div>
  );
}
