// The yellow extrude arrow, from both directions at once.
//
// Two field reports on 0.1.144, opposite complaints, one boolean between them
// (`DimInput.userDriven`):
//
//   3998d6ea — "I select it then select extrude, the yellow arrow is
//   automatically attached to my mouse so the extrude goes wherever I move my
//   mouse to." The create path honours a pre-selected profile by going straight
//   to beginDrag, which set `distance = 10` WITHOUT seeding the input — so the
//   field stayed cursor-tracking and onMove scrubbed the depth off every bare
//   pointermove. On the reporter's shape two moves with no button ever down were
//   enough to swing the depth from the seeded 10 mm to a large negative and then
//   a large positive value — the figures depend on unrecorded cursor positions,
//   so the tests below assert the PROPERTY (a bare move changes nothing) rather
//   than any number. The sign is the part that bites: `entersSolid` reads
//   `distance >= 0`, so hovering across the
//   sketch plane silently retargeted the operation between Cut and Join.
//
//   6e2bcadd — "I can change the height by typing a number in but I cannot grab
//   the yellow arrow that is visible." The edit path seeds the saved distance,
//   which sets userDriven, so onMove took the other branch and the pointer could
//   not move the depth at all: 40 synthetic pointermoves left it at exactly
//   33.594, one distinct value, while the same 40 on the create path produced 40.
//
// The fix is one rule, not two patches: the arrow is a HANDLE. It moves the depth
// while it is being DRAGGED (press on it, travel past the click threshold,
// release) and at no other time. These tests assert BOTH reports against that
// rule, and then the three things a review found the rule had not yet paid for:
// the handle has to be grabbable in the camera the app actually leaves you in,
// a press must not discard a typed value before it is known to be a drag, and a
// press that misses the handle must not commit the feature. Commit therefore
// moved to the RELEASE of a click that did not travel.
//
// The viewport here is a deliberately trivial projection rather than a real
// camera: side-on the eye looks along -X, screen x maps to world Y and screen y
// to world Z at 10 px/mm, so the axis reading for a cursor at clientY is exactly
// (300 - clientY)/10 mm along the sketch normal. Every number below is hand
// checkable from that, which is the point — a real camera would make a failure
// unattributable between the tool and the projection. `harness({ topDown: true })`
// is the same trick for the down-the-normal view.

import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { SketchPlane } from "../sketch/plane";
import { ExtrudeTool } from "./extrudeTool";

const SCALE = 10; // screen px per mm
const CX = 400, CY = 300; // screen position of the world origin

/** Records handlers so a test can dispatch to what the tool actually
 *  registered, rather than calling its private methods by cast. */
function hub() {
  const map = new Map<string, ((e: never) => void)[]>();
  return {
    addEventListener(type: string, fn: (e: never) => void) {
      map.set(type, [...(map.get(type) ?? []), fn]);
    },
    removeEventListener(type: string, fn: (e: never) => void) {
      map.set(type, (map.get(type) ?? []).filter((f) => f !== fn));
    },
    dispatch(type: string, e: unknown) {
      for (const fn of [...(map.get(type) ?? [])]) fn(e as never);
    },
    count(type: string) {
      return (map.get(type) ?? []).length;
    },
  };
}

