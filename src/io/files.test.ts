import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { DocumentStore } from "../document/store";
import type { GeometryBackend } from "../geometry/client";

import { extToFormat, extToImportFormat, looksLikeContainer, nearestPaletteSlot } from "./files";

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

// A v5 `.sindri` is a ZIP; builds that predate it must SAY so rather than
// showing a JSON syntax error, and must NOT drop the file from Recent while
// telling the user to upgrade. `openDocumentAtPath` and the welcome-screen
// wiring need Tauri + a DOM, neither of which this suite has (see
// vitest.config.ts: "no DOM/Tauri APIs mocked yet"), so the DECISION is
// unit-tested here and the wiring is left to the browser harness.
// NOT COVERED by any unit test: that welcome.ts actually skips forgetRecent on
// the "newerFormat" outcome. Stated rather than implied.
describe("looksLikeContainer", () => {
  // 0x50 0x4b 0x03 0x04 = "PK\x03\x04", a ZIP local-file header, followed by
  // bytes that are invalid UTF-8 (0xff 0xfe ...) — i.e. a realistic prefix.
  const zipBytes = new Uint8Array([
    0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x08, 0x00, 0x08, 0x00,
    0xff, 0xfe, 0x9c, 0x8d, 0xe2, 0x28, 0x00, 0x00,
  ]);

  // The whole diagnosis rests on one premise: plugin-fs decodes with a
  // NON-FATAL TextDecoder, so reading a zip as text SUCCEEDS (mangled) rather
  // than throwing, which is why JSON.parse is what fails and why we still have
  // the text to inspect. If that ever became fatal the read would throw first
  // and the friendly message would be unreachable — so pin the premise itself.
  it("decoding zip bytes as UTF-8 does not throw (the premise)", () => {
    expect(() => new TextDecoder().decode(zipBytes)).not.toThrow();
  });

  it("recognises a zip through that lossy decode", () => {
    expect(looksLikeContainer(new TextDecoder().decode(zipBytes))).toBe(true);
  });

  it("does not fire on a real document, or on ordinary corruption", () => {
    expect(looksLikeContainer('{ "version": 4, "features": [] }')).toBe(false);
    expect(looksLikeContainer("")).toBe(false);
    expect(looksLikeContainer("<!DOCTYPE html>")).toBe(false);
    expect(looksLikeContainer(" PK")).toBe(false); // leading space: not a header
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

// --- export busy/cancel wiring (Wave 1.3) ------------------------------------
//
// Both export paths used to just `await` the backend. On a large document an
// export replays the whole feature history, so it runs as long as an import
// does — with nothing on screen to show it, and nothing for Cancel to attach
// to. These pin the two halves of the fix: the op is wrapped in runBusy, and it
// hands back its request id so a cancel targets THIS export rather than
// whatever ran most recently (the document stays editable meanwhile).
describe("export runs as a cancellable busy op", () => {
  const savePath = "/tmp/part.step";
  let reported: string[];

  beforeEach(() => {
    reported = [];
    // No jsdom in this project on purpose (see vitest.config.ts), so stand up
    // the one property exportModel's isTauri() probe reads, nothing more.
    // diagnostics/breadcrumbs.ts registers global handlers at MODULE scope
    // whenever `window` exists, so the stub needs those no-ops too.
    (globalThis as unknown as Record<string, unknown>).window = {
      __TAURI_INTERNALS__: {},
      addEventListener() {},
      removeEventListener() {},
    };
    vi.doMock("@tauri-apps/plugin-dialog", () => ({
      save: async () => savePath,
      open: async () => null,
      message: async (m: string) => void reported.push(m),
    }));
    vi.doMock("../ui/choice", () => ({
      choose: async () => null,
      listModal: async () => {},
    }));
  });

  afterEach(() => {
    vi.doUnmock("@tauri-apps/plugin-dialog");
    vi.doUnmock("../ui/choice");
    vi.resetModules();
    delete (globalThis as unknown as Record<string, unknown>).window;
  });

  function storeWith(exportImpl: GeometryBackend["export"]) {
    const backend = {
      async rebuild() { return { ok: false, error: { message: "stub" } }; },
      async init() {}, onStatus() { return () => {}; }, connected: true,
      export: exportImpl,
    } as unknown as GeometryBackend;
    return { backend, store: new DocumentStore(backend, { parameters: {}, features: [] }) };
  }

  it("is busy while exporting, and hands back an id a cancel can target", async () => {
    let busyDuring: { active: boolean; id: string | null } | null = null;
    const { backend, store } = storeWith(async (_d, _f, _p, _o, onStarted) => {
      onStarted?.("req-42");
      busyDuring = { active: store.busyState.active, id: store.busyState.id };
      return { ok: true, path: savePath };
    });
    const { exportModel } = await import("./files");
    await exportModel(store, backend);

    expect(busyDuring).not.toBeNull();
    expect(busyDuring!.active).toBe(true);
    // the id is what makes Cancel target THIS op — without it cancelBusy is a no-op
    expect(busyDuring!.id).toBe("req-42");
    expect(store.busyState.active).toBe(false);  // always cleared
  });

  it("says nothing when the user cancels — that is not an error", async () => {
    const { backend, store } = storeWith(async () => ({
      ok: false, cancelled: true, message: "export cancelled",
    }));
    const { exportModel } = await import("./files");
    await exportModel(store, backend);

    expect(reported).toEqual([]);   // no "Export failed: cancelled" dialog
    expect(store.busyState.active).toBe(false);
  });

  it("still reports a genuine failure", async () => {
    const { backend, store } = storeWith(async () => ({ ok: false, message: "disk full" }));
    const { exportModel } = await import("./files");
    await exportModel(store, backend);

    expect(reported.join(" ")).toContain("disk full");
    expect(store.busyState.active).toBe(false);
  });

  it("clears busy even when the backend throws", async () => {
    const { backend, store } = storeWith(async () => { throw new Error("socket died"); });
    const { exportModel } = await import("./files");
    await expect(exportModel(store, backend)).rejects.toThrow("socket died");
    expect(store.busyState.active).toBe(false);
  });
});
