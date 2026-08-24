// The one piece of the Text-on-Face panel with logic rather than layout.
//
// SCOPE, stated rather than implied: this repo has no jsdom, so the panel's DOM
// — the Flat option itself, hiding the depth and bevel fields, repainting the
// chips — is NOT covered here and is only reachable by hand in the app. What IS
// covered is the rule that decides which filament a flat text starts on, which
// is the part that can be silently wrong: get it wrong and the letters are
// invisible, which is exactly the failure the auto-pick exists to prevent.
import { describe, expect, it } from "vitest";

import { autoGlyphSlot } from "./textOnFacePanel";

describe("autoGlyphSlot — a flat text must never start invisible", () => {
  it("avoids the body's own filament, so the glyphs read against it", () => {
    expect(autoGlyphSlot(4, 0)).toBe(1);
    expect(autoGlyphSlot(4, 1)).toBe(0);
    expect(autoGlyphSlot(4, 3)).toBe(0);
  });

  it("takes the first slot when the body has no colour of its own", () => {
    expect(autoGlyphSlot(4, null)).toBe(0);
  });

  it("still returns a slot when the body holds the only colour there is", () => {
    // A single-filament palette: there is no contrasting choice, so the text
    // takes slot 0 and prints in the body's colour. Invisible, but the user can
    // see the chip is lit and change it — which beats a null that silently means
    // "inherit" and gives them nothing to notice.
    expect(autoGlyphSlot(1, 0)).toBe(0);
  });

  it("returns null rather than an index into an empty palette", () => {
    expect(autoGlyphSlot(0, null)).toBeNull();
    expect(autoGlyphSlot(0, 2)).toBeNull();
  });
});
