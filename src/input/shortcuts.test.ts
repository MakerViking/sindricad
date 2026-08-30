// Rebindable-shortcut logic: conflict rules, persistence, and what the
// dispatcher resolves once an override is in play.
//
// Every test loads the module FRESH (vi.resetModules + dynamic import) against
// its own in-memory localStorage, because the override map is module state
// loaded from storage on first use — sharing it across tests would let one
// test's rebinding decide another's outcome, and a persistence test that
// re-reads its own in-memory map proves nothing about the round trip.

import { beforeEach, describe, expect, it, vi } from "vitest";

class MemStorage {
  private data = new Map<string, string>();
  getItem(k: string): string | null {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, String(v));
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
  clear() {
    this.data.clear();
  }
}

let storage: MemStorage;

/** Fresh module instance reading the CURRENT storage. */
async function load() {
  vi.resetModules();
  return import("./shortcuts");
}

beforeEach(() => {
  storage = new MemStorage();
  vi.stubGlobal("localStorage", storage);
});

describe("defaults", () => {
  it("ship free of conflicts", async () => {
    const { SHORTCUTS, bindingOf, findConflict } = await load();
    for (const s of SHORTCUTS) {
      const b = bindingOf(s);
      expect(b).not.toBeNull();
      const clash = findConflict(s.id, b!);
      expect(clash && `${s.id} clashes with ${clash.id}`).toBeNull();
    }
  });

  it("give every entry a unique id", async () => {
    const { SHORTCUTS } = await load();
    expect(new Set(SHORTCUTS.map((s) => s.id)).size).toBe(SHORTCUTS.length);
  });

  it("resolve the way they always did", async () => {
    const { resolveShortcut } = await load();
    expect(resolveShortcut("f", false, "model")).toBe("fillet");
    expect(resolveShortcut("f", false, "sketch")).toBe("fillet-sketch");
    expect(resolveShortcut("h", true, "model")).toBe("show-all-bodies");
    expect(resolveShortcut("home", false, "sketch")).toBe("fit"); // global reaches both
    expect(resolveShortcut("z", false, "model")).toBeNull();
  });
});

describe("rebinding", () => {
  it("makes the dispatcher answer on the new key and go quiet on the old", async () => {
    const { rebindShortcut, resolveShortcut } = await load();
    expect(rebindShortcut("m.fillet", { key: "g", shift: false }).ok).toBe(true);
    expect(resolveShortcut("g", false, "model")).toBe("fillet");
    expect(resolveShortcut("f", false, "model")).toBeNull();
  });

  it("normalizes the key it is handed", async () => {
    const { rebindShortcut, resolveShortcut } = await load();
    rebindShortcut("m.fillet", { key: "G", shift: false });
    expect(resolveShortcut("g", false, "model")).toBe("fillet");
  });

  it("refuses a conflict and names the incumbent, changing nothing", async () => {
    const { rebindShortcut, resolveShortcut } = await load();
    const r = rebindShortcut("m.chamfer", { key: "e", shift: false });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.conflict.id).toBe("m.extrude");
    expect(resolveShortcut("e", false, "model")).toBe("extrude"); // incumbent kept
    expect(resolveShortcut("b", false, "model")).toBe("chamfer"); // applicant unmoved
  });

  it("treats a global entry as conflicting with both contexts", async () => {
    const { rebindShortcut } = await load();
    expect(rebindShortcut("g.fit", { key: "e", shift: false }).ok).toBe(false);
    expect(rebindShortcut("g.fit", { key: "t", shift: false }).ok).toBe(false); // sketch Trim
  });

  it("does NOT treat model vs sketch as a conflict", async () => {
    const { rebindShortcut, resolveShortcut } = await load();
    // "m" is Move in the model context; a sketch entry may take it freely
    expect(rebindShortcut("s.trim", { key: "m", shift: false }).ok).toBe(true);
    expect(resolveShortcut("m", false, "sketch")).toBe("trim");
    expect(resolveShortcut("m", false, "model")).toBe("move");
  });

  it("separates a shifted binding from its unshifted twin", async () => {
    const { rebindShortcut, resolveShortcut } = await load();
    // Shift+H is Show All; plain H is Hide. Binding Move to Shift+H must clash,
    // but binding it to Shift+M (plain M is its own key) must not.
    expect(rebindShortcut("m.move", { key: "h", shift: true }).ok).toBe(false);
    expect(rebindShortcut("m.move", { key: "m", shift: true }).ok).toBe(true);
    expect(resolveShortcut("m", true, "model")).toBe("move");
    expect(resolveShortcut("m", false, "model")).toBeNull();
  });

  it("throws on an id it does not ship rather than no-op", async () => {
    const { rebindShortcut } = await load();
    expect(() => rebindShortcut("m.nosuchtool", { key: "g", shift: false })).toThrow();
  });
});

