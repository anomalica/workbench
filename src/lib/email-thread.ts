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

/** Every top-level `key: value` pair of the flow mapping.
 *
 *  Scanned rather than matched with a per-key regex, because a regex for one key
 *  cannot tell where a value ends. Two ways that bit:
 *
 *  - A QUOTED value owns its commas. The ingester writes
 *    `date: "Mar 5, 2015 6:08 PM"` when it could not parse the source
 *    attribution into a timestamp, and a pattern excluding commas captured
 *    "Mar 5" - a date with no year.
 *  - An unanchored key matches INSIDE another token. `date:` occurs within a
 *    hypothetical `update:` or `sentdate:`, and within any quoted value that
 *    happens to contain the text - so the lookup could silently return another
 *    field's value, misattributing a date in an archive whose entire purpose is
 *    correct attribution.
 *
 *  Text inside quotes is never read as structure, so a key only counts when it
 *  is a key. Flow sequences (`refs: [a, b]`) are not part of this annotation's
 *  grammar and would split on their inner commas. */
export function fields(inner: string): Record<string, string> {
  const out: Record<string, string> = {};
  const n = inner.length;
  let i = 0;
  while (i < n) {
    while (i < n && (inner[i] === "," || /\s/.test(inner[i]))) i++;
    const keyStart = i;
    while (i < n && inner[i] !== ":" && inner[i] !== ",") i++;
    if (i >= n || inner[i] !== ":") break; // malformed - stop, keep what parsed
    const key = inner.slice(keyStart, i).trim();
    i++;
    while (i < n && /\s/.test(inner[i])) i++;
    let value: string;
    if (inner[i] === '"') {
      const start = ++i;
      while (i < n && inner[i] !== '"') i++;
      value = inner.slice(start, i);
      i++; // past the closing quote
      while (i < n && inner[i] !== ",") i++; // ignore trailing junk
    } else {
      const start = i;
      while (i < n && inner[i] !== ",") i++;
      value = inner.slice(start, i).trim();
    }
    if (key) out[key] = value;
  }
  return out;
}

/** One field out of the flow mapping, or "" when it carries none. */
export function field(inner: string, key: string): string {
  return fields(inner)[key] ?? "";
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
  const f = fields(inner);
  return {
    who: senderName(f.from ?? "") || "Unknown sender",
    // Read as a FIELD, not as a substring search: `/quoted:\s*true/` over the
    // whole string is true for a sender called `quoted: true` as readily as for
    // the real flag, which would mark a first-hand message as someone else's
    // words.
    quoted: (f.quoted ?? "").trim() === "true",
    when: displayDate(f.date ?? ""),
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
