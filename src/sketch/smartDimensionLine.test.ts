// Smart dimensioning on a SINGLE slanted line (GH #17, the part left open).
//
// The two-point case already switched between horizontal, vertical and aligned
// as the label was dragged. A lone line did not: resolveSingle turned a line
// pick into its length and never read the cursor, and the hover only re-planned
// once TWO picks were in. Clicking a diagonal line and dragging the label above,
// beside or off it read "L 50" in all three places — exactly what the reporter
// described ("defaults only to the shortest direct distance").
//
// The line's own endpoints are the two points, so the horizontal and vertical
// extents are the existing p2pDistanceX/Y constraints on (line,0)-(line,1).
// These drive the real dimension tool's click, hover and commit with only the
// screen-to-plane step and the value box stubbed, and read the constraint that
// lands.
import { describe, it, expect, afterEach, vi } from "vitest";
import * as THREE from "three";
import { installFakeDocument } from "../ui/fakeDom.testkit";
import { resolveDim, isDimError, type DimTarget } from "./dimensionTool";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";

installFakeDocument(); // setPrompt looks for #prompt and finds none
vi.stubGlobal("requestAnimationFrame", () => 0);

const { SketchMode } = await import("./sketchMode");
const { DimInput } = await import("./dimInput");
const { setUnit } = await import("../ui/units");

const v = (x: number, y: number) => new THREE.Vector2(x, y);
// (-60,-40) -> (-20,-10): 40 across, 30 up, 50 long — the skeptic's own line
const LINE: ResolvedEntity = { type: "line", id: "L1", x1: -60, y1: -40, x2: -20, y2: -10 };
const MID = v(-40, -25);
const PERP = v(-30, 40).normalize(); // perpendicular to (40, 30)
const TOL = 0.9;

const pick = (e: ResolvedEntity): DimTarget => ({ kind: "entity", e });
const planFor = (e: ResolvedEntity, cursor: THREE.Vector2) => {
  const r = resolveDim([pick(e)], { cursor, onLineTol: TOL });
  if (isDimError(r)) throw new Error(r.error);
  return r;
};
const made = (e: ResolvedEntity, cursor: THREE.Vector2) => planFor(e, cursor).make(planFor(e, cursor).measure()) as SketchConstraint & { value: number };

describe("a lone line's dimension follows the cursor", () => {
  it("above the line: its HORIZONTAL extent", () => {
    const c = made(LINE, v(-40, 60));
    expect(c).toMatchObject({ type: "p2pDistanceX", e1: "L1", e2: "L1", value: 40 });
  });

  it("beside the line: its VERTICAL extent", () => {
    const c = made(LINE, v(40, -25));
    expect(c).toMatchObject({ type: "p2pDistanceY", e1: "L1", e2: "L1", value: 30 });
  });

  it("off its perpendicular: its length, as before", () => {
    const c = made(LINE, MID.clone().addScaledVector(PERP, 30));
    expect(c).toEqual({ type: "distance", line: "L1", value: 50 });
  });

  it("ON the line, where the pick just happened: its length", () => {
    // Pick a line, type, Enter must keep giving the length. At the instant of
    // the pick the cursor sits on the line, which has no offset to read a
    // direction from — scored like a pair it would come out horizontal or
    // vertical, never aligned.
    const nearEnd = v(-25, -13.75); // on the line, three quarters along
    expect(made(LINE, nearEnd).type).toBe("distance");
    expect(made(LINE, nearEnd.clone().addScaledVector(PERP, TOL * 0.5)).type).toBe("distance");
  });

  it("measures a line drawn right-to-left as a POSITIVE extent", () => {
    // A picked pair is signed by pick order; a line has no pick order, so a
    // negative number here would only be a trap (typing 25 into "-40" moves the
    // end across the start).
    const back: ResolvedEntity = { type: "line", id: "L2", x1: -20, y1: -10, x2: -60, y2: -40 };
    expect(made(back, v(-40, 60))).toMatchObject({ type: "p2pDistanceX", value: 40 });
    expect(made(back, v(40, -25))).toMatchObject({ type: "p2pDistanceY", value: 30 });
  });

  it("leaves an axis-aligned line on its length wherever the label goes", () => {
    // A horizontal line has no vertical extent, but scored like a pair a label
    // BESIDE it still asks for one: it offered "DY 0", which Enter refuses,
    // where main gave the length. Straight above is the one place the two tie,
    // so every zone is tried, not just that one.
    const flat: ResolvedEntity = { type: "line", id: "L3", x1: 0, y1: 0, x2: 50, y2: 0 };
    for (const c of [v(25, 30), v(80, 2), v(-20, 3), v(45, 8), v(5, -8), v(25, -30)]) {
      expect(made(flat, c), `flat line, label at ${c.x},${c.y}`).toEqual({ type: "distance", line: "L3", value: 50 });
    }
    const upright: ResolvedEntity = { type: "line", id: "L4", x1: 0, y1: 0, x2: 0, y2: 50 };
    for (const c of [v(30, 25), v(2, 80), v(-3, -20), v(-8, 45)]) {
      expect(made(upright, c), `vertical line, label at ${c.x},${c.y}`).toEqual({ type: "distance", line: "L4", value: 50 });
    }
  });

  it("treats solver noise on a vertical line as vertical", () => {
    // A Vertical-constrained line comes back from the solver a hair off. It
    // must not flip between "L 50" and "DY 50" as the label crosses its middle.
    const noisy: ResolvedEntity = { type: "line", id: "L5", x1: 0, y1: 0, x2: 1e-9, y2: 50 };
    expect(made(noisy, v(30, 30)).type).toBe("distance");
    expect(made(noisy, v(30, 20)).type).toBe("distance");
    expect(made(noisy, v(2, 80)).type).toBe("distance");
  });
});