describe("clearing and resetting", () => {
  it("unbinds an entry without touching the rest", async () => {
    const { rebindShortcut, resolveShortcut, keyHint } = await load();
    rebindShortcut("m.fillet", null);
    expect(resolveShortcut("f", false, "model")).toBeNull();
    expect(resolveShortcut("f", false, "sketch")).toBe("fillet-sketch");
    expect(keyHint("fillet")).toBeUndefined();
  });

  it("lets a cleared key be taken — the swap a refuse-only policy needs", async () => {
    const { rebindShortcut, resolveShortcut } = await load();
    // swap Fillet (F) and Chamfer (B): clear one, then both moves are free
    expect(rebindShortcut("m.fillet", { key: "b", shift: false }).ok).toBe(false);
    rebindShortcut("m.chamfer", null);
    expect(rebindShortcut("m.fillet", { key: "b", shift: false }).ok).toBe(true);
    expect(rebindShortcut("m.chamfer", { key: "f", shift: false }).ok).toBe(true);
    expect(resolveShortcut("b", false, "model")).toBe("fillet");
    expect(resolveShortcut("f", false, "model")).toBe("chamfer");
  });

  it("restores one entry", async () => {
    const { rebindShortcut, resetShortcut, resolveShortcut, isShortcutOverridden } = await load();
    rebindShortcut("m.fillet", { key: "g", shift: false });
    expect(isShortcutOverridden("m.fillet")).toBe(true);
    resetShortcut("m.fillet");
    expect(isShortcutOverridden("m.fillet")).toBe(false);
    expect(resolveShortcut("f", false, "model")).toBe("fillet");
  });

  it("restores everything", async () => {
    const { rebindShortcut, resetAllShortcuts, resolveShortcut } = await load();
    rebindShortcut("m.fillet", { key: "g", shift: false });
    rebindShortcut("s.trim", null);
    resetAllShortcuts();
    expect(resolveShortcut("f", false, "model")).toBe("fillet");
    expect(resolveShortcut("t", false, "sketch")).toBe("trim");
  });

  it("records no override when the binding equals the default", async () => {
    const { rebindShortcut, isShortcutOverridden } = await load();
    rebindShortcut("m.fillet", { key: "g", shift: false });
    rebindShortcut("m.fillet", { key: "f", shift: false });
    expect(isShortcutOverridden("m.fillet")).toBe(false);
  });
});

describe("persistence", () => {
  it("survives a reload", async () => {
    const first = await load();
    first.rebindShortcut("m.fillet", { key: "g", shift: false });
    first.rebindShortcut("s.trim", null);

    const second = await load(); // fresh module, same storage
    expect(second.resolveShortcut("g", false, "model")).toBe("fillet");
    expect(second.resolveShortcut("f", false, "model")).toBeNull();
    expect(second.resolveShortcut("t", false, "sketch")).toBeNull();
    expect(second.isShortcutOverridden("s.trim")).toBe(true);
  });

  it("does not write an untouched map", async () => {
    const { resolveShortcut } = await load();
    resolveShortcut("f", false, "model");
    expect(storage.getItem("sindricad.shortcuts.v1")).toBeNull();
  });

  it("survives a reset across a reload", async () => {
    const first = await load();
    first.rebindShortcut("m.fillet", { key: "g", shift: false });
    first.resetAllShortcuts();
    const second = await load();
    expect(second.resolveShortcut("f", false, "model")).toBe("fillet");
    expect(second.resolveShortcut("g", false, "model")).toBeNull();
  });
});

