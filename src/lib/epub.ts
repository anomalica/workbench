/**
 * Minimal EPUB parser for source-side preview in the workbench.
 *
 * Goal: extract enough from an EPUB to let a reviewer scroll through
 * the original chapters and visually compare against the ingested
 * markdown. Not a full reader. No pagination, no CFIs, no scripted
 * content support.
 *
 * Threat model: the EPUB is untrusted. We parse it in JS, inline its
 * resources as data URIs into self-contained chapter HTML strings,
 * and the consumer renders each chapter inside a fully-locked-down
 * iframe (sandbox="" with srcdoc). No same-origin, no scripts, no
 * cookie access, no cross-frame messaging. A malicious EPUB cannot
 * reach our origin.
 *
 * Defence in depth: this parser also strips <script>, on* attributes,
 * javascript: URLs, and rewrites every external resource reference
 * to a data URI it controls. If srcdoc sandboxing fails for any
 * reason, the chapter HTML on its own is already neutralised.
 */
import { BlobReader, ZipReader, type Entry, type FileEntry } from "@zip.js/zip.js";

function isFileEntry(e: Entry): e is FileEntry {
  return !e.directory;
}

export interface EpubChapter {
  /** OPF manifest id for the spine item. */
  id: string;
  /** Title from the navigation document, if present. */
  title: string | null;
  /** Self-contained HTML with images and CSS inlined as data URIs. */
  html: string;
}

export interface ParsedEpub {
  chapters: EpubChapter[];
}

/** Flatten a parsed EPUB into a single self-contained HTML document.
 *
 *  Each chapter's <body> content is appended into one combined body,
 *  separated by a chapter heading and a horizontal rule. Style blocks
 *  from every chapter's <head> are collected and emitted into a single
 *  <head>. Images and CSS are already data URIs (done at parse time),
 *  so the result is fully self-contained: it renders correctly inside
 *  a sandbox="" iframe with srcdoc, no network requests.
 *
 *  This is the EPUB analogue of the "single_file" snapshot used for
 *  web records - one HTML document, one scroll surface, no nested
 *  iframes per chapter.
 */
export function flattenEpubToHtml(parsed: ParsedEpub): string {
  const parser = new DOMParser();
  const styles: string[] = [];
  const bodies: string[] = [];

  parsed.chapters.forEach((chapter, index) => {
    let doc: Document;
    try {
      doc = parser.parseFromString(chapter.html, "application/xhtml+xml");
      // XHTML parser sets documentElement.tagName to 'parsererror' on failure
      if (doc.querySelector("parsererror")) {
        doc = parser.parseFromString(chapter.html, "text/html");
      }
    } catch {
      doc = parser.parseFromString(chapter.html, "text/html");
    }

    for (const style of Array.from(doc.querySelectorAll("head style"))) {
      styles.push(style.textContent || "");
    }

    // Normalise EPUB3 pagebreak markers to id="page_{label}" anchors so the
    // sandboxed iframe can be jumped to a page by URL fragment. The label
    // priority mirrors the ingester's printed_page extraction exactly
    // (epub_extract._pagebreak_label: title, else the trailing number/roman
    // numeral of the id, else the element text), so fragments line up with
    // the record's printed_page values.
    if (doc.body) {
      walk(doc.body, (el) => {
        if (!isPagebreak(el)) return;
        const label = pagebreakLabel(el);
        if (label) el.id = `page_${label}`;
      });
    }

    const bodyContent = doc.body ? doc.body.innerHTML : chapter.html;
    const heading = chapter.title
      ? `<h2 class="epub-chapter-heading">${escapeHtml(chapter.title)}</h2>`
      : "";
    bodies.push(
      `<section class="epub-chapter" data-chapter-index="${index}">${heading}${bodyContent}</section>`,
    );
  });

  const combinedStyles = styles.join("\n");
  const builtinStyles = `
    body { margin: 0; padding: 2rem; max-width: 48rem; margin-left: auto; margin-right: auto;
      font-family: Georgia, serif; line-height: 1.6; color: #222; background: #fdfcf8; }
    .epub-chapter { padding-top: 2rem; }
    .epub-chapter + .epub-chapter { border-top: 1px solid #ddd; margin-top: 3rem; }
    .epub-chapter-heading { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.1em;
      color: #888; margin-bottom: 2rem; font-weight: normal; }
    img, svg { max-width: 100%; height: auto; display: block; margin: 1rem auto; }
  `;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${builtinStyles}</style><style>${combinedStyles}</style></head><body>${bodies.join("")}</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c] as string,
  );
}

