import { describe, it, expect } from "vitest";

import { extToFormat, extToImportFormat, nearestPaletteSlot } from "./files";

// Both mappers are TOTAL — an unrecognised extension silently becomes "step"
// rather than erroring. That is deliberate (the save dialog can hand back a bare
// name), but it means a format added to a dialog filter list and forgotten here
// writes a STEP file wearing the user's chosen extension, with no error anywhere.
// These tests exist to make that omission fail loudly instead.
describe("extToFormat", () => {
  it("maps every extension offered in the export dialog", () => {
    expect(extToFormat("/tmp/part.step")).toBe("step");
    expect(extToFormat("/tmp/part.stp")).toBe("step");
    expect(extToFormat("/tmp/part.stl")).toBe("stl");
    expect(extToFormat("/tmp/part.3mf")).toBe("3mf");
    expect(extToFormat("/tmp/part.glb")).toBe("glb");
  });

  it("is case-insensitive and survives dots in the path", () => {
    expect(extToFormat("/tmp/my.part.v2.GLB")).toBe("glb");
    expect(extToFormat("C:\\models\\a.b\\Part.Stl")).toBe("stl");
  });

  it("falls back to step for anything unknown", () => {
    expect(extToFormat("/tmp/part")).toBe("step");
    expect(extToFormat("/tmp/part.wat")).toBe("step");
  });
});

describe("extToImportFormat", () => {
  it("maps every extension offered in the import dialog", () => {
    expect(extToImportFormat("/tmp/a.stl")).toBe("stl");
    expect(extToImportFormat("/tmp/a.3mf")).toBe("3mf");
    expect(extToImportFormat("/tmp/a.step")).toBe("step");
    expect(extToImportFormat("/tmp/a.stp")).toBe("step");
    expect(extToImportFormat("/tmp/a.obj")).toBe("obj");
    expect(extToImportFormat("/tmp/a.brep")).toBe("brep");
    expect(extToImportFormat("/tmp/a.glb")).toBe("glb");
  });

  it("is case-insensitive", () => {
    expect(extToImportFormat("/tmp/A.GLB")).toBe("glb");
  });
});

describe("nearestPaletteSlot", () => {
  // the shipped default palette
  const pal = [
    { name: "White", color: "#e8e8e8" },
    { name: "Black", color: "#202020" },
    { name: "Red", color: "#d23b30" },
    { name: "Blue", color: "#3050c8" },
  ];

  it("picks the exact slot when the colour is already in the palette", () => {
    expect(nearestPaletteSlot("#d23b30", pal)).toBe(2);
    expect(nearestPaletteSlot("#3050C8", pal)).toBe(3);
  });

  it("picks the perceptually closest slot for a colour that is not", () => {
    expect(nearestPaletteSlot("#ff0000", pal)).toBe(2); // crimson -> Red
    expect(nearestPaletteSlot("#0000aa", pal)).toBe(3); // navy -> Blue
    expect(nearestPaletteSlot("#fdfdfd", pal)).toBe(0); // near-white -> White
    expect(nearestPaletteSlot("#010101", pal)).toBe(1); // near-black -> Black
  });

  it("returns null rather than guessing on bad input", () => {
    expect(nearestPaletteSlot("#d23b30", [])).toBeNull();
    expect(nearestPaletteSlot("not-a-colour", pal)).toBeNull();
    expect(nearestPaletteSlot("#abc", pal)).toBeNull(); // 3-digit form unsupported
  });

  it("never invents a slot beyond the palette — it matches, never extends", () => {
    // the palette is the U1's 4 physical filament slots, not a display palette
    for (const c of ["#123456", "#00ff00", "#ffff00", "#7f7f7f"]) {
      const slot = nearestPaletteSlot(c, pal);
      expect(slot).not.toBeNull();
      expect(slot!).toBeGreaterThanOrEqual(0);
      expect(slot!).toBeLessThan(pal.length);
    }
  });
});
