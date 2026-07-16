"""Waveform peaks for the timestamp editor.

The editor shows a few seconds of audio around the word being retimed so the
reviewer can drag a timestamp onto the sound's onset. Rather than decode a
(possibly multi-hour) media file in the browser, the peaks are reduced from PCM
to a small per-bin array.

The REDUCTION itself lives in `anomalica_common.peaks`, single-sourced: the
ingester bakes `sources/{hash}.peaks.json` at archive time with the same code, and
a drift between the two would be invisible - the waveform would simply stop
matching the audio, and every timestamp aligned against it would be wrong.

What stays here is the LOCAL delivery path: `/api/sources/{hash}/waveform` asks
ffmpeg for just the requested window (fast seek), which is instant whatever the
file's length. Online there is no ffmpeg, so the browser reads the ingester's
precomputed sidecar instead and slices the window out of it.
"""

from __future__ import annotations

from anomalica_common.peaks import pcm_peaks

__all__ = ["pcm_peaks"]
