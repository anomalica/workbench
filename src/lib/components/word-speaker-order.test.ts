import { fireEvent, render, within } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import { parseWords } from "$lib/transcript-words";
import WordTranscript from "./WordTranscript.svelte";

describe("word transcript speaker ordering", () => {
  it("offers named speakers in descending word-count order", async () => {
    const body = `<!-- speaker: Brief Speaker -->
{{t:0}}brief
<!-- speaker: Main Speaker -->
{{t:1}}one {{t:2}}two {{t:3}}three
<!-- speaker: Speaker 3 -->
{{t:4}}unknown`;
    const { getAllByTitle, getByRole } = render(WordTranscript, {
      body,
      parsedWords: parseWords(body),
      namedSpeakers: ["Brief Speaker", "Main Speaker"],
      onreassign: () => {},
    });

    await fireEvent.click(getAllByTitle("Change this speaker")[2]);
    const options = within(getByRole("menu"))
      .getAllByRole("button")
      .map((button) => button.textContent?.trim());

    expect(options.indexOf("Main Speaker")).toBeLessThan(options.indexOf("Brief Speaker"));
  });
});
