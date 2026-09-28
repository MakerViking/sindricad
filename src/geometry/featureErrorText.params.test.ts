import { describe, expect, it, vi } from "vitest";

import { featureErrorText } from "./featureErrorText";

// A catalogue of our own (vi.mock is hoisted above the import), so this checks
// what featureErrorText HANDS the translation, whatever locales/en.json says
// today. The sentence is the real one's shape: a split's error over several
// bodies names the first body with damaged parts, counts the bodies (`count`,
// which picks the plural) and the damaged parts in all (`parts`, which does
// not).
vi.mock("../i18n", async (importOriginal) => {
  const real = await importOriginal<typeof import("../i18n")>();
  const catalogue: Record<string, string> = {
    "engine.error.splitDamagedAllMore": "{count} bodies, {body} among them, have damaged parts ({parts} in all).",
  };
  return {
    ...real,
    hasKey: (key: string) => key in catalogue,
    t: (key: string, params?: Record<string, string | number>) =>
      (catalogue[key] ?? key).replace(/\{(\w+)\}/g, (m, name: string) => String(params?.[name] ?? m)),
  };
});

describe("featureErrorText hands the translation every number it counts", () => {
  it("passes `parts` beside `count`, and still fills the body", () => {
    const e = { message: "x", code: "splitDamagedAllMore", body_id: "body2", count: 2, parts: 3 };
    expect(featureErrorText(e, [{ id: "body2", name: "Hinge" }])).toBe(
      "2 bodies, Hinge among them, have damaged parts (3 in all).",
    );
  });
});
