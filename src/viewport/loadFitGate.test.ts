// A load's owed Fit gives way to a user who MOVED the camera, not to one who
// clicked.
//
// Driven in headless chromium, 2026-09-26: open a 2-body document with one body
// hidden, and click the view once while it builds. The document came up
// unframed (the camera stayed 2,455 mm out; 52.96 mm without the click). The
// gate read `userMovedCamera`, and camera-controls fires `controlstart`, which
// sets it, on EVERY press on the canvas, a left selection click included,
// although that press's action is NONE and it moves nothing. On the field Ender
// file, which opens with 339 of 340 bodies hidden and streams for over a minute
// cold, any click in that minute forfeited the framing.
//
// The first part drives the real rig through the pointer path a user's mouse
// takes. The viewport itself cannot be built without WebGL, so the second pins
// the wiring that carries each behaviour to the screen, and every pin was shown
// to fail with its fix reverted. The last runs the viewport's own load path
// (the stream's begin, the commit, a resize) against a stand-in, and watches
// where the camera ends up.
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { harness } from "./rig.testkit";
import { Viewport } from "./viewport";
import { ProgressiveModel } from "./progressive";
import { disposeBody } from "./render";
import { LoadDebts } from "./loadDebts";
import type { RebuildResult } from "../types";
import viewportSrc from "./viewport.ts?raw";

/** A rig that counts both signals: every gesture START, and every real move. */
function counted() {
  const h = harness();
  const n = { starts: 0, moves: 0 };
  h.rig.controls.addEventListener("controlstart", () => n.starts++);
  h.rig.setOnUserMove(() => n.moves++);
  return { h, n };
}

describe("what counts as the user moving the camera", () => {
  it("a selection click does not, though camera-controls announces a gesture for it", () => {
    const { h, n } = counted();
    h.down(0, 400, 300);
    h.up();
    // The precondition that makes this a test of anything: the press reached
    // camera-controls and it DID announce a gesture, which is the signal the
    // old gate read.
    expect(n.starts, "the click never reached camera-controls").toBe(1);
    expect(n.moves, "a plain selection click counted as moving the camera").toBe(0);
  });

  it("nor does a selection click whose pointer wobbles, or a box-select drag", () => {
    const { h, n } = counted();
    h.down(0, 400, 300);
    h.move(402, 301);
    h.move(480, 360);
    h.up();
    expect(n.moves, "a left drag, which selects and never moves the camera, counted").toBe(0);
  });

  it("an orbit does, from its first movement, and a press alone does not", () => {
    const { h, n } = counted();
    h.down(1, 400, 300); // middle = orbit
    h.move(400, 300); // a pointermove that goes nowhere
    expect(n.moves, "pressing the middle button counted before anything moved").toBe(0);
    h.move(410, 300);
    expect(n.moves, "a middle-drag orbit did not count as moving the camera").toBeGreaterThan(0);
    h.up();
  });

  it("a pan does", () => {
    const { h, n } = counted();
    h.down(2, 400, 300); // right = pan
    h.move(420, 310);
    h.up();
    expect(n.moves, "a right-drag pan did not count as moving the camera").toBeGreaterThan(0);
  });
});

/** A method's source, from its signature to its closing brace at method depth. */
function method(signature: string): string {
  const at = viewportSrc.indexOf(signature);
  expect(at, `no "${signature}" in viewport.ts, so this test's slice is stale`).toBeGreaterThan(-1);
  return viewportSrc.slice(at, viewportSrc.indexOf("\n  }\n", at));
}

