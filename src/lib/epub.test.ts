import { describe, expect, it } from "vitest";
import { flattenEpubToHtml, type ParsedEpub } from "$lib/epub";

describe("flattenEpubToHtml", () => {
  it("gives repeated printed pages sequence-aware source anchors", () => {
    const parsed: ParsedEpub = {
      chapters: [
        {
          id: "original",
          title: null,
          html: '<html><body><span epub:type="pagebreak" title="4"></span><span epub:type="pagebreak" title="5"></span></body></html>',
        },
        {
          id: "added",
          title: null,
          html: '<html><body><span epub:type="pagebreak" title="4"></span><span epub:type="pagebreak" title="5"></span></body></html>',
        },
        {
          id: "backmatter",
          title: null,
          html: '<html><body><span epub:type="pagebreak" title="6"></span></body></html>',
        },
      ],
    };

    const html = flattenEpubToHtml(parsed);

    expect(html.match(/id="page_1_4"/g)).toHaveLength(1);
    expect(html.match(/id="page_2_4"/g)).toHaveLength(1);
    expect(html).toContain('id="page_1_6"');
  });
});
