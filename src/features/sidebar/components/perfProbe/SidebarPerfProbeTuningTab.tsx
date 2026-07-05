import PerfCoverThreadsControl from '@/features/sidebar/components/perfProbe/PerfCoverThreadsControl';

export default function SidebarPerfProbeTuningTab() {
  return (
    <div className="perf-tuning">
      <p className="sidebar-perf-modal__hint perf-tuning__hint">
        Live runtime knobs for experiments — not persisted in Settings. Values reset on restart unless noted.
      </p>
      <PerfCoverThreadsControl />
    </div>
  );
}