// --- through the tool -----------------------------------------------------------

function makeMode(realBox = false, entities: ResolvedEntity[] = [LINE]) {
  const s = Object.create(SketchMode.prototype) as InstanceType<typeof SketchMode>;
  const state = s as unknown as Record<string, unknown>; // the private fields the stubs fill
  const shown: string[] = [];
  const stubBox = {
    isActive: false,
    show(fields: { label: string }[]) { stubBox.isActive = true; shown.push(fields[0]!.label); },
    hide() { stubBox.isActive = false; },
    updateFromCursor() {},
    isUserDriven: () => false,
    isEdited: () => false,
    getRaw: () => "",
    setClickThrough() {},
    focus() {},
    position() {},
  };
  const dim = realBox ? new DimInput() : stubBox;
  Object.assign(state, {
    active: true,
    tool: "dimension",
    entities,
    constraints: [] as SketchConstraint[],
    dimPicks: [], dimPlan: null, dimPlace: null, dimPlaced: false, dimBoxAt: null,
    dimFieldKey: "", dimPlanKey: "", dimTangentArmed: false,
    referenceMode: false, solverDead: false,
    pendingBindings: new Map(), editingId: null, store: null,
    lastCursor: new THREE.Vector2(),
    dim,
    dims: { clearSelection() {} },
    doublePress: () => false,
    rightDownAt: null,
    boxSel: null,
    pickTol: () => TOL,
    planePoint: (e: { clientX: number; clientY: number }) => v(e.clientX, e.clientY),
    viewport: { pixelWorldSize: () => 0.1 },
    plane: { origin: new THREE.Vector3() },
    overlay: { setPreview() {} },
    dimTargetObjects: () => [],
    dimPreviewSegs: () => [],
    positionDimBox: () => {},
    requestSolve: () => {},
  });
  const ev = (p: THREE.Vector2) => ({ button: 0, clientX: p.x, clientY: p.y, preventDefault() {} });
  const call = (name: string, ...args: unknown[]) => (s as unknown as Record<string, (...a: unknown[]) => void>)[name]!.apply(s, args);
  return {
    s, state, shown,
    down: (p: THREE.Vector2) => call("onPointerDown", ev(p)),
    move: (p: THREE.Vector2) => call("onPointerMove", ev(p)),
    enter: () => call("commitDim"),
    constraints: () => state.constraints as SketchConstraint[],
  };
}

describe("dimensioning a slanted line with the tool", () => {
  const onLine = v(-30, -17.5);

  it("re-plans while the label is dragged, and commits the extent on screen", () => {
    const m = makeMode();
    m.down(onLine); // pick the line
    expect(m.shown.at(-1)).not.toMatch(/^D[XY]$/);
    m.move(v(-40, 60)); // drag above it
    expect(m.shown.at(-1)).toBe("DX");
    m.move(v(40, -25)); // ...beside it
    expect(m.shown.at(-1)).toBe("DY");
    m.move(v(-40, 60)); // ...back above
    m.down(v(-40, 60)); // place the label
    m.move(v(40, -25)); // placed: moving on must not change what it is
    expect(m.shown.at(-1)).toBe("DX");
    m.enter();
    expect(m.constraints()).toHaveLength(1);
    expect(m.constraints()[0]).toMatchObject({ type: "p2pDistanceX", e1: "L1", p1: 0, e2: "L1", p2: 1, value: 40 });
  });

  it("still gives the length for pick, Enter", () => {
    const m = makeMode();
    m.down(onLine);
    m.move(onLine.clone().addScaledVector(PERP, 0.3)); // a hand never holds perfectly still
    m.enter();
    expect(m.constraints()[0]).toMatchObject({ type: "distance", line: "L1", value: 50 });
  });

  it("gives a horizontal line its length wherever the label is placed", () => {
    // The Line tool makes a near-flat line exactly horizontal, so this is the
    // commonest line there is. Placed above its right end it read "DY 0" and
    // Enter refused it ("Dimension not created"); main gives the length.
    const flat: ResolvedEntity = { type: "line", id: "H1", x1: -50, y1: 20, x2: 50, y2: 20 };
    const m = makeMode(false, [flat]);
    m.down(v(-25, 20));
    for (const p of [v(-25, 35), v(40, 30), v(70, 22), v(-45, 12)]) m.move(p);
    expect(m.shown.filter((l) => /^D[XY]$/.test(l)), "an extent was offered for a flat line").toEqual([]);
    m.down(v(40, 30)); // place
    m.enter();
    expect(m.constraints()).toEqual([expect.objectContaining({ type: "distance", line: "H1", value: 100 })]);
  });
});

