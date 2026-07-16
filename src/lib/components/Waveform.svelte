<script lang="ts">
  import { untrack } from "svelte";
  import { STATIC_READS } from "$lib/api";
  import { decodePeaks, sliceWindow, type PeaksSidecar } from "$lib/peaks";
  import { resolvePeaksUrl } from "$lib/source-address";

  // A windowed waveform for the timestamp editor: peaks for [windowStart,
  // windowStart+windowDuration], word-timestamp markers drawn on top and
  // draggable to retime, plus a playhead. Coordinates are a fixed 1000x100 SVG
  // viewBox stretched to the container, so drawing needs no pixel width.
  //
  // Where the peaks come from differs by deployment. LOCALLY the backend cuts the
  // window with ffmpeg (fast seek - instant at any file length). ONLINE there is
  // no ffmpeg, so the ingester's whole-file sidecar is fetched once per record
  // and the window is sliced from it; after that first fetch, panning and zooming
  // need no network at all.
  let {
    hash,
    windowStart,
    windowDuration,
    mediaDuration = 0,
    copyrightStatus = null,
    marks,
    currentTime = 0,
    onretime,
    onseek,
  }: {
    hash: string;
    windowStart: number;
    windowDuration: number;
    /** Decides whether the peaks sidecar is openly addressable - peaks follow the
     *  transcript's visibility, not the original file's. */
    copyrightStatus?: string | null;
    /** The media element's OWN duration. Online this maps the sidecar's peaks
     *  onto the timeline: peaks span the whole file by construction, so this is
     *  authoritative where the sidecar's declared duration may not be. */
    mediaDuration?: number;
    /** The word timestamps to mark, each with its row index for the retime
     *  callback. `start` is absolute seconds. */
    marks: { index: number; start: number; label: string; active: boolean }[];
    currentTime?: number;
    onretime: (index: number, start: number) => void;
    onseek: (t: number) => void;
  } = $props();

  const BINS = 500;
  const H = 100;

  let peaks = $state<number[]>([]);
  let loading = $state(true);
  let failed = $state(false);
  let svgEl = $state<SVGSVGElement>();
  let dragIndex = $state<number | null>(null);

  // The whole-file sidecar, kept per record so panning/zooming online costs no
  // network after the first window. Module-scoped: remounting the editor on the
  // same record should not refetch ~60KB-750KB.
  let fullPeaks: Float32Array | null = null;
  let fullPeaksHash = "";

  // Fetch peaks whenever the window changes (record load / different selection),
  // NOT while dragging - the window is stable during an edit.
  $effect(() => {
    const h = hash;
    const s = windowStart;
    const d = windowDuration;
    const md = mediaDuration;
    untrack(() => void loadPeaks(h, s, d, md));
  });

  async function loadPeaks(h: string, s: number, d: number, md: number) {
    loading = true;
    failed = false;
    try {
      peaks = STATIC_READS ? await staticPeaks(h, s, d, md) : await windowedPeaks(h, s, d);
    } catch {
      failed = true;
      peaks = [];
    } finally {
      loading = false;
    }
  }

  /** Local: ffmpeg cuts exactly the window asked for. */
  async function windowedPeaks(h: string, s: number, d: number): Promise<number[]> {
    const res = await fetch(
      `/api/sources/${h}/waveform?start=${s.toFixed(3)}&duration=${d.toFixed(3)}&bins=${BINS}`,
    );
    if (!res.ok) throw new Error(String(res.status));
    return (await res.json()).peaks ?? [];
  }

  /** Online: slice the window out of the ingester's whole-file sidecar. */
  async function staticPeaks(h: string, s: number, d: number, md: number): Promise<number[]> {
    if (fullPeaksHash !== h || !fullPeaks) {
      const url = resolvePeaksUrl(h, copyrightStatus);
      if (!url) throw new Error("peaks not addressable");
      const res = await fetch(url);
      if (!res.ok) throw new Error(String(res.status));
      const sidecar: PeaksSidecar = await res.json();
      fullPeaks = decodePeaks(sidecar.peaks);
      fullPeaksHash = h;
    }
    // Map onto the MEDIA's duration, not the sidecar's declared one: the peaks
    // span the whole file, and the player knows its own length even when a
    // sidecar header is wrong.
    return sliceWindow(fullPeaks, md || 0, s, d, BINS);
  }

  /** Time -> x in the 0..1000 viewBox space (clamped to the window). */
  function timeToX(t: number): number {
    const f = (t - windowStart) / windowDuration;
    return Math.max(0, Math.min(1, f)) * 1000;
  }
  function xToTime(clientX: number): number {
    if (!svgEl) return windowStart;
    const r = svgEl.getBoundingClientRect();
    const f = r.width > 0 ? (clientX - r.left) / r.width : 0;
    return windowStart + Math.max(0, Math.min(1, f)) * windowDuration;
  }

  let barWidth = $derived(peaks.length ? 1000 / peaks.length : 0);

  function onMarkerDown(e: PointerEvent, index: number) {
    e.preventDefault();
    e.stopPropagation();
    dragIndex = index;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: PointerEvent) {
    if (dragIndex === null) return;
    onretime(dragIndex, xToTime(e.clientX));
  }
  function onPointerUp() {
    dragIndex = null;
  }

  // Click on the waveform body (not a marker) seeks there.
  function onBodyClick(e: MouseEvent) {
    if (dragIndex !== null) return;
    onseek(xToTime(e.clientX));
  }
</script>

<div class="w-full select-none">
  <div class="relative h-16 rounded bg-surface border border-border overflow-hidden">
    {#if loading}
      <div class="absolute inset-0 grid place-items-center text-xs text-on-surface-muted">Loading waveform…</div>
    {:else if failed}
      <div class="absolute inset-0 grid place-items-center text-xs text-on-surface-muted">Waveform unavailable</div>
    {/if}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <svg
      bind:this={svgEl}
      viewBox="0 0 1000 {H}"
      preserveAspectRatio="none"
      class="w-full h-full block cursor-crosshair"
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
      onclick={onBodyClick}
    >
      <!-- Peak bars, mirrored around the centre line. -->
      {#each peaks as p, i}
        {@const h = Math.max(1, p * (H - 6))}
        <rect
          x={i * barWidth}
          y={(H - h) / 2}
          width={Math.max(0.5, barWidth * 0.8)}
          height={h}
          class="fill-primary/45"
        />
      {/each}

      <!-- Word-timestamp markers: a vertical line + a grab handle at the top. -->
      {#each marks as m (m.index)}
        {@const x = timeToX(m.start)}
        <line x1={x} y1="0" x2={x} y2={H} stroke-width={dragIndex === m.index ? 3 : 1.5}
          class={m.active ? "stroke-warning" : "stroke-on-surface/70"} />
        <rect
          x={x - 6} y="0" width="12" height={H}
          class="fill-transparent cursor-ew-resize"
          onpointerdown={(e) => onMarkerDown(e, m.index)}
          role="slider"
          aria-label={`Timestamp for "${m.label}"`}
          aria-valuenow={m.start}
          tabindex="-1"
        />
        <rect x={x - 3} y="0" width="6" height="7"
          class={m.active ? "fill-warning" : "fill-on-surface/70"} />
      {/each}

      <!-- Playhead. -->
      {#if currentTime >= windowStart && currentTime <= windowStart + windowDuration}
        <line x1={timeToX(currentTime)} y1="0" x2={timeToX(currentTime)} y2={H}
          class="stroke-success" stroke-width="2" />
      {/if}
    </svg>
  </div>
</div>
