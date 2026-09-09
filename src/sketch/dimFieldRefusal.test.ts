// A number the user TYPED and the app cannot read must never become a default.
//
// parseField is the one numeric entry point for the on-canvas dim box, and it is
// strict: "5mm", or a slipped "5m", is not a plain number, so `getValue` returns
// null and `DimInput.commit` drops the field from the committed record entirely.
// Every commit path in the sketch then read that field back through a `??`
// fallback — `getValue("radius") ?? 2` for Fillet, the cursor's own figure for
// the drawing tools, the pattern's current value for a hole grid — and built the
// FALLBACK. Typing 5 into the Radius box produced a 2 mm fillet, recorded it in
// the timeline, and said nothing at all.
//
// The rule these pin: a field the user typed into and that does not parse
// REFUSES the operation and says so; a field the user never opened still uses
// its default, because that is what a default is for. `isUserDriven` is the
// whole difference, so every test below comes in three: typed-and-unreadable
// (refuse), typed-and-readable (build what was typed), never-typed (default).
//
// These drive the REAL methods off SketchMode.prototype / a real PatternFlow —
// a real SketchMode needs WebGL. What is stubbed is the dim box, the overlay and
// the solve; never the guard, and never the geometry it protects.
// the guard's dispatch is asserted against the SOURCE (see the last describe);
// `?raw` is how vite hands a file to a test — "node:fs" does not typecheck here,
// this project ships no @types/node ("types": ["vite/client"]).
import sketchModeSource from "./sketchMode.ts?raw";

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as THREE from "three";

const { prompts, toasts } = vi.hoisted(() => ({
  prompts: [] as (string | null)[],
  toasts: [] as string[],
}));
vi.mock("../ui/prompt", () => ({ setPrompt: (m: string | null) => void prompts.push(m) }));
vi.mock("../ui/toast", () => ({ toast: (m: string) => void toasts.push(m) }));

import { SketchMode } from "./sketchMode";
import { PatternFlow } from "./patternFlow";
import { t } from "../i18n";
import { circumcenter } from "./arc";
import type { ResolvedEntity } from "./snap";
import type { SketchPattern } from "../types";

/** the private commit seams under test, plus the state they act on */
interface Priv {
  applyFillet(iA: number, iB: number): void;
  applyChamfer(iA: number, iB: number): void;
  commitFromCursor(cursor: THREE.Vector2): void;
  multiClickAt(p: THREE.Vector2): void;
  rotateClick(p: THREE.Vector2): void;
  scaleClick(p: THREE.Vector2): void;
  entities: ResolvedEntity[];
  filletFirst: number | null;
  clickPts: THREE.Vector2[];
}

const BAD = t("feature.badNumber");

/** one field's state on the on-canvas box: what the user did to it, and what
 *  `parseField` makes of the text that is in it now. */
type FieldState = { typed: boolean; value: number | null };

function fakeDim(fields: Record<string, FieldState>) {
  const seen = { hidden: 0, shown: 0 };
  let onCommit: (() => void) | null = null;
  return {
    seen,
    fire: () => onCommit?.(),
    isUserDriven: (n: string) => fields[n]?.typed ?? false,
    getValue: (n: string) => fields[n]?.value ?? null,
    hide: () => { seen.hidden++; },
    show: (_defs: unknown, c: () => void) => { seen.shown++; onCommit = c; },
    updateFromCursor: () => {},
    position: () => {},
    setClickThrough: () => {},
    focus: () => {},
  };
}

/** a SketchMode whose collaborators are stubs, with a right-angled corner at the
 *  origin: the two lines Fillet/Chamfer join. */
