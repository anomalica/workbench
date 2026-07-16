import { describe, it, expect } from "vitest";
import { decodePeaks, sliceWindow, declaredDurationIsSuspect } from "./peaks";

/** Base64 of one byte per bin, matching anomalica_common.peaks.encode_peaks. */
function encode(values: number[]): string {
  return btoa(String.fromCharCode(...values.map((v) => Math.round(v * 255))));
}

describe("decodePeaks", () => {
  it("reads one byte per bin back to [0, 1]", () => {
    const got = decodePeaks(encode([0, 0.5, 1]));
    expect(got.length).toBe(3);
    expect(got[0]).toBe(0);
    expect(got[1]).toBeCloseTo(0.5, 2);
    expect(got[2]).toBe(1);
  });

  it("round-trips the python encoder's output", () => {
    // AAB//w== is bytes [0, 0, 127, 255] - the shape encode_peaks emits.
    const got = decodePeaks("AAB//w==");
    expect(Array.from(got).map((v) => Math.round(v * 255))).toEqual([0, 0, 127, 255]);
  });
});

describe("sliceWindow", () => {
  // 10s of audio at 100 bins/sec, silent except a spike at t=5.00s.
  const mediaDuration = 10;
  const peaks = new Float32Array(1000);
  peaks[500] = 1;

  it("puts a spike at the same time it occupies in the media", () => {
    const out = sliceWindow(peaks, mediaDuration, 4, 2, 200); // [4s, 6s) over 200 bins
    const peakBin = out.indexOf(Math.max(...out));
    // t=5s is halfway through a [4,6) window -> the middle output bin.
    expect(Math.abs(peakBin - 100)).toBeLessThanOrEqual(1);
    expect(Math.max(...out)).toBe(1);
  });

  it("maps against the SPAN it is given, not an assumed bins-per-second", () => {
    // The anti-drift property. Same peaks, but they span 20s: the spike at bin
    // 500 of 1000 is then at t=10s, not t=5s. A consumer hardcoding 100 bins/sec
    // would look for it at 5s and find silence.
    const out = sliceWindow(peaks, 20, 9, 2, 200); // window [9s, 11s)
    expect(Math.max(...out)).toBe(1);
    const atFive = sliceWindow(peaks, 20, 4, 2, 200);
    expect(Math.max(...atFive)).toBe(0);
  });

  it("a rounded span misplaces a late onset - why the sidecar's exact duration wins", () => {
    // YouTube reports whole seconds: 4685 for a 4684.89s source. The caller must
    // pass the sidecar's exact span, not the player's, or a spike near the end
    // lands adrift. 100 bins/sec over 4684.89s, spike at the very last second.
    const n = Math.round(4684.89 * 100);
    const long = new Float32Array(n);
    const spikeAt = 4684.0; // seconds
    long[Math.floor(spikeAt * 100)] = 1;

    // Exact span: the spike is found in a tight window around 4684.0s.
    const exact = sliceWindow(long, 4684.89, 4683.9, 0.2, 20);
    expect(Math.max(...exact)).toBe(1);

    // Rounded span (the YT-reported number): the same window now misses it.
    const rounded = sliceWindow(long, 4685, 4683.9, 0.2, 20);
    expect(Math.max(...rounded)).toBe(0);
  });

  it("re-reduces by MAX so a zoomed-out window keeps its onsets", () => {
    // 100 source bins per output bin; the lone spike must survive, not be
    // averaged into invisibility (1/100th would render as silence).
    const out = sliceWindow(peaks, mediaDuration, 0, 10, 10);
    expect(Math.max(...out)).toBe(1);
  });

  it("samples the nearest bin when zoomed past the source resolution", () => {
    // A 10ms window over 20 output bins asks for finer detail than exists.
    const out = sliceWindow(peaks, mediaDuration, 5.0, 0.01, 20);
    expect(out.length).toBe(20);
    expect(Math.max(...out)).toBe(1); // no false gap across real audio
  });

  it("reads silence outside the media rather than wrapping", () => {
    const out = sliceWindow(peaks, mediaDuration, 20, 2, 50);
    expect(Math.max(...out)).toBe(0);
  });

  it("clamps a window that straddles the start", () => {
    const out = sliceWindow(peaks, mediaDuration, -1, 2, 50);
    expect(out.length).toBe(50);
    expect(out.every((v) => v >= 0)).toBe(true);
  });

  it("degrades to a flat line rather than throwing on empty/zero input", () => {
    expect(sliceWindow(new Float32Array(0), 10, 0, 6, 5)).toEqual([0, 0, 0, 0, 0]);
    expect(sliceWindow(peaks, 0, 0, 6, 5)).toEqual([0, 0, 0, 0, 0]);
    expect(sliceWindow(peaks, 10, 0, 0, 5)).toEqual([0, 0, 0, 0, 0]);
    expect(sliceWindow(peaks, 10, 0, 6, 0)).toEqual([]);
  });
});

describe("declaredDurationIsSuspect", () => {
  it("flags the drift bug that shipped (declared 469 vs real 470.04)", () => {
    expect(declaredDurationIsSuspect({ duration: 469 }, 470.04)).toBe(true);
    // The worst live case: 29.5s out.
    expect(declaredDurationIsSuspect({ duration: 3312 }, 3341.49)).toBe(true);
  });

  it("tolerates the sub-bin difference between a container and its decode", () => {
    // ffprobe says 470.0438, the decoded PCM covers 470.037 - 7ms, well under a bin.
    expect(declaredDurationIsSuspect({ duration: 470.037 }, 470.0438)).toBe(false);
  });

  it("says nothing when either duration is unknown", () => {
    expect(declaredDurationIsSuspect({ duration: 0 }, 470)).toBe(false);
    expect(declaredDurationIsSuspect({ duration: 470 }, 0)).toBe(false);
  });
});