const windowHub = hub();
(globalThis as unknown as { window: unknown }).window = windowHub;
(globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = () => 0;
// DimInput builds a real element tree; these paths only ever touch the members
// below. Stubbed rather than pulling in jsdom, matching extrudeTool.test.ts —
// but with `value`/`focus`/`select`, because this file runs the REAL beginDrag.
(globalThis as unknown as { document: unknown }).document ??= {
  createElement: () => ({
    style: {},
    value: "",
    appendChild() {},
    addEventListener() {},
    remove() {},
    focus() {},
    select() {},
    setAttribute() {},
    classList: { add() {}, remove() {}, toggle() {} },
    querySelector: () => null,
    querySelectorAll: () => [],
  }),
  body: { appendChild() {} },
  getElementById: () => null,
};

type Wr = {
  sketchId: string;
  plane: SketchPlane;
  interior3D: THREE.Vector3;
  centroid3D: THREE.Vector3;
  region: {
    loop: THREE.Vector2[];
    holes: THREE.Vector2[][];
    entityIds: string[];
    holeEntityIds: string[][];
    interior: THREE.Vector2;
  };
};

/** A 20x20 square on XY, centred on (`cx`, 0) — at the default the arrow anchor
 *  is the world origin and projects to (400, 300). */
function square(cx = 0): Wr {
  return {
    sketchId: "s1",
    plane: new SketchPlane("XY"),
    interior3D: new THREE.Vector3(cx, 0, 0),
    centroid3D: new THREE.Vector3(cx, 0, 0),
    region: {
      loop: [
        new THREE.Vector2(cx - 10, -10),
        new THREE.Vector2(cx + 10, -10),
        new THREE.Vector2(cx + 10, 10),
        new THREE.Vector2(cx - 10, 10),
      ],
      holes: [],
      entityIds: [`sq${cx}`],
      holeEntityIds: [],
      interior: new THREE.Vector2(cx, 0),
    },
  };
}

/** `hasSolid` puts a body in the model so currentOperation answers cut/join
 *  instead of the unconditional "new" — the hover-flips-the-operation assertion
 *  needs that. The solid sits BELOW the sketch plane (pointInSolid: z < 0), so a
 *  positive depth reads Join and a negative one reads Cut.
 *
 *  `topDown` swaps the eye to +Z looking -Z — straight down the XY sketch's
 *  normal. That is not an exotic camera, it is the one the app leaves you in:
 *  Finish Sketch runs viewport.exitSketchView, which restores the projection
 *  mode and the up vector and NOT the orientation. `scale` zooms (px per mm),
 *  `savedDistance` sets the depth the edit path reopens on, and `otherRegion`
 *  adds a second, UNSELECTED profile 30 mm along +X. */
function harness(
  opts: {
    hasSolid?: boolean;
    topDown?: boolean;
    scale?: number;
    savedDistance?: number;
    otherRegion?: boolean;
  } = {},
) {
  const S = opts.scale ?? SCALE;
  const wr = square();
  const el = hub();
  const selection: Wr[] = [wr];

  const overlay = {
    regions: opts.otherRegion ? [wr, square(30)] : [wr],
    selectedRegions: () => selection,
    selectRegionsByEntities: () => ({ resolved: [wr], unresolved: [] }),
    setHoverRegion() {},
    toggleRegionSelection() {},
    clearRegionSelection() {},
    update() {},
  };

  const written: { feature: unknown } = { feature: null };
  const store = {
    document: {
      features: [
        {
          id: "ex1",
          type: "extrude",
          sketch: "s1",
          distance: opts.savedDistance ?? 33.594,
          operation: "join",
          regions: [[0, 0, 0]],
          regionEntities: [["sq"]],
          regionHoleEntities: [[]],
        },
      ],
      parameters: [],
    },
    isParamBound: () => false,
    beginEditPreview() {},
    endEditPreview() {},
    buildState: opts.hasSolid ? { result: { mesh: { positions: [0, 0, 0] } } } : {},
    hiddenBodyIds: () => [],
    nextId: () => "new1",
    replaceFeature: (_id: string, f: unknown) => {
      written.feature = f;
    },
    addFeature: (f: unknown) => {
      written.feature = f;
    },
  };

  const viewport = {
    suspendPicking: false,
    pointInSolid: (p: THREE.Vector3) => p.z < 0,
    addToScene() {},
    removeFromScene() {},
    // side-on: eye at +X looking -X; screen x -> world y, screen y -> world z.
    // topDown: eye at +Z looking -Z; screen x -> world x, screen y -> world y.
    rayFrom: (cx: number, cy: number) => ({
      ray: opts.topDown
        ? new THREE.Ray(
            new THREE.Vector3((cx - CX) / S, (CY - cy) / S, 1000),
            new THREE.Vector3(0, 0, -1),
          )
        : new THREE.Ray(
            new THREE.Vector3(1000, (cx - CX) / S, (CY - cy) / S),
            new THREE.Vector3(-1, 0, 0),
          ),
    }),
    projectToScreen: (w: THREE.Vector3) =>
      opts.topDown ? { x: CX + w.x * S, y: CY - w.y * S } : { x: CX + w.y * S, y: CY - w.z * S },
    pixelWorldSize: () => 1 / S,
    camera: {
      getWorldDirection: (v: THREE.Vector3) => (opts.topDown ? v.set(0, 0, -1) : v.set(-1, 0, 0)),
    },
    domElement: {
      style: { cursor: "default" },
      addEventListener: el.addEventListener,
      removeEventListener: el.removeEventListener,
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600 }),
    },
  };

  const tool = new ExtrudeTool(viewport as never, overlay as never, store as never);
  const t = tool as unknown as {
    phase: string;
    distance: number;
    commit: () => Promise<void>;
    currentOperation: () => string;
    overArrow: (cx: number, cy: number) => boolean;
    dim: { getValue: (n: string) => number | null; isUserDriven: (n: string) => boolean };
  };
  return { tool, t, el, written, viewport };
}

