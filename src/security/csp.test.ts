// The shipping Content-Security-Policy, pinned — and pinned to what it is about
// to become.
//
// Two policies exist: `csp` (every PACKAGED build) and `devCsp` (only `tauri
// dev`; tauri picks between them in `AppManager::csp`, gated on `is_dev()` =
// `!cfg!(feature = "custom-protocol")`). That split is exactly how the solver
// bug hid for months: `tauri dev` serves from vite with no CSP at all, so the
// policy that killed planegcs in every packaged build could not be reproduced
// on the machine that shipped it. Three Windows reporters and one Linux
// reporter paid for that; src/sketch/solver.test.ts tells the story and pins
// the error message. This file pins the POLICY, which that test deliberately
// does not name.
//
// The assertion that earns its keep is that the two stay IN STEP. A policy that
// is tightened in `devCsp` alone silently protects nothing, and one tightened
// in `csp` alone breaks only for users. Nobody notices either until a report
// arrives.
import { describe, it, expect } from "vitest";

// `?raw` + JSON.parse rather than a JSON import: tsconfig has no
// resolveJsonModule, and vite/client already declares the `?raw` form.
const CONFIGS = import.meta.glob("../../src-tauri/*.json", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** What `script-src` becomes once the vendored planegcs glue (built with
 *  emscripten `-s DYNAMIC_EXECUTION=0`, so embind stops handing source strings
 *  to the Function constructor) is in place. The flip is the deletion of one
 *  token from two lines of src-tauri/tauri.conf.json — see
 *  docs/CSP-SOLVER-VERIFICATION.md, which also gives the procedure that proves
 *  the solver still comes up. Do NOT flip it without running that procedure:
 *  no unit test in this repo exercises a CSP, and `tauri dev` cannot fail. */
export const TARGET_SCRIPT_SRC = "script-src 'self' 'wasm-unsafe-eval'";

/** The one token standing between TARGET_SCRIPT_SRC and today's policy. */
const PENDING_REMOVAL = "'unsafe-eval'";

/** directive name → its value string, e.g. "script-src" → "'self' 'wasm-unsafe-eval'" */
function directives(policy: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of policy.split(";")) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) out.set(name, values.join(" "));
  }
  return out;
}

const conf = (() => {
  const entry = Object.entries(CONFIGS).find(([p]) => p.endsWith("/tauri.conf.json"));
  // a plain throw, not expect(): this runs at collection time, and a missing
  // config must stop the file loudly rather than let every test below pass
  // against an empty policy
  if (!entry) throw new Error("src-tauri/tauri.conf.json is not in the glob — this whole file would be asserting nothing");
  return JSON.parse(entry[1]) as { app?: { security?: { csp?: string; devCsp?: string } } };
})();

const csp = conf.app?.security?.csp ?? "";
const devCsp = conf.app?.security?.devCsp ?? "";

describe("CSP config is where this test thinks it is", () => {
  it("reads both policies out of tauri.conf.json", () => {
    expect(csp, "app.security.csp is missing or empty").toMatch(/script-src/);
    expect(devCsp, "app.security.devCsp is missing or empty").toMatch(/script-src/);
  });

  it("is the only config that sets one", () => {
    // src-tauri holds four configs (alt-ports, bundle, macos-sign, base) and
    // `tauri build --config X` MERGES X over the base. A `security` block in
    // any of the others would override the policy for one build flavour only,
    // which is the same class of divergence as csp/devCsp drifting apart.
    const others = Object.entries(CONFIGS)
      .filter(([p]) => !p.endsWith("/tauri.conf.json"))
      .filter(([, raw]) => JSON.parse(raw)?.app?.security?.csp !== undefined || JSON.parse(raw)?.app?.security?.devCsp !== undefined)
      .map(([p]) => p);
    expect(others, "an override config declares its own CSP — that build flavour no longer ships the policy this file pins").toEqual([]);
  });
});

describe("csp and devCsp stay in step", () => {
  const a = directives(csp);
  const b = directives(devCsp);

  it("declare the same directives", () => {
    expect([...b.keys()].sort()).toEqual([...a.keys()].sort());
  });

  it("agree on script-src exactly", () => {
    // the directive this task is about: if the packaged policy is tightened and
    // the dev one is not (or the reverse), the difference is invisible until a
    // user hits it
    expect(b.get("script-src"), "script-src drifted between the packaged and dev policies").toBe(a.get("script-src"));
  });

  it("differ only in frame-src, and only by a loopback origin", () => {
    // The single legitimate divergence: the dev policy additionally allows the
    // TinkerAtlas site running locally. Everything else must be identical, and
    // anything new that diverges has to be argued for here rather than landing
    // unnoticed.
    const drift = [...a.keys()].filter((k) => a.get(k) !== b.get(k));
    expect(drift, "a directive other than frame-src now differs between the two policies").toEqual(["frame-src"]);

    const extra = (b.get("frame-src") ?? "").split(/\s+/).filter((v) => !(a.get("frame-src") ?? "").split(/\s+/).includes(v));
    expect(extra.every((v) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(v)), `devCsp's frame-src adds a non-loopback origin: ${extra.join(", ")}`).toBe(true);
  });
});

describe("script-src", () => {
  it("still allows WebAssembly compilation", () => {
    // dropping this would take the solver out in dev AND in packaged builds —
    // it is the one eval-family source planegcs legitimately needs
    for (const [name, policy] of [["csp", csp], ["devCsp", devCsp]] as const) {
      expect(directives(policy).get("script-src"), `${name} no longer allows 'wasm-unsafe-eval'`).toContain("'wasm-unsafe-eval'");
    }
  });

  it("carries 'unsafe-eval' ONLY until the patched planegcs glue lands", () => {
    // This is a pin on a known-undesirable state, and it is meant to fail the
    // day it changes. When it does: update TARGET_SCRIPT_SRC's use below,
    // delete this test, and run docs/CSP-SOLVER-VERIFICATION.md end to end —
    // the whole point is that a green vitest run does not prove the solver
    // starts under the tightened policy.
    expect(
      directives(csp).get("script-src"),
      `script-src changed. If 'unsafe-eval' was just removed: good — but a packaged build with the `
        + `stock @salusoft89/planegcs glue will fail to start the 2D solver, because embind hands a `
        + `SOURCE STRING to the Function constructor and 'wasm-unsafe-eval' does not cover that. `
        + `Confirm the vendored glue is in place first (docs/CSP-SOLVER-VERIFICATION.md), then delete this test.`,
    ).toBe(`${TARGET_SCRIPT_SRC.replace("script-src ", "")} ${PENDING_REMOVAL}`);
  });

  it("is the only directive that carries 'unsafe-eval'", () => {
    for (const [name, policy] of [["csp", csp], ["devCsp", devCsp]] as const) {
      const leaked = [...directives(policy)].filter(([d, v]) => d !== "script-src" && v.includes(PENDING_REMOVAL)).map(([d]) => d);
      expect(leaked, `${name} allows 'unsafe-eval' outside script-src — removing it from script-src alone would not tighten anything`).toEqual([]);
    }
  });
});
