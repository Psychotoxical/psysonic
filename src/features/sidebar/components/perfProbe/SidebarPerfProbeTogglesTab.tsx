import { useState, type CSSProperties } from 'react';
import { ChevronRight } from 'lucide-react';
import { setPerfProbeFlag, type PerfProbeFlags } from '@/lib/perf/perfFlags';
import type { PerfToggleEngineLeaf, PerfToggleLeaf, PerfToggleNode } from '@/lib/perf/perfProbeToggleTree';
import {
  isPerfToggleEngineLeaf,
  isPerfToggleGroup,
  PERF_PROBE_TOGGLE_TREE,
} from '@/lib/perf/perfProbeToggleTree';

interface EngineProps {
  hotCacheEnabled: boolean;
  setHotCacheEnabled: (v: boolean) => void;
  normalizationEngine: string;
  setNormalizationEngine: (v: 'off' | 'loudness') => void;
  loggingMode: string;
  setLoggingMode: (v: 'off' | 'normal') => void;
}

interface Props extends EngineProps {
  perfFlags: PerfProbeFlags;
}

function ToggleLeaf({
  node,
  perfFlags,
  engineProps,
}: {
  node: PerfToggleLeaf | PerfToggleEngineLeaf;
  perfFlags: PerfProbeFlags;
  engineProps: EngineProps;
}) {
  if (isPerfToggleEngineLeaf(node)) {
    const checked = node.engine === 'hotCache'
      ? !engineProps.hotCacheEnabled
      : node.engine === 'normalization'
        ? engineProps.normalizationEngine === 'off'
        : engineProps.loggingMode === 'off';
    return (
      <label className="perf-tree-leaf">
        <input
          type="checkbox"
          checked={checked}
          onChange={e => {
            if (node.engine === 'hotCache') engineProps.setHotCacheEnabled(!e.target.checked);
            else if (node.engine === 'normalization') {
              engineProps.setNormalizationEngine(e.target.checked ? 'off' : 'loudness');
            } else engineProps.setLoggingMode(e.target.checked ? 'off' : 'normal');
          }}
        />
        <span className="perf-tree-leaf__text">
          <span className="perf-tree-leaf__label">{node.label}</span>
          {node.description && (
            <span className="perf-tree-leaf__desc">{node.description}</span>
          )}
        </span>
      </label>
    );
  }

  if ('flag' in node) {
    return (
      <label className="perf-tree-leaf">
        <input
          type="checkbox"
          checked={perfFlags[node.flag]}
          onChange={e => setPerfProbeFlag(node.flag, e.target.checked)}
        />
        <span className="perf-tree-leaf__text">
          <span className="perf-tree-leaf__label">{node.label}</span>
          {node.description && (
            <span className="perf-tree-leaf__desc">{node.description}</span>
          )}
        </span>
      </label>
    );
  }

  return null;
}

function ToggleTreeNode({
  node,
  depth,
  perfFlags,
  engineProps,
}: {
  node: PerfToggleNode;
  depth: number;
  perfFlags: PerfProbeFlags;
  engineProps: EngineProps;
}) {
  const [open, setOpen] = useState(depth < 1);

  if (isPerfToggleGroup(node)) {
    return (
      <div className="perf-tree-group" style={{ '--perf-tree-depth': depth } as CSSProperties}>
        <button
          type="button"
          className="perf-tree-group__head"
          onClick={() => setOpen(v => !v)}
          aria-expanded={open}
        >
          <ChevronRight size={14} className={`perf-tree-group__chevron${open ? ' perf-tree-group__chevron--open' : ''}`} />
          <span>{node.label}</span>
        </button>
        {open && (
          <div className="perf-tree-group__body">
            {node.children.map(child => (
              <ToggleTreeNode
                key={child.id}
                node={child}
                depth={depth + 1}
                perfFlags={perfFlags}
                engineProps={engineProps}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="perf-tree-leaf-wrap" style={{ '--perf-tree-depth': depth } as CSSProperties}>
      <ToggleLeaf node={node} perfFlags={perfFlags} engineProps={engineProps} />
    </div>
  );
}

export default function SidebarPerfProbeTogglesTab({
  perfFlags,
  hotCacheEnabled,
  setHotCacheEnabled,
  normalizationEngine,
  setNormalizationEngine,
  loggingMode,
  setLoggingMode,
}: Props) {
  const engineProps: EngineProps = {
    hotCacheEnabled,
    setHotCacheEnabled,
    normalizationEngine,
    setNormalizationEngine,
    loggingMode,
    setLoggingMode,
  };

  return (
    <div className="perf-toggle-tree">
      <p className="sidebar-perf-modal__hint perf-toggle-tree__hint">
        Disable subsystems one at a time to estimate their UI cost. Changes apply immediately.
      </p>
      {PERF_PROBE_TOGGLE_TREE.map(group => (
        <ToggleTreeNode
          key={group.id}
          node={group}
          depth={0}
          perfFlags={perfFlags}
          engineProps={engineProps}
        />
      ))}
    </div>
  );
}