function makeMode(dim: ReturnType<typeof fakeDim>, over: Record<string, unknown> = {}) {
  const s = Object.create(SketchMode.prototype) as SketchMode & Record<string, never>;
  const calls = { afterModify: 0, refreshActive: 0, solve: 0, transformed: 0 };
  const entities: ResolvedEntity[] = [
    { type: "line", id: "a", x1: -40, y1: 0, x2: 0, y2: 0 },
    { type: "line", id: "b", x1: 0, y1: 0, x2: 0, y2: 40 },
  ];
  Object.assign(s, {
    entities, constraints: [], trial: null, filletFirst: 0, dim,
    tool: "select", clickPts: [], base: null, constructionMode: false,
    polygonSides: 6, selected: new Set<string>(), chainStart: null,
    basePinned: false, lastSnapKind: "free",
    lastCursor: new THREE.Vector2(),
    overlay: { setPreview: () => {} },
    afterModify: () => { calls.afterModify++; },
    refreshActive: () => { calls.refreshActive++; },
    requestSolve: () => { calls.solve++; },
    entityCurve: () => ({}),
    transformSelection: () => { calls.transformed++; },
    reid: (e: unknown) => [e],
    onState: () => {},
    ...over,
  });
  const priv = s as unknown as Priv;
  // applyFillet/applyChamfer REPLACE this.entities with a fresh array, so the
  // live list has to be read back off the mode; the array handed in above would
  // read "unchanged" forever and every refusal test would pass vacuously.
  return { s: priv, calls, live: () => priv.entities, seed: entities };
}

const arcs = (es: ResolvedEntity[]) => es.filter((e) => e.type === "arc");

/** an arc is stored as three points; its radius is the one thing a fillet is
 *  ABOUT, so read it rather than trusting that an arc appeared at all. */
function arcRadius(es: ResolvedEntity[]): number {
  const a = arcs(es)[0] as { x1: number; y1: number; mx: number; my: number; x2: number; y2: number } | undefined;
  if (!a) return NaN;
  const c = circumcenter({ x: a.x1, y: a.y1 }, { x: a.mx, y: a.my }, { x: a.x2, y: a.y2 });
  return c ? c.distanceTo(new THREE.Vector2(a.x1, a.y1)) : NaN;
}

/** the x where the horizontal leg was cut back from the corner at 0,0 */
const legCut = (es: ResolvedEntity[]) => (es.find((e) => e.id === "a") as { x2: number }).x2;

beforeEach(() => { prompts.length = 0; toasts.length = 0; });

describe("Fillet refuses a radius it cannot read", () => {
  it("does not build the 2 mm default when the typed radius is unreadable", () => {
    const dim = fakeDim({ radius: { typed: true, value: null } }); // the box holds "5mm"
    const { s, calls, live } = makeMode(dim);
    s.applyFillet(0, 1);
    // the whole defect: a 2 mm arc used to appear here, under a typed 5
    expect(arcs(live())).toHaveLength(0);
    expect(live()).toHaveLength(2);
    expect(calls.afterModify).toBe(0);
    expect(prompts).toContain(BAD);
    // the pick and the box stay live so the number can be fixed and re-entered
    expect(s.filletFirst).toBe(0);
    expect(dim.seen.hidden).toBe(0);
  });

  it("builds the radius that WAS readable", () => {
    const dim = fakeDim({ radius: { typed: true, value: 5 } });
    const { s, live } = makeMode(dim);
    s.applyFillet(0, 1);
    expect(arcs(live())).toHaveLength(1);
    expect(arcRadius(live())).toBeCloseTo(5, 6);
    expect(legCut(live())).toBeCloseTo(-5, 6); // the leg is trimmed to the tangent point
    expect(prompts).not.toContain(BAD);
  });

  it("still uses the 2 mm default for a box the user never opened", () => {
    // proves the guard keys on isUserDriven, and that the 2 mm fallback the
    // refusal test rules out is genuinely reachable from this same setup
    const dim = fakeDim({ radius: { typed: false, value: null } });
    const { s, live } = makeMode(dim);
    s.applyFillet(0, 1);
    expect(arcs(live())).toHaveLength(1);
    expect(arcRadius(live())).toBeCloseTo(2, 6);
  });
});

describe("Chamfer refuses a distance it cannot read", () => {
  it("does not build the 2 mm default when the typed distance is unreadable", () => {
    const dim = fakeDim({ distance: { typed: true, value: null } });
    const { s, calls, live, seed } = makeMode(dim);
    const before = seed.map((e) => JSON.stringify(e));
    s.applyChamfer(0, 1);
    expect(live().map((e) => JSON.stringify(e))).toEqual(before);
    expect(calls.afterModify).toBe(0);
    expect(prompts).toContain(BAD);
  });

  it("builds the distance that WAS readable, and the default when untyped", () => {
    const typed = makeMode(fakeDim({ distance: { typed: true, value: 8 } }));
    typed.s.applyChamfer(0, 1);
    // the chamfer cuts `distance` back along each line from the corner at 0,0
    expect(legCut(typed.live())).toBeCloseTo(-8, 6);

    const untouched = makeMode(fakeDim({ distance: { typed: false, value: null } }));
    untouched.s.applyChamfer(0, 1);
    expect(legCut(untouched.live())).toBeCloseTo(-2, 6);
  });
});