const move = (clientX: number, clientY: number, buttons = 0) =>
  ({ clientX, clientY, buttons, button: -1, preventDefault() {} }) as unknown as PointerEvent;
const press = (clientX: number, clientY: number) =>
  ({
    clientX,
    clientY,
    buttons: 1,
    button: 0,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault() {},
  }) as unknown as PointerEvent;
/** The left button coming back UP. Distinct from `move` because onUp reads
 *  `button` — commit is a LEFT click's release and nothing else's. */
const release = (clientX: number, clientY: number) =>
  ({ clientX, clientY, buttons: 0, button: 0, preventDefault() {} }) as unknown as PointerEvent;
/** press and release in place: the whole click gesture, which is what commits. */
const click = (h: { el: ReturnType<typeof hub> }, x: number, y: number) => {
  h.el.dispatch("pointerdown", press(x, y));
  windowHub.dispatch("pointerup", release(x, y));
};

// --- report 3998d6ea: the create path scrubs with no click -------------------

describe("ExtrudeTool create path, pre-selected profile (field 3998d6ea)", () => {
  it("a bare pointermove does not touch the depth", () => {
    const h = harness();
    h.tool.start(() => {});
    expect(h.t.phase, "a pre-selected profile should still land in drag").toBe("drag");
    expect(h.t.distance).toBe(10);

    // no button was ever down: these are hovers
    h.el.dispatch("pointermove", move(560, 546)); // axis reading -24.6 mm
    h.el.dispatch("pointermove", move(120, 28)); // axis reading +27.2 mm

    expect(h.t.distance, "the depth followed the cursor with no click").toBe(10);
  });

  it("hovering across the sketch plane does not flip Cut/Join", () => {
    // The silent half of the report. entersSolid steps the profile a hair along
    // `sign * n` and asks the model, and `sign` is `distance >= 0` — so a hover
    // that carries the depth negative retargets the whole operation.
    const h = harness({ hasSolid: true });
    h.tool.start(() => {});
    expect(h.t.currentOperation()).toBe("join"); // +10 mm, away from the solid

    h.el.dispatch("pointermove", move(400, 546)); // would read -24.6 mm

    expect(h.t.currentOperation(), "a hover retargeted the operation").toBe("join");
  });

  it("the depth box shows the starting depth instead of staying blank", () => {
    // With the scrub gone, nothing else fills the field until the user acts —
    // and a blank D beside a 10 mm preview is the same "the tool is ignoring me"
    // that both reports are about.
    const h = harness();
    h.tool.start(() => {});
    expect(h.t.dim.getValue("distance")).toBeCloseTo(10);
  });
});

// --- report 6e2bcadd: the edit path cannot be dragged at all -----------------