export async function parseEpub(file: File): Promise<ParsedEpub> {
  const reader = new ZipReader(new BlobReader(file));
  try {
    const entries = await reader.getEntries();
    const byPath = new Map<string, FileEntry>();
    for (const e of entries) {
      if (isFileEntry(e)) byPath.set(normalisePath(e.filename), e);
    }

    const opfPath = await readOpfPath(byPath);
    const opfDir = dirname(opfPath);
    const opfXml = await readEntryText(byPath, opfPath);
    const opf = new DOMParser().parseFromString(opfXml, "application/xml");

    const manifest = parseManifest(opf, opfDir);
    const spineIds = parseSpine(opf);
    const titles = await readNavTitles(opf, manifest, byPath, opfDir);

    const chapters: EpubChapter[] = [];
    for (const id of spineIds) {
      const item = manifest.get(id);
      if (!item) continue;
      const xhtml = await readEntryText(byPath, item.href);
      const html = await inlineResources(xhtml, item.href, manifest, byPath);
      chapters.push({ id, title: titles.get(id) ?? null, html });
    }

    return { chapters };
  } finally {
    await reader.close();
  }
}

interface ManifestItem {
  /** Absolute path inside the zip. */
  href: string;
  mediaType: string;
}

async function readOpfPath(byPath: Map<string, FileEntry>): Promise<string> {
  const containerXml = await readEntryText(byPath, "META-INF/container.xml");
  const doc = new DOMParser().parseFromString(containerXml, "application/xml");
  const rootfile = doc.querySelector("rootfile[full-path]");
  const path = rootfile?.getAttribute("full-path");
  if (!path) throw new Error("EPUB has no rootfile in container.xml");
  return normalisePath(path);
}

function parseManifest(opf: Document, opfDir: string): Map<string, ManifestItem> {
  const map = new Map<string, ManifestItem>();
  for (const item of opf.querySelectorAll("manifest > item")) {
    const id = item.getAttribute("id");
    const href = item.getAttribute("href");
    const mediaType = item.getAttribute("media-type") ?? "application/octet-stream";
    if (!id || !href) continue;
    map.set(id, { href: resolvePath(opfDir, href), mediaType });
  }
  return map;
}

function parseSpine(opf: Document): string[] {
  const ids: string[] = [];
  for (const itemref of opf.querySelectorAll("spine > itemref")) {
    const idref = itemref.getAttribute("idref");
    if (idref) ids.push(idref);
  }
  return ids;
}

/** Read titles from the EPUB 3 nav document if present. EPUB 2 toc.ncx
 *  is also supported as a fallback - same idea, different element names. */
async function readNavTitles(
  opf: Document,
  manifest: Map<string, ManifestItem>,
  byPath: Map<string, FileEntry>,
  _opfDir: string,
): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  const hrefToId = new Map<string, string>();
  for (const [id, item] of manifest) hrefToId.set(item.href, id);

  // EPUB 3 nav document
  const navItem = Array.from(opf.querySelectorAll("manifest > item")).find((el) =>
    (el.getAttribute("properties") || "").split(/\s+/).includes("nav"),
  );
  if (navItem) {
    const navHref = navItem.getAttribute("href");
    const navId = navItem.getAttribute("id");
    if (navHref && navId) {
      const navAbs = manifest.get(navId)?.href;
      if (navAbs) {
        try {
          const navHtml = await readEntryText(byPath, navAbs);
          const navDoc = new DOMParser().parseFromString(navHtml, "application/xhtml+xml");
          collectNavTitles(navDoc, dirname(navAbs), hrefToId, titles);
          if (titles.size > 0) return titles;
        } catch {
          // fall through to NCX
        }
      }
    }
  }

  // EPUB 2 NCX fallback
  const ncxItem = Array.from(manifest.values()).find(
    (it) => it.mediaType === "application/x-dtbncx+xml",
  );
  if (ncxItem) {
    try {
      const ncxXml = await readEntryText(byPath, ncxItem.href);
      const ncxDoc = new DOMParser().parseFromString(ncxXml, "application/xml");
      for (const point of ncxDoc.querySelectorAll("navPoint")) {
        const label = point.querySelector("navLabel > text")?.textContent?.trim();
        const src = point.querySelector("content")?.getAttribute("src");
        if (!label || !src) continue;
        const target = resolvePath(dirname(ncxItem.href), stripFragment(src));
        const id = hrefToId.get(target);
        if (id && !titles.has(id)) titles.set(id, label);
      }
    } catch {
      // give up - titles are optional
    }
  }

  return titles;
}

