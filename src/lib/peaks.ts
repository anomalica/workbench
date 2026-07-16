// Reading the ingester's `sources/{hash}.peaks.json` sidecar.
//
// Online there is no ffmpeg to cut a waveform window on demand, so the whole
// file's peaks arrive once (one byte per bin, ~100/sec) and the window is sliced
// out of them here. Locally the backend still cuts the window with ffmpeg - see
// backend/waveform.py.

export type PeaksSidecar = {
  schema: string;
  hex_hash: string;
  bins_per_second: number;
  duration: number;
  peaks: string;
};

/** One byte per bin, base64 -> amplitudes in [0, 1]. */
export function decodePeaks(encoded: string): Float32Array {
  const raw = atob(encoded);
  const out = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i) / 255;
  return out;
}

/** Peaks span the WHOLE media by construction (the sidecar decodes the whole
 *  file), so a bin's position is its fraction of the array - which is why
 *  `mediaDuration` below is the media element's own duration and not the
 *  sidecar's declared one. */
export function sliceWindow(
  peaks: Float32Array,
  mediaDuration: number,
  windowStart: number,
  windowDuration: number,
  outBins: number,
): number[] {
  if (outBins <= 0) return [];
  if (peaks.length === 0 || mediaDuration <= 0 || windowDuration <= 0) {
    return new Array(outBins).fill(0);
  }
  const binsPerSecond = peaks.length / mediaDuration;
  const out: number[] = new Array(outBins);
  for (let i = 0; i < outBins; i++) {
    // The source range this output bin covers. Re-reduce by MAX, never by mean:
    // averaging here would undo the whole point of a peak reduction and flatten
    // the onsets the reviewer is aiming at.
    const t0 = windowStart + (i / outBins) * windowDuration;
    const t1 = windowStart + ((i + 1) / outBins) * windowDuration;
    let lo = Math.floor(t0 * binsPerSecond);
    let hi = Math.ceil(t1 * binsPerSecond);
    lo = Math.max(0, Math.min(peaks.length, lo));
    hi = Math.max(0, Math.min(peaks.length, hi));
    if (hi <= lo) {
      // Zoomed in past the source resolution, or outside the media: sample the
      // nearest bin rather than drawing a false gap in the middle of audio.
      out[i] = lo < peaks.length && t0 >= 0 && t0 <= mediaDuration ? peaks[lo] : 0;
      continue;
    }
    let m = 0;
    for (let j = lo; j < hi; j++) if (peaks[j] > m) m = peaks[j];
    out[i] = m;
  }
  return out;
}

/** A sidecar whose declared duration disagrees materially with the media the
 *  reviewer is actually playing. The peaks still render correctly (they are
 *  mapped onto the media's duration), but a mismatch means the sidecar's header
 *  is wrong and worth surfacing rather than silently papering over. */
export function declaredDurationIsSuspect(
  sidecar: Pick<PeaksSidecar, "duration">,
  mediaDuration: number,
  toleranceSeconds = 0.5,
): boolean {
  if (!mediaDuration || !sidecar.duration) return false;
  return Math.abs(sidecar.duration - mediaDuration) > toleranceSeconds;
}