describe("ExtrudeTool edit path, the arrow the reporter can see (field 6e2bcadd)", () => {
  /** The arrow runs from the anchor (world origin, screen 400,300) along +Z for
   *  33.594 mm, so its screen segment is x=400 from y=300 up to y=-35.9. Press
   *  at (400, 150) is on the shaft. */
  const onShaft = { x: 400, y: 150 };

  it("pressing the arrow and moving changes the depth", () => {
    const h = harness();
    expect(h.tool.startEdit("ex1", () => {})).toBe(true);
    expect(h.t.distance).toBe(33.594);

    h.el.dispatch("pointerdown", press(onShaft.x, onShaft.y));
    h.el.dispatch("pointermove", move(onShaft.x, 100, 1));

    // grabbed at clientY 150 (axis +15) and moved to 100 (axis +20): +5 mm
    expect(h.t.distance, "the arrow could not be dragged").toBeCloseTo(38.594);
  });

  it("a drag produces a continuum of depths, not one frozen value", () => {
    // The measurement from the report, as an assertion: 40 moves left the depth
    // at exactly 33.594 — one distinct value — while the same 40 on the create
    // path produced 40.
    //
    // The moves start 5 px from the press and step 5 px, because a press is not
    // a drag until it has travelled DRAG_START_PX (4). Two moves 3 px apart
    // would legitimately produce the same depth twice — that is the click
    // guard doing its job, not the freeze this asserts against.
    const h = harness();
    h.tool.startEdit("ex1", () => {});
    h.el.dispatch("pointerdown", press(onShaft.x, onShaft.y));

    const seen = new Set<number>();
    for (let i = 0; i < 40; i++) {
      h.el.dispatch("pointermove", move(onShaft.x, onShaft.y - 5 - i * 5, 1));
      seen.add(h.t.distance);
    }
    expect(seen.size).toBe(40);
  });

  it("grabbing the shaft does not teleport the depth to the cursor", () => {
    // Reading the axis absolutely would snap 33.594 mm to wherever the cursor
    // happens to be the instant the button goes down — a new complaint of the
    // same family. The grab records an offset instead.
    const h = harness();
    h.tool.startEdit("ex1", () => {});
    h.el.dispatch("pointerdown", press(onShaft.x, onShaft.y)); // axis reads 15, depth is 33.594
    expect(h.t.distance).toBe(33.594);
    h.el.dispatch("pointermove", move(onShaft.x, onShaft.y, 1)); // same spot
    expect(h.t.distance).toBeCloseTo(33.594);
  });

  it("the depth box follows the drag instead of holding the seeded value", () => {
    const h = harness();
    h.tool.startEdit("ex1", () => {});
    expect(h.t.dim.getValue("distance")).toBeCloseTo(33.594);

    h.el.dispatch("pointerdown", press(onShaft.x, onShaft.y));
    h.el.dispatch("pointermove", move(onShaft.x, 100, 1));

    expect(h.t.dim.getValue("distance"), "the box froze while the solid moved").toBeCloseTo(38.594);
  });

  it("releasing ends the drag — the next hover is inert again", () => {
    const h = harness();
    h.tool.startEdit("ex1", () => {});
    h.el.dispatch("pointerdown", press(onShaft.x, onShaft.y));
    h.el.dispatch("pointermove", move(onShaft.x, 100, 1));
    const held = h.t.distance;
    windowHub.dispatch("pointerup", move(onShaft.x, 100));

    h.el.dispatch("pointermove", move(onShaft.x, 500));

    expect(h.t.distance, "the drag latched on after release").toBe(held);
  });

  it("a plain click AWAY from the arrow still commits", () => {
    // The hit test must not swallow the commit gesture. (700, 520) is 300 px off
    // the arrow's screen segment.
    const h = harness();
    h.tool.startEdit("ex1", () => {});
    const commit = vi.fn(async () => {});
    h.t.commit = commit;

    click(h, 700, 520);

    expect(commit).toHaveBeenCalledTimes(1);
    expect(h.t.distance).toBe(33.594);
  });

  it("a press ON the arrow does not commit", () => {
    const h = harness();
    h.tool.startEdit("ex1", () => {});
    const commit = vi.fn(async () => {});
    h.t.commit = commit;

    h.el.dispatch("pointerdown", press(onShaft.x, onShaft.y));

    expect(commit, "grabbing the handle committed the feature").not.toHaveBeenCalled();
  });
});

// --- the rule both reports share -------------------------------------------

