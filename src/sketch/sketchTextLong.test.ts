// "If I do just one word or small sentence it's ok, but I have more text than
// that for the card, and then nothing shows up."
//
// Two ways a sketch text showed nothing, both reproduced in the real app:
//
// 1. Every keystroke sent its own `tessellateText`, and the sidecar answers them
//    one at a time, in order, each costing time in proportion to the whole
//    string. A 175-character card typed into a rectangle at 150 ms a key went
//    blank from about character 40 and appeared 72 s after Add.
// 2. A font with no glyph for one character (🎉 on a birthday card) refuses the
//    whole string. The client turned that refusal into an empty list and cached
//    it: no outline, no message, until Finish Sketch turned the sketch red.
//
// And two ways the fix itself still lost a text, found in review in the real app:
//
// 3. A text the font refuses drew nothing, and glyphs were all the sketch could
//    hit, so after Add it could not be selected, dragged or reopened: the message
//    said "edit it" about a text nobody could reach. It now gets a frame.
// 4. Dragging a card-length text drew nothing for the whole drag, because each
//    frame is a new anchor and a reply takes longer than a frame.
//
// Everything here goes in where the user does: the real SketchMode text flow
// (openTextPanel, the call endDrag makes for a click with the Text tool), the
// real TextPanel typed into key by key, the real refresh -> curveObjects ->
// warmText path, the real select-tool press and release, and the real Geometry
// client on a socket. Only the sidecar is fake, and it behaves like server.py:
// one request at a time, in arrival order, replying with the same envelope,
// including the coded refusal.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ui/toast", () => ({ toast: vi.fn(() => () => {}) }));

import * as THREE from "three";
import { SketchMode } from "./sketchMode";
import { SketchPlane } from "./plane";
import { originGeometry } from "./origin";
import { TextPanel } from "./textPanel";
import { setTextBackend } from "./textCache";
import { translated } from "./pattern";
import { Geometry } from "../geometry/client";
import { FakeEl, installFakeDocument } from "../ui/fakeDom.testkit";
import { toast } from "../ui/toast";
import { t } from "../i18n";
import type { ResolvedEntity } from "./snap";

const PREVIEW = "__textpreview__";
const CARD =
  "Gratulerer med dagen, kjære Åse! Hipp hipp hurra for deg på 40-årsdagen. " +
  "Vi håper du får en fantastisk dag med masse kake, gaver og gode venner rundt deg. Klem fra Tom og Kari";
/** The sidecar's real refusal for 🎉 (font_coverage.coverage_message), verbatim. */
const NO_GLYPH =
  "Text: the font 'Arial' (this computer draws it with 'DejaVu Sans') has no glyph for 🎉 — " +
  "those characters would be embossed as empty boxes. No font installed on this computer covers " +
  "them — install one (for example Noto Sans CJK for Japanese, Chinese or Korean) and restart.";

type TextEnt = Extract<ResolvedEntity, { type: "text" }>;
type Reply = { ok: true; faces: unknown[] } | { ok: false; message: string; code?: string };

/** One request at a time, in arrival order: server.py takes a per-connection
 *  lock around every op. The cost model is the measured one, about 4 ms a
 *  character for text in a box (2 ms without), whatever the font. */
class FakeSidecar {
  private queue: { id: string; entity: TextEnt }[] = [];
  private working = false;
  requests: TextEnt[] = [];
  /** the most requests ever waiting or running at once */
  mostOutstanding = 0;
  /** what to answer instead of outlines, decided per request */
  answer: (e: TextEnt) => Reply = (e) => ({ ok: true, faces: glyphs(e) });

  constructor(private socket: FakeSocket) {}

  receive(raw: string) {
    const m = JSON.parse(raw) as { id: string; op: string; entity: TextEnt };
    if (m.op !== "tessellateText") return;
    this.requests.push(m.entity);
    this.queue.push({ id: m.id, entity: m.entity });
    this.mostOutstanding = Math.max(this.mostOutstanding, this.queue.length + (this.working ? 1 : 0));
    this.pump();
  }

  get outstanding() {
    return this.queue.length + (this.working ? 1 : 0);
  }

