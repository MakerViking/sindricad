// Offset an outline, then use the area inside it and the ring between the two.
//
// Field report 356b2693 (0.1.225): "Chain select no longer works on offset.
// Even right-click and select 'Chain Select' does not work." and "After
// trimming, extending, making tangent, coincident points, and everything else I
// could think of to close the inside offset curves, I still cannot select the
// inside to cut a hole through the revolved section, nor can I select the area
// between the outside and the offset curves to use for a loft."
//
// The geometry below is the reporter's sketch, replayed: a closed outline of a
// line and three arcs, plus two CONSTRUCTION lines from the origin out to two of
// its corners. Those two lines are the whole first bug. Each one made a corner a
// vertex shared by three curves, offsetChain gives up at any such junction, and
// the tool fell back to offsetting the one picked curve without a word, with the
// Chain Selection toggle showing ON. The reporter then built the inner outline a
// curve at a time and closed it by trimming, which left two ends 0.0196 mm apart:
// the second bug, and the reason no region ever appeared.
//
// These drive the REAL offset tool off SketchMode.prototype (a real SketchMode
// needs WebGL) and the real ConstraintTools click flow; the dim box, overlay,
// toast and menu are stubs. The region count is the oracle, because a selectable
// inside and a selectable ring is what the reporter could not get.

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as THREE from "three";

const { toasts, menus } = vi.hoisted(() => ({
  toasts: [] as string[],
  menus: [] as { label: string; onClick?: () => void }[][],
}));
// the real planegcs WASM, as in sketchSolve.test.ts: the `?url` import resolves
// root-relative under vitest, so it needs the absolute path
declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));
vi.mock("../ui/prompt", () => ({ setPrompt: () => {} }));
vi.mock("../ui/toast", () => ({ toast: (m: string) => void toasts.push(m) }));
vi.mock("../ui/menu", async (orig) => ({
  ...(await orig<typeof import("../ui/menu")>()),
  contextMenu: (_x: number, _y: number, items: { label: string; onClick?: () => void }[]) =>
    void menus.push(items),
}));

import { SketchMode } from "./sketchMode";
import { ConstraintTools, type ConstraintHost } from "./constraintTools";
import { compileAndSolve, constraintIndexOf } from "./sketchSolve";
import { detectRegions } from "./region";
import { originGeometry } from "./origin";
import { fmtLength } from "../ui/units";
import { t } from "../i18n";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";
import type { SketchTool } from "./sketchMode";

const v = (x: number, y: number) => new THREE.Vector2(x, y);

// --- the reporter's sketch (feature "Outlet_Base"), coordinates as saved ------
const OUTLINE: ResolvedEntity[] = [
  { type: "arc", id: "e73", x1: -41.36199950239928, y1: 95.88748797815876, x2: -92.14050361774925, y2: 127.55427943455176, mx: -56.1133231860191, my: 128.77907194953656 },
  { type: "arc", id: "e384", x1: -153.87098149377496, y1: -32.91941164635793, x2: -63.31325610464162, y2: -31.98966462288939, mx: -108.20232485976976, my: -70.4206209883575 },
  { type: "line", id: "e70", x1: -41.36199950239928, y1: 95.88748797815876, x2: -63.31325610464162, y2: -31.98966462288939 },
  { type: "arc", id: "e79", x1: -92.14050361774925, y1: 127.55427943455176, x2: -153.87098149377496, y2: -32.91941164635793, mx: -146.86175086484803, my: 56.49428265488107 },
];
const CONSTRUCTION: ResolvedEntity[] = [
  { type: "line", id: "e37", x1: 0, y1: 0, x2: 0, y2: 155, construction: true },
  // origin -> the e79/e384 corner, and origin -> the e73/e79 corner
  { type: "line", id: "e80", x1: 0, y1: 0, x2: -153.87098149377496, y2: -32.91941164635793, construction: true },
  { type: "line", id: "e81", x1: 0, y1: 0, x2: -92.14050361774925, y2: 127.55427943455176, construction: true },
];
const POINTS: ResolvedEntity[] = [
  { type: "point", id: "e47", x: 0, y: 0 },
  { type: "point", id: "e48", x: 0, y: 0 },
  { type: "point", id: "e68", x: -72.09240215725585, y: 101.32778913360129 },
];
/** the inner outline as the reporter left it: built a curve at a time, then
 *  trimmed closed. e379's end and e388's start are 0.0196 mm apart. */
