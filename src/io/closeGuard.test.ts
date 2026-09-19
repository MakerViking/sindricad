// The unsaved-changes guard in front of New / Open / Close.
//
// Field report (Doug Smith, #20): "A close file option with a save / discard
// option so you can work on another model and do not get asked to recover the
// previous model that was saved, but apparently is seen as needing recovery the
// next time you start SindriCAD."
//
// Two holes produced that. New offered a BINARY discard (no way to save first)
// and left the autosave slot on disk; Open had no guard at all. Either way the
// abandoned snapshot offered itself back on the next launch, which made the
// recovery prompt mean "you once pressed New" instead of "the app died".
//
// These tests pin the DECISION — may the caller replace the document? — because
// that is the half that loses work when it is wrong. `choose` is mocked: the
// point is what the guard does with each answer, not how the modal is drawn.

import { describe, it, expect, vi, beforeEach } from "vitest";

const choose = vi.fn();
vi.mock("../ui/choice", () => ({ choose: (...a: unknown[]) => choose(...a) }));

const clearRecovery = vi.fn(async (_path: string | null) => {});
vi.mock("./recovery", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  clearRecovery: (path: string | null) => clearRecovery(path),
}));

const { confirmDiscardChanges } = await import("./files");

/** Only the three fields the guard reads. */
function fakeStore(dirty: boolean, filePath: string | null = "/tmp/part.sindri") {
  return { dirty, filePath } as unknown as Parameters<typeof confirmDiscardChanges>[0];
}

describe("confirmDiscardChanges", () => {
  beforeEach(() => {
    choose.mockReset();
    clearRecovery.mockReset();
  });

  // The common case, and the one that must never cost a click.
  it("proceeds without prompting when nothing is unsaved", async () => {
    const ok = await confirmDiscardChanges(fakeStore(false), "title");
    expect(ok).toBe(true);
    expect(choose).not.toHaveBeenCalled();
  });

  it("proceeds and clears the recovery slot when the user discards", async () => {
    choose.mockResolvedValue("discard");
    const ok = await confirmDiscardChanges(fakeStore(true), "title");
    expect(ok).toBe(true);
    // The half that fixes the report: a deliberately abandoned document must not
    // come back as a recovery prompt.
    expect(clearRecovery).toHaveBeenCalledWith("/tmp/part.sindri");
  });

  // Esc / clicking away is NOT consent. Before this guard existed, Open simply
  // replaced the document, so there was no way to change your mind.
  it("refuses to proceed when the prompt is dismissed", async () => {
    choose.mockResolvedValue(null);
    const ok = await confirmDiscardChanges(fakeStore(true), "title");
    expect(ok).toBe(false);
    expect(clearRecovery).not.toHaveBeenCalled();
  });

  it("offers Save as well as Discard, which the binary prompt did not", async () => {
    choose.mockResolvedValue(null);
    await confirmDiscardChanges(fakeStore(true), "title");
    const [, options] = choose.mock.calls[0] as [string, { value: string }[]];
    expect(options.map((o) => o.value).sort()).toEqual(["discard", "save"]);
  });

  it("passes the caller's title through, so New/Open/Close read differently", async () => {
    choose.mockResolvedValue(null);
    await confirmDiscardChanges(fakeStore(true), "Save before opening?");
    expect(choose.mock.calls[0]?.[0]).toBe("Save before opening?");
  });
});