describe("the drawing tools refuse a size they cannot read", () => {
  it("Rectangle commits nothing when the typed width is unreadable", () => {
    const dim = fakeDim({ width: { typed: true, value: null }, height: { typed: false, value: null } });
    const { s, calls, live } = makeMode(dim, { entities: [], tool: "rectangle", base: new THREE.Vector2(0, 0) });
    s.commitFromCursor(new THREE.Vector2(30, 20));
    expect(live()).toHaveLength(0); // used to bank the 30 mm the CURSOR happened to be at
    expect(calls.refreshActive).toBe(0);
    expect(prompts).toContain(BAD);
  });

  it("Rectangle commits the typed width, and the cursor's when nothing was typed", () => {
    const typed = makeMode(fakeDim({ width: { typed: true, value: 12 }, height: { typed: false, value: null } }),
      { entities: [], tool: "rectangle", base: new THREE.Vector2(0, 0) });
    typed.s.commitFromCursor(new THREE.Vector2(30, 20));
    const a = typed.s.entities as { width: number; height: number }[];
    expect(a).toHaveLength(1);
    expect(a[0]?.width).toBeCloseTo(12, 6);
    expect(a[0]?.height).toBeCloseTo(20, 6); // never opened → the cursor still drives it

    const bare = makeMode(fakeDim({}), { entities: [], tool: "rectangle", base: new THREE.Vector2(0, 0) });
    bare.s.commitFromCursor(new THREE.Vector2(30, 20));
    expect((bare.s.entities as { width: number }[])[0]?.width).toBeCloseTo(30, 6);
  });

  it("Polygon commits nothing when the typed circumradius is unreadable", () => {
    const dim = fakeDim({ radius: { typed: true, value: null }, sides: { typed: false, value: null } });
    const { s, live } = makeMode(dim, { entities: [], tool: "polygon", clickPts: [new THREE.Vector2(0, 0)] });
    s.multiClickAt(new THREE.Vector2(9, 0));
    expect(live()).toHaveLength(0); // used to bank the cursor's 9 mm under a typed 20
    expect(prompts).toContain(BAD);
  });

  it("Polygon commits the typed circumradius", () => {
    const dim = fakeDim({ radius: { typed: true, value: 20 }, sides: { typed: false, value: null } });
    const { s, live } = makeMode(dim, { entities: [], tool: "polygon", clickPts: [new THREE.Vector2(0, 0)] });
    s.multiClickAt(new THREE.Vector2(9, 0));
    const es = live() as { radius: number }[];
    expect(es).toHaveLength(1);
    expect(es[0]?.radius).toBeCloseTo(20, 6);
  });
});

describe("Rotate and Scale refuse a figure they cannot read", () => {
  it("Rotate does not fall through to 0°", () => {
    const dim = fakeDim({ angle: { typed: true, value: null } });
    const { s, calls } = makeMode(dim, { selected: new Set(["a"]) });
    s.rotateClick(new THREE.Vector2(0, 0));
    dim.fire(); // Enter in the box
    expect(calls.transformed).toBe(0); // a silent no-op rotation is still a lie
    expect(dim.seen.hidden).toBe(0);
    expect(prompts).toContain(BAD);
  });

  it("Scale does not fall through to ×1", () => {
    const dim = fakeDim({ factor: { typed: true, value: null } });
    const { s, calls } = makeMode(dim, { selected: new Set(["a"]) });
    s.scaleClick(new THREE.Vector2(0, 0));
    dim.fire();
    expect(calls.transformed).toBe(0);
    expect(prompts).toContain(BAD);
  });

  it("Rotate still transforms when the angle IS readable", () => {
    const dim = fakeDim({ angle: { typed: true, value: 45 } });
    const { s, calls } = makeMode(dim, { selected: new Set(["a"]) });
    s.rotateClick(new THREE.Vector2(0, 0));
    dim.fire();
    expect(calls.transformed).toBe(1);
    expect(prompts).not.toContain(BAD);
  });
});