const INNER: ResolvedEntity[] = [
  { type: "arc", id: "e388", x1: -151.4920922842811, y1: -32.41095239420846, x2: -65.7210681748368, y2: -31.753839418212237, mx: -108.33176373454124, my: -67.95338473290693 },
  { type: "line", id: "e359", x1: -43.74021472444282, y1: 96.29572976636813, x2: -65.7210681748368, y2: -31.753839418212237 },
  { type: "arc", id: "e368", x1: -43.74021472444282, y1: 96.29572976636813, x2: -90.72753505157962, y2: 125.59824036770856, mx: -57.3901870264739, my: 126.73158868148796 },
  { type: "arc", id: "e379", x1: -90.72753505157962, y1: 125.59824036770856, x2: -151.51137806488617, y2: -32.414594195808064, mx: -144.60963440154674, my: 55.62794528657244 },
];
/** the saved constraints, in saved order (the order is what constraintKey
 *  numbers them by, so it is kept exactly) */
const SAVED_CONSTRAINTS: SketchConstraint[] = [
  { type: "vertical", line: "e37" },
  { type: "coincident", e1: "e48", p1: 0, e2: "e47", p2: 0 },
  { type: "fix", e: "e68", p: 0 },
  { id: "c82", type: "distance", line: "e80", value: 157.353 },
  { id: "c83", type: "distance", line: "e81", value: 157.353 },
  { id: "c360", type: "offset", pairs: [{ src: "e70", cpy: "e359" }], value: -2.413 },
  { id: "c369", type: "offset", pairs: [{ src: "e73", cpy: "e368" }], value: -2.413 },
  { id: "c380", type: "offset", pairs: [{ src: "e79", cpy: "e379" }], value: -2.413 },
  { type: "coincident", e1: "e359", p1: 1, e2: "e388", p2: 1 },
  { type: "coincident", e1: "e359", p1: 0, e2: "e368", p2: 0 },
  { type: "coincident", e1: "e368", p1: 1, e2: "e379", p2: 0 },
  { type: "tangent2", a: "e388", b: "e379" },
  { type: "tangent2", a: "e388", b: "e359" },
  { type: "tangent2", a: "e359", b: "e368" },
  { type: "tangent2", a: "e379", b: "e368" },
] as SketchConstraint[];

/** what the user would see as selectable areas: [regions, how many of them
 *  carry a hole]. The reporter wanted 2 and 1 — the inside, and the ring. */
const regionShape = (ents: ResolvedEntity[]) => {
  const rs = detectRegions("sk", ents.filter((e) => !e.id.startsWith("__")));
  return { regions: rs.length, withHole: rs.filter((r) => r.holes.length === 1).length };
};

// --- the offset tool, driven off SketchMode.prototype -------------------------
interface OffsetPriv {
  offsetClick(p: THREE.Vector2): void;
  commitOffset(): void;
  openOffsetMenu(e: MouseEvent): void;
  entities: ResolvedEntity[];
  offsetChainMode: boolean;
}

/** a SketchMode holding `entities`, with the offset box already reading `typed`
 *  (what the reporter typed: -2.413, inward). */
function offsetMode(entities: ResolvedEntity[], typed: number, chainMode = true) {
  const s = Object.create(SketchMode.prototype) as SketchMode & Record<string, never>;
  const driving: SketchConstraint[] = [];
  Object.assign(s, {
    // origin geometry is in a live sketch's entity list, as in the app
    entities: [...originGeometry(), ...entities.map((e) => ({ ...e }))],
    constraints: [],
    offsetPick: null,
    // a class-field default, which Object.create does not run: set it as the
    // app's own default (ON) unless a test says otherwise
    offsetChainMode: chainMode,
    dim: {
      show: () => {}, hide: () => {}, focus: () => {}, position: () => {}, updateFromCursor: () => {},
      isUserDriven: (n: string) => n === "offset",
      getValue: (n: string) => (n === "offset" ? typed : null),
    },
    overlay: { setPreview: () => {} },
    pickTol: () => 1,
    afterModify: () => {},
    setDrivingDimension: (c: SketchConstraint) => void driving.push(c),
  });
  return { s: s as unknown as OffsetPriv, driving };
}

/** a point ON line e70, a third of the way along: where the user clicked */
const ON_E70 = v(-41.36199950239928 + (-63.31325610464162 + 41.36199950239928) / 3,
  95.88748797815876 + (-31.98966462288939 - 95.88748797815876) / 3);

beforeEach(() => { toasts.length = 0; menus.length = 0; });

