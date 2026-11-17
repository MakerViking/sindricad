// Shell opens every face the user picks, not only the first (GH #78).
//
// Reported: "When using the shell command and selecting multiple faces it will
// only shell the first face selected and the rest are ignored." Two ways in:
// faces already selected when Shell starts, and faces clicked while the
// thickness box is open. Each is observed at the EFFECT, the `faces` of the
// feature that lands in the document, through the same canvas listeners a real
// click goes through.

import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";
import { createFeatureStarters } from "./featureStarters";
import type { Selector } from "../types";

vi.mock("../ui/prompt", () => ({ setPrompt: () => {} }));
vi.mock("../ui/toast", () => ({ toast: () => {} }));

// The thickness box: commit() stands in for the user pressing Enter on 3 mm.
const box = { commit: () => {}, cancel: () => {} };
vi.mock("../sketch/dimInput", () => ({
  DimInput: class {
    show(_f: unknown, onCommit: () => void, onCancel: () => void) {
      box.commit = onCommit;
      box.cancel = onCancel;
    }
    getValue() { return 3; }
    hide() {}
    position() {}
    seed() {}
    focus() {}
  },
}));

(globalThis as unknown as { window: unknown }).window ??= {
  addEventListener() {},
  removeEventListener() {},
};
(globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = (cb: () => void) => cb();

type Hit = { selector: Selector; faceId: number; normal: THREE.Vector3; anchor: THREE.Vector3; bodyId: string | null };
const face = (faceId: number, bodyId: string): Hit => ({
  selector: { kind: "face", by: "nearest", point: [faceId, 0, 0] },
  faceId,
  normal: new THREE.Vector3(0, 0, 1),
  anchor: new THREE.Vector3(faceId, 0, 0),
  bodyId,
});

function harness(pre: Hit[] | null) {
  const added: { type: string; faces?: Selector | Selector[]; thickness?: number }[] = [];
  const listeners: { type: string; fn: (e: PointerEvent) => void; capture: boolean }[] = [];
  const selected = new Set<number>();
  let underCursor: Hit | null = null;
  const deps = {
    store: {
      nextId: () => "new1",
      addFeature: (f: (typeof added)[number]) => added.push(f),
      document: { features: [] },
      buildState: { result: { bodies: [{ id: "body1" }, { id: "body2" }] } },
    },
    viewport: {
      suspendPicking: false,
      selectedFacesForPressPull: () => pre && {
        selectors: pre.map((h) => h.selector),
        faceIds: pre.map((h) => h.faceId),
        normal: pre[0]!.normal,
        anchor: pre[0]!.anchor,
        bodyId: pre[0]!.bodyId,
      },
      faceIdToBodyId: (fid: number) => pre?.find((h) => h.faceId === fid)?.bodyId ?? null,
      projectToScreen: () => ({ x: 100, y: 100 }),
      pickFaceForPressPull: () => underCursor,
      hoverFaceAt: () => {},
      clearHover: () => {},
      selectFaces: (ids: number[]) => ids.forEach((i) => selected.add(i)),
      deselectFaces: (ids: number[]) => ids.forEach((i) => selected.delete(i)),
    },
    canvas: {
      addEventListener: (type: string, fn: (e: PointerEvent) => void, capture?: boolean) =>
        listeners.push({ type, fn, capture: !!capture }),
      removeEventListener: (type: string, fn: unknown) => {
        const k = listeners.findIndex((l) => l.type === type && l.fn === fn);
        if (k >= 0) listeners.splice(k, 1);
      },
    },
    toolBusy: () => false,
    hasBody: () => true,
    setStatus: () => {},
    setPlanePick: () => {},
  };
  const click = (hit: Hit) => {
    underCursor = hit;
    const e = { button: 0, clientX: 1, clientY: 1, preventDefault() {}, stopImmediatePropagation() {} };
    for (const l of [...listeners]) if (l.type === "pointerdown") l.fn(e as unknown as PointerEvent);
  };
  return { starters: createFeatureStarters(deps as never), added, click, selected, listeners };
}

const openings = (f: { faces?: Selector | Selector[] } | undefined): (Selector & { point?: number[] })[] =>
  f?.faces === undefined ? [] : Array.isArray(f.faces) ? f.faces : [f.faces];

describe("Shell with several faces already selected", () => {
  it("opens all of them, each on the body that owns it", () => {
    const { starters, added } = harness([face(10, "body1"), face(11, "body2")]);
    starters.startShell();
    box.commit();
    expect(added).toHaveLength(1);
    expect(openings(added[0]).map((s) => [s.point, s.body])).toEqual([
      [[10, 0, 0], "body1"],
      [[11, 0, 0], "body2"],
    ]);
    expect(added[0]!.thickness).toBe(3);
  });
});

describe("Shell picking its faces", () => {
  it("adds a face clicked while the thickness box is open", () => {
    const { starters, added, click } = harness(null);
    starters.startShell();
    click(face(10, "body1")); // the pick that opens the box
    click(face(11, "body1")); // a second opening
    box.commit();
    expect(openings(added[0]).map((s) => s.point)).toEqual([[10, 0, 0], [11, 0, 0]]);
  });

  it("takes a face out again on a second click, but never the last one", () => {
    const { starters, added, click } = harness(null);
    starters.startShell();
    click(face(10, "body1"));
    click(face(11, "body1"));
    click(face(11, "body1")); // out again
    click(face(10, "body1")); // the last opening stays
    box.commit();
    expect(openings(added[0]).map((s) => s.point)).toEqual([[10, 0, 0]]);
  });

  it("keeps the single-selector form for one face, as older documents have it", () => {
    const { starters, added, click } = harness(null);
    starters.startShell();
    click(face(10, "body1"));
    box.commit();
    expect(Array.isArray(added[0]!.faces)).toBe(false);
  });

  it("stops listening and clears its highlight when the box closes", () => {
    const { starters, click, selected, listeners } = harness(null);
    starters.startShell();
    click(face(10, "body1"));
    click(face(11, "body1"));
    expect([...selected].sort()).toEqual([10, 11]);
    box.cancel();
    expect(selected.size).toBe(0);
    expect(listeners.filter((l) => l.type === "pointerdown")).toHaveLength(0);
  });
});
