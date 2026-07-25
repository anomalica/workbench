import { describe, expect, it } from "vitest";
import {
  displayDate,
  field,
  fields,
  messageHeaderHtml,
  messageInner,
  parseMessage,
  senderName,
} from "./email-thread";

// The two annotations the ingester actually wrote for the Podesta record
// (ingests/store/8205b049...md), verbatim - one machine-parsed ISO timestamp,
// one attribution it could only carry as written.
const PODESTA =
  'message: {n: 1, from: "John Podesta <john.podesta@gmail.com>", date: 2015-03-05T18:38:14-05:00, quoted: false}';
const FISH =
  'message: {n: 2, from: "Bob Fish <robertbfish@earthlink.net>", date: "Mar 5, 2015 6:08 PM", quoted: true}';

describe("messageInner", () => {
  it("accepts a message annotation and rejects anything else", () => {
    expect(messageInner(PODESTA)).toContain("from:");
    expect(messageInner("image:\n  file: abc123def456.jpg")).toBeNull();
    expect(messageInner("file_page: 12")).toBeNull();
  });
});

describe("field: a quoted value survives its own commas", () => {
  it("does NOT truncate a quoted date at the first comma", () => {
    // The reported fault: a class excluding commas captured "Mar 5" out of
    // "Mar 5, 2015 6:08 PM", so the reader saw a date with no year.
    expect(field(messageInner(FISH)!, "date")).toBe("Mar 5, 2015 6:08 PM");
  });

  it("still reads an unquoted scalar, stopping at the comma that ends it", () => {
    expect(field(messageInner(PODESTA)!, "date")).toBe("2015-03-05T18:38:14-05:00");
  });

  it("reads a quoted sender containing a comma", () => {
    const inner = messageInner('message: {from: "Fish, Bob <b@x.invalid>", quoted: false}')!;
    expect(field(inner, "from")).toBe("Fish, Bob <b@x.invalid>");
  });

  it("is empty for a field the annotation does not carry", () => {
    expect(field(messageInner(PODESTA)!, "subject")).toBe("");
  });

  it("reads the last field, which ends at the closing brace not a comma", () => {
    expect(field(messageInner(PODESTA)!, "quoted")).toBe("false");
  });
});

describe("displayDate", () => {
  it("reduces an ISO timestamp to its date", () => {
    expect(displayDate("2015-03-05T18:38:14-05:00")).toBe("2015-03-05");
  });

  it("leaves a human-written attribution intact", () => {
    // slice(0, 10) was written for ISO input; on this it produced "Mar 5, 201".
    expect(displayDate("Mar 5, 2015 6:08 PM")).toBe("Mar 5, 2015 6:08 PM");
  });

  it("passes an empty date through", () => {
    expect(displayDate("")).toBe("");
  });
});

describe("senderName", () => {
  it("strips the address, keeping the display name", () => {
    expect(senderName("John Podesta <john.podesta@gmail.com>")).toBe("John Podesta");
  });

  it("strips EVERY angle-bracket run, not just the first", () => {
    // Without the /g flag the second run survived into {@html} output.
    expect(senderName("a <b@x.invalid> <img src=x onerror=alert(1)>")).toBe("a");
  });
});

describe("parseMessage", () => {
  it("reads the sender, date and quoted flag of a first-hand message", () => {
    expect(parseMessage(messageInner(PODESTA)!)).toEqual({
      who: "John Podesta",
      when: "2015-03-05",
      quoted: false,
    });
  });

  it("reads a quoted reply, keeping its unparsed date whole", () => {
    expect(parseMessage(messageInner(FISH)!)).toEqual({
      who: "Bob Fish",
      when: "Mar 5, 2015 6:08 PM",
      quoted: true,
    });
  });

  it("names an unattributed message rather than rendering a blank", () => {
    expect(parseMessage("n: 3").who).toBe("Unknown sender");
  });
});

describe("messageHeaderHtml", () => {
  it("attributes the message and marks a quoted reply", () => {
    const html = messageHeaderHtml(parseMessage(messageInner(FISH)!));
    expect(html).toContain('class="email-msg email-msg-quoted"');
    expect(html).toContain(">Bob Fish<");
    expect(html).toContain(">Mar 5, 2015 6:08 PM<");
    expect(html).toContain("quoted reply");
  });

  it("does not mark a first-hand message as quoted", () => {
    const html = messageHeaderHtml(parseMessage(messageInner(PODESTA)!));
    expect(html).toContain('class="email-msg"');
    expect(html).not.toContain("quoted reply");
  });

  it("omits the date span entirely when there is no date", () => {
    expect(messageHeaderHtml({ who: "A", when: "", quoted: false })).not.toContain("email-when");
  });

  it("escapes the sender - record bodies are ingested third-party email", () => {
    // This reaches the DOM through {@html}, so an unescaped name is an
    // injection, not just a rendering glitch.
    const html = messageHeaderHtml({
      who: '<img src=x onerror=alert(1)> & "co"',
      when: "",
      quoted: false,
    });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).toContain("&amp;");
    expect(html).toContain("&quot;");
  });

  it("escapes the date too", () => {
    const html = messageHeaderHtml({ who: "A", when: "<script>x</script>", quoted: false });
    expect(html).not.toContain("<script>");
  });
});

describe("a key only counts where it is a key", () => {
  it("does not read `date` out of a longer key", () => {
    // Unanchored matching found `date:` inside `update:`, so the lookup returned
    // another field's value. Latent until the ingester adds such a field.
    const inner = 'update: "2020-01-01", date: "Mar 5, 2015 6:08 PM"';
    expect(field(inner, "date")).toBe("Mar 5, 2015 6:08 PM");
  });

  it("does not read a key out of quoted text", () => {
    // A crafted display name must not be able to supply the date. Escaping
    // makes it inert, but a wrong date is still a misattribution.
    const inner =
      'from: "Bob date: Jan 1 1999 Fish <b@x.invalid>", date: 2015-03-05T18:38:14-05:00';
    expect(field(inner, "date")).toBe("2015-03-05T18:38:14-05:00");
    expect(parseMessage(inner).when).toBe("2015-03-05");
  });

  it("does not let a crafted sender forge the quoted flag", () => {
    const inner = 'from: "quoted: true <b@x.invalid>", quoted: false';
    expect(parseMessage(inner).quoted).toBe(false);
  });

  it("splits every field of the real annotation", () => {
    expect(fields(messageInner(FISH)!)).toEqual({
      n: "2",
      from: "Bob Fish <robertbfish@earthlink.net>",
      date: "Mar 5, 2015 6:08 PM",
      quoted: "true",
    });
  });

  it("keeps what parsed when the mapping is malformed", () => {
    expect(fields('from: "A", garbage')).toEqual({ from: "A" });
    expect(fields("")).toEqual({});
  });
});
