// Where a record's archived ORIGINAL file lives, and how to reach it.
//
// Two deployments, two answers. Locally the backend proxies every source through
// /api/sources/<hash>. Online there is no such route - the edge serves static
// objects only - so the file is addressed directly in the CDN zone.

export type SourceAddress =
  | { kind: "stream"; url: string } // point a media element at it; let it range-request
  | { kind: "fetch"; url: string } // pull into a blob, then render
  | { kind: "none" }; // nothing addressable from here

export type SourceAddressInput = {
  staticReads: boolean;
  sourceKey: string;
  archivedExt?: string | null;
  copyrightStatus?: string | null;
  isMedia: boolean;
};

// Only public_domain originals sit in the OPEN zone. Every other status -
// open_licence and publicly_accessible included - lives in the token-auth gated
// zone, where an unsigned URL returns 404 (probed, not assumed: the one
// publicly_accessible PDF 404s while a public_domain one serves 206). Those
// records reach a reviewer through the possession gate's signed URL instead, so
// asking directly only produces a broken fetch and an error panel.
const OPEN_ZONE_STATUS = "public_domain";

// PEAKS ARE NOT THE FILE. A waveform sidecar is in the same disclosure class as
// the TRANSCRIPT - which Mark opened for publicly_accessible in 75519a4 - not the
// same class as the original bytes. His ruling (2026-07-17): "open the peaks up
// for publicly_accessible, same reasoning as the transcripts" - the sources are
// already publicly accessible and ours are just more accurate transcripts; peaks
// are a weaker derivative still, carrying 100 amplitudes/sec, no words, and no
// way to reconstruct the audio.
//
// So peaks and originals DELIBERATELY DIVERGE for publicly_accessible: the .opus
// stays gated, its peaks are open. That is the decision, not an inconsistency to
// reconcile - do not "fix" it by routing peaks through resolveSourceAddress.
// licensed/restricted (the copyrighted books) and any unknown/absent status stay
// gated, same fail-closed allow-list as the snapshot.
const PEAKS_OPEN_STATUSES = new Set(["public_domain", "open_licence", "publicly_accessible"]);

/** The peaks sidecar's URL, or null where it is not openly addressable. */
export function resolvePeaksUrl(sourceKey: string, copyrightStatus?: string | null): string | null {
  if (!sourceKey) return null;
  if (!copyrightStatus || !PEAKS_OPEN_STATUSES.has(copyrightStatus)) return null;
  return `/sources/${sourceKey}.peaks.json`;
}

export function resolveSourceAddress(input: SourceAddressInput): SourceAddress {
  const { staticReads, sourceKey, archivedExt, copyrightStatus, isMedia } = input;
  if (!sourceKey) return { kind: "none" };

  if (!staticReads) return { kind: "fetch", url: `/api/sources/${sourceKey}` };

  // The extension is NOT derivable: codec/container describe the stream, the
  // extension is a property of the file (76 records say `container: ogg` yet are
  // stored .opus). It comes from the record's `archived_ext`, stamped by the
  // ingester at archive time. Do NOT reconcile it with `source_file` - that is
  // the ORIGINAL filename and may legitimately disagree (record-format.md:74).
  if (!archivedExt) return { kind: "none" };
  if (copyrightStatus !== OPEN_ZONE_STATUS) return { kind: "none" };

  const url = `/sources/${sourceKey}.${archivedExt}`;
  // Audio/video stream rather than download: pulling a 167MB opus into a blob
  // merely to press play is absurd online. Trade-off: a streamed ogg/opus seeks
  // to a page boundary (~150ms off) where a downloaded blob is exact - fine for
  // listening, and why precise timestamp alignment stays a local job for now.
  return isMedia ? { kind: "stream", url } : { kind: "fetch", url };
}
