import { describe, expect, it } from "vitest";
import { stepDoublePress, DOUBLE_PRESS_MS } from "./doublePress";

describe("stepDoublePress", () => {
  const at = (timeStamp: number, x = 10, y = 10) => ({ clientX: x, clientY: y, timeStamp });

  it("pairs two presses by the time the events happened, not when the handler ran", () => {
    const first = stepDoublePress(null, at(1000));
    // the handler for the second press runs late (a busy main thread), but the
    // press itself was 200 ms after the first
    const second = stepDoublePress(first.next, at(1200));
    expect(second.double).toBe(true);
    expect(second.next).toBeNull();
  });

  it("keeps two presses further apart than the window separate", () => {
    const first = stepDoublePress(null, at(1000));
    expect(stepDoublePress(first.next, at(1000 + DOUBLE_PRESS_MS + 1)).double).toBe(false);
  });

  it("keeps two presses on different spots separate", () => {
    const first = stepDoublePress(null, at(1000));
    expect(stepDoublePress(first.next, at(1100, 40, 40)).double).toBe(false);
  });
});