describe("a hole pattern refuses a count or diameter it cannot read", () => {
  function makeFlow(dim: ReturnType<typeof fakeDim>) {
    const patterns: SketchPattern[] = [];
    const tools: string[] = [];
    const flow = new PatternFlow({
      tool: () => "boltCircle",
      setActiveTool: () => {},
      setTool: (x: string) => { tools.push(x); },
      selected: () => new Set<string>(),
      patterns: () => patterns,
      dim: () => dim as never,
      refreshActive: () => {},
      onState: () => {},
    } as never);
    return { flow, patterns, tools };
  }

  it("does not commit the 6 mm default diameter when the typed one is unreadable", () => {
    const dim = fakeDim({ count: { typed: false, value: null }, diameter: { typed: true, value: null } });
    const { flow, patterns, tools } = makeFlow(dim);
    flow.click(new THREE.Vector2(0, 0)); // first click places it and opens the box
    flow.commit();
    expect(patterns).toHaveLength(0); // used to bank the 6 mm default under a typed 12
    expect(flow.hasPending()).toBe(true); // still pending, so the number can be fixed
    expect(tools).toHaveLength(0); // and the tool did NOT finish
    expect(prompts).toContain(BAD);
  });

  it("refuses a diameter that reads but is not a legal size", () => {
    // 0 and -5 both PARSE, so the unreadable-input guard waved them through and
    // they were written straight into the pattern feature. A hole of diameter
    // zero is not a hole and a negative one is not anything.
    for (const bad of [0, -5]) {
      const dim = fakeDim({ count: { typed: false, value: null }, diameter: { typed: true, value: bad } });
      const { flow, patterns, tools } = makeFlow(dim);
      flow.click(new THREE.Vector2(0, 0));
      flow.commit();
      expect(patterns, `diameter ${bad} was written into the pattern`).toHaveLength(0);
      expect(flow.hasPending()).toBe(true);
      expect(tools).toHaveLength(0);
      expect(prompts).toContain(BAD);
    }
  });

  it("commits once the diameter reads, and commits the default when untyped", () => {
    const good = fakeDim({ count: { typed: false, value: null }, diameter: { typed: true, value: 12 } });
    const a = makeFlow(good);
    a.flow.click(new THREE.Vector2(0, 0));
    a.flow.move(new THREE.Vector2(20, 0), { clientX: 0, clientY: 0 } as PointerEvent);
    a.flow.commit();
    expect(a.patterns).toHaveLength(1);
    expect((a.patterns[0] as { diameter: number }).diameter).toBeCloseTo(12, 6);

    const bare = makeFlow(fakeDim({}));
    bare.flow.click(new THREE.Vector2(0, 0));
    bare.flow.commit();
    expect(bare.patterns).toHaveLength(1);
    expect((bare.patterns[0] as { diameter: number }).diameter).toBeCloseTo(6, 6);
  });
});

// The guard above is only worth having if the gesture a user actually makes
// reaches it. It did not: `onPointerDown` dispatched polygon / slot / circle2 /
// centerRectangle STRAIGHT to their own click handlers, so the guard on
// `multiClickAt` only ever ran on the Enter/OK callback — the rarer path — and
// every test above drove `multiClickAt` directly, which is exactly the seam
// that was already safe. Found by an adversarial re-check, not by the suite.
//
// This is asserted against the SOURCE rather than by clicking, because
// `onPointerDown` needs a real WebGL viewport to turn a PointerEvent into a
// sketch-plane point, and this repo has no jsdom. A behavioural version of this
// belongs in the browser-driven end-to-end rig, not here. What it pins is the
// one thing that broke: that the dispatch cannot walk past the guard again.
describe("the pointer path reaches the guard", () => {
  const src = sketchModeSource;
  // Just this ONE method's body. A slice that runs to the next handler swallows
  // `multiClickAt`, whose own body calls those click handlers legitimately —
  // and the assertions below would then pass for the wrong reason.
  const from = src.indexOf("private onPointerDown");
  const dispatch = src.slice(from, src.indexOf("\n  private ", from + 1));

  it("dispatches every guarded multi-click tool through multiClickAt, not to its own handler", () => {
    expect(dispatch, "onPointerDown was not found where expected").toContain("this.multiClickAt(p)");
    for (const raw of ["polygonClick", "slotClick", "circle2Click", "centerRectClick"]) {
      expect(
        dispatch,
        `onPointerDown calls ${raw} directly, so a typed-but-unreadable field commits the cursor's figure instead of refusing`,
      ).not.toContain(`this.${raw}(p)`);
    }
  });

  it("still dispatches the tools that have no typed field directly", () => {
    // circle3 offers no dim field, so routing it through the guard would be
    // noise. If it ever gains one, it belongs in multiDimDefs and here.
    expect(dispatch).toContain("this.circle3Click(p)");
  });
});

