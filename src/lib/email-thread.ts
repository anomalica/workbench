/**
 * Email thread segments: turning a `message:` annotation into an attributed
 * header for the prose pane.
 *
 * An email is a CONVERSATION, not prose. Without a per-message header each
 * message runs into the next and a quoted reply reads as the sender's own words
 * - on the Podesta record that means Bob Fish's text is attributed to John
 * Podesta, which is a factual misattribution in a research archive, not a
 * cosmetic one.
 *
 * The annotation is an inline flow mapping the ingester writes:
 *
 *   <!-- message: {n: 1, from: "John Podesta <john.podesta@gmail.com>",
 *        date: 2015-03-05T18:38:14-05:00, quoted: false} -->
 *
 * Lives here rather than inside IngestViewer.svelte because it is parsing, not
 * rendering: the two faults this module was extracted to fix (a comma-truncated
 * date and unescaped interpolation) both shipped precisely because the logic sat
 * in a component where no unit test could reach it.
 */

import yaml from "js-yaml";

export interface EmailMessage {
  /** Sender with the address stripped - the display name alone. */
  who: string;
  /** The date as it should be SHOWN: an ISO timestamp reduced to its date, any
   *  other attribution left verbatim. Empty when the annotation carries none. */
  when: string;
  quoted: boolean;
}

/** The inner text of a `message: { ... }` annotation, or null if it is not one.
 *  Accepts the annotation body with the comment fences already stripped. */
export function messageInner(annotation: string): string | null {
  const m = annotation.trim().match(/^message:\s*\{([\s\S]*)\}$/);
  return m ? m[1] : null;
}

/** The annotation's flow mapping, parsed as the YAML it is.
 *
 *  Parsed with a real parser rather than read with a regex, because the grammar
 *  is not ours to track by hand. Three faults came from hand-reading it, each
 *  invisible rather than loud:
 *
 *  - A QUOTED value owns its commas: `date: "Mar 5, 2015 6:08 PM"` was captured
 *    as "Mar 5" by a pattern that merely excluded commas.
 *  - An unanchored key matches inside another token, so a lookup could return a
 *    different field's value - or a display name containing `quoted: true` could
 *    forge the flag that says whose words these are.
 *  - A quoted scalar can carry ESCAPES. The ingester emits `>` as `\x3e` so a
 *    display name containing `-->` cannot close the HTML comment early; only a
 *    real parser turns that back into the sender's actual name, and a reader
 *    that does not would show `\x3e` to the reviewer.
 *
 *  CORE_SCHEMA, not the default: the default resolves an ISO timestamp to a JS
 *  Date, which has no timezone and normalises to UTC - a message sent
 *  2015-03-05T22:30-05:00 would then DISPLAY as 2015-03-06, moving a message to
 *  the wrong day. Keeping it a string preserves the date as the sender saw it.
 *  (Python's PyYAML keeps tzinfo and does not have this trap; this one is JS's.)
 *
 *  Returns {} for a malformed annotation - a bad mapping must not break the
 *  whole record's render. */
export function parseMapping(inner: string): Record<string, unknown> {
  try {
    const doc = yaml.load(`{${inner}}`, { schema: yaml.CORE_SCHEMA });
    return doc && typeof doc === "object" && !Array.isArray(doc)
      ? (doc as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** One field as text, or "" when the annotation does not carry it. */
export function field(inner: string, key: string): string {
  const v = parseMapping(inner)[key];
  return v === undefined || v === null ? "" : String(v);
}

/** An ISO timestamp shows as its date; anything else shows verbatim.
 *  Slicing to ten characters unconditionally was written for ISO input and
 *  mangles a human-written attribution. */
export function displayDate(raw: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : raw;
}

/** The display name: every `<...>` run removed, not just the first. The address
 *  is one such run, but a display name can carry more, and this text reaches the
 *  DOM through {@html}. */
export function senderName(from: string): string {
  return from.replace(/\s*<[^>]*>/g, "").trim();
}

export function parseMessage(inner: string): EmailMessage {
  const m = parseMapping(inner);
  return {
    who: senderName(m.from == null ? "" : String(m.from)) || "Unknown sender",
    // Read as a FIELD, not as a substring search: `/quoted:\s*true/` over the
    // whole string is true for a sender called `quoted: true` as readily as for
    // the real flag, which would mark a first-hand message as someone else's
    // words.
    quoted: m.quoted === true,
    when: displayDate(m.date == null ? "" : String(m.date)),
  };
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

/** The attributed header for one message. Every interpolated value is escaped:
 *  record bodies are ingested third-party email, never trusted markup. */
export function messageHeaderHtml(msg: EmailMessage): string {
  return (
    `\n\n<div class="email-msg${msg.quoted ? " email-msg-quoted" : ""}">` +
    `<span class="email-from">${escapeHtml(msg.who)}</span>` +
    (msg.when ? `<span class="email-when">${escapeHtml(msg.when)}</span>` : "") +
    (msg.quoted ? `<span class="email-quoted">quoted reply</span>` : "") +
    `</div>\n\n`
  );
}
