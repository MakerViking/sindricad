// Numbers as a person types them, and as the app prints them back.
//
// The bug this pins: `parseFloat("1,5")` is 1. Every dimension field in the app
// went through it, so a user whose keyboard and whose habits put a comma in
// "one and a half" silently modelled a 1 mm wall — no error, no red chip, just
// the wrong geometry. Assertions here are about the VALUE that comes out, which
// is the thing the user would have measured on the print.
import { describe, it, expect, afterEach } from "vitest";
import {
  canonicalDecimal,
  fieldText,
  fmtCount,
  fmtLength,
  fmtNumber,
  isPlainNumber,
  parseField,
  parseNumber,
  setUnit,
} from "./units";
import { SENS_MAX, fmtSliderValue } from "./spaceMouseSettings";
import { parseExpr } from "../params/parse";
import { evalExpr } from "../params/eval";

afterEach(() => setUnit("mm"));

describe("parseNumber — both decimal separators, every locale", () => {
  it("reads a comma exactly like a dot", () => {
    expect(parseNumber("12,5")).toBe(12.5);
    expect(parseNumber("12.5")).toBe(12.5);
    expect(parseNumber(",5")).toBe(0.5);
    expect(parseNumber("-0,25")).toBe(-0.25);
    expect(parseNumber(" 12,5 ")).toBe(12.5);
  });

  it("treats a lone comma as a DECIMAL separator, never as thousands", () => {
    // Deliberate, and the reason it is pinned here: in a dimension field "1,500"
    // is overwhelmingly a European "one and a half", not fifteen hundred. Reading
    // it as a group separator would silently multiply the value by a thousand —
    // the one failure mode that produces geometry nobody notices until it prints.
    expect(parseNumber("1,500")).toBe(1.5);
    expect(parseNumber("1.500")).toBe(1.5); // and symmetrically for the dot
  });

  it("reads a pasted grouped number by its LAST separator", () => {
    expect(parseNumber("1,234.5")).toBe(1234.5);
    expect(parseNumber("1.234,5")).toBe(1234.5);
    expect(parseNumber("1.234.567")).toBe(1234567); // every group exactly 3 digits
    expect(parseNumber("1,234,567")).toBe(1234567);
    expect(parseNumber("1 234,5")).toBe(1234.5); // fr-style space grouping
    expect(parseNumber("1\u202f234,5")).toBe(1234.5); // ...and U+202F, the one Intl emits
  });

  it("IGNORES a trailing separator instead of reading it as grouping", () => {
    // A separator with no digits after it cannot be a decimal point. Read as
    // one, "1.5." became 15 — a finger that stayed a beat too long on the key
    // committed a ten-times-deeper extrude with no error anywhere.
    expect(parseNumber("1.5.")).toBe(1.5);
    expect(parseNumber("12,5,")).toBe(12.5);
    expect(parseNumber("0,5.")).toBe(0.5);
    expect(parseNumber("3.2.")).toBe(3.2);
    expect(parseNumber("1,500,")).toBe(1.5); // and then the one-separator rule
  });

  it("reads the FULLWIDTH digits a Japanese IME produces", () => {
    // With the IME in kana mode, typing 12 gives "１２" (U+FF11 U+FF12), and the
    // separator keys give fullwidth forms too. They are not ASCII digits, so
    // every numeric field refused a number the user could see on screen.
    expect(parseNumber("１２")).toBe(12);
    expect(parseNumber("１２．５")).toBe(12.5);
    expect(parseNumber("１２，５")).toBe(12.5);
    expect(parseNumber("－５")).toBe(-5); // fullwidth minus
    // and ordinary input is untouched
    expect(parseNumber("12.5")).toBe(12.5);
  });

  it("REFUSES the same mark as both group and decimal separator", () => {
    // "1.234" is a well-formed group, so the shape test alone accepts
    // "1.234.56" and reads it 1234.56 — a silent 1000x on a dimension. No
    // locale writes a group and a decimal with the same character, so this is
    // a slip, and the only safe answer is to refuse it and let the red chip
    // show. Found by an adversarial re-check, after the shape test had been
    // added and reviewed.
    expect(parseNumber("1.234.56")).toBeNull();
    expect(parseNumber("1,234,56")).toBeNull();
    expect(parseNumber("12.345.6")).toBeNull();
    // The genuine mixed-mark forms still read, and so does pure grouping.
    expect(parseNumber("1,234.5")).toBe(1234.5);
    expect(parseNumber("1.234,5")).toBe(1234.5);
    expect(parseNumber("1.234.567")).toBe(1234567);
  });

  it("REFUSES multiple separators that are not grouping in any locale", () => {
    // Not a number anywhere on earth, and the damage is silent: isPlainNumber is
    // this parser, so a value it accepts skips the params engine that used to
    // reject these. "3.14.15" typed in the inspector's Distance row read 314.15.
    for (const bad of ["1.2.3", "3.14.15", "1,2,3", "1..2", ",,5", "1.234,567.5", "12.34.567"]) {
      expect(parseNumber(bad), bad).toBeNull();
    }
    expect(isPlainNumber("3.14.15")).toBe(false);
    // ...while real grouping still reads, including grouping plus a decimal.
    expect(parseNumber("1,234,567.5")).toBe(1234567.5);
    expect(parseNumber("1.234.567,5")).toBe(1234567.5);
  });

  it("keeps signs and exponents", () => {
    expect(parseNumber("-2e3")).toBe(-2000);
    expect(parseNumber("1,5e2")).toBe(150);
    expect(parseNumber("+4")).toBe(4);
  });

  it("refuses what is not a bare number instead of taking its first digits", () => {
    for (const bad of ["", "   ", "abc", "5abc", "5 mm", "w/2", "5+3", ".", ",", "--1", "1e999"]) {
      expect(parseNumber(bad), bad).toBeNull();
    }
  });

  it("is the same predicate isPlainNumber answers with", () => {
    expect(isPlainNumber("12,5")).toBe(true);
    expect(isPlainNumber("width/2")).toBe(false);
    expect(isPlainNumber("5 mm")).toBe(false); // an expression: it has a unit suffix
  });
});