describe("the viewport wiring that carries the load fit", () => {
  it("gates every owed load fit on real camera movement, not on a press", () => {
    for (const sig of ["  beginProgressiveModel(", "  setModel(", "  clearModel("]) {
      const body = method(sig);
      expect(body, `${sig.trim()} fits on an owed load fit without the gate`).toMatch(/!this\.cameraDriven/);
      expect(
        body,
        `${sig.trim()} gates the load fit on userMovedCamera again, which any click sets`,
      ).not.toMatch(/fit && !this\.userMovedCamera/);
    }
  });

  it("sets that flag only from real movement: the rig's report, the wheel and the SpaceMouse", () => {
    const sets = viewportSrc.split("\n").filter((l) => /this\.cameraDriven = true/.test(l));
    expect(sets.length, "cameraDriven is set from somewhere new; check it is real movement").toBe(2);
    expect(viewportSrc).toMatch(/setOnUserMove\(\(\) => \{\s*this\.cameraDriven = true;/);
    // the other one: the moves camera-controls never reports (the wheel here,
    // the SpaceMouse loop in spacemouse.ts), and it claims the resize re-fit too
    const noted = method("  noteCameraDriven() {");
    expect(noted).toContain("this.cameraDriven = true");
    expect(noted, "a SpaceMouse user is re-framed on every window resize").toContain("this.userMovedCamera = true");
    const gesture = viewportSrc.slice(
      viewportSrc.indexOf("const gestureStarted = () => {"),
      viewportSrc.indexOf("};", viewportSrc.indexOf("const gestureStarted = () => {")),
    );
    expect(gesture, "the gesture START sets cameraDriven, so a click forfeits the load fit").not.toContain(
      "cameraDriven",
    );
    const wheel = viewportSrc.slice(viewportSrc.indexOf('"wheel",'), viewportSrc.indexOf("{ passive: false }"));
    expect(wheel, "a wheel zoom during a load no longer keeps the camera where the user put it").toContain(
      "this.noteCameraDriven()",
    );
  });

  it("releases both flags when a replacing document first draws", () => {
    const body = method("  releaseCamera() {");
    expect(body).toContain("this.userMovedCamera = false");
    expect(body, "a camera moved on the OLD document cancels the new one's fit").toContain(
      "this.cameraDriven = false",
    );
  });

  it("fits a stream's first frame even with bodies hidden, and leaves the rest owed", () => {
    const body = method("  beginProgressiveModel(");
    expect(body, "a hidden body cancels the first-frame fit, so parts stream in off screen").not.toMatch(
      /const fitNow = [^;]*hiddenBodies/,
    );
    expect(body, "with bodies hidden the commit is no longer owed its narrower fit").toContain(
      "return fitNow && hiddenBodies.length === 0",
    );
  });
});

describe("the viewport wiring that reaches the box and Fit fixes", () => {
  // CHANGELOG: "measures the model from what it actually draws", "Fit always
  // puts the camera back", "Fit frames the bodies you can see". The functions
  // behind those are tested in modelBox.test.ts and fitRecovery.test.ts; these
  // pin the calls that make the viewport use them. Reverting the six call sites
  // to their earlier form left the whole suite green while the app, driven
  // against a sidecar sending ±1e100, kept model.box at ±1e100 and sent Fit
  // and every resize to the origin.
  it("builds the model box from documentBox, never from the sidecar's box verbatim", () => {
    const body = method("  setModel(");
    expect(body).toContain("documentBox(result.bbox, result.mesh.positions)");
    expect(body, "setModel trusts result.bbox verbatim again").not.toMatch(
      /new THREE\.Box3\(new THREE\.Vector3\(\.\.\.result\.bbox/,
    );
  });

  it("refuses a stream's box that is not sane, rather than aiming at it", () => {
    const body = method("  beginProgressiveModel(");
    expect(body).toMatch(/const box = isSaneBox\(sent\) \? sent : new THREE\.Box3\(\);/);
  });

  it("sends every Fit through fitTarget: the command, the load fit and the resize re-fit", () => {
    expect(method("  fitView() {"), "Fit frames hidden bodies again").toContain("this.fitTarget(this.model)");
    expect(method("  setModel("), "the load fit frames hidden bodies again").toContain(
      "this.rig.fit(this.fitTarget(this.model), true)",
    );
    expect(method("  private resize() {"), "a resize re-fits hidden bodies (or ±1e100) again").toContain(
      "this.rig.fit(this.fitTarget(this.model), false)",
    );
    // and nothing fits the raw model box directly any more
    expect(viewportSrc).not.toMatch(/this\.rig\.fit\(this\.model\.box/);
  });

  it("asks for a frame when an eye toggle only flips visibility", () => {
    const body = method("  setModel(");
    const fast = body.slice(body.indexOf("if (anyChanged) {"), body.indexOf("return;", body.indexOf("if (anyChanged) {")));
    expect(fast, "the visibility-only path leaves a stale frame under render-on-demand").toContain(
      "this.requestRender()",
    );
  });
});

// The rest drives the REAL load path: beginProgressiveModel, setModel and
// resize run off the prototype against a stand-in `this` (the pattern
// regionPickRepaint.test.ts uses, since a real Viewport needs a WebGL context),
// with the real rig, the real ProgressiveModel and real body meshes. What they
// observe is where the camera ends up.

/** A Viewport with only the members the load path touches, around a real rig. */
function standIn() {
  const h = harness();
  const group = new THREE.Group();
  const vp = Object.create(Viewport.prototype) as Viewport & Record<string, unknown>;
  Object.assign(vp, {
    rig: h.rig,
    canvas: { getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }) },
    scene: { modelGroup: group, renderer: { localClippingEnabled: false, setSize() {} } },
    progressive: new ProgressiveModel(group, disposeBody),
    picker: { invalidate() {} },
    highlighter: null,
    model: null,
    lastResult: null,
    streaming: false,
    resolution: new THREE.Vector2(800, 600),
    targetGridZ: 0,
    datumPlaneDefs: [],
    analysis: "none",
    bodyPaint: {},
    texturePaint: {},
    zebra: false,
    combs: false,
    clipPlane: null,
    savedMats: new Map(),
    needsRender: false,
    lingerFrames: 0,
    userMovedCamera: false,
    cameraDriven: false,
  });
  // what the constructor wires (pinned above): a drag that moves the camera
  h.rig.setOnUserMove(() => {
    vp["cameraDriven"] = true;
  });
  h.rig.update(0.016);
  return { vp, h };
}

/** 40 mm cubes as one rebuild reply, well away from the origin, so the origin
 *  view Fit falls back to cannot be mistaken for framing them. */
function cubesReply(centres: Record<string, THREE.Vector3>, bbox: RebuildResult["bbox"] | null): RebuildResult {
  const positions: number[] = [];
  const faceIds: number[] = [];
  const bodies: NonNullable<RebuildResult["bodies"]> = [];
  for (const [id, c] of Object.entries(centres)) {
    const g = new THREE.BoxGeometry(40, 40, 40).toNonIndexed();
    g.translate(c.x, c.y, c.z);
    const faceStart = bodies.length * 6;
    const tris = g.getAttribute("position").count / 3;
    positions.push(...(g.getAttribute("position").array as Float32Array));
    for (let t = 0; t < tris; t++) faceIds.push(faceStart + Math.floor(t / 2));
    bodies.push({ id, name: id, faceStart, faceCount: 6, etag: `${id}-1` });
  }
  return {
    mesh: { positions, indices: Array.from({ length: positions.length / 3 }, (_, i) => i), faceIds },
    edges: [],
    bbox: bbox as RebuildResult["bbox"],
    bodies,
  };
}
const CUBE = new THREE.Vector3(520, 0, 20);
const cubeReply = (bbox: RebuildResult["bbox"] | null) => cubesReply({ cube: CUBE }, bbox);

const settle = (h: ReturnType<typeof harness>) => {
  for (let i = 0; i < 600; i++) h.rig.update(1 / 60);
};
const target = (h: ReturnType<typeof harness>) => h.rig.controls.getTarget(new THREE.Vector3());
const position = (h: ReturnType<typeof harness>) => h.rig.controls.getPosition(new THREE.Vector3());

/** main.ts's hand-off, in shape: the begin frame pays the owed fit if it
 *  reports it paid, and the commit is handed whatever is still owed. */
function load(
  vp: Viewport,
  reply: RebuildResult,
  streamBox: RebuildResult["bbox"] | null,
  hidden: string[] = [],
  fit = true,
) {
  let owedFit = fit;
  const paidAtBegin = vp.beginProgressiveModel(1, reply.bodies!, reply, streamBox, hidden, owedFit);
  if (paidAtBegin) owedFit = false;
  return {
    paidAtBegin,
    commit: () => vp.setModel(reply, owedFit, hidden),
  };
}

describe("a stream whose box cannot be trusted", () => {
  // Every real rebuild reply streams, so this is the path the ±1e100 document
  // actually takes. The begin refuses the box and must leave the fit OWED: it
  // has nothing to frame. Reporting it paid, the commit was handed no fit and
  // the opened document came up on the origin view, off screen.
  const OPEN = 1e100;
  for (const [label, box] of [
    ["the ±1e100 box of an untriangulated cone face", { min: [-OPEN, -OPEN, -OPEN], max: [OPEN, OPEN, OPEN] }],
    ["no box at all", null],
  ] as const) {
    it(`keeps the fit owed to the commit, which frames the measured triangles: ${label}`, () => {
      const { vp, h } = standIn();
      const reply = cubeReply(box as RebuildResult["bbox"] | null);
      const run = load(vp, reply, box as RebuildResult["bbox"] | null);
      expect(run.paidAtBegin, "the begin reported the fit paid on a box it refused to aim at").toBe(false);
      run.commit();
      settle(h);
      expect(
        target(h).distanceTo(CUBE),
        "the commit did not frame the triangles: the opened document came up off screen",
      ).toBeLessThan(1);
      expect(h.rig.controls.distance, "the camera is nowhere near the 40 mm part").toBeLessThan(400);
    });
  }

  it("while a sane stream box is framed at the begin, which pays the fit", () => {
    const { vp, h } = standIn();
    const box = { min: [500, -20, 0], max: [540, 20, 40] } as RebuildResult["bbox"];
    const run = load(vp, cubeReply(box), box);
    expect(run.paidAtBegin, "a sane box with every body visible did not pay the fit at the first frame").toBe(true);
    settle(h);
    expect(target(h).distanceTo(CUBE)).toBeLessThan(1);
  });
});

describe("moving the camera over the document being replaced", () => {
  // It stays on screen, and navigable, for the whole build of the one replacing
  // it: 60 to 150 s of OCCT on a cold 340-body open. Released at the
  // replacement, an orbit in that minute vetoed the new document's fit, and it
  // came up unframed. main.ts releases at the first frame instead (the order
  // below is its begin handler's, pinned in loadDebts.test.ts).
  it("does not cost the opened document its fit", () => {
    const { vp, h } = standIn();
    const owed = new LoadDebts();
    const oldBox = { min: [-20, -20, 0], max: [20, 20, 40] } as RebuildResult["bbox"];
    load(vp, cubesReply({ old: new THREE.Vector3(0, 0, 20) }, oldBox), oldBox).commit();
    const orbit = () => {
      h.down(1, 400, 300);
      h.move(460, 330);
      h.up();
    };
    orbit(); // the old document, before the Open
    owed.replaced("load");
    orbit(); // the old document, while the new one builds
    expect(vp["cameraDriven"], "the setup: the orbits did not count as moving the camera").toBe(true);
    owed.onBuild({ building: true });
    if (owed.firstFrame()) vp.releaseCamera();
    const box = { min: [500, -20, 0], max: [540, 20, 40] } as RebuildResult["bbox"];
    const run = load(vp, cubeReply(box), box, [], owed.fit);
    expect(run.paidAtBegin, "an orbit over the OLD document vetoed the fit").toBe(true);
    settle(h);
    expect(target(h).distanceTo(CUBE), "the opened document came up unframed").toBeLessThan(1);
  });
});

// With a body hidden the begin frames the whole model and the commit narrows
// the fit to the visible bodies. A user who moved the camera while the parts
// streamed in was steering THIS document, so that narrowing gives way to them.
describe("moving the camera while the opened document streams in", () => {
  const SHOWN = new THREE.Vector3(520, 0, 20);
  const HIDDEN = new THREE.Vector3(820, 0, 20);
  const BOX = { min: [500, -20, 0], max: [840, 20, 40] } as RebuildResult["bbox"];
  const whole = new THREE.Vector3(670, 0, 20);

  function streamWithOneHidden(move: (vp: Viewport, h: ReturnType<typeof harness>) => void) {
    const { vp, h } = standIn();
    const run = load(vp, cubesReply({ shown: SHOWN, hidden: HIDDEN }, BOX), BOX, ["hidden"]);
    expect(run.paidAtBegin, "with a body hidden the begin paid the fit in full").toBe(false);
    settle(h);
    expect(target(h).distanceTo(whole), "the begin did not frame the whole model").toBeLessThan(1);
    move(vp, h);
    settle(h);
    const before = position(h);
    run.commit();
    settle(h);
    return { h, before };
  }

  it("with nobody touching the camera, the commit narrows the fit to the visible body", () => {
    const { h } = streamWithOneHidden(() => {});
    expect(target(h).distanceTo(SHOWN), "the commit did not frame the visible body").toBeLessThan(1);
  });

  for (const [label, move] of [
    ["a mouse orbit", (_vp: Viewport, h: ReturnType<typeof harness>) => {
      h.down(1, 400, 300);
      h.move(460, 330);
      h.up();
    }],
    ["the SpaceMouse", (vp: Viewport, h: ReturnType<typeof harness>) => {
      // what one frame of the SpaceMouse loop does when an axis is deflected
      h.rig.tumble(0.3, 0.1);
      vp.noteCameraDriven();
    }],
  ] as const) {
    it(`${label} keeps the camera where the user put it`, () => {
      const { h, before } = streamWithOneHidden(move);
      expect(
        position(h).distanceTo(before),
        `the commit yanked the camera after ${label} during the stream`,
      ).toBeLessThan(1e-6);
    });
  }
});

describe("a SpaceMouse moves the camera without the rig noticing", () => {
  // The SpaceMouse loop (spacemouse.ts) drives the rig directly: controls.truck,
  // rig.zoomBy, rig.tumble, rig.roll. None of them is pointer input, so none
  // fires camera-controls' controlstart or the rig's onUserMove, and the
  // viewport never learnt the user had taken the camera.
  it("its calls move the camera and report nothing, which is why the loop must", () => {
    const { h, n } = counted();
    h.rig.update(0.016);
    const from = position(h);
    h.rig.controls.truck(40, 20, false);
    h.rig.zoomBy(0.8);
    h.rig.tumble(0.4, 0.2);
    h.rig.roll(0.3);
    h.rig.update(0.016);
    expect(position(h).distanceTo(from), "the setup did not move the camera").toBeGreaterThan(10);
    expect(n.moves + n.starts, "the rig now reports these itself; noteCameraDriven may be redundant").toBe(0);
  });

  it("once noted, a window resize no longer re-frames over the user's navigation", () => {
    const refit = (note: boolean) => {
      const { vp, h } = standIn();
      const box = { min: [500, -20, 0], max: [540, 20, 40] } as RebuildResult["bbox"];
      load(vp, cubeReply(box), box).commit();
      settle(h);
      h.rig.tumble(0.5, 0.2);
      h.rig.controls.truck(60, 0, false);
      if (note) vp.noteCameraDriven();
      settle(h);
      const before = position(h);
      (vp as unknown as { resize(): void }).resize();
      settle(h);
      return position(h).distanceTo(before);
    };
    expect(refit(false), "the setup: a resize with the camera unclaimed should re-frame").toBeGreaterThan(1);
    expect(refit(true), "a resize re-framed the model over the user's SpaceMouse navigation").toBeLessThan(1e-6);
  });

  it("and a load's owed fit gives way to it", () => {
    const { vp, h } = standIn();
    h.rig.tumble(0.5, 0.2);
    vp.noteCameraDriven();
    settle(h);
    const before = position(h);
    const box = { min: [500, -20, 0], max: [540, 20, 40] } as RebuildResult["bbox"];
    const run = load(vp, cubeReply(box), box);
    expect(run.paidAtBegin, "the begin fitted over a camera the user had driven").toBe(false);
    run.commit();
    settle(h);
    expect(position(h).distanceTo(before)).toBeLessThan(1e-6);
  });
});
