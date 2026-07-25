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

/** One field out of the flow mapping.
 *
 *  A QUOTED value is taken whole, before the bare-scalar fallback. The ingester
 *  writes `date: "Mar 5, 2015 6:08 PM"` when the source attribution could not be
 *  parsed into a timestamp, and a pattern that merely excludes commas truncates
 *  that to "Mar 5". Only an UNQUOTED scalar ends at a comma or the closing
 *  brace. */
export function field(inner: string, key: string): string {
  const m = inner.match(new RegExp(`${key}:\\s*(?:"([^"]*)"|([^,}]+))`));
  return m ? (m[1] ?? m[2] ?? "").trim() : "";
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
  return {
    who: senderName(field(inner, "from")) || "Unknown sender",
    when: displayDate(field(inner, "date")),
    quoted: /quoted:\s*true/.test(inner),
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
