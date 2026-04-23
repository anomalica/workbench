import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/svelte";
import SpeakerManager from "./SpeakerManager.svelte";
import { parseTranscript } from "$lib/transcript";

interface MakePropsOverrides {
  onfilter?: ReturnType<typeof vi.fn>;
  onselect?: ReturnType<typeof vi.fn>;
  onsetfilter?: ReturnType<typeof vi.fn>;
  onrename?: ReturnType<typeof vi.fn>;
  onmerge?: ReturnType<typeof vi.fn>;
  onaddnamed?: ReturnType<typeof vi.fn>;
  onremovenamed?: ReturnType<typeof vi.fn>;
  onrenamenamed?: ReturnType<typeof vi.fn>;
}

// Vitest mock functions are structurally callable but TypeScript's strict
// Svelte component typings don't accept Mock<...> where (args) => void is expected.
// Cast at the function boundary to keep the tests readable.
type AnyFn = (...args: unknown[]) => unknown;

function makeProps(overrides: MakePropsOverrides = {}) {
  const body = `
<!-- speaker: Ross Coulthart -->
00:00:01.0 Hello.
00:00:03.0 Second sentence.

<!-- speaker: David Marler -->
00:00:10.0 First from David.

<!-- speaker: Speaker 5 -->
00:00:20.0 Something from unnamed.
`;
  return {
    segments: parseTranscript(body),
    namedSpeakers: ["Ross Coulthart", "David Marler", "Unassigned Person"],
    selectedSpeakers: new Set<string>(),
    filteredSpeakers: new Set<string>(),
    onselect: (overrides.onselect ?? vi.fn()) as unknown as AnyFn,
    onfilter: (overrides.onfilter ?? vi.fn()) as unknown as AnyFn,
    onsetfilter: (overrides.onsetfilter ?? vi.fn()) as unknown as AnyFn,
    onrename: (overrides.onrename ?? vi.fn()) as unknown as AnyFn,
    onmerge: (overrides.onmerge ?? vi.fn()) as unknown as AnyFn,
    onaddnamed: (overrides.onaddnamed ?? vi.fn()) as unknown as AnyFn,
    onremovenamed: (overrides.onremovenamed ?? vi.fn()) as unknown as AnyFn,
    onrenamenamed: (overrides.onrenamenamed ?? vi.fn()) as unknown as AnyFn,
  };
}

describe("SpeakerManager - speaker dots", () => {
  it("renders a dot next to every named speaker row", () => {
    const { getByText, container } = render(SpeakerManager, makeProps());
    // Each named row should contain a SpeakerDot (data-testid="speaker-dot")
    const rossRow = getByText("Ross Coulthart").closest("div");
    expect(rossRow?.querySelector('[data-testid="speaker-dot"]')).not.toBeNull();

    const davidRow = getByText("David Marler").closest("div");
    expect(davidRow?.querySelector('[data-testid="speaker-dot"]')).not.toBeNull();

    // Unassigned named (in frontmatter, no segments) also has a dot
    const unassignedRow = getByText("Unassigned Person").closest("div");
    expect(unassignedRow?.querySelector('[data-testid="speaker-dot"]')).not.toBeNull();

    // All dots together - 3 named + 3 unassigned=0 + 1 unnamed = at least 3
    const dots = container.querySelectorAll('[data-testid="speaker-dot"]');
    expect(dots.length).toBeGreaterThanOrEqual(3);
  });

  it("renders a dot next to every unnamed speaker row", () => {
    const { getByText } = render(SpeakerManager, makeProps());
    const speaker5Row = getByText("Speaker 5").closest("div");
    expect(speaker5Row?.querySelector('[data-testid="speaker-dot"]')).not.toBeNull();
  });

  it("clicking a named speaker's dot calls onfilter", async () => {
    const onfilter = vi.fn();
    const { getByText } = render(SpeakerManager, makeProps({ onfilter }));
    const row = getByText("Ross Coulthart").closest("div");
    const dotButton = row?.querySelector<HTMLButtonElement>('button[title*="filter"]');
    expect(dotButton).not.toBeNull();
    await fireEvent.click(dotButton!);
    expect(onfilter).toHaveBeenCalledWith("Ross Coulthart");
  });

  it("clicking an unnamed speaker's dot calls onfilter", async () => {
    const onfilter = vi.fn();
    const { getByText } = render(SpeakerManager, makeProps({ onfilter }));
    const row = getByText("Speaker 5").closest("div");
    const dotButton = row?.querySelector<HTMLButtonElement>('button[title*="filter"]');
    expect(dotButton).not.toBeNull();
    await fireEvent.click(dotButton!);
    expect(onfilter).toHaveBeenCalledWith("Speaker 5");
  });
});

describe("SpeakerManager - count alignment", () => {
  it("shows the count as a right-aligned element with consistent padding", () => {
    const { getByText } = render(SpeakerManager, makeProps());

    // Ross has 2 segments - count button
    const rossRow = getByText("Ross Coulthart").closest("div");
    const rossCount = rossRow?.querySelector('button[title*="filter"]:last-of-type');
    expect(rossCount).not.toBeNull();

    // Unassigned Person has 0 - should have the same padding class
    const unassignedRow = getByText("Unassigned Person").closest("div");
    const zeroSpan = [...(unassignedRow?.querySelectorAll("span") ?? [])].find(
      (s) => s.textContent?.trim() === "0",
    );
    expect(zeroSpan).not.toBeNull();
    // Both use px-1.5 py-0.5 padding classes so numbers line up
    expect(zeroSpan?.className).toContain("px-1.5");
    expect(zeroSpan?.className).toContain("py-0.5");
  });
});

describe("SpeakerManager - section counts", () => {
  it("displays a count in the Named section header", () => {
    const { container } = render(SpeakerManager, makeProps());
    // "Named (3)" because Ross + David (have segments) + Unassigned Person
    expect(container.textContent).toMatch(/Named\s*\(3\)/);
  });

  it("displays a count in the Unnamed section header", () => {
    const { container } = render(SpeakerManager, makeProps());
    // Exactly one unnamed speaker in the test body
    expect(container.textContent).toMatch(/Unnamed\s*\(1\)/);
  });
});

describe("SpeakerManager - section filter eye", () => {
  it("clicking the Named eye icon sets filter to all named speaker ids", async () => {
    const onsetfilter = vi.fn();
    const { getByTitle } = render(SpeakerManager, makeProps({ onsetfilter }));
    const eye = getByTitle(/only named speakers|clear filter/i);
    await fireEvent.click(eye);
    expect(onsetfilter).toHaveBeenCalled();
    const [ids] = onsetfilter.mock.calls[0];
    // Only named rows with actual segments (Ross, David)
    expect(ids).toContain("Ross Coulthart");
    expect(ids).toContain("David Marler");
  });
});
