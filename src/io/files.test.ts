import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { DocumentStore } from "../document/store";
import type { GeometryBackend } from "../geometry/client";

import { describeImportCapability, describeSurfaceFit, extToFormat, extToImportFormat, importedBodyCount, looksLikeContainer, nearestPaletteSlot, needsUnassignedConfirm } from "./files";

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

// --- import capability warning (Wave 1.5) ------------------------------------
//
// The counts are known at import time, before the viewport is built. Saying
// nothing means the user discovers a 3,000-body document as a freeze and
// concludes the app is broken. The thresholds are MEASURED post-Phase-A on real
// WebKitGTK — 60 fps at 1,000 bodies, 27-37 at 3,060 — not guessed, so a test
// that pins them is pinning a measurement.
describe("describeImportCapability", () => {
  it("says nothing about a document that will be fine", () => {
    for (const n of [1, 7, 500, 999, 1000]) {
      expect(describeImportCapability(n)).toBeNull();
    }
  });

  it("warns gently just past the smooth limit", () => {
    const msg = describeImportCapability(1500);
    expect(msg).not.toBeNull();
    expect(msg!).toContain("1,500");
    expect(msg!).toMatch(/still works/i);   // reassures: not a refusal
    expect(msg!).not.toMatch(/27-37/);      // the harsher figure is for later
  });

  it("is blunt about a document past the slow limit, and says what still works", () => {
    const msg = describeImportCapability(3060);
    expect(msg).not.toBeNull();
    expect(msg!).toContain("3,060");
    expect(msg!).toContain("27-37 fps");    // the measured number, not a vague "slow"
    // The user needs to know this is a VIEWPORT limit, not a broken import —
    // otherwise the natural conclusion is that the file failed to load.
    expect(msg!).toMatch(/export/i);
  });

  it("never warns on a nonsense count", () => {
    expect(describeImportCapability(NaN)).toBeNull();
    expect(describeImportCapability(0)).toBeNull();
    expect(describeImportCapability(-5)).toBeNull();
  });
});

describe("importedBodyCount", () => {
  it("counts assembly leaves", () => {
    expect(importedBodyCount({ parts: [{ node: 0, faces: 6 }, { node: 1, faces: 8 }] })).toBe(2);
  });

  it("treats a file with no tree as one body", () => {
    // A plain STL/STEP carries no `parts`, and it still produces a body — a
    // count of 0 here would silently disable the warning for single-body files
    // and, worse, misreport the document.
    expect(importedBodyCount({})).toBe(1);
  });
});

// Field-reported 2026-08-21: a curated four-slot palette exported as one object
// on extruder 1, and NOTHING said so. The colour side of the project 3MF was
// correct all along — filament_colour carried all four — but no body had ever
// been bound to a slot, and the warning that exists for exactly that case never
// fired, because it was computed AFTER an awaited printer probe that rejects
// when the U1 is offline, unconfigured, or merely slower than 1.5s.
describe("print-project colour assignment warnings", () => {
  const backend = {
    async rebuild() { return { ok: false, error: { message: "stub" } }; },
    async init() {}, onStatus() { return () => {}; }, connected: true,
  } as unknown as GeometryBackend;

  const CUSTOM_PALETTE = [
    { name: "Lilac", color: "#B8ACD6" },
    { name: "Mint", color: "#96D8AF" },
    { name: "Coral", color: "#F99963" },
    { name: "Sky", color: "#B8CDE9" },
  ];

  function storeWithPalette(palette?: { name: string; color: string }[]) {
    const store = new DocumentStore(backend, { parameters: {}, features: [] });
    if (palette) store.load(JSON.stringify({ version: 5, parameters: {}, features: [], palette }));
    return store;
  }

  afterEach(() => {
    vi.doUnmock("../print/printerClient");
    vi.doUnmock("../ui/toast");
    vi.resetModules();
  });

  it("still reports unassigned bodies when the printer never answers", async () => {
    // THE REGRESSION. The printer probe rejects, exactly as an offline U1 makes
    // it. The unassigned count needs no printer, so it must survive that.
    vi.doMock("../print/printerClient", () => ({
      activePrinterId: () => "u1",
      printerFilaments: async () => { throw new Error("offline"); },
    }));
    const toasts: string[] = [];
    vi.doMock("../ui/toast", () => ({ toast: (m: string) => void toasts.push(m) }));

    const { warnPrintAssignments } = await import("./files");
    await warnPrintAssignments(storeWithPalette(CUSTOM_PALETTE), ["b1"]);

    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toContain("1 body is unassigned");
  });

  it("says nothing when every body is assigned and the printer is unreachable", async () => {
    // The counter-check: making the warning printer-independent must not make it
    // fire on a correctly-assigned document.
    vi.doMock("../print/printerClient", () => ({
      activePrinterId: () => "u1",
      printerFilaments: async () => { throw new Error("offline"); },
    }));
    const toasts: string[] = [];
    vi.doMock("../ui/toast", () => ({ toast: (m: string) => void toasts.push(m) }));

    const { warnPrintAssignments } = await import("./files");
    const store = storeWithPalette(CUSTOM_PALETTE);
    store.setBodyColorSlot("b1", 2);
    await warnPrintAssignments(store, ["b1"]);

    expect(toasts).toEqual([]);
  });

  it("reports both halves when the printer DOES answer", async () => {
    vi.doMock("../print/printerClient", () => ({
      activePrinterId: () => "u1",
      printerFilaments: async () => ({ 0: { present: false } }),
    }));
    const toasts: string[] = [];
    vi.doMock("../ui/toast", () => ({ toast: (m: string) => void toasts.push(m) }));

    const { warnPrintAssignments } = await import("./files");
    await warnPrintAssignments(storeWithPalette(CUSTOM_PALETTE), ["b1"]);

    expect(toasts[0]).toContain("slot 1 has no filament loaded");
    expect(toasts[0]).toContain("1 body is unassigned");
  });
});