function collectNavTitles(
  navDoc: Document,
  navDir: string,
  hrefToId: Map<string, string>,
  out: Map<string, string>,
) {
  for (const a of navDoc.querySelectorAll("nav a[href]")) {
    const label = a.textContent?.trim();
    const href = a.getAttribute("href");
    if (!label || !href) continue;
    const target = resolvePath(navDir, stripFragment(href));
    const id = hrefToId.get(target);
    if (id && !out.has(id)) out.set(id, label);
  }
}

/** Replace external resource references (img src, link href, style url())
 *  with data URIs read from the zip. Strip scripts and event handlers as
 *  defence in depth - the rendering iframe should already block them. */
async function inlineResources(
  xhtml: string,
  chapterHref: string,
  manifest: Map<string, ManifestItem>,
  byPath: Map<string, FileEntry>,
): Promise<string> {
  const doc = new DOMParser().parseFromString(xhtml, "application/xhtml+xml");
  const fallback = new DOMParser().parseFromString(xhtml, "text/html");
  const root = doc.documentElement?.tagName ? doc : fallback;
  const chapterDir = dirname(chapterHref);

  // Strip <script> and event handler attributes
  for (const s of Array.from(root.querySelectorAll("script"))) s.remove();
  walk(root.documentElement, (el) => {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.toLowerCase().startsWith("on")) el.removeAttribute(attr.name);
      if (attr.name.toLowerCase() === "href" && /^javascript:/i.test(attr.value)) {
        el.setAttribute("href", "#");
      }
    }
  });

  // Inline images
  for (const img of Array.from(root.querySelectorAll("img[src]"))) {
    const src = img.getAttribute("src")!;
    const dataUri = await fetchAsDataUri(src, chapterDir, manifest, byPath);
    if (dataUri) img.setAttribute("src", dataUri);
    else img.removeAttribute("src");
  }
  for (const image of Array.from(root.querySelectorAll("image[href], image"))) {
    const xlinkHref = image.getAttributeNS("http://www.w3.org/1999/xlink", "href");
    const href = image.getAttribute("href") ?? xlinkHref;
    if (!href) continue;
    const dataUri = await fetchAsDataUri(href, chapterDir, manifest, byPath);
    if (dataUri) {
      image.setAttribute("href", dataUri);
      if (xlinkHref) image.setAttributeNS("http://www.w3.org/1999/xlink", "href", dataUri);
    }
  }

  // Inline CSS - convert <link rel="stylesheet"> to <style>
  for (const link of Array.from(root.querySelectorAll('link[rel="stylesheet"][href]'))) {
    const href = link.getAttribute("href")!;
    const cssText = await fetchAsText(href, chapterDir, byPath);
    if (cssText !== null) {
      const style = root.createElement("style");
      style.textContent = await inlineCssUrls(cssText, href, byPath);
      link.replaceWith(style);
    } else {
      link.remove();
    }
  }
  // Same for inline <style> blocks: rewrite url(...) refs
  for (const style of Array.from(root.querySelectorAll("style"))) {
    if (style.textContent) {
      style.textContent = await inlineCssUrls(style.textContent, chapterHref, byPath);
    }
  }

  return root.documentElement?.outerHTML || `<html><body>${xhtml}</body></html>`;
}

