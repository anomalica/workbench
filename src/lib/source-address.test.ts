import { describe, it, expect } from "vitest";
import { resolveSourceAddress } from "./source-address";

// These expectations are pinned to PROBED behaviour of the live zone, not to
// assumption: a public_domain object serves 206, while a publicly_accessible one
// 404s at the same unsigned path. If the zone's access model changes, this suite
// should fail loudly rather than let the workbench build URLs that 404.

const base = {
  staticReads: true,
  sourceKey: "5a05136da7b7",
  archivedExt: "ogg",
  copyrightStatus: "public_domain",
  isMedia: true,
};

describe("resolveSourceAddress: local (proxied) reads", () => {
  it("goes through the backend proxy regardless of status or extension", () => {
    expect(
      resolveSourceAddress({ ...base, staticReads: false, copyrightStatus: "restricted" }),
    ).toEqual({ kind: "fetch", url: "/api/sources/5a05136da7b7" });
  });

  it("does not need archived_ext locally - the proxy resolves the file itself", () => {
    expect(resolveSourceAddress({ ...base, staticReads: false, archivedExt: null })).toEqual({
      kind: "fetch",
      url: "/api/sources/5a05136da7b7",
    });
  });
});

describe("resolveSourceAddress: static (CDN) reads", () => {
  it("STREAMS public_domain media rather than downloading it to a blob", () => {
    expect(resolveSourceAddress(base)).toEqual({
      kind: "stream",
      url: "/sources/5a05136da7b7.ogg",
    });
  });

  it("uses archived_ext verbatim - the extension is not derivable from container", () => {
    // 76 records declare `container: ogg` yet are stored .opus; trusting the
    // container instead of archived_ext addresses a file that does not exist.
    expect(resolveSourceAddress({ ...base, archivedExt: "opus" })).toEqual({
      kind: "stream",
      url: "/sources/5a05136da7b7.opus",
    });
  });

  it("FETCHES a public_domain non-media source (a PDF renders from a blob)", () => {
    expect(resolveSourceAddress({ ...base, archivedExt: "pdf", isMedia: false })).toEqual({
      kind: "fetch",
      url: "/sources/5a05136da7b7.pdf",
    });
  });

  it("addresses nothing without archived_ext, rather than guessing an extension", () => {
    expect(resolveSourceAddress({ ...base, archivedExt: null })).toEqual({ kind: "none" });
    expect(resolveSourceAddress({ ...base, archivedExt: "" })).toEqual({ kind: "none" });
  });

  it("addresses nothing for a gated status - an unsigned URL 404s there", () => {
    // publicly_accessible and open_licence are PUBLIC to a reviewer, but their
    // originals are not in the OPEN zone: they arrive via the possession gate.
    for (const status of ["publicly_accessible", "open_licence", "licensed", "restricted"]) {
      expect(resolveSourceAddress({ ...base, copyrightStatus: status })).toEqual({ kind: "none" });
    }
  });

  it("treats an absent/unknown status as gated (fail closed)", () => {
    expect(resolveSourceAddress({ ...base, copyrightStatus: null })).toEqual({ kind: "none" });
    expect(resolveSourceAddress({ ...base, copyrightStatus: "some_future_status" })).toEqual({
      kind: "none",
    });
  });

  it("addresses nothing without a source key", () => {
    expect(resolveSourceAddress({ ...base, sourceKey: "" })).toEqual({ kind: "none" });
  });
});