describe("ExtrudeTool depth handle, both paths", () => {
  it("typing survives a hover, and a drag overrides it", () => {
    const h = harness();
    h.tool.start(() => {});
    // what the user typed: DimInput marks the field userDriven on `input`
    const dim = (h.tool as unknown as { dim: { seed: (n: string, v: number) => void } }).dim;
    dim.seed("distance", 42);
    h.el.dispatch("pointermove", move(560, 546));
    expect(h.t.distance, "a hover overwrote a typed depth").toBeCloseTo(42);

    // the arrow is now 42 mm long: screen segment x=400, y from 300 up to -120
    h.el.dispatch("pointerdown", press(400, 200)); // axis +10
    h.el.dispatch("pointermove", move(400, 150, 1)); // axis +15
    expect(h.t.distance, "a deliberate drag did not override the typed value").toBeCloseTo(47);
  });

  it("a hover after a NEGATIVE drag does not strip the cut's sign", () => {
    // The trap the handle model opens up. While tracking, the box shows the
    // MAGNITUDE (`updateFromCursor({ distance: Math.abs(...) })`), and a drag
    // leaves the field unlocked — so the not-dragging branch, which reads the
    // field back so typing reaches the preview, would read +25 for a -25 mm cut
    // and turn it into a join on the next stray mouse move. Only a value the
    // user actually TYPED carries its own sign, so only a typed value is read
    // back. (The DimInput abs-display trap, third sighting.)
    const h = harness();
    h.tool.start(() => {});
    h.el.dispatch("pointerdown", press(400, 250)); // on the 10 mm arrow, axis +5
    h.el.dispatch("pointermove", move(400, 600, 1)); // axis -30 → depth -25
    expect(h.t.distance).toBeCloseTo(-25);
    windowHub.dispatch("pointerup", move(400, 600));

    h.el.dispatch("pointermove", move(300, 400));

    expect(h.t.distance, "the cut turned into a join on a mouse move").toBeCloseTo(-25);
  });

  it("the create path drags exactly like the edit path", () => {
    // Both reports are one fix, so the two paths must not be left differing in
    // how the handle behaves — only in what the box starts out showing.
    const create = harness();
    create.tool.start(() => {});
    const edit = harness();
    edit.tool.startEdit("ex1", () => {});

    // grab each at its own arrow's midpoint and move 50 px (5 mm) up the axis
    for (const [h, mid] of [
      [create, CY - (10 * SCALE) / 2],
      [edit, CY - (33.594 * SCALE) / 2],
    ] as const) {
      const before = h.t.distance;
      h.el.dispatch("pointerdown", press(400, mid));
      h.el.dispatch("pointermove", move(400, mid - 50, 1));
      expect(h.t.distance - before).toBeCloseTo(5);
    }
  });
});

// --- the camera the user is actually in when they reach for the arrow --------
//
// The first repair of this fix. "Drag the yellow arrow" is only an answer to
// field 6e2bcadd if the arrow can be grabbed from where the user is standing,
// and after Finish Sketch that is looking straight down the sketch normal —
// sketchMode.cleanup calls viewport.exitSketchView, which restores the
// projection mode and the up vector and NOT the orientation.

describe("ExtrudeTool depth handle, looking down the sketch normal", () => {
  it("anchor and tip project to the same screen point — the premise", () => {
    // Not an assertion about the tool: an assertion about the situation, so the
    // tests below cannot quietly stop testing what they claim to.
    const h = harness({ topDown: true });
    h.tool.start(() => {});
    const anchor = new THREE.Vector3(0, 0, 0);
    const tip = new THREE.Vector3(0, 0, 10); // +10 mm along the XY sketch normal
    expect(h.viewport.projectToScreen(anchor)).toEqual({ x: 400, y: 300 });
    expect(h.viewport.projectToScreen(tip)).toEqual({ x: 400, y: 300 });
  });

  it("the profile is grabbable when the shaft projects to nothing", () => {
    // Measured before this repair: the whole grabbable set was a 21 px disc at
    // the profile centre — `pixelDistanceToSegment` clamped to the anchor
    // because the segment had no length. 80 px off the centre missed it.
    const h = harness({ topDown: true });
    h.tool.start(() => {});
    expect(h.t.distance).toBe(10);

    h.el.dispatch("pointerdown", press(480, 300)); // on the profile, 80 px out
    h.el.dispatch("pointermove", move(480, 250, 1)); // 50 px up = +5 mm

    expect(h.t.distance, "the arrow could not be grabbed from the profile").toBeCloseTo(15);
  });

  it("only the SELECTED profile grabs — another one is still just a click", () => {
    // The fallback is deliberately narrow: it widens the handle to the areas
    // being extruded, not to whatever is under the cursor.
    const h = harness({ topDown: true, otherRegion: true });
    h.tool.start(() => {});

    expect(h.t.overArrow(400, 300), "own profile").toBe(true);
    expect(h.t.overArrow(700, 300), "another sketch region grabbed the handle").toBe(false);
  });

  it("a wide grab is safe because a click still commits", () => {
    // What pays for widening the handle to the whole profile: commit is a
    // release in place, so a press on the profile that does not travel is still
    // the commit gesture the prompt teaches.
    const h = harness({ topDown: true });
    h.tool.start(() => {});
    const commit = vi.fn(async () => {});
    h.t.commit = commit;

    click(h, 480, 300); // squarely inside the widened grab region

    expect(commit).toHaveBeenCalledTimes(1);
  });
});

// --- a press must not destroy what the user has already done ----------------

