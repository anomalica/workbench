/**
 * Self-hosted Umami analytics via direct HTTP to the collect API - no external
 * script tag, so no CSP change is needed (the workbench enforces none today).
 * Cookieless, no PII; the website id and origin are public values the browser
 * sends regardless, so they live here as constants, not secrets. Shared instance
 * with the public site, provisioned by anomalica/operations.
 *
 * This is an authenticated internal reviewer tool, so the numbers are internal
 * usage metrics (which records get opened, reviews submitted), not visitor
 * analytics. Opt out by setting localStorage `umami.disabled` to "1".
 *
 * The workbench is a plain Svelte SPA with no router, so callers pass a logical
 * `url` (e.g. `/records`, `/record/<public_hash>`) rather than relying on a real
 * path change.
 */

const UMAMI_URL = "https://analytics.akiyahopper.com";
const UMAMI_WEBSITE_ID = "f82c01b2-ccd3-4a64-9092-6c2fbac39d86";

let cacheHeader = "";

function disabled(): boolean {
  return typeof window !== "undefined" && localStorage.getItem("umami.disabled") === "1";
}

function basePayload(url?: string, title?: string): Record<string, unknown> {
  const { hostname, pathname } = window.location;
  const { width, height } = window.screen;
  const { referrer, title: docTitle } = window.document;
  const ref = referrer && !referrer.startsWith(window.location.origin) ? referrer : "";
  return {
    website: UMAMI_WEBSITE_ID,
    hostname,
    language: window.navigator.language,
    screen: `${width}x${height}`,
    url: url ?? pathname,
    title: title ?? docTitle,
    referrer: ref,
  };
}

async function send(payload: Record<string, unknown>, keepalive = false): Promise<void> {
  if (typeof window === "undefined" || disabled()) return;
  try {
    const res = await fetch(`${UMAMI_URL}/api/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cacheHeader && { "x-umami-cache": cacheHeader }),
      },
      body: JSON.stringify({ type: "event", payload }),
      credentials: "omit",
      ...(keepalive && { keepalive: true }),
    });
    if (res.ok) {
      const text = await res.text();
      if (text) cacheHeader = text;
    }
  } catch {
    // Analytics must never break the page.
  }
}

/** A pageview for the given logical url. Umami treats a payload with no `name`
 *  as a view. */
export function trackView(url?: string, title?: string): void {
  if (typeof window === "undefined") return;
  void send(basePayload(url, title));
}

/** A named funnel event (e.g. "review-submitted"), optionally with data. */
export function trackEvent(name: string, data?: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  void send(
    { ...basePayload(), name, ...(data && Object.keys(data).length ? { data } : {}) },
    true,
  );
}