describe("Offset with Chain Selection on the reporter's outline", () => {
  it("takes the whole outline, not the construction lines drawn to its corners", () => {
    const { s, driving } = offsetMode([...OUTLINE, ...CONSTRUCTION, ...POINTS], -2.413);
    s.offsetClick(ON_E70);
    s.commitOffset();
    // ONE associative offset over all four outline curves. Before the fix this
    // was a single pair (e70 alone): the fallback the reporter saw.
    expect(driving).toHaveLength(1);
    const c = driving[0] as Extract<SketchConstraint, { type: "offset" }>;
    expect(c.type).toBe("offset");
    expect(c.pairs.map((p) => p.src).sort()).toEqual(["e384", "e70", "e73", "e79"]);
    expect(c.value).toBeCloseTo(-2.413, 9);
    // and nothing else was copied: no offset construction line, no stray curve
    const own = s.entities.filter((e) => !e.id.startsWith("__"));
    expect(own).toHaveLength(OUTLINE.length + CONSTRUCTION.length + POINTS.length + 4);
    // a profile the user can actually use: the inside, and the ring between the
    // outline and its offset, each a region of its own
    expect(regionShape(s.entities)).toEqual({ regions: 2, withHole: 1 });
    expect(toasts).toEqual([]); // nothing stopped the chain, so nothing to say
  });

  it("works through the right-click menu too, which the reporter tried", () => {
    const { s, driving } = offsetMode([...OUTLINE, ...CONSTRUCTION, ...POINTS], -2.413, false);
    s.offsetClick(ON_E70);
    s.openOffsetMenu({ preventDefault: () => {}, clientX: 0, clientY: 0 } as MouseEvent);
    const item = menus[0]?.find((i) => i.label.includes(t("sketch.offset.chainSelection")));
    expect(item).toBeDefined();
    item!.onClick!(); // Chain Selection: off -> on
    expect(s.offsetChainMode).toBe(true);
    s.commitOffset();
    const c = driving[0] as Extract<SketchConstraint, { type: "offset" }>;
    expect(c.pairs).toHaveLength(4);
    expect(regionShape(s.entities)).toEqual({ regions: 2, withHole: 1 });
  });

  it("takes the distance typed after the right-click menu", () => {
    // The stub box above reads -2.413 whatever holds focus, so it cannot see
    // this. In the app the right-click blurs the distance box and the menu item
    // never gave focus back: the reporter's keys went to the page, Enter did
    // nothing, and the pick just sat there. This box only hears keys while it
    // holds focus, and the right-click takes it away.
    const { s, driving } = offsetMode([...OUTLINE, ...CONSTRUCTION, ...POINTS], 0);
    const box = { focused: false, typed: null as number | null };
    Object.assign(s, {
      dim: {
        show: () => { box.focused = true; box.typed = null; },
        focus: () => { box.focused = true; },
        hide: () => { box.focused = false; },
        position: () => {}, updateFromCursor: () => {},
        isUserDriven: (n: string) => n === "offset" && box.typed !== null,
        getValue: (n: string) => (n === "offset" ? box.typed : null),
      },
    });
    const chainItem = () => {
      box.focused = false; // the right-click landed on the canvas
      s.openOffsetMenu({ preventDefault: () => {}, clientX: 0, clientY: 0 } as MouseEvent);
      return menus[menus.length - 1]!.find((i) => i.label.includes(t("sketch.offset.chainSelection")))!;
    };

    s.offsetClick(ON_E70);
    // the reporter's path: Chain Selection is ON by default, so the first click
    // turns it off and a second one turns it back on
    chainItem().onClick!();
    chainItem().onClick!();
    expect(s.offsetChainMode).toBe(true);
    if (box.focused) box.typed = -2.413; // typing
    if (box.focused) s.commitOffset(); // Enter

    expect(driving).toHaveLength(1);
    const c = driving[0] as Extract<SketchConstraint, { type: "offset" }>;
    expect(c.pairs).toHaveLength(4);
    expect(c.value).toBeCloseTo(-2.413, 9);
    expect(regionShape(s.entities)).toEqual({ regions: 2, withHole: 1 });
  });

  it("still chains construction geometry when the pick is construction", () => {
    // the other half of the rule: a construction pick keeps today's walk. Here
    // the two construction lines from the origin form a chain of their own.
    const { s, driving } = offsetMode([...CONSTRUCTION.slice(1)], 2);
    s.offsetClick(v(-153.87098149377496 / 2, -32.91941164635793 / 2)); // middle of e80
    s.commitOffset();
    const c = driving[0] as Extract<SketchConstraint, { type: "offset" }>;
    expect(c.pairs.map((p) => p.src).sort()).toEqual(["e80", "e81"]);
  });
});

