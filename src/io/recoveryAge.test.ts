// The one number in the recovery prompt: "Recover unsaved work? (drawing, ~90
// min old)". It is a count in a sentence, so it is grouped and follows the
// locale — and the "min" is in the catalogue, not spliced on in code, so a
// translation can put the unit where its grammar wants it.
import { describe, it, expect } from "vitest";
import { recoveryAge } from "./recovery";
import { t } from "../i18n";

const MIN = 60_000;

describe("recoveryAge", () => {
  it("reports whole minutes since the snapshot", () => {
    const now = Date.UTC(2026, 0, 2, 12, 0, 0);
    expect(recoveryAge(now - 90 * MIN, now)).toBe("90");
  });

  it("never says nothing was lost when something was", () => {
    const now = Date.UTC(2026, 0, 2, 12, 0, 0);
    expect(recoveryAge(now - 4_000, now), "seconds old is still a minute").toBe("1");
  });

  it("groups a long-running session's age the way the locale writes it", () => {
    // A session left open overnight really does reach four digits.
    const now = Date.UTC(2026, 0, 2, 12, 0, 0);
    expect(recoveryAge(now - 1440 * MIN, now)).toBe("1,440"); // en
  });

  it("lands in the prompt as a number, not as an unfilled placeholder", () => {
    const now = Date.UTC(2026, 0, 2, 12, 0, 0);
    const line = t("recovery.prompt", { from: "drawing.sindri", age: recoveryAge(now - 90 * MIN, now) });
    expect(line).toContain("90");
    expect(line).not.toContain("{age}");
  });
});