  private pump() {
    if (this.working) return;
    const next = this.queue.shift();
    if (!next) return;
    this.working = true;
    const perChar = next.entity.boxWidth ? 4 : 2;
    setTimeout(() => {
      this.working = false;
      const r = this.answer(next.entity);
      const reply = r.ok
        ? { id: next.id, ok: true, result: { faces: r.faces } }
        : { id: next.id, ok: false, error: { message: r.message, ...(r.code ? { code: r.code } : {}) } };
      this.socket.onmessage?.({ data: JSON.stringify(reply) });
      this.pump();
    }, 2 + perChar * next.entity.text.length);
  }
}

/** One square per visible character, placed at the entity's anchor the way the
 *  sidecar places real glyphs. */
function glyphs(e: TextEnt) {
  const out = [];
  let i = 0;
  for (const ch of e.text) {
    if (ch.trim()) {
      const x = e.x + i * 6, y = e.y;
      out.push({ outer: [[x, y], [x + 5, y], [x + 5, y + 8], [x, y + 8], [x, y]], holes: [] });
    }
    i++;
  }
  return out;
}

class FakeSocket {
  static readonly OPEN = 1;
  static last: FakeSocket | null = null;
  readyState = 1;
  binaryType = "";
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  sidecar = new FakeSidecar(this);
  constructor(public url: string) {
    FakeSocket.last = this;
  }
  send(raw: string) {
    this.sidecar.receive(raw);
  }
  close() {}
}

/** Enough DOM for the panel (see textPanel.test.ts): buttons with a caption
 *  span, document-level key listeners, a window and `new Option`. */
function installPanelDom() {
  const makeEl = (tag: string): FakeEl => {
    const el = new FakeEl(tag);
    Object.defineProperty(el, "innerHTML", {
      get: () => "",
      set(html: string) {
        el.children.length = 0;
        if (html.includes("<span>")) el.children.push(new FakeEl("span"));
      },
    });
    return Object.assign(el, { remove() {} });
  };
  installFakeDocument({ prompt: makeEl("div") });
  const doc = globalThis.document as unknown as Record<string, unknown>;
  doc.createElement = makeEl;
  doc.addEventListener = () => {};
  doc.removeEventListener = () => {};
  vi.stubGlobal("window", {
    innerWidth: 1280,
    innerHeight: 900,
    addEventListener() {},
    removeEventListener() {},
    setTimeout: (...a: unknown[]) => (globalThis.setTimeout as never as (...x: unknown[]) => number)(...a),
    clearTimeout: (...a: unknown[]) => (globalThis.clearTimeout as never as (...x: unknown[]) => void)(...a),
  });
  vi.stubGlobal("Option", class extends FakeEl {
    constructor(text: string, value = "") {
      super("option");
      this.textContent = text;
      this.value = value;
    }
  });
}

interface TextFlow {
  entities: ResolvedEntity[];
  selected: Set<string>;
  tool: string;
  lastPress: unknown;
  textPanel: TextPanel;
  openTextPanel(click: THREE.Vector2, screen: { x: number; y: number }, box?: unknown, edit?: unknown, phi?: number): void;
  redraw(): void;
  refreshDragGeometry(): void;
  onPointerDown(e: PointerEvent): void;
  endDrag(pointerId?: number): void;
}

/** Screen pixels per plane millimetre for the select-tool presses. */
const PX = 10;
const pointer = (x: number, y: number) =>
  ({
    button: 0, clientX: x * PX, clientY: y * PX, pointerId: 1,
    shiftKey: false, ctrlKey: false, metaKey: false,
    preventDefault() {}, stopPropagation() {},
  }) as unknown as PointerEvent;

/** Is this one of the dashed frames a text that draws nothing gets? */
const isFrame = (o: THREE.Object3D) => (o as { material?: { dashed?: boolean } }).material?.dashed === true;

/** A SketchMode whose drawing surfaces are stubs and whose text flow, panel and
 *  refresh are real. `drawn()` is what the last refresh put on screen. */