describe("needsUnassignedConfirm", () => {
  const backend = {
    async rebuild() { return { ok: false, error: { message: "stub" } }; },
    async init() {}, onStatus() { return () => {}; }, connected: true,
  } as unknown as GeometryBackend;
  const CUSTOM = [{ name: "Lilac", color: "#B8ACD6" }, { name: "Mint", color: "#96D8AF" }];

  function storeWithPalette(palette?: { name: string; color: string }[]) {
    const store = new DocumentStore(backend, { parameters: {}, features: [] });
    if (palette) store.load(JSON.stringify({ version: 5, parameters: {}, features: [], palette }));
    return store;
  }

  it("prompts when a curated palette has no assignments at all", () => {
    expect(needsUnassignedConfirm(storeWithPalette(CUSTOM), ["b1", "b2"])).toBe(true);
  });

  it("stays quiet once ANY body is assigned", () => {
    // One assignment means the user knows the mechanism; the post-export toast
    // still names the bodies they missed. Prompting again would be a nag.
    const store = storeWithPalette(CUSTOM);
    store.setBodyColorSlot("b2", 1);
    expect(needsUnassignedConfirm(store, ["b1", "b2"])).toBe(false);
  });

  it("never prompts on an untouched default palette", () => {
    // The ordinary single-colour export must not grow a dialog.
    expect(needsUnassignedConfirm(storeWithPalette(), ["b1"])).toBe(false);
  });

  it("never prompts with no bodies", () => {
    expect(needsUnassignedConfirm(storeWithPalette(CUSTOM), [])).toBe(false);
  });
});

describe("needsUnassignedConfirm and face-level color", () => {
  const backend = {
    async rebuild() { return { ok: false, error: { message: "stub" } }; },
    async init() {}, onStatus() { return () => {}; }, connected: true,
  } as unknown as GeometryBackend;
  const CUSTOM = [{ name: "Lilac", color: "#B8ACD6" }, { name: "Mint", color: "#96D8AF" }];

  function storeWithFacePaint(slots: (number | null)[]) {
    const store = new DocumentStore(backend, { parameters: {}, features: [] });
    store.load(JSON.stringify({ version: 5, parameters: {}, features: [], palette: CUSTOM }));
    // buildState is what the sidecar filled in; textureColorSlots is its dense
    // per-face palette-slot array (main.ts:computeTexturePaint paints from it).
    // buildState is a getter on the prototype; shadow it with an own property
    // rather than reaching for a private field name that could be renamed.
    Object.defineProperty(store, "buildState", {
      configurable: true,
      get: () => ({
        result: { bodies: [{ id: "b1", name: "Body1", faceStart: 0, faceCount: slots.length, textureColorSlots: slots }] },
      }),
    });
    return store;
  }

  it("does not warn when a texture colors faces but no body is assigned", () => {
    // The field document exactly: a curated palette, zero body assignments, and
    // three textured faces carrying slots. Since the project writer emits
    // per-triangle paint_color this DOES print in color, so warning would be
    // the same lie the prompt exists to prevent, inverted.
    expect(needsUnassignedConfirm(storeWithFacePaint([null, 2, null, 0]), ["b1"])).toBe(false);
  });

  it("still warns when the faces carry no slots at all", () => {
    expect(needsUnassignedConfirm(storeWithFacePaint([null, null]), ["b1"])).toBe(true);
  });
});

