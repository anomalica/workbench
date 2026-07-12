#!/usr/bin/env python3
"""pcm_peaks: downsample 16-bit mono PCM to per-bin peak amplitudes in [0, 1]."""

import struct

from backend.waveform import pcm_peaks


def _pcm(samples):
    return struct.pack(f"<{len(samples)}h", *samples)


def test_empty_input_yields_zeros():
    assert pcm_peaks(b"", 4) == [0.0, 0.0, 0.0, 0.0]


def test_zero_bins():
    assert pcm_peaks(_pcm([1, 2, 3]), 0) == []


def test_peak_is_max_abs_per_bin():
    # Two bins over four samples: bin0 = max(|100|,|−200|), bin1 = max(|300|,|−50|).
    peaks = pcm_peaks(_pcm([100, -200, 300, -50]), 2)
    assert peaks[0] == 200 / 32768.0
    assert peaks[1] == 300 / 32768.0


def test_full_scale_normalises_near_one():
    peaks = pcm_peaks(_pcm([32767, -32768]), 1)
    assert 0.99 < peaks[0] <= 1.0


def test_more_bins_than_samples_pads_with_zeros():
    peaks = pcm_peaks(_pcm([1000, 2000]), 5)
    assert len(peaks) == 5
    # Empty bins read 0; at least one non-empty bin carries a peak.
    assert any(p > 0 for p in peaks)
    assert all(p >= 0 for p in peaks)