async function inlineCssUrls(
  css: string,
  cssHref: string,
  byPath: Map<string, FileEntry>,
): Promise<string> {
  const cssDir = dirname(cssHref);
  const matches = [...css.matchAll(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/g)];
  let result = css;
  for (const m of matches) {
    const ref = m[2];
    if (/^(data:|https?:)/i.test(ref)) continue;
    const target = resolvePath(cssDir, stripFragment(ref));
    const entry = byPath.get(target);
    if (!entry) continue;
    const dataUri = await entryToDataUri(entry);
    if (dataUri) result = result.replace(m[0], `url(${dataUri})`);
  }
  return result;
}

async function fetchAsDataUri(
  ref: string,
  chapterDir: string,
  _manifest: Map<string, ManifestItem>,
  byPath: Map<string, FileEntry>,
): Promise<string | null> {
  if (/^(data:|https?:)/i.test(ref)) return ref;
  const target = resolvePath(chapterDir, stripFragment(ref));
  const entry = byPath.get(target);
  if (!entry) return null;
  return entryToDataUri(entry);
}

async function fetchAsText(
  ref: string,
  baseDir: string,
  byPath: Map<string, FileEntry>,
): Promise<string | null> {
  if (/^(data:|https?:)/i.test(ref)) return null;
  const target = resolvePath(baseDir, stripFragment(ref));
  const entry = byPath.get(target);
  if (!entry) return null;
  return readEntryText(byPath, target);
}

async function entryToDataUri(entry: FileEntry): Promise<string | null> {
  const { Uint8ArrayWriter } = await import("@zip.js/zip.js");
  const bytes = await entry.getData(new Uint8ArrayWriter());
  const mime = guessMimeType(entry.filename);
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

async function readEntryText(byPath: Map<string, FileEntry>, path: string): Promise<string> {
  const entry = byPath.get(normalisePath(path));
  if (!entry) throw new Error(`zip entry not found: ${path}`);
  const { TextWriter } = await import("@zip.js/zip.js");
  return entry.getData(new TextWriter());
}

function walk(el: Element | null, fn: (el: Element) => void) {
  if (!el) return;
  fn(el);
  for (const child of Array.from(el.children)) walk(child, fn);
}

/** An EPUB3 print-page marker: `epub:type="pagebreak"` or
 *  `role="doc-pagebreak"`, whatever namespace prefix the attribute carries. */
export function isPagebreak(el: Element): boolean {
  for (const attr of Array.from(el.attributes)) {
    const local = attr.name.split(":").pop() ?? attr.name;
    if (local === "type" && attr.value.includes("pagebreak")) return true;
    if (local === "role" && attr.value.includes("doc-pagebreak")) return true;
  }
  return false;
}

/** The print-edition page label for a pagebreak element - `title` (e.g.
 *  title="308"), else a trailing number/roman numeral in its id
 *  (id="page_308"), else its text. Mirrors the ingester's extraction. */
export function pagebreakLabel(el: Element): string | null {
  const title = (el.getAttribute("title") ?? "").trim();
  if (/^[0-9A-Za-z]+$/.test(title)) return title;
  const id = (el.getAttribute("id") ?? "").trim();
  const idMatch = id.match(/([0-9]+|[ivxlcdmIVXLCDM]+)$/);
  if (idMatch) return idMatch[1];
  const text = (el.textContent ?? "").trim();
  if (/^[0-9A-Za-z]+$/.test(text)) return text;
  return null;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function guessMimeType(path: string): string {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  return (
    {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      gif: "image/gif",
      svg: "image/svg+xml",
      webp: "image/webp",
      css: "text/css",
      woff: "font/woff",
      woff2: "font/woff2",
      otf: "font/otf",
      ttf: "font/ttf",
    }[ext] ?? "application/octet-stream"
  );
}

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

function stripFragment(path: string): string {
  const i = path.indexOf("#");
  return i < 0 ? path : path.slice(0, i);
}

function resolvePath(base: string, ref: string): string {
  if (!ref) return base;
  if (ref.startsWith("/")) return normalisePath(ref);
  const segments = (base ? base.split("/") : []).concat(ref.split("/"));
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

function normalisePath(path: string): string {
  return path.replace(/^\/+/, "").replace(/\/+/g, "/");
}
