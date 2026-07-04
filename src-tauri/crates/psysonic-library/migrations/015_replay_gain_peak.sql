-- ReplayGain track peak for anti-clipping bind (OpenSubsonic replayGain.trackPeak).
ALTER TABLE track ADD COLUMN replay_gain_peak REAL;