// ---------------------------------------------------------------------------
// The second half of the same rule. Everything above is about text the app
// cannot READ; these are about numbers it reads fine and must still refuse.
// A fillet radius of -3 parsed, passed the guard, reached filletCorner, and
// EXTENDED the leg past the corner — a wrong sketch, recorded with afterModify,
// with no message anywhere. What is legal is units.dimValueOk, the one rule the
// dimension editor already applies: a length is a magnitude and must be
// positive, an angle may be any finite value, and a signed field (the offset
// tool, whose minus IS the side) is the deliberate exception that keeps its own.
//
// Same three cases as above, per site: typed-and-illegal refuses and builds
// nothing, typed-and-legal builds what was typed, never-typed still uses the
// cursor or the default.

describe("Fillet refuses a radius that is not a radius", () => {
  for (const bad of [0, -3]) {
    it(`refuses a typed ${bad} instead of mutating the corner`, () => {
      const dim = fakeDim({ radius: { typed: true, value: bad } });
      const { s, calls, live, seed } = makeMode(dim);
      const before = seed.map((e) => JSON.stringify(e));
      s.applyFillet(0, 1);
      expect(arcs(live())).toHaveLength(0);
      // -3 used to EXTEND leg "a" from x2 = 0 out to x2 = +3
      expect(live().map((e) => JSON.stringify(e))).toEqual(before);
      expect(calls.afterModify).toBe(0);
      expect(prompts).toContain(BAD);
      expect(s.filletFirst).toBe(0); // pick + box stay live, as for unreadable text
      expect(dim.seen.hidden).toBe(0);
    });
  }
});

describe("Chamfer refuses a distance that is not a distance", () => {
  for (const bad of [0, -8]) {
    it(`refuses a typed ${bad}`, () => {
      const dim = fakeDim({ distance: { typed: true, value: bad } });
      const { s, calls, live, seed } = makeMode(dim);
      const before = seed.map((e) => JSON.stringify(e));
      s.applyChamfer(0, 1);
      expect(live().map((e) => JSON.stringify(e))).toEqual(before);
      expect(calls.afterModify).toBe(0);
      expect(prompts).toContain(BAD);
    });
  }
});

describe("the drag-draw tools refuse a size that is not a size", () => {
  it("Rectangle refuses a negative width instead of building one", () => {
    const dim = fakeDim({ width: { typed: true, value: -12 }, height: { typed: false, value: null } });
    const { s, calls, live } = makeMode(dim, { entities: [], tool: "rectangle", base: new THREE.Vector2(0, 0) });
    s.commitFromCursor(new THREE.Vector2(30, 20));
    expect(live()).toHaveLength(0); // used to bank a rectangle of width -12
    expect(calls.refreshActive).toBe(0);
    expect(prompts).toContain(BAD);
  });

  it("Circle refuses a zero diameter", () => {
    const dim = fakeDim({ diameter: { typed: true, value: 0 } });
    const { s, live } = makeMode(dim, { entities: [], tool: "circle", base: new THREE.Vector2(0, 0) });
    s.commitFromCursor(new THREE.Vector2(30, 0));
    expect(live()).toHaveLength(0);
    expect(prompts).toContain(BAD);
  });

  it("Line refuses a zero length but keeps a negative ANGLE, which is a direction", () => {
    const zero = makeMode(fakeDim({ length: { typed: true, value: 0 }, angle: { typed: false, value: null } }),
      { entities: [], tool: "line", base: new THREE.Vector2(0, 0) });
    zero.s.commitFromCursor(new THREE.Vector2(30, 0));
    expect(zero.live()).toHaveLength(0);
    expect(prompts).toContain(BAD);

    prompts.length = 0;
    const down = makeMode(fakeDim({ length: { typed: true, value: 10 }, angle: { typed: true, value: -90 } }),
      { entities: [], tool: "line", base: new THREE.Vector2(0, 0) });
    down.s.commitFromCursor(new THREE.Vector2(30, 0));
    const seg = down.live()[0] as { x2: number; y2: number };
    expect(seg?.x2).toBeCloseTo(0, 6);
    expect(seg?.y2).toBeCloseTo(-10, 6); // -90° is a legal heading, not a bad number
    expect(prompts).not.toContain(BAD);
  });
});