describe("ExtrudeTool depth handle, press vs click", () => {
  it("a typed depth survives a click that lands on the arrow", () => {
    // Measured before this repair: pointermove over the profile, "25" in the D
    // box, pointerdown at the same place (the taught click-to-commit), release
    // without moving — the tool committed the PRE-TYPED value. The press
    // unlocked the field, so commit's isUserDriven gate then refused to read
    // the number the user had just typed.
    const h = harness({ topDown: true });
    h.tool.start(() => {});
    const dim = (h.tool as unknown as { dim: { seed: (n: string, v: number) => void } }).dim;
    h.el.dispatch("pointermove", move(400, 300));
    dim.seed("distance", 25); // what typing leaves behind: value + userDriven

    click(h, 400, 300); // the arrow is here, and so is the taught commit click

    expect((h.written.feature as { distance: number }).distance).toBe(25);
  });

  it("a press that MISSES the handle does not commit the feature", () => {
    // Measured before this repair, side-on: press 15 px off the shaft (aimed at
    // it), drag — the distance stayed 33.594 and the feature was committed
    // anyway, because commit fired on pointerDOWN with no movement guard. A
    // miss is now a no-op, which is the whole point: one more click costs a
    // click, one accidental commit costs the work.
    const h = harness();
    h.tool.startEdit("ex1", () => {});
    const commit = vi.fn(async () => {});
    h.t.commit = commit;

    h.el.dispatch("pointerdown", press(415, 150)); // 15 px off the shaft at x=400
    h.el.dispatch("pointermove", move(415, 100, 1));
    windowHub.dispatch("pointerup", release(415, 100));

    expect(commit, "a missed grab committed the in-progress feature").not.toHaveBeenCalled();
    expect(h.t.distance, "a missed grab moved the depth").toBe(33.594);
  });

  it("a release far from the press does not commit, even with no move heard", () => {
    // Moves are only heard on the CANVAS while the release is heard on the
    // window, so a drag that leaves the viewport delivers no pointermove at all.
    // Without checking the release position that would come back as a click and
    // commit — the same lost work by another route.
    const h = harness();
    h.tool.startEdit("ex1", () => {});
    const commit = vi.fn(async () => {});
    h.t.commit = commit;

    h.el.dispatch("pointerdown", press(415, 150));
    windowHub.dispatch("pointerup", release(415, 400));

    expect(commit).not.toHaveBeenCalled();
  });

  it("a release with no press behind it does not commit", () => {
    // The click that PICKS a profile goes down in the pick phase and comes up in
    // the drag phase, because onDown calls beginDrag. If that release could
    // commit, choosing a profile would commit the extrude in the same gesture.
    // Also covers a release that started on the ribbon or the depth box.
    const h = harness();
    h.tool.startEdit("ex1", () => {});
    const commit = vi.fn(async () => {});
    h.t.commit = commit;

    windowHub.dispatch("pointerup", release(400, 150));

    expect(commit).not.toHaveBeenCalled();
  });

  it("a press under the drag threshold does not touch the depth", () => {
    // The other half of "typing wins until the user DRAGS": a hand that shakes
    // 3 px between press and release is a click, not a scrub.
    const h = harness();
    h.tool.startEdit("ex1", () => {});

    h.el.dispatch("pointerdown", press(400, 150));
    h.el.dispatch("pointermove", move(402, 152, 1)); // ~2.8 px: still a click

    expect(h.t.distance).toBe(33.594);
  });
});

// --- what the reviewer's mutations must break -------------------------------