describe("parseField — display unit in, millimetres out", () => {
  it("converts a comma-typed length from the display unit", () => {
    setUnit("cm");
    expect(parseField("1,5")).toBe(15); // 1.5 cm is 15 mm
    setUnit("in");
    expect(parseField("0,5")).toBe(12.7);
  });

  it("leaves an angle in degrees whichever separator was typed", () => {
    setUnit("in");
    expect(parseField("30,5", "angle")).toBe(30.5);
  });
});

describe("display formatting", () => {
  it("never groups, so what it prints can be typed back", () => {
    // The round-trip that matters: a grouped "1,500" would read back as 1.5.
    expect(fmtNumber(1500)).toBe("1500");
    expect(parseNumber(fmtNumber(1500))).toBe(1500);
    expect(parseNumber(fmtNumber(1234.5))).toBe(1234.5);
  });

  it("groups a COUNT, which is prose and is never typed back", () => {
    expect(fmtCount(1500)).toBe("1,500"); // en
  });

  it("does not print minus nothing", () => {
    expect(fmtNumber(-0)).toBe("0");
  });

  it("keeps the unit abbreviation untranslated next to the number", () => {
    expect(fmtLength(40)).toBe("40 mm");
    setUnit("in");
    expect(fmtLength(25.4)).toBe("1 in");
  });

  it("round-trips every field value through parseField", () => {
    setUnit("cm");
    for (const mm of [0.5, 1, 12.5, 1500, 15000, -3.25]) {
      expect(parseField(fieldText(mm)), `${mm} mm`).toBeCloseTo(mm, 6);
    }
  });
});

describe("canonicalDecimal — the expression language keeps the dot", () => {
  it("rewrites a typed comma so an expression field accepts it", () => {
    expect(canonicalDecimal("12,5")).toBe("12.5");
    expect(canonicalDecimal("w/2 + 1,5")).toBe("w/2 + 1.5");
    expect(canonicalDecimal("min(1,5; 2)")).toBe("min(1.5; 2)");
  });

  it("leaves an expression that has no comma alone", () => {
    expect(canonicalDecimal("width/2")).toBe("width/2");
    expect(canonicalDecimal("12.5")).toBe("12.5");
  });

  it("hands the grammar something it accepts — the grammar itself has no comma", () => {
    // Pinning the boundary: a document stores dot-decimal expressions so it
    // means the same thing on the machine that opens it next, and the typed
    // comma is normalised at the input rather than in the tokenizer.
    expect(() => parseExpr("1,5")).toThrow();
    expect(parseExpr(canonicalDecimal("1,5"))).toEqual({ t: "num", v: 1.5 });
    expect(evalExpr(canonicalDecimal("min(1,5; 2)"), {})).toBe(1.5);
  });
});

// The SpaceMouse sensitivity readout lives here because the defect was a
// FORMATTING one — fmtNumber's three-decimal cap, correct for a dimension,
// applied to sliders whose entire range is smaller than half of one of those
// decimals.
describe("SpaceMouse slider readout", () => {
  it("shows a value at every position of every sensitivity slider", () => {
    for (const [name, max] of Object.entries(SENS_MAX)) {
      expect(fmtSliderValue(0), name).toBe("0"); // the bottom really is zero
      // The top of the range, and a value one step in from it: both read "0"
      // before the fix, so all three controls looked dead at every position.
      expect(fmtSliderValue(max), `${name} max`).not.toBe("0");
      expect(fmtSliderValue(max / 2), `${name} mid`).not.toBe("0");
      expect(fmtSliderValue(max / 100), `${name} one step`).not.toBe("0");
    }
  });

  it("keeps two significant digits rather than three decimals", () => {
    expect(fmtSliderValue(SENS_MAX.pan)).toBe("0.000003");
    expect(fmtSliderValue(SENS_MAX.zoom)).toBe("0.0000035");
    expect(fmtSliderValue(SENS_MAX.rotate)).toBe("0.00001");
    expect(fmtSliderValue(0.25)).toBe("0.25");
    expect(fmtSliderValue(0.000000123)).toBe("0.00000012"); // rounded, not dropped
  });

  it("still writes whole numbers whole", () => {
    expect(fmtSliderValue(200)).toBe("200"); // deadzone's top
    expect(fmtSliderValue(37.4)).toBe("37");
  });
});
