/**
 * What a record IS, as distinct from what file arrived.
 *
 * `source_type` conflated the two: video/audio/web/pdf/image describe the FILE,
 * ebook/document describe the thing. So one book read as `ebook` when it came as
 * EPUB and `pdf` when it came as PDF, and a briefing slide read as `image` -
 * true of the JPEG, useless about the document.
 *
 * The list below is what the UI OFFERS, not a closed vocabulary. The format
 * calls `document_type` an open set and names values this list does not carry
 * (`memo`, `statute`, `affidavit`), so refusing everything else would put the
 * workbench at odds with the spec and with records already written. Offering a
 * list gets the common case in one click without a typo; permitting a value
 * outside it keeps the field able to name a form nobody listed yet.
 *
 * ABSENCE IS A REAL STATE AND THE COMMON ONE. The format emits the field only
 * where the artefact STATES its own form - RFC822 headers, a page headed
 * MEMORANDUM FOR RECORD - and leaves it absent otherwise, because a value
 * guessed from appearance "returns a fluent value indistinguishable from a
 * correct one". Roughly half the corpus is deliberately blank. So a missing
 * type is an invitation to a reviewer, never a fault to flag.
 */

export const DOCUMENT_TYPES = [
  "book",
  "paper",
  "report",
  "article",
  "letter",
  "email",
  "statement",
  "form",
  "transcript",
  "slide",
  "interview",
  "documentary",
  "podcast",
  "lecture",
  "broadcast",
  "recording",
] as const;

export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export function isDocumentType(value: string | undefined | null): value is DocumentType {
  return !!value && (DOCUMENT_TYPES as readonly string[]).includes(value);
}

/**
 * What to show as the record's type, and whether it is trustworthy.
 *
 * `missing` is the ordinary state for about half the corpus, not a fault. The
 * caller shows it as something a reviewer can fill in, never as an error.
 *
 * `source_type` is NOT used as a fallback: it answers a different question and
 * is shown in its own slot.
 */
export function recordType(frontmatter: { document_type?: string | null }): {
  label: string;
  known: boolean;
  missing: boolean;
} {
  const declared = (frontmatter.document_type ?? "").trim();
  if (declared) {
    return { label: declared, known: isDocumentType(declared), missing: false };
  }
  // Deliberately NOT falling back to source_type. That field says how the
  // source reached us - pdf, video, web - and putting it in the type slot
  // reads as "this record is classified" when nobody has said what it is.
  // How it arrived is shown separately, which is where that fact belongs.
  return { label: "", known: false, missing: true };
}

/**
 * How a type reads to a human.
 *
 * The list and the filter chips each grew their own version of this, so the same
 * record read `PDF` in one place and `Pdf` in the other. Only the acronyms need
 * saying; everything else is a plain word and capitalises the ordinary way.
 */
const TYPE_LABELS: Record<string, string> = { pdf: "PDF" };

export function typeLabel(value: string | undefined | null): string {
  const v = (value ?? "").trim();
  if (!v) return "";
  return TYPE_LABELS[v.toLowerCase()] ?? v.charAt(0).toUpperCase() + v.slice(1);
}