describe("ExtrudeTool overArrow, the parts nothing else asserts", () => {
  it("grabs a NEGATIVE arrow where it is DRAWN, not where +n would be", () => {
    // Hardcoding `sign = 1` in overArrow left every other test in this file
    // green while a cut's visible arrow refused to be grabbed — and, before
    // commit moved to the release, committed the feature instead.
    const h = harness();
    h.tool.start(() => {});
    // drag the 10 mm arrow down to -25 mm, then let go
    h.el.dispatch("pointerdown", press(400, 250));
    h.el.dispatch("pointermove", move(400, 600, 1));
    windowHub.dispatch("pointerup", release(400, 600));
    expect(h.t.distance).toBeCloseTo(-25);

    // the arrow is now drawn from y=300 DOWN to y=550; +n is bare screen
    expect(h.t.overArrow(400, 450), "the drawn (negative) shaft").toBe(true);
    expect(h.t.overArrow(400, 150), "the mirrored +n side, where nothing is drawn").toBe(false);

    // and it drags from there
    h.el.dispatch("pointerdown", press(400, 450));
    h.el.dispatch("pointermove", move(400, 500, 1)); // 50 px further down = -5 mm
    expect(h.t.distance, "the visible cut arrow could not be dragged").toBeCloseTo(-30);
  });

  it("grabs along the 1 mm floor the arrow is DRAWN at, not its true length", () => {
    // updatePreview floors the drawn arrow at ARROW_MIN_MM; overArrow reads the
    // same floor. Dropping the Math.max leaves an arrow that is plainly on
    // screen and refuses to be grabbed past its true tip.
    //
    // Zoomed to 100 px/mm so both lengths clear DEGENERATE_SHAFT_PX (20) and the
    // profile fallback stays out of it: a 0.4 mm depth is 40 px of true shaft
    // and 100 px of drawn shaft. 70 px up is 30 px past the true tip — well
    // outside GRAB_PX — and comfortably inside the drawn one.
    const h = harness({ scale: 100, savedDistance: 0.4 });
    h.tool.startEdit("ex1", () => {});
    expect(h.t.distance).toBe(0.4);

    expect(h.t.overArrow(400, 230), "the drawn shaft past the true tip").toBe(true);

    h.el.dispatch("pointerdown", press(400, 230));
    h.el.dispatch("pointermove", move(400, 180, 1)); // 50 px = +0.5 mm at this zoom
    expect(h.t.distance, "the arrow as drawn could not be dragged").toBeCloseTo(0.9);
  });
});

// A gesture the browser never finishes must not leave the handle latched to the
// cursor. That is field 3998d6ea ("the arrow is attached to my mouse") reached
// from the other side: the fix for it made the depth follow the pointer ONLY
// while a press is held, so anything that loses the release re-opens it in full.
// pointerup is heard on window, which covers releasing over the depth box or off
// the canvas — it does not cover a release the browser never delivers.
describe("a lost release does not latch the depth to the cursor", () => {
  it("stops dragging when the button is no longer down on a move", () => {
    // Drag out past the window edge and release there: for mouse input no
    // pointerup arrives at all. The next move over the canvas still carries
    // buttons=0, which is the only evidence available that the gesture is over.
    const h = harness();
    h.tool.startEdit("ex1", () => {});
    h.el.dispatch("pointerdown", press(400, 250));
    h.el.dispatch("pointermove", move(400, 200, 1)); // held: this is a real drag
    const dragged = h.t.distance;
    expect(dragged, "the drag did not move the depth at all").not.toBeCloseTo(33.594);

    h.el.dispatch("pointermove", move(400, 100, 0)); // button no longer down
    const afterLoss = h.t.distance;
    h.el.dispatch("pointermove", move(400, 40, 0)); // bare hover, far away
    expect(h.t.distance, "the depth followed a cursor with no button held")
      .toBeCloseTo(afterLoss);
  });

  it("pointercancel abandons the drag without committing", () => {
    // A system drag, context menu or focus loss takes the gesture away. Nothing
    // about the user's intent is known, so this must not be read as a click.
    const h = harness();
    h.tool.startEdit("ex1", () => {});
    h.el.dispatch("pointerdown", press(400, 250));
    h.el.dispatch("pointermove", move(400, 200, 1));
    const dragged = h.t.distance;

    windowHub.dispatch("pointercancel", {});
    // buttons=1 DELIBERATELY. A cancel means the browser took the gesture away
    // while the button is still nominally down, so the buttons check cannot see
    // it — only the cancel handler can. With buttons=0 here this test would pass
    // with the pointercancel listener removed entirely, which is the whole
    // failure mode it exists to catch.
    h.el.dispatch("pointermove", move(400, 60, 1));
    expect(h.t.distance, "the cancelled drag kept following the cursor").toBeCloseTo(dragged);
    expect(h.written.feature, "a cancelled gesture committed a feature").toBeNull();
  });

  it("CONTROL: a held drag still moves the depth, so the guard is not blanket", () => {
    const h = harness();
    h.tool.startEdit("ex1", () => {});
    h.el.dispatch("pointerdown", press(400, 250));
    h.el.dispatch("pointermove", move(400, 200, 1));
    const a = h.t.distance;
    h.el.dispatch("pointermove", move(400, 150, 1));
    expect(h.t.distance, "a held drag stopped working").not.toBeCloseTo(a);
  });
});
