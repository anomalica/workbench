import yaml from "js-yaml";

// Ingest annotations that locate text are useful in the source, not as raw
// markup in the reading view. Kindle's first import predates the underscore
// convention, so its two source-only fields also need hiding here.
const LEGACY_KINDLE_FIELDS = new Set(["kindle_position", "element_id"]);
// Exclusion is not an ordinary hidden point: stripping only its marker would
// leave prose that the marker says to exclude. Keep it visible until the
// reading view implements the paired-region semantics.
const SOURCE_ONLY_INLINE = /\{\{_(?!irrelevant\b)[A-Za-z][\w-]*:\s*[^{}\n]*\}\}/g;
const SOURCE_ONLY_COMMENT_FIELD = /^\s*(?:_[A-Za-z][\w-]*|kindle_position|element_id)\s*:/m;

export function stripSourceOnlyInline(body: string): string {
  return body.replace(SOURCE_ONLY_INLINE, "");
}

function visibleFields(value: unknown, topLevel = false): unknown {
  if (Array.isArray(value)) return value.map((part) => visibleFields(part));
  if (!value || typeof value !== "object") return value;

  const fields: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if ((key.startsWith("_") && key !== "_irrelevant") ||
      (topLevel && LEGACY_KINDLE_FIELDS.has(key))) continue;
    fields[key] = visibleFields(entry);
  }
  return fields;
}

/** The part of an HTML-comment annotation the reading view may show. Other
 *  consumers still read the original body, including the hidden coordinates.
 *  Leave malformed/unrecognised comments visible so a reviewer can spot them. */
export function visibleAnnotationContent(content: string): string {
  const original = content.trim();
  if (!SOURCE_ONLY_COMMENT_FIELD.test(original)) return original;

  try {
    const parsed = yaml.load(original);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return original;
    const visible = visibleFields(parsed, true) as Record<string, unknown>;
    return Object.keys(visible).length ? yaml.dump(visible, { lineWidth: -1 }).trim() : "";
  } catch {
    return original;
  }
}
