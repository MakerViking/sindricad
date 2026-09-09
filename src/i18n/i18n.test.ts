import { beforeEach, describe, expect, it } from "vitest";
import { detectLocale, getLocale, hasKey, setLocale, setMissingKeyReporter, sourceOf, t, tEn } from "./index";
import { pseudoize } from "./pseudo";
import { asLocale } from "./registry";

let missing: string[] = [];
beforeEach(() => {
  missing = [];
  setMissingKeyReporter((key) => missing.push(key));
  setLocale("en");
});

describe("t()", () => {
  it("looks up nested keys and fills named parameters", () => {
    expect(t("common.cancel")).toBe("Cancel");
    expect(t("settings.language.system", { name: "English" })).toBe("System default (English)");
  });

  it("selects plural forms from Intl.PluralRules, never from a ternary", () => {
    expect(t("common.bodies", { count: 1 })).toBe("1 body");
    expect(t("common.bodies", { count: 2 })).toBe("2 bodies");
    expect(t("common.bodies", { count: 0 })).toBe("0 bodies");
  });

  it("never returns an empty string: a missing key falls back to the key and warns once", () => {
    expect(t("nope.missing")).toBe("nope.missing");
    expect(t("nope.missing")).toBe("nope.missing");
    expect(missing).toEqual(["nope.missing"]);
  });

  it("leaves an unfilled placeholder visible rather than blanking it", () => {
    expect(t("settings.language.system")).toBe("System default ({name})");
    expect(missing).toContain("settings.language.system#name");
  });

  it("remembers what it produced so a breadcrumb can name the key and the English", () => {
    const s = t("common.bodies", { count: 3 });
    expect(sourceOf(s)).toEqual({ key: "common.bodies", english: "3 bodies" });
    expect(sourceOf("never produced")).toBeUndefined();
  });

  it("tEn and hasKey read English regardless of locale", () => {
    setLocale("qps-ploc");
    expect(tEn("common.cancel")).toBe("Cancel");
    expect(hasKey("common.cancel")).toBe(true);
    expect(hasKey("common.nope")).toBe(false);
  });
});

describe("pseudo-locale", () => {
  it("brackets, accents and lengthens every string, leaving placeholders intact", () => {
    setLocale("qps-ploc");
    expect(getLocale()).toBe("qps-ploc");
    const s = t("settings.language.system", { name: "English" });
    expect(s.startsWith("[")).toBe(true);
    expect(s.endsWith("]")).toBe(true);
    expect(s).toContain("(English)"); // the parameter is data, not translated
    expect(s).not.toContain("System"); // the fixed text was accented
    expect(s.length).toBeGreaterThan("System default (English)".length * 1.3);
  });

  it("pseudoize keeps the growth near 35% and keeps braces", () => {
    const p = pseudoize("Save {name}");
    expect(p).toMatch(/^\[.*\{name\}.*\]$/);
    expect(p).toContain("~");
  });

  it("plural entries are pseudoized per form", () => {
    setLocale("qps-ploc");
    expect(t("common.bodies", { count: 2 })).toMatch(/^\[2 .*\]$/);
  });
});

describe("the plural-set rule", () => {
  // A group of ordinary keys that happens to contain one named `other` used to
  // be read as a plural set, which silently dropped every sibling key. The bug
  // reporter's category picker is exactly that shape, and the catalogue check
  // caught it: `bug.category.label` had vanished.
  it("treats a group containing an `other` key as a group, not a plural set", () => {
    expect(t("bug.category.label")).toBe("What kind of report is this?");
    expect(t("bug.category.other")).toBe("Something else");
    expect(t("bug.category.translation")).toBe("A translation is wrong or missing");
    expect(missing).toEqual([]);
  });

  it("still reads a real plural set, whose keys are all CLDR categories", () => {
    expect(t("common.faces", { count: 1 })).toBe("1 face");
    expect(t("common.faces", { count: 4 })).toBe("4 faces");
  });
});

describe("locale detection and narrowing", () => {
  it("maps a BCP 47 tag to a registered locale and defaults to English", () => {
    expect(detectLocale("en-US")).toBe("en");
    expect(detectLocale("de-DE")).toBe("en");
    expect(detectLocale(undefined)).toBe("en");
    expect(detectLocale("qps-ploc")).toBe("en"); // never auto-selected
  });

  it("asLocale refuses anything not registered", () => {
    expect(asLocale("en")).toBe("en");
    expect(asLocale("qps-ploc")).toBe("qps-ploc");
    expect(asLocale("xx")).toBeNull();
    expect(asLocale("__proto__")).toBeNull();
    expect(asLocale(42)).toBeNull();
  });
});
