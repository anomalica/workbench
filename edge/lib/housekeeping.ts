/**
 * Applying an approved housekeeping proposal, at the edge.
 *
 * A FAITHFUL PORT of `apply_items` in
 * anomalica-common/src/anomalica_common/llm/../housekeeping.py. That is a
 * liability, not a design preference: this is a second implementation of the one
 * function that guarantees housekeeping never touches body prose, and it exists
 * only because production has no Python - the deployed workbench is a static SPA
 * plus this Deno edge, so the local FastAPI route cannot serve it.
 *
 * The Python test cases are ported alongside in main_test.ts. If you change
 * either implementation, change both and run both suites.
 *
 * See anomalica/architecture/housekeeping.md and housekeeping-format.md.
 */

export type HousekeepingOperation = "set" | "clear" | "move";
export type HousekeepingStatus = "proposed" | "approved" | "rejected";
/** Must move with anomalica_common.housekeeping.ALGORITHM_VERSION. */
export const HOUSEKEEPING_ALGORITHM_VERSION = "1";

export interface HousekeepingV1Item {
  id: string;
  check: string;
  field: string;
  to_field?: string;
  operation: HousekeepingOperation;
  current: unknown;
  proposed: unknown;
  confidence: string;
  evidence: { reasoning: string; sources?: string[]; record_spans?: string[] };
  status: HousekeepingStatus;
  /** Items that must be approved alongside this one, or it destroys data. */
  depends_on?: string[];
}

export interface TokenOccurrence {
  start_byte: number;
  end_byte: number;
}

export interface HousekeepingV2Item {
  id: string;
  check: string;
  operation: "replace-token";
  scope: "body";
  old_token: string;
  new_token: string;
  case_sensitive: true;
  token_boundary: "ascii-word";
  occurrences: TokenOccurrence[];
  expected_count: number;
  confidence: string;
  evidence: { reasoning: string; sources?: string[]; record_spans?: string[] };
  status: HousekeepingStatus;
}

/** Kept as the v1 name for callers shared with the original frontmatter format. */
export type HousekeepingItem = HousekeepingV1Item;
export type AnyHousekeepingItem = HousekeepingV1Item | HousekeepingV2Item;

/**
 * Approved ids whose prerequisites are not also approved.
 *
 * Enforced, not advisory: the dependent case exists because applying it alone
 * destroys data - setting date_published without the move that frees it
 * overwrites the upload date instead of relocating it.
 */
export function unmetDependencies(items: HousekeepingV1Item[], approved: Set<string>): string[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const bad: string[] = [];
  for (const id of approved) {
    const item = byId.get(id);
    if (!item) continue;
    if ((item.depends_on ?? []).some((d) => !approved.has(d))) bad.push(id);
  }
  return bad.sort();
}

export interface HousekeepingSidecar {
  schema: string;
  content_hash: string;
  checked_at: string;
  checker_version?: number;
  input_sha256?: string;
  algorithm_version?: string;
  outcome?: string;
  usage?: unknown;
  items: AnyHousekeepingItem[];
}

export class BodyChanged extends Error {}
export class ApplyConflict extends Error {}

export interface ApplyResult {
  text: string;
  applied: HousekeepingV1Item[];
  didNotApply: { item: HousekeepingV1Item; reason: string }[];
}

/**
 * Whether the record still looks the way this item assumed.
 *
 * This is what makes an item a PATCH rather than a field-name replacement. A
 * patch carries its context and fails to apply when the context is gone; a
 * name-keyed replacement has nothing to fail against, so it overwrites whatever
 * is there now - including an edit made after the proposal was written.
 *
 * Compares the VALUE, not the raw line: the corpus quotes inconsistently and a
 * proposal must not fail merely because a value is written 'x' rather than "x".
 */