describe("tolerant load", () => {
  const stored = (overrides: unknown) =>
    storage.setItem("sindricad.shortcuts.v1", JSON.stringify({ version: 1, overrides }));

  it("ignores unparseable storage", async () => {
    storage.setItem("sindricad.shortcuts.v1", "{not json");
    const { resolveShortcut } = await load();
    expect(resolveShortcut("f", false, "model")).toBe("fillet");
  });

  it("drops an id we no longer ship instead of carrying it forever", async () => {
    stored({ "m.retiredtool": { key: "g", shift: false } });
    const { rebindShortcut, resolveShortcut } = await load();
    expect(resolveShortcut("g", false, "model")).toBeNull();
    expect(resolveShortcut("f", false, "model")).toBe("fillet");
    // and the orphan is gone the next time we write, rather than riding along
    // in the user's storage for the life of the install
    rebindShortcut("m.fillet", { key: "y", shift: false });
    expect(storage.getItem("sindricad.shortcuts.v1")).not.toContain("retiredtool");
  });

  it("falls back to the default for a malformed binding, keeping the good ones", async () => {
    // The last entry is well-formed and later in table order than the broken
    // ones on purpose: a load that rejects per-entry keeps it, a load that
    // throws part-way through the map silently loses it along with the rest.
    stored({
      "m.fillet": { shift: true },
      "m.chamfer": "g",
      "m.move": { key: "" },
      "m.split": { key: "y", shift: false },
    });
    const { resolveShortcut } = await load();
    expect(resolveShortcut("f", false, "model")).toBe("fillet");
    expect(resolveShortcut("b", false, "model")).toBe("chamfer");
    expect(resolveShortcut("m", false, "model")).toBe("move");
    expect(resolveShortcut("y", false, "model")).toBe("split");
  });

  it("keeps a stored null as unbound rather than falling back", async () => {
    stored({ "m.fillet": null });
    const { resolveShortcut, bindingOf, SHORTCUTS } = await load();
    expect(resolveShortcut("f", false, "model")).toBeNull();
    expect(bindingOf(SHORTCUTS.find((s) => s.id === "m.fillet")!)).toBeNull();
  });
});

describe("normalizeKey", () => {
  it("drops shift on a symbol that only exists shifted", async () => {
    const { normalizeKey } = await load();
    expect(normalizeKey({ key: "?", shiftKey: true })).toEqual({ key: "?", shift: false });
  });

  it("keeps shift on a letter and lowercases it", async () => {
    const { normalizeKey } = await load();
    expect(normalizeKey({ key: "H", shiftKey: true })).toEqual({ key: "h", shift: true });
    expect(normalizeKey({ key: "h", shiftKey: false })).toEqual({ key: "h", shift: false });
  });

  it("agrees with the default `?` binding", async () => {
    const { normalizeKey, resolveShortcut } = await load();
    const b = normalizeKey({ key: "?", shiftKey: true });
    expect(resolveShortcut(b.key, b.shift, "model")).toBe("shortcut-help");
  });

  it("leaves a named key alone but lowercases it", async () => {
    const { normalizeKey } = await load();
    expect(normalizeKey({ key: "Home", shiftKey: false })).toEqual({ key: "home", shift: false });
  });
});

describe("keyHint", () => {
  it("follows an override", async () => {
    const { rebindShortcut, keyHint } = await load();
    expect(keyHint("fillet")).toBe("F");
    rebindShortcut("m.fillet", { key: "g", shift: false });
    expect(keyHint("fillet")).toBe("G");
  });

  it("skips a cleared entry and reports the next binding for the action", async () => {
    const { rebindShortcut, keyHint } = await load();
    expect(keyHint("fit")).toBe("Home");
    rebindShortcut("g.fit", null);
    expect(keyHint("fit")).toBe("F6"); // the alt entry still carries it
  });

  it("formats shift and named keys the way the menus print them", async () => {
    const { keyHint } = await load();
    expect(keyHint("show-all-bodies")).toBe("Shift+H");
    expect(keyHint("shortcut-help")).toBe("?");
  });
});
