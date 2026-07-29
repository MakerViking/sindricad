// The bug-report trail's two channels behave differently on purpose, and the
// difference is load-bearing: a fact captured once at startup must still be in
// the report after the user has done a pile of things.

import { describe, it, expect } from "vitest";
import { crumb, stickyFact, breadcrumbs } from "./breadcrumbs";

describe("breadcrumbs", () => {
  it("evicts ordinary crumbs past the ring size", () => {
    for (let i = 0; i < 40; i++) crumb(`event ${i}`);
    const out = breadcrumbs();
    expect(out.some((l) => l.includes("event 39"))).toBe(true);
    expect(out.some((l) => l.includes("event 0"))).toBe(false);
  });

  it("keeps sticky facts however many crumbs follow, and puts them first", () => {
    stickyFact("[spacemouse] picked nothing — of 26 HID interfaces:");
    for (let i = 0; i < 60; i++) crumb(`noise ${i}`);
    const out = breadcrumbs();
    // This is the whole point: the HID inventory is captured at startup, and the
    // user opens the bug reporter long after. If the ring ate it, the report is
    // silent about the SpaceMouse — which is the failure we set out to fix.
    expect(out.some((l) => l.includes("26 HID interfaces"))).toBe(true);
    expect(out[0]).toContain("[spacemouse]");
  });
});