function matches(lines: string[], item: HousekeepingV1Item): { ok: boolean; reason: string } {
  const span = fieldSpan(lines, item.field);
  const present = span ? lines[span[0]] : null;
  const unquote = (v: string) => v.replace(/^['"]+|['"]+$/g, "");
  if (item.current === null || item.current === undefined) {
    if (present !== null) {
      return { ok: false, reason: `${item.field} now exists; expected absent` };
    }
    return { ok: true, reason: "" };
  }
  if (present === null) {
    return {
      ok: false,
      reason: `${item.field} is gone; expected ${item.current}`,
    };
  }
  const idx = present.indexOf(":");
  const value = idx >= 0 ? present.slice(idx + 1).trim() : "";
  if (unquote(value) !== unquote(String(item.current))) {
    return {
      ok: false,
      reason: `${item.field} is now ${value}; expected ${item.current}`,
    };
  }
  return { ok: true, reason: "" };
}
export class MultilineField extends Error {}

const FIELD_LINE = /^([A-Za-z_][A-Za-z0-9_]*):(.*)$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Same shape the edge already uses to split a record (main.ts). */
const FRONTMATTER = /^(---(\r\n|\n))([\s\S]*?)(\r\n|\n)---((?:\r\n|\n)|$)([\s\S]*)$/;

/**
 * Digest of everything after the frontmatter fence.
 *
 * Deliberately does NOT reuse splitRecord. The guard compares a record before and
 * after, and a guard sharing its parser with the code it guards is cancelled out
 * by a fault in that parser: a mis-split corrupts both sides identically and the
 * comparison passes. This does its own minimal match so the two disagree when
 * anything is wrong.
 */
export async function bodyDigest(text: string): Promise<string> {
  const stripped = text.replace(/^---(?:\r\n|\n)[\s\S]*?(?:\r\n|\n)---(?:\r\n|\n|$)/, "");
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stripped));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function splitRecord(text: string): {
  frontmatter: string;
  body: string;
  newline: string;
  closingNewline: string;
} | null {
  const m = text.match(FRONTMATTER);
  if (!m) return null;
  return { frontmatter: m[3], body: m[6], newline: m[2], closingNewline: m[5] };
}

/**
 * Render a proposed value the way the corpus writes it.
 *
 * A full ISO date goes bare so it parses as a date. Everything else is quoted -
 * including a reduced-precision date like "1967", which must stay a string:
 * ingest-format makes precision the evidence marker, and a bare 1967 parses as an
 * integer.
 */
export function scalar(value: unknown): string {
  const v = String(value);
  if (ISO_DATE.test(v)) return v;
  return '"' + v.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

export function previewItem(
  original: string,
  item: AnyHousekeepingItem,
): { removed: string[]; added: string[] } {
  if (item.operation === "replace-token") {
    return { removed: [item.old_token], added: [item.new_token] };
  }
  const split = splitRecord(original);
  const lines = split ? split.frontmatter.split(split.newline) : [];
  const span = fieldSpan(lines, item.field);
  const existing = span ? lines[span[0]] : null;
  if (item.operation === "clear") {
    return { removed: existing ? [existing] : [], added: [] };
  }
  const field = item.operation === "move" ? item.to_field : item.field;
  return {
    removed: existing ? [existing] : [],
    added: [`${field}: ${scalar(item.proposed)}`],
  };
}

/** [start, end) of `name:` and any continuation lines, or null if absent. */
function fieldSpan(lines: string[], name: string): [number, number] | null {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(FIELD_LINE);
    if (!m || m[1] !== name) continue;
    let j = i + 1;
    while (j < lines.length && /^[ \t-]/.test(lines[j]) && lines[j].trim() !== "") j++;
    return [i, j];
  }
  return null;
}

/**
 * The record text with the APPROVED items applied to its frontmatter.
 *
 * Splices individual lines. It deliberately does NOT parse the YAML and
 * re-serialise: a no-op round-trip rewrites 200 of the 288 records in the store -
 * it re-quotes every string and turns `date_accessed: 2026-07-18T13:13:13+00:00`
 * into `2026-07-18 13:13:13+00:00`, dropping the ISO `T`. That buries the one
 * approved change in a whole-frontmatter diff and silently reformats timestamps
 * nobody agreed to touch. Splicing leaves every unapproved byte identical, so the
 * commit diff IS the approved items.
 */
export async function applyItems(original: string, items: HousekeepingV1Item[]): Promise<string> {
  return (await applyPatch(original, items)).text;
}

export async function applyPatch(
  original: string,
  items: HousekeepingV1Item[],
): Promise<ApplyResult> {
  const split = splitRecord(original);
  if (!split) throw new BodyChanged("no parseable frontmatter");
  const lines = split.frontmatter.split(split.newline);
  const applied: HousekeepingV1Item[] = [];
  const didNotApply: { item: HousekeepingV1Item; reason: string }[] = [];

  for (const item of items) {
    if (item.status !== "approved") continue;
    const m = matches(lines, item);
    if (!m.ok) {
      throw new ApplyConflict(`${item.id}: ${m.reason}`);
    }
    applied.push(item);
    const span = fieldSpan(lines, item.field);
    if (span && span[1] - span[0] > 1) {
      throw new MultilineField(`${item.id}: ${item.field} spans lines`);
    }

    if (item.operation === "set") {
      const line = `${item.field}: ${scalar(item.proposed)}`;
      if (span) lines[span[0]] = line;
      else lines.push(line);
    } else if (item.operation === "clear") {
      if (span) lines.splice(span[0], span[1] - span[0]);
    } else if (item.operation === "move") {
      if (!item.to_field) throw new Error(`${item.id}: move without to_field`);
      const line = `${item.to_field}: ${scalar(item.proposed)}`;
      const dest = fieldSpan(lines, item.to_field);
      if (dest) {
        throw new ApplyConflict(`${item.id}: destination ${item.to_field} already exists`);
      }
      if (span) {
        lines[span[0]] = line;
      } else {
        lines.push(line);
      }
    } else {
      throw new Error(`${item.id}: unknown operation ${item.operation}`);
    }
  }

  const updated =
    "---" +
    split.newline +
    lines.join(split.newline) +
    split.newline +
    "---" +
    split.closingNewline +
    split.body;
  if ((await bodyDigest(updated)) !== (await bodyDigest(original))) {
    throw new BodyChanged("body changed during a frontmatter-only apply");
  }
  return { text: updated, applied, didNotApply };
}

const V2_KEYS = [
  "id",
  "check",
  "operation",
  "scope",
  "old_token",
  "new_token",
  "case_sensitive",
  "token_boundary",
  "occurrences",
  "expected_count",
  "confidence",
  "evidence",
  "status",
].sort();
const ASCII_WORD_TOKEN = /^[A-Za-z0-9_]+$/;
const isAsciiWordByte = (byte: number | undefined) =>
  byte !== undefined &&
  ((byte >= 48 && byte <= 57) ||
    (byte >= 65 && byte <= 90) ||
    byte === 95 ||
    (byte >= 97 && byte <= 122));

export class InvalidReplacement extends Error {}

const SIDECAR_V2_REQUIRED = [
  "schema",
  "content_hash",
  "input_sha256",
  "checked_at",
  "algorithm_version",
  "outcome",
  "items",
].sort();
const FRONTMATTER_COMMON = [
  "id",
  "check",
  "field",
  "operation",
  "current",
  "proposed",
  "confidence",
  "evidence",
  "status",
];
const FULL_SHA = /^sha256:[a-f0-9]{64}$/;
const ALGORITHM_VERSION = /^[A-Za-z0-9._-]+$/;
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function exactKeys(value: object, required: string[], optional: string[] = []): boolean {
  const keys = Object.keys(value).sort();
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function validEvidence(value: unknown): boolean {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const evidence = value as Record<string, unknown>;
  return (
    exactKeys(evidence, ["reasoning"], ["sources", "record_spans"]) &&
    typeof evidence.reasoning === "string" &&
    evidence.reasoning.trim().length > 0 &&
    (evidence.sources === undefined ||
      (Array.isArray(evidence.sources) && evidence.sources.every((v) => typeof v === "string"))) &&
    (evidence.record_spans === undefined ||
      (Array.isArray(evidence.record_spans) &&
        evidence.record_spans.every((v) => typeof v === "string")))
  );
}

/** Strict structural validation before a v2 sidecar can be decided or applied. */
export function validateV2Sidecar(sidecar: HousekeepingSidecar): boolean {
  if (
    !exactKeys(sidecar, SIDECAR_V2_REQUIRED, ["usage"]) ||
    sidecar.schema !== "anomalica/housekeeping/2" ||
    !FULL_SHA.test(sidecar.content_hash) ||
    !FULL_SHA.test(sidecar.input_sha256 ?? "") ||
    typeof sidecar.checked_at !== "string" ||
    !sidecar.checked_at ||
    !ALGORITHM_VERSION.test(sidecar.algorithm_version ?? "") ||
    sidecar.outcome !== "completed" ||
    !Array.isArray(sidecar.items)
  )
    return false;

  const ids = new Set<string>();
  return sidecar.items.every((item) => {
    if (
      item == null ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      typeof item.id !== "string" ||
      !item.id ||
      typeof item.check !== "string" ||
      !item.check ||
      !["high", "medium", "low"].includes(item.confidence) ||
      !["proposed", "approved", "rejected"].includes(item.status) ||
      !validEvidence(item.evidence)
    )
      return false;
    if (ids.has(item.id)) return false;
    ids.add(item.id);
    if (item.operation === "replace-token") {
      if (
        !exactKeys(item, V2_KEYS) ||
        item.scope !== "body" ||
        item.case_sensitive !== true ||
        item.token_boundary !== "ascii-word" ||
        !ASCII_WORD_TOKEN.test(item.old_token) ||
        !ASCII_WORD_TOKEN.test(item.new_token) ||
        item.old_token === item.new_token ||
        !Number.isSafeInteger(item.expected_count) ||
        item.expected_count <= 0 ||
        !Array.isArray(item.occurrences) ||
        item.expected_count !== item.occurrences.length
      )
        return false;
      let previousEnd = -1;
      for (const occurrence of item.occurrences) {
        if (
          occurrence == null ||
          typeof occurrence !== "object" ||
          Array.isArray(occurrence) ||
          !exactKeys(occurrence, ["start_byte", "end_byte"]) ||
          !Number.isSafeInteger(occurrence.start_byte) ||
          !Number.isSafeInteger(occurrence.end_byte) ||
          occurrence.start_byte < 0 ||
          occurrence.end_byte <= occurrence.start_byte ||
          occurrence.start_byte < previousEnd
        )
          return false;
        previousEnd = occurrence.end_byte;
      }
      return true;
    }
    if (!["set", "clear", "move"].includes(item.operation)) return false;
    const required =
      item.operation === "move" ? [...FRONTMATTER_COMMON, "to_field"] : FRONTMATTER_COMMON;
    if (!exactKeys(item, required, ["depends_on"])) return false;
    if (typeof item.field !== "string" || !FIELD_NAME.test(item.field)) {
      return false;
    }
    if (
      item.operation === "move" &&
      (typeof item.to_field !== "string" ||
        !FIELD_NAME.test(item.to_field) ||
        item.to_field === item.field)
    )
      return false;
    return (
      item.depends_on === undefined ||
      (Array.isArray(item.depends_on) &&
        item.depends_on.every((v) => typeof v === "string" && v.length > 0))
    );
  });
}

/** Validate and apply exact v2 byte spans without altering any other byte. */
export function applyTokenReplacements(original: string, items: HousekeepingV2Item[]): string {
  const bytes = new TextEncoder().encode(original);
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const frontmatter = original.match(/^---(?:\r\n|\n)[\s\S]*?(?:\r\n|\n)---(?:\r\n|\n|$)/);
  if (!frontmatter) {
    throw new InvalidReplacement("record has no parseable frontmatter");
  }
  const bodyStart = new TextEncoder().encode(frontmatter[0]).length;

  const allSpans: { start: number; end: number; replacement: Uint8Array }[] = [];
  for (const item of items) {
    if (JSON.stringify(Object.keys(item).sort()) !== JSON.stringify(V2_KEYS)) {
      throw new InvalidReplacement(`${item.id ?? "item"}: invalid item shape`);
    }
    const evidence = item.evidence;
    if (
      typeof item.id !== "string" ||
      !item.id ||
      typeof item.check !== "string" ||
      !item.check ||
      item.operation !== "replace-token" ||
      item.scope !== "body" ||
      item.case_sensitive !== true ||
      item.token_boundary !== "ascii-word" ||
      !ASCII_WORD_TOKEN.test(item.old_token) ||
      !ASCII_WORD_TOKEN.test(item.new_token) ||
      item.old_token === item.new_token ||
      item.status !== "proposed" ||
      !["high", "medium", "low"].includes(item.confidence) ||
      evidence == null ||
      typeof evidence !== "object" ||
      Array.isArray(evidence) ||
      typeof evidence.reasoning !== "string" ||
      !evidence.reasoning.trim() ||
      (evidence.sources !== undefined &&
        (!Array.isArray(evidence.sources) ||
          evidence.sources.some((value) => typeof value !== "string"))) ||
      (evidence.record_spans !== undefined &&
        (!Array.isArray(evidence.record_spans) ||
          evidence.record_spans.some((value) => typeof value !== "string"))) ||
      !Array.isArray(item.occurrences) ||
      !Number.isSafeInteger(item.expected_count) ||
      item.expected_count <= 0
    ) {
      throw new InvalidReplacement(`${item.id ?? "item"}: invalid replacement`);
    }

    const oldBytes = new TextEncoder().encode(item.old_token);
    const newBytes = new TextEncoder().encode(item.new_token);
    const matches: TokenOccurrence[] = [];
    for (let start = bodyStart; start <= bytes.length - oldBytes.length; start++) {
      if (!oldBytes.every((byte, i) => bytes[start + i] === byte)) continue;
      const end = start + oldBytes.length;
      if (!isAsciiWordByte(bytes[start - 1]) && !isAsciiWordByte(bytes[end])) {
        matches.push({ start_byte: start, end_byte: end });
      }
    }
    if (
      item.expected_count !== item.occurrences.length ||
      item.expected_count !== matches.length ||
      item.occurrences.some(
        (span, index) =>
          JSON.stringify(Object.keys(span).sort()) !== JSON.stringify(["end_byte", "start_byte"]) ||
          span.start_byte !== matches[index].start_byte ||
          span.end_byte !== matches[index].end_byte,
      )
    ) {
      throw new InvalidReplacement(`${item.id}: occurrences are not the complete body match set`);
    }
    for (const span of item.occurrences) {
      if (
        !Number.isSafeInteger(span.start_byte) ||
        !Number.isSafeInteger(span.end_byte) ||
        span.start_byte < bodyStart ||
        span.end_byte <= span.start_byte ||
        span.end_byte > bytes.length
      ) {
        throw new InvalidReplacement(`${item.id}: invalid occurrence span`);
      }
      allSpans.push({
        start: span.start_byte,
        end: span.end_byte,
        replacement: newBytes,
      });
    }
  }

  allSpans.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < allSpans.length; i++) {
    if (allSpans[i].start <= allSpans[i - 1].start || allSpans[i].start < allSpans[i - 1].end) {
      throw new InvalidReplacement("replacement spans are duplicate, unordered, or overlapping");
    }
  }
  let output = bytes;
  for (const span of allSpans.toReversed()) {
    const next = new Uint8Array(output.length - (span.end - span.start) + span.replacement.length);
    next.set(output.subarray(0, span.start));
    next.set(span.replacement, span.start);
    next.set(output.subarray(span.end), span.start + span.replacement.length);
    output = next;
  }
  let sourceCursor = 0;
  let outputCursor = 0;
  const equal = (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((byte, index) => byte === b[index]);
  for (const span of allSpans) {
    const unchangedLength = span.start - sourceCursor;
    if (
      !equal(
        bytes.subarray(sourceCursor, span.start),
        output.subarray(outputCursor, outputCursor + unchangedLength),
      )
    ) {
      throw new InvalidReplacement("bytes outside replacement spans changed");
    }
    outputCursor += unchangedLength;
    if (
      !equal(
        span.replacement,
        output.subarray(outputCursor, outputCursor + span.replacement.length),
      )
    ) {
      throw new InvalidReplacement("replacement postcondition failed");
    }
    outputCursor += span.replacement.length;
    sourceCursor = span.end;
  }
  if (!equal(bytes.subarray(sourceCursor), output.subarray(outputCursor))) {
    throw new InvalidReplacement("bytes outside replacement spans changed");
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(output);
}