describe("the multi-click tools refuse a figure that is not a figure", () => {
  const polygon = (dim: ReturnType<typeof fakeDim>) =>
    makeMode(dim, { entities: [], tool: "polygon", clickPts: [new THREE.Vector2(0, 0)] });

  it("Polygon refuses a negative circumradius instead of taking the cursor's", () => {
    const dim = fakeDim({ radius: { typed: true, value: -20 }, sides: { typed: false, value: null } });
    const { s, live } = polygon(dim);
    s.multiClickAt(new THREE.Vector2(9, 0));
    expect(live()).toHaveLength(0); // used to bank the cursor's 9 mm under a typed -20
    expect(prompts).toContain(BAD);
  });

  for (const bad of [0, 2, 100]) {
    it(`Polygon refuses ${bad} sides rather than silently clamping to a shape nobody asked for`, () => {
      const dim = fakeDim({ radius: { typed: true, value: 20 }, sides: { typed: true, value: bad } });
      const { s, live } = polygon(dim);
      s.multiClickAt(new THREE.Vector2(9, 0));
      expect(live()).toHaveLength(0); // 2 used to build a triangle, 100 a 64-gon
      expect(prompts).toContain(BAD);
    });
  }

  it("Polygon builds the side count that WAS legal, and the default when untyped", () => {
    const typed = polygon(fakeDim({ radius: { typed: true, value: 20 }, sides: { typed: true, value: 8 } }));
    typed.s.multiClickAt(new THREE.Vector2(9, 0));
    expect((typed.live()[0] as { sides: number })?.sides).toBe(8);
    expect(prompts).not.toContain(BAD);

    const bare = polygon(fakeDim({ radius: { typed: true, value: 20 }, sides: { typed: false, value: null } }));
    bare.s.multiClickAt(new THREE.Vector2(9, 0));
    expect((bare.live()[0] as { sides: number })?.sides).toBe(6); // polygonSides, untouched
  });

  it("Circle-by-2-points refuses a zero diameter instead of taking the cursor's", () => {
    const dim = fakeDim({ diameter: { typed: true, value: 0 } });
    const { s, live } = makeMode(dim, { entities: [], tool: "circle2", clickPts: [new THREE.Vector2(0, 0)] });
    s.multiClickAt(new THREE.Vector2(9, 0));
    expect(live()).toHaveLength(0); // used to bank a 9 mm-diameter circle under a typed 0
    expect(prompts).toContain(BAD);
  });

  it("Circle-by-2-points still builds the typed diameter, and the cursor's when untyped", () => {
    const typed = makeMode(fakeDim({ diameter: { typed: true, value: 12 } }),
      { entities: [], tool: "circle2", clickPts: [new THREE.Vector2(0, 0)] });
    typed.s.multiClickAt(new THREE.Vector2(9, 0));
    expect((typed.live()[0] as { radius: number })?.radius).toBeCloseTo(6, 6);

    const bare = makeMode(fakeDim({}), { entities: [], tool: "circle2", clickPts: [new THREE.Vector2(0, 0)] });
    bare.s.multiClickAt(new THREE.Vector2(9, 0));
    expect((bare.live()[0] as { radius: number })?.radius).toBeCloseTo(4.5, 6);
  });

  it("Slot refuses a negative length, and leaves the first click standing", () => {
    const dim = fakeDim({ length: { typed: true, value: -10 } });
    const { s, live } = makeMode(dim, { entities: [], tool: "slot", clickPts: [new THREE.Vector2(0, 0)] });
    s.multiClickAt(new THREE.Vector2(9, 0));
    expect(live()).toHaveLength(0);
    expect(s.clickPts).toHaveLength(1); // the axis end was NOT taken from the cursor
    expect(prompts).toContain(BAD);
  });

  it("Slot refuses a zero width on the third click", () => {
    const dim = fakeDim({ width: { typed: true, value: 0 } });
    const { s, live } = makeMode(dim,
      { entities: [], tool: "slot", clickPts: [new THREE.Vector2(0, 0), new THREE.Vector2(30, 0)] });
    s.multiClickAt(new THREE.Vector2(0, 4));
    expect(live()).toHaveLength(0);
    expect(prompts).toContain(BAD);
  });

  it("Slot builds the typed length and width", () => {
    const dim = fakeDim({ length: { typed: true, value: 30 }, width: { typed: true, value: 6 } });
    const { s, live } = makeMode(dim, { entities: [], tool: "slot", clickPts: [new THREE.Vector2(0, 0)] });
    s.multiClickAt(new THREE.Vector2(9, 0));  // second click: the axis end
    expect(s.clickPts).toHaveLength(2);
    s.multiClickAt(new THREE.Vector2(0, 4));  // third click: the width
    const slot = live()[0] as { x2: number; width: number };
    expect(slot?.x2).toBeCloseTo(30, 6);
    expect(slot?.width).toBeCloseTo(6, 6);
    expect(prompts).not.toContain(BAD);
  });

  it("Center rectangle refuses a negative width instead of falling silent", () => {
    const dim = fakeDim({ width: { typed: true, value: -4 }, height: { typed: false, value: null } });
    const { s, live } = makeMode(dim, { entities: [], tool: "centerRectangle", clickPts: [new THREE.Vector2(0, 0)] });
    s.multiClickAt(new THREE.Vector2(9, 5));
    expect(live()).toHaveLength(0);
    expect(prompts).toContain(BAD); // it used to just return, saying nothing at all
  });

  it("Center rectangle builds the typed size, and the cursor's when untyped", () => {
    const typed = makeMode(fakeDim({ width: { typed: true, value: 12 }, height: { typed: false, value: null } }),
      { entities: [], tool: "centerRectangle", clickPts: [new THREE.Vector2(0, 0)] });
    typed.s.multiClickAt(new THREE.Vector2(9, 5));
    const r = typed.live()[0] as { width: number; height: number };
    expect(r?.width).toBeCloseTo(12, 6);
    expect(r?.height).toBeCloseTo(10, 6); // never opened → twice the cursor's 5
    expect(prompts).not.toContain(BAD);
  });
});