/** The live value box's field, reached as the user reaches it: the last input
 *  on the page (each test's box is the newest one appended to the body). */
function boxField(): { value: string; dispatch(type: string): void } {
  type El = { tagName: string; children: El[]; value: string; dispatch(type: string): void };
  const out: El[] = [];
  const walk = (el: El) => {
    if (el.tagName === "input") out.push(el);
    for (const c of el.children) walk(c);
  };
  walk((globalThis as unknown as { document: { body: El } }).document.body);
  return out.at(-1)!;
}

describe("a value typed before the label is placed", () => {
  it("is kept: dragging the label clear afterwards does not turn it into an extent", () => {
    // The hint says "type a length ... click to place". Following it re-planned
    // to DX as the label passed above the line, threw the 25 away with a
    // "retype" toast, and committed the MEASURED extent instead. A lone line
    // never re-planned on main, so this flow always committed the 25.
    const m = makeMode(true);
    m.down(v(-30, -17.5)); // pick the line
    const f = boxField();
    f.value = "25";
    f.dispatch("input");
    m.move(v(-40, 60)); // drag the label up, into the horizontal-extent zone
    m.down(v(-40, 60)); // place it
    m.enter();
    expect(m.constraints()).toEqual([expect.objectContaining({ type: "distance", line: "L1", value: 25 })]);
  });

  it("is the number typed, even when it matches the readout", () => {
    // A line drawn with the mouse is 49.999993 long and its box reads "50".
    // Enter on that untouched text keeps the line where it is; TYPING 50 means
    // 50, and must not come back as the hidden measurement.
    const drawn: ResolvedEntity = { type: "line", id: "M1", x1: 0, y1: 0, x2: 49.999993047127845, y2: 0 };
    const untouched = makeMode(true, [drawn]);
    untouched.down(v(25, 0));
    expect(boxField().value).toBe("50");
    untouched.enter();
    expect(untouched.constraints()[0]).toMatchObject({ type: "distance", value: 49.999993047127845 });

    const typed = makeMode(true, [drawn]);
    typed.down(v(25, 0));
    const f = boxField();
    f.value = "50";
    f.dispatch("input");
    typed.enter();
    expect(typed.constraints()[0]).toMatchObject({ type: "distance", value: 50 });
  });
});

describe("accepting a measured dimension in inches", () => {
  afterEach(() => setUnit("mm"));

  it("holds the length the line HAS, not the length its rounded readout parses to", () => {
    // The box shows the measurement to four decimals; Enter with nothing typed
    // used to commit the parse of that text. 50 mm reads "1.9685", which is
    // 49.9999 mm — so dimensioning a line moved it (by 12.6 um at the old three
    // decimals). Driven through the REAL value box.
    setUnit("in");
    const m = makeMode(true);
    m.down(v(-30, -17.5));
    m.move(MID.clone().addScaledVector(PERP, 30));
    m.down(MID.clone().addScaledVector(PERP, 30)); // place it
    const box = m.state.dim as InstanceType<typeof DimInput>;
    expect(box.getRaw("length")).toBe("1.9685");
    m.enter();
    expect(m.constraints()[0]).toEqual(expect.objectContaining({ type: "distance", line: "L1", value: 50 }));
  });
});

describe("click a line, then press D (the selection seeds the tool)", () => {
  it("gives the length, wherever an earlier tool left the cursor", () => {
    // The key press carries no cursor and the select tool's hover never writes
    // one, so the plan read a point some earlier tool left behind. Above the
    // line, that turned "click a line, D, type 25, Enter" into a DX of 25.
    const m = makeMode(true);
    Object.assign(m.state, {
      tool: "select",
      selected: new Set(["L1"]),
      textPanel: { hide() {} },
      projectPanel: { hide() {} },
      constraintTools: { resetPending() {} },
      patternFlow: { flushPending() {} },
      glyphs: { setInteractive() {} },
      dims: { clearSelection() {}, setInteractive() {} },
      dropTextPreview: () => false,
      refreshActive: () => {},
    });
    (m.state.viewport as Record<string, unknown>).hoverEntity = () => {};
    (m.state.lastCursor as THREE.Vector2).set(-40, 60); // the DX zone, left by an earlier tool
    m.s.setTool("dimension");
    const f = boxField();
    f.value = "25";
    f.dispatch("input");
    m.enter();
    expect(m.constraints()).toEqual([expect.objectContaining({ type: "distance", line: "L1", value: 25 })]);
  });
});
