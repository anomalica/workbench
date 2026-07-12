"""Waveform peaks for the timestamp editor.

The editor shows a few seconds of audio around the word being retimed so the
reviewer can drag a timestamp onto the sound's onset. Rather than decode a
(possibly multi-hour) media file in the browser, the backend asks ffmpeg for
just the window and downsamples it to a small peak array. See the endpoint
`/api/sources/{hash}/waveform` in server.py.
"""

from __future__ import annotations

import struct


def pcm_peaks(pcm: bytes, bins: int) -> list[float]:
    """Downsample signed 16-bit little-endian mono PCM into `bins` peak values in
    [0, 1] - the max absolute amplitude in each equal slice. Short/empty input
    yields zeros, so a silent or missing window still renders a flat line rather
    than erroring."""
    if bins <= 0:
        return []
    n = len(pcm) // 2
    if n == 0:
        return [0.0] * bins
    samples = struct.unpack(f"<{n}h", pcm[: n * 2])
    peaks: list[float] = []
    for b in range(bins):
        lo = (b * n) // bins
        hi = ((b + 1) * n) // bins
        if hi <= lo:
            peaks.append(0.0)
            continue
        m = 0
        for i in range(lo, hi):
            a = samples[i]
            if a < 0:
                a = -a
            if a > m:
                m = a
        peaks.append(m / 32768.0)
    return peaks