describe("Scale refuses a factor that is not a factor", () => {
  for (const bad of [0, -2]) {
    it(`says so for a typed ${bad} rather than doing nothing`, () => {
      const dim = fakeDim({ factor: { typed: true, value: bad } });
      const { s, calls } = makeMode(dim, { selected: new Set(["a"]) });
      s.scaleClick(new THREE.Vector2(0, 0));
      dim.fire();
      expect(calls.transformed).toBe(0);
      expect(prompts).toContain(BAD); // used to swallow it silently: `if (f > 0)`
    });
  }

  it("still scales by a factor that IS legal", () => {
    const dim = fakeDim({ factor: { typed: true, value: 2 } });
    const { s, calls } = makeMode(dim, { selected: new Set(["a"]) });
    s.scaleClick(new THREE.Vector2(0, 0));
    dim.fire();
    expect(calls.transformed).toBe(1);
    expect(prompts).not.toContain(BAD);
  });
});

describe("Rotate keeps every angle a rotation can have", () => {
  // the guard must not borrow the LENGTH rule here: 0° and -45° are rotations,
  // and refusing them would be a regression dressed up as a fix
  for (const ang of [0, -45]) {
    it(`accepts ${ang}°`, () => {
      const dim = fakeDim({ angle: { typed: true, value: ang } });
      const { s, calls } = makeMode(dim, { selected: new Set(["a"]) });
      s.rotateClick(new THREE.Vector2(0, 0));
      dim.fire();
      expect(calls.transformed).toBe(1);
      expect(prompts).not.toContain(BAD);
    });
  }
});