function sketchWithText(extra: ResolvedEntity[] = []) {
  installPanelDom();
  vi.stubGlobal("WebSocket", FakeSocket);
  const geometry = new Geometry("ws://127.0.0.1:8750");
  (geometry as unknown as { connect(): void }).connect();
  const sidecar = FakeSocket.last!.sidecar;
  running = sidecar;

  let drawn: THREE.Object3D[] = [];
  const s = Object.create(SketchMode.prototype) as TextFlow;
  Object.assign(s, {
    active: true,
    tool: "text",
    plane: new SketchPlane("XY"),
    entities: [...originGeometry(), ...extra],
    constraints: [],
    patterns: [],
    selected: new Set<string>(),
    fonts: ["DejaVu Sans", "Noto Sans"],
    textPanel: new TextPanel(),
    constructionMode: false,
    dimPicks: [],
    dimsVisible: false,
    glyphsVisible: false,
    conflict: false,
    lastDof: -1,
    entityVersion: 0,
    cdims: [],
    conflictIdx: new Set<number>(),
    overIdx: new Set<number>(),
    patternFlow: { pending: null },
    dims: { hide() {}, clearSelection() {} },
    glyphs: { hide() {} },
    overlay: {
      setActiveSketch: (objs: THREE.Object3D[]) => { drawn = objs; },
      setActiveRegions() {},
      clearRegionSelection() {},
      setPreview() {},
      activeRegionAt: () => null,
      // glyph hits come from the region layer, which this harness does not
      // build; a text that draws nothing has no glyph regions anyway
      activeTextIdAt: () => null,
    },
    viewport: {
      pixelWorldSize: () => 0.1,
      requestRender() {},
      domElement: { setPointerCapture() {}, releasePointerCapture() {} },
      rig: { active: new THREE.Object3D() },
    },
    // the select tool's press and release, as liveSketch.testkit.ts sets them up
    lastPress: null,
    moveDrag: null,
    dragFrom: null,
    boxSel: null,
    textBoxStart: null,
    detachArmed: null,
    planePointAt: (cx: number, cy: number) => new THREE.Vector2(cx / PX, cy / PX),
    snapAt: (cx: number, cy: number) => ({ p: new THREE.Vector2(cx / PX, cy / PX), kind: "free" }),
    requestSolve() {},
  });
  // main.ts wires the same thing: a landed outline repaints the open sketch
  setTextBackend(geometry, () => s.redraw());

  const root = () => (globalThis.document as unknown as { body: FakeEl }).body.children.at(-1)!;
  const find = (el: FakeEl, tag: string, cls?: string): FakeEl | undefined => {
    for (const c of el.children) {
      if (c.tagName === tag && (cls === undefined || c.className === cls)) return c;
      const hit = find(c, tag, cls);
      if (hit) return hit;
    }
    return undefined;
  };
  const textOf = (id: string) => s.entities.find((e) => e.id === id && e.type === "text") as TextEnt | undefined;
  const committed = () => s.entities.filter((e): e is TextEnt => e.type === "text" && e.id !== PREVIEW);
  return {
    s,
    sidecar,
    /** a click with the Text tool at plane (x, y) */
    clickText(x: number, y: number) {
      s.openTextPanel(new THREE.Vector2(x, y), { x: 100, y: 100 }, undefined, undefined, 0);
    },
    /** the textarea, typed into the way the browser delivers it */
    type(text: string) {
      const ta = find(root(), "textarea")!;
      ta.value = text;
      ta.dispatch("input");
    },
    pickFont(family: string) {
      const sel = find(root(), "select")!;
      sel.value = family;
      sel.dispatch("change");
    },
    add() {
      const btn = find(root(), "button")!;
      btn.dispatch("pointerdown", { preventDefault() {}, stopPropagation() {} });
    },
    cancel() {
      const buttons: FakeEl[] = [];
      const all = (el: FakeEl) => { for (const c of el.children) { if (c.tagName === "button") buttons.push(c); all(c); } };
      all(root());
      buttons[1]!.dispatch("pointerdown", { preventDefault() {}, stopPropagation() {} });
    },
    /** what the text box holds */
    typed(): string {
      return find(root(), "textarea")?.value ?? "";
    },
    /** a select-tool press and release at plane (x, y), a fresh gesture each time */
    click(x: number, y: number) {
      s.lastPress = null;
      s.onPointerDown(pointer(x, y));
      s.endDrag(1);
    },
    /** two presses at plane (x, y), close enough in time and place to be a double-click */
    doubleClick(x: number, y: number) {
      s.lastPress = null;
      s.onPointerDown(pointer(x, y));
      s.endDrag(1);
      s.onPointerDown(pointer(x, y));
      s.endDrag(1);
    },
    /** what the panel says under the text, or "" when it says nothing */
    panelSays(): string {
      const el = find(root(), "div", "tool-panel-warn");
      return el && el.style.display !== "none" ? el.textContent : "";
    },
    /** how many glyph contours are on screen for entity `id` (the fake draws one per character) */
    glyphsDrawn(id: string): number {
      let n = 0;
      for (const o of drawn) {
        if (o.userData.entityId !== id || !textOf(id) || isFrame(o)) continue;
        o.traverse((c) => { if ((c.userData as { pts?: unknown }).pts) n++; });
      }
      return n;
    },
    /** the glyph outline on screen for entity `id`, as plane points (empty: nothing drawn) */
    outline(id: string): THREE.Vector3[] {
      const pts: THREE.Vector3[] = [];
      for (const o of drawn) {
        if (o.userData.entityId !== id || !textOf(id) || isFrame(o)) continue;
        o.traverse((c) => { pts.push(...((c.userData as { pts?: THREE.Vector3[] }).pts ?? [])); });
      }
      return pts;
    },
    /** the frame drawn in place of a text that draws nothing (empty: none) */
    frame(id: string): THREE.Vector3[] {
      const o = drawn.find((d) => d.userData.entityId === id && textOf(id) && isFrame(d));
      return o ? [...((o.userData as { pts?: THREE.Vector3[] }).pts ?? [])] : [];
    },
    committed,
  };
}