describe("Chain Selection says where it stopped", () => {
  // three REAL curves at one vertex: a genuine junction, which the chain still
  // cannot pass. What changed is that the user is told, and told where.
  const T: ResolvedEntity[] = [
    { type: "line", id: "a", x1: 0, y1: 0, x2: 10, y2: 0 },
    { type: "line", id: "b", x1: 10, y1: 0, x2: 10, y2: 10 },
    { type: "line", id: "c", x1: 10, y1: 0, x2: 20, y2: 0 },
  ];
  const said = t("sketch.offset.chainJunction", { x: fmtLength(10), y: fmtLength(0) });

  it("names the junction when the curve is picked", () => {
    const { s, driving } = offsetMode(T, 2);
    s.offsetClick(v(5, 0));
    expect(toasts).toEqual([said]);
    // and still offsets the picked curve, as before
    s.commitOffset();
    expect((driving[0] as Extract<SketchConstraint, { type: "offset" }>).pairs.map((p) => p.src)).toEqual(["a"]);
  });

  it("names it when Chain Selection is switched on mid-pick", () => {
    const { s } = offsetMode(T, 2, false);
    s.offsetClick(v(5, 0));
    expect(toasts).toEqual([]); // chain off: one curve is what was asked for
    s.openOffsetMenu({ preventDefault: () => {}, clientX: 0, clientY: 0 } as MouseEvent);
    menus[0]!.find((i) => i.label.includes(t("sketch.offset.chainSelection")))!.onClick!();
    expect(toasts).toEqual([said]);
  });
});

// --- the reporter's SAVED sketch: join the gap the trim left -------------------
class Host implements ConstraintHost {
  cons: SketchConstraint[];
  warnings: string[] = [];
  private held: number | null = null;
  constructor(private ents: ResolvedEntity[], cons: SketchConstraint[]) { this.cons = [...cons]; }
  tool(): SketchTool { return "coincident"; }
  entities() { return this.ents; }
  constraints() { return this.cons; }
  pickTol() { return 1; }
  getFilletFirst() { return this.held; }
  setFilletFirst(i: number | null) { this.held = i; }
  requestSolve() {}
  warn(msg: string) { this.warnings.push(msg); }
  setPendingPoints() {}
  addConstraint(c: SketchConstraint) { this.cons.push(c); }
}

describe("the reporter's saved sketch", () => {
  const saved = () => [...CONSTRUCTION.slice(0, 1), ...OUTLINE, ...POINTS, ...CONSTRUCTION.slice(1), ...INNER]
    .map((e) => ({ ...e }));
  const e379End = v(-151.51137806488617, -32.414594195808064);

  it("is open as saved: one region, the outline alone", () => {
    expect(regionShape(saved())).toEqual({ regions: 1, withHole: 0 });
  });

  it("closes when Coincident is clicked twice on the gap", async () => {
    const ents = saved();
    const host = new Host(ents, SAVED_CONSTRAINTS);
    const tools = new ConstraintTools(host);
    // both clicks land on the same spot: the two ends are 0.0196 mm apart, far
    // inside any pick tolerance, so there is no way to aim at one or the other
    tools.click(e379End);
    tools.click(e379End);
    expect(host.warnings).toEqual([]);
    expect(host.cons.slice(SAVED_CONSTRAINTS.length)).toEqual([
      { type: "coincident", e1: "e379", p1: 1, e2: "e388", p2: 0 },
    ]);

    const r = await compileAndSolve(ents, host.cons);
    expect(r.ok).toBe(true);
    expect(r.conflicts).toEqual([]);
    const a = r.entities.find((e) => e.id === "e379") as Extract<ResolvedEntity, { type: "arc" }>;
    const b = r.entities.find((e) => e.id === "e388") as Extract<ResolvedEntity, { type: "arc" }>;
    expect(Math.hypot(a.x2 - b.x1, a.y2 - b.y1)).toBeLessThan(1e-6);
    // the inside AND the ring between the outline and the inner curves
    expect(regionShape(r.entities)).toEqual({ regions: 2, withHole: 1 });
  });

  it("does not draw the user's joins amber when the ends already touch", async () => {
    // coincidents 1, 8, 9 and 10 join points that already sit together (the two
    // origin points, and three corners of the inner outline). planegcs called
    // them redundant and the glyphs were drawn amber, which reads as "too many
    // constraints" on a sketch that has nothing wrong with those joins.
    const r = await compileAndSolve(saved(), SAVED_CONSTRAINTS);
    const amber = new Set(r.overDefined.map(constraintIndexOf));
    for (const k of [1, 8, 9, 10]) expect(amber.has(k), `constraint ${k}`).toBe(false);
  });
});