// --- surface fitting on mesh import (GH #49) ---------------------------------
//
// The fitter is silent by design: it either recognises curved surfaces or leaves
// them faceted, and either way the import "works". The toast is the only place
// the user learns WHICH happened, so an import that quietly stayed faceted (and
// will therefore refuse a press/pull on that wall) must not read the same as one
// that came back fully editable. Both counts are quoted for that reason.
//
// Every key is optional: a backend that predates the fitter, and a STEP import,
// send none of them, and that has to stay silent rather than claiming zero.
describe("describeSurfaceFit", () => {
  it("says nothing when the reply carries no fitting counts", () => {
    expect(describeSurfaceFit({})).toBeNull();
  });

  it("says nothing when nothing was recognised", () => {
    // Today's faceted import. Claiming "0 curved surfaces" on every STL would be
    // noise, so the release notes promise a message only when something WAS
    // recognised. Note what this costs: a mesh whose curves are all cones or
    // spheres comes back like this and most of its faces will refuse
    // Press/Pull, with no warning until the user tries one. If that trade is
    // ever reversed, the new branch goes AFTER the fitSkipped lookup — a
    // declined fit also has faceted > 0, and preempting it would replace a true
    // sentence with a false one.
    expect(describeSurfaceFit({ fitted: 0, faceted: 120 })).toBeNull();
  });

  it("quotes both counts when part of the body stayed faceted", () => {
    const msg = describeSurfaceFit({ fitted: 12, faceted: 3587 });
    expect(msg).not.toBeNull();
    expect(msg!).toContain("12 curved surfaces");
    expect(msg!).toContain("3,587");              // thousands separator, like the capability toast
    expect(msg!).toMatch(/stayed faceted/);
    expect(msg!).not.toContain("—");              // house style: no em-dashes
  });

  it("does not claim leftovers when the whole body was recognised", () => {
    const msg = describeSurfaceFit({ fitted: 1, faceted: 0 });
    expect(msg).not.toBeNull();
    expect(msg!).toContain("1 curved surface.");  // singular, not "1 curved surfaces"
    expect(msg!).not.toMatch(/1 faces/);
    expect(msg!).toMatch(/No faces stayed faceted/i);
  });

  it("reads naturally for a single leftover face", () => {
    const msg = describeSurfaceFit({ fitted: 2, faceted: 1 });
    expect(msg!).toContain("1 face stayed faceted");
    expect(msg!).not.toContain("1 faces");
  });

  it("gives the one reason the sidecar sends its own sentence", () => {
    // "checks" is the ONLY reason `_fit_surfaces` writes, and the sidecar's own
    // test pins it reaching the reply. This leg is the copy check for the
    // sentence a user can actually be shown.
    const checks = describeSurfaceFit({ fitSkipped: "checks" });
    expect(checks).not.toBeNull();
    expect(checks!).toMatch(/faceted/);
    expect(checks!).not.toContain("—");           // house style: no em-dashes
  });

  it("renders the forward-compatible reasons distinctly, though none is sent yet", () => {
    // "dense" and "coarse" are the plan's other two reasons and nothing in the
    // sidecar emits either, so no user has seen these strings. They are kept so
    // a newer sidecar that grows a density screen renders without a frontend
    // change; this leg only guarantees they would not collide or read as one
    // vague sentence. It is NOT coverage of shipped behaviour.
    const dense = describeSurfaceFit({ fitSkipped: "dense" });
    const coarse = describeSurfaceFit({ fitSkipped: "coarse" });
    const checks = describeSurfaceFit({ fitSkipped: "checks" });
    for (const m of [dense, coarse]) {
      expect(m).not.toBeNull();
      expect(m!).toMatch(/faceted/);
      expect(m!).not.toContain("—");
    }
    // Distinct on purpose: "too dense to look", "too coarse to be sure" and
    // "the fit failed its checks" are three different things to do about it.
    expect(new Set([dense, coarse, checks]).size).toBe(3);
  });

  it("stays quiet on a skip reason it does not know", () => {
    // A reason added in the sidecar later must not surface as a half-sentence.
    expect(describeSurfaceFit({ fitSkipped: "banana" })).toBeNull();
  });

  it("never reports a nonsense count", () => {
    expect(describeSurfaceFit({ fitted: NaN, faceted: 3 })).toBeNull();
    expect(describeSurfaceFit({ fitted: -3, faceted: 5 })).toBeNull();
    // An unusable leftover count degrades to the recognised sentence rather
    // than printing "NaN faces stayed faceted".
    const msg = describeSurfaceFit({ fitted: 4, faceted: NaN });
    expect(msg).not.toBeNull();
    expect(msg!).toContain("4 curved surfaces");
    expect(msg!).not.toMatch(/NaN/);
    expect(msg!).not.toMatch(/faceted/);
  });
});