/** The fake sidecar of the test in progress, drained after it. */
let running: FakeSidecar | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(toast).mockClear();
});

afterEach(async () => {
  // Let every request finish even when the test failed: textCache is module
  // state, and a text left "being drawn" would hold back the next test's.
  if (running) await drain(running);
  running = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Let `ms` pass a step at a time, so replies and the repaints they trigger run. */
async function wait(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

/** Let every request still in the fake sidecar finish. */
async function drain(sidecar: FakeSidecar) {
  for (let i = 0; i < 2000 && sidecar.outstanding; i++) await wait(100);
}

describe("a card-length sketch text stays on screen (the reported bug)", () => {
  it("draws a 175-character card in a rectangle while it is typed, and right after Add", async () => {
    const card = CARD;
    expect(card.length).toBe(175);
    const live = sketchWithText([{ type: "rectangle", id: "e900", x: 0, y: 0, width: 90, height: 60 }]);
    live.clickText(0, 0); // inside the rectangle: the text is bound into it, centred and wrapped
    expect(live.panelSays()).toBe("");

    const blankAt: number[] = [];
    const behind: string[] = [];
    for (let i = 1; i <= card.length; i++) {
      live.type(card.slice(0, i));
      await wait(150); // a normal typing pace
      if (i > 5 && live.outline(PREVIEW).length === 0) blankAt.push(i);
      // Keeping up, not just showing something: an outline frozen at character
      // 37 is not blank, and the first cut of this fix did exactly that. At the
      // end a request takes 702 ms, about 5 keys, and the preview may be up to
      // two of those behind.
      const typed = card.slice(0, i).replace(/\s/g, "").length;
      if (live.glyphsDrawn(PREVIEW) < typed - 15) behind.push(`${live.glyphsDrawn(PREVIEW)}/${typed}`);
    }
    // On 40d6b68 the preview went blank from about character 40 to the end.
    expect(blankAt, `the preview was blank at characters ${blankAt.slice(0, 10).join(", ")}...`).toEqual([]);
    expect(behind, `glyphs drawn / typed: ${behind.slice(0, 8).join(", ")}...`).toEqual([]);
    // Keystrokes that land while the text is being drawn are skipped, never queued.
    expect(live.sidecar.mostOutstanding).toBe(1);
    expect(live.sidecar.requests.length).toBeLessThan(card.length);

    const before = Date.now();
    live.add();
    const [text] = live.committed();
    expect(text?.text).toBe(card);
    while (live.outline(text!.id).length === 0 && Date.now() - before < 120_000) await wait(50);
    const shownAfter = Date.now() - before;
    // One reply in flight plus the final one, at 702 ms each for this card. On
    // 40d6b68 the committed text waited behind every keystroke still queued.
    expect(shownAfter, `the card appeared ${shownAfter} ms after Add`).toBeLessThan(2000);
    expect(live.panelSays()).toBe("");
    expect(toast).not.toHaveBeenCalled();
  });

  it("keeps showing the card while a later keystroke is still on its way", async () => {
    const live = sketchWithText();
    live.clickText(0, 20);
    const card = CARD.slice(0, 120);
    live.type(card);
    await wait(2000);
    const settled = live.outline(PREVIEW).length;
    expect(settled).toBeGreaterThan(0);
    live.type(card + "!");
    await wait(1); // the request for the new text is in flight, not answered
    expect(live.outline(PREVIEW).length).toBe(settled);
  });

  it("draws two identical texts each at its own anchor", async () => {
    const live = sketchWithText();
    for (const y of [0, -40]) {
      live.clickText(0, y);
      live.type("Hei Åse");
      await wait(500);
      live.add();
      await wait(500);
    }
    const [a, b] = live.committed();
    const ys = (id: string) => live.outline(id).map((p) => p.y);
    expect(Math.min(...ys(a!.id))).toBeCloseTo(0);
    // On 40d6b68 the cache key left the anchor out, so the second text was drawn
    // on top of the first and the user saw one.
    expect(Math.min(...ys(b!.id))).toBeCloseTo(-40);
  });
});

describe("a text the font cannot draw says why instead of showing nothing", () => {
  it("names the character in the panel while typing, and again after Add", async () => {
    const live = sketchWithText();
    live.sidecar.answer = (e) =>
      e.text.includes("🎉") && !e.font
        ? { ok: false, message: NO_GLYPH, code: "fontMissingGlyphs" }
        : { ok: true, faces: glyphs(e) };
    live.clickText(0, 60);
    live.type("Gratulerer med dagen Åse! ");
    await wait(500);
    expect(live.outline(PREVIEW).length).toBeGreaterThan(0);
    expect(live.panelSays()).toBe("");

    live.type("Gratulerer med dagen Åse! 🎉");
    await wait(500);
    // the font's refusal, word for word: the character, and what to do about it
    expect(live.panelSays()).toBe(NO_GLYPH);
    // no glyphs for a text that will not build, only a frame where it would be
    expect(live.outline(PREVIEW)).toEqual([]);
    expect(live.frame(PREVIEW).length).toBeGreaterThan(0);

    // another keystroke keeps the reason up while it is checked again
    live.type("Gratulerer med dagen Åse! 🎉 ");
    expect(live.panelSays()).toBe(NO_GLYPH);
    await wait(500);
    expect(live.panelSays()).toBe(NO_GLYPH);

    // Add anyway: the sketch says it once, where the panel was
    live.add();
    await wait(500);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(NO_GLYPH, { kind: "error" });
    await wait(1000); // repaints do not repeat it
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it("is not remembered once the text or the font changes", async () => {
    const live = sketchWithText();
    live.sidecar.answer = (e) =>
      e.text.includes("🎉") && !e.font
        ? { ok: false, message: NO_GLYPH, code: "fontMissingGlyphs" }
        : { ok: true, faces: glyphs(e) };
    live.clickText(0, 100);
    live.type("Klem 🎉");
    await wait(500);
    expect(live.panelSays()).toBe(NO_GLYPH);

    live.pickFont("Noto Sans"); // a font that has the glyph
    await wait(500);
    expect(live.panelSays()).toBe("");
    expect(live.outline(PREVIEW).length).toBeGreaterThan(0);

    live.pickFont(""); // back to the default font: still refused, and still said
    await wait(500);
    expect(live.panelSays()).toBe(NO_GLYPH);

    live.type("Klem"); // without the emoji the default font draws it
    await wait(500);
    expect(live.panelSays()).toBe("");
    expect(live.outline(PREVIEW).length).toBeGreaterThan(0);
  });

  it("asks again after a failure that said nothing about the text", async () => {
    const live = sketchWithText();
    let down = true;
    live.sidecar.answer = (e) =>
      down ? { ok: false, message: t("engine.error.connectionLost") } : { ok: true, faces: glyphs(e) };
    live.clickText(0, 140);
    live.type("Til mamma");
    await wait(500);
    // not "edit it or pick another font": neither would help with the engine away
    expect(live.panelSays()).toBe(
      t("sketch.text.notDrawnRetry", { reason: t("engine.error.connectionLost") }),
    );
    expect(live.outline(PREVIEW)).toEqual([]);

    // Add it while the engine is away: the panel said so, but a toast per text
    // would repeat the app's own engine-down notice for every text in the sketch.
    live.add();
    await wait(500);
    expect(toast).not.toHaveBeenCalled();
    const [text] = live.committed().filter((e) => e.text === "Til mamma");

    // The engine is back. On 40d6b68 the failure was cached as "no outlines" for
    // good, so this exact text never drew again until it was changed.
    down = false;
    await wait(6000);
    live.s.redraw(); // any repaint: a hover, a pan, another sketch edit
    await wait(500);
    expect(live.outline(text!.id).length).toBeGreaterThan(0);
  });
});

/** The default font has no 🎉; Noto Sans does. */
const refuseEmojiInDefaultFont = (e: TextEnt): Reply =>
  e.text.includes("🎉") && !e.font
    ? { ok: false, message: NO_GLYPH, code: "fontMissingGlyphs" }
    : { ok: true, faces: glyphs(e) };

describe("a text that draws nothing can still be reached", () => {
  it("can be selected, reopened with its reason, and fixed after Add", async () => {
    const live = sketchWithText();
    live.sidecar.answer = refuseEmojiInDefaultFont;
    const dismissToast = vi.fn();
    vi.mocked(toast).mockImplementationOnce(() => dismissToast);
    live.clickText(0, 200);
    live.type("Gratulerer med dagen Åse 🎉");
    await wait(500);
    live.add();
    await wait(500);
    expect(toast).toHaveBeenCalledTimes(1);
    const [text] = live.committed().filter((e) => e.text.includes("🎉"));

    // No glyphs, but a frame where the text would be: left-aligned on its anchor,
    // centred on it vertically.
    expect(live.outline(text!.id)).toEqual([]);
    const frame = live.frame(text!.id);
    expect(frame.length).toBeGreaterThan(0);
    const xs = frame.map((p) => p.x), ys = frame.map((p) => p.y);
    expect(Math.min(...xs)).toBeCloseTo(0);
    expect(Math.max(...xs)).toBeGreaterThan(100);
    expect(Math.min(...ys)).toBeLessThan(200);
    expect(Math.max(...ys)).toBeGreaterThan(200);

    // A click on it selects it. Before the frame, nothing was under the cursor:
    // the press began a marquee and selected nothing.
    live.s.tool = "select";
    live.click(20, 200);
    expect([...live.s.selected]).toEqual([text!.id]);

    // A double-click reopens it, and says why before the first keystroke: what
    // the toast told the user to come back and fix.
    live.doubleClick(20, 200);
    expect(live.s.textPanel.isActive).toBe(true);
    expect(live.typed()).toBe("Gratulerer med dagen Åse 🎉");
    expect(live.panelSays()).toBe(NO_GLYPH);
    // the panel says it now, so the toast (which sits where Add tends to be) goes
    expect(dismissToast).toHaveBeenCalledTimes(1);

    live.pickFont("Noto Sans");
    await wait(500);
    expect(live.panelSays()).toBe("");
    live.add();
    await wait(500);
    const [fixed] = live.committed().filter((e) => e.text.includes("🎉"));
    expect(fixed!.id).toBe(text!.id);
    expect(fixed!.font).toBe("Noto Sans");
    expect(live.outline(fixed!.id).length).toBeGreaterThan(0);
    expect(live.frame(fixed!.id)).toEqual([]);
    expect(toast).toHaveBeenCalledTimes(1); // and the fix raised nothing new
  });

  it("does not toast again while a refused text is dragged", async () => {
    const live = sketchWithText();
    live.sidecar.answer = refuseEmojiInDefaultFont;
    live.clickText(0, 260);
    live.type("Klem 🎉");
    await wait(500);
    live.add();
    await wait(500);
    expect(toast).toHaveBeenCalledTimes(1);
    const id = live.committed().find((e) => e.text === "Klem 🎉")!.id;
    for (let i = 1; i <= 8; i++) {
      const at = live.s.entities.findIndex((e) => e.id === id);
      live.s.entities[at] = translated(live.s.entities[at]!, 5, 0, id);
      live.s.refreshDragGeometry();
      // the frame goes with it, frame by frame
      expect(Math.min(...live.frame(id).map((p) => p.x))).toBeCloseTo(5 * i);
      await wait(100);
    }
    live.s.redraw(); // the release
    await wait(1000);
    expect(toast).toHaveBeenCalledTimes(1);
  });
});

describe("a card-length text stays on screen while it is dragged", () => {
  it("draws it at every frame of the drag, exactly where it is", async () => {
    const live = sketchWithText();
    live.clickText(0, -100);
    live.type(CARD);
    await wait(1000);
    live.add();
    const id = live.committed().find((e) => e.text === CARD)!.id;
    while (live.outline(id).length === 0) await wait(50);
    const minX = (pts: THREE.Vector3[]) => Math.min(...pts.map((p) => p.x));
    const minY = (pts: THREE.Vector3[]) => Math.min(...pts.map((p) => p.y));
    const x0 = minX(live.outline(id)), y0 = minY(live.outline(id));

    // 8 frames of 100 ms, each moving it (5, -3.75): every frame is a new
    // anchor, and a reply for this card takes about 350 ms.
    const blank: number[] = [];
    for (let i = 1; i <= 8; i++) {
      const at = live.s.entities.findIndex((e) => e.id === id);
      live.s.entities[at] = translated(live.s.entities[at]!, 5, -3.75, id);
      live.s.refreshDragGeometry();
      const pts = live.outline(id);
      if (!pts.length) { blank.push(i); continue; }
      expect(minX(pts)).toBeCloseTo(x0 + 5 * i);
      expect(minY(pts)).toBeCloseTo(y0 - 3.75 * i);
      await wait(100);
    }
    // On the first cut of this fix it was blank at every frame and for about
    // 0.6 s after release.
    expect(blank, `blank at drag frames ${blank.join(", ")}`).toEqual([]);

    live.s.redraw(); // the release
    expect(minX(live.outline(id))).toBeCloseTo(x0 + 40);
    await drain(live.sidecar);
    // and once its own reply is in, it is the sidecar's outline at the new anchor
    expect(minX(live.outline(id))).toBeCloseTo(x0 + 40);
    expect(minY(live.outline(id))).toBeCloseTo(y0 - 30);
    expect(live.glyphsDrawn(id)).toBe(CARD.replace(/\s/g, "").length);
  });
});

describe("a new text starts from nothing", () => {
  it("does not show the text cancelled before it as its own preview", async () => {
    const live = sketchWithText([{ type: "rectangle", id: "e901", x: 0, y: 300, width: 90, height: 60 }]);
    live.clickText(0, 300); // both texts bind into the same rectangle: the same anchor
    live.type(CARD.slice(0, 120));
    await wait(1000);
    expect(live.glyphsDrawn(PREVIEW)).toBeGreaterThan(50);
    live.type(CARD.slice(0, 121)); // still being drawn when it is cancelled
    await wait(1);
    live.cancel();

    live.clickText(0, 300);
    live.type("B");
    await wait(1);
    // On the first cut this showed the cancelled card (50 glyphs) until B landed.
    expect(live.glyphsDrawn(PREVIEW)).toBe(0);
    await wait(1000);
    expect(live.glyphsDrawn(PREVIEW)).toBe(1);
  });
});
