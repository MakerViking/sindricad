// A toast with something to read must stay up long enough to read it.
//
// Field report 4875dacc (0.1.225, Windows), about a refused Press/Pull: "the
// warning message disappears far too quickly, I don't get time to read and
// understand it or copy it. There is a 'SHOW' button and an 'x' but the 'SHOW'
// does not seem to do anything. I suggest letting the user close the dialogue
// rather than timeout."
//
// Three faults, all asserted here through the real toast() and the events a
// user's pointer, keyboard and click deliver to it:
//   1. every error went after a flat 8 s, and that refusal is 364 characters;
//   2. nothing held it while the pointer was on it or focus was in it;
//   3. its action dismissed it unconditionally, so Show threw away the only copy
//      of the message on screen.
// main.ts cannot run here (it needs WebGL and a sidecar), so its half, the
// failure toast's options and what Show does, is pinned as source at the end.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeEl, installFakeDocument } from "./fakeDom.testkit";
import { toast, toastTimeout } from "./toast";
import mainSrc from "../main.ts?raw";

/** fakeDom's element plus what toast() needs: remove() and firstElementChild. */
class El extends FakeEl {
  parent: El | null = null;
  appendChild(c: FakeEl): FakeEl {
    (c as El).parent = this;
    return super.appendChild(c);
  }
  get firstElementChild(): El | null {
    return (this.children[0] as El | undefined) ?? null;
  }
  remove() {
    const p = this.parent;
    if (p) p.children.splice(p.children.indexOf(this), 1);
    this.parent = null;
  }
}
installFakeDocument();
const doc = globalThis.document as unknown as { createElement: (tag: string) => El; body: El };
doc.createElement = (tag: string) => new El(tag);
doc.body = new El("body");
// toast() schedules through window.*; delegate at call time so fake timers apply
vi.stubGlobal("window", {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (id: number) => clearTimeout(id),
});
afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.runAllTimers(); // let every timed toast leave
  // a sticky one never leaves on its own: clear it, so the next test starts empty
  const stack = doc.body.children.find((c) => c.className === "toast-stack");
  if (stack) stack.children.length = 0;
  vi.useRealTimers();
});

/** The toasts on screen, by their message. */
function onScreen(): string[] {
  const stack = doc.body.children.find((c) => c.className === "toast-stack");
  return (stack?.children ?? []).map((t) => t.children.find((c) => c.className === "toast-msg")?.textContent ?? "");
}
function toastEl(message: string): El {
  const stack = doc.body.children.find((c) => c.className === "toast-stack")!;
  return stack.children.find((t) => t.children.some((c) => c.textContent === message)) as El;
}

// The reporter's message, verbatim (364 characters).
const REFUSAL =
  "⚠ Press/Pull failed: This face meets its neighbour at the shallow angle of a tessellation facet, so I cannot tell it from one piece of a curved surface I did not recognise, and moving it on its own would dent the body rather than resize the curve. On a mesh body that is still entirely faceted, Clean Up can sometimes recognise the curve.";

describe("a long error stays up long enough to read (4875dacc)", () => {
  it("the reporter's message outlasts the old 8 s, and still goes on its own", () => {
    toast(REFUSAL, { kind: "error" });
    vi.advanceTimersByTime(8000 + 200);
    expect(onScreen(), "gone at the old flat 8 s").toContain(REFUSAL);
    vi.advanceTimersByTime(30000);
    expect(onScreen()).not.toContain(REFUSAL);
  });

  it("short messages keep their old timing, and nothing waits longer than 30 s", () => {
    expect(toastTimeout("info", REFUSAL)).toBe(3500);
    expect(toastTimeout("error", "Export failed")).toBe(8000);
    expect(toastTimeout("warning", "Nothing to undo")).toBe(6000);
    expect(toastTimeout("warning", REFUSAL)).toBeGreaterThan(20000);
    expect(toastTimeout("error", REFUSAL.repeat(5))).toBe(30000);
  });

  it("the pointer on it holds it, for as long as it stays", () => {
    toast("Saved", { kind: "info" });
    toastEl("Saved").dispatch("mouseenter");
    vi.advanceTimersByTime(60000);
    expect(onScreen()).toContain("Saved");
    toastEl("Saved").dispatch("mouseleave");
    vi.advanceTimersByTime(3500 + 200);
    expect(onScreen()).not.toContain("Saved");
  });

  it("focus inside it (Tab to its button) holds it too", () => {
    toast("Exported", { kind: "info" });
    toastEl("Exported").dispatch("focusin");
    vi.advanceTimersByTime(60000);
    expect(onScreen()).toContain("Exported");
    toastEl("Exported").dispatch("focusout");
    vi.advanceTimersByTime(3500 + 200);
    expect(onScreen()).not.toContain("Exported");
  });

  it("the pointer leaving does not let it go while focus is still inside it", () => {
    toast("Reloaded", { kind: "info" });
    const el = toastEl("Reloaded");
    el.dispatch("focusin");
    el.dispatch("mouseenter");
    el.dispatch("mouseleave");
    vi.advanceTimersByTime(60000);
    expect(onScreen()).toContain("Reloaded");
  });

  it("a toast that was about to go does not vanish the moment the pointer leaves it", () => {
    toast("Copied", { kind: "info" });
    vi.advanceTimersByTime(3400);
    toastEl("Copied").dispatch("mouseenter");
    toastEl("Copied").dispatch("mouseleave");
    vi.advanceTimersByTime(1000);
    expect(onScreen()).toContain("Copied");
  });
});

describe("Show leaves the message up (4875dacc)", () => {
  function actionButton(message: string): El {
    return toastEl(message).children.find((c) => c.className === "toast-action") as El;
  }

  it("an action marked keepOnAction runs and the toast stays", () => {
    const shown: string[] = [];
    toast(REFUSAL, { kind: "error", timeout: 0, keepOnAction: true, action: { label: "Show", onClick: () => shown.push("f7") } });
    actionButton(REFUSAL).dispatch("click");
    expect(shown).toEqual(["f7"]);
    vi.advanceTimersByTime(60000);
    expect(onScreen()).toContain(REFUSAL);
  });

  it("any other action still closes it, and so does the ✕", () => {
    toast("Every body is hidden", { kind: "warning", timeout: 0, action: { label: "Show all", onClick: () => {} } });
    actionButton("Every body is hidden").dispatch("click");
    vi.advanceTimersByTime(200);
    expect(onScreen()).not.toContain("Every body is hidden");

    toast(REFUSAL, { kind: "error", timeout: 0 });
    toastEl(REFUSAL).children.find((c) => c.className === "toast-close")!.dispatch("click");
    vi.advanceTimersByTime(200);
    expect(onScreen()).not.toContain(REFUSAL);
  });
});

// The half that lives in main.ts: the build listener that raises a feature's
// failure toast, and what its Show does.
describe("main.ts: a feature's failure toast", () => {
  const at = mainSrc.indexOf('toast(t("feature.failed"');
  const call = mainSrc.slice(at, mainSrc.indexOf("\n        );", at));

  it("stays until the user closes it when it is their own commit, and Show does not close it", () => {
    expect(at, "the feature-failure toast call moved; re-anchor this test").toBeGreaterThan(-1);
    expect(call).toContain("...(id === lastCommittedId ? { timeout: 0 } : {})");
    expect(call).toContain("keepOnAction: !repairable?.at");
  });

  it("any other failure (a document opening with several) is not sticky: it gets reading time and goes", () => {
    // Every failure sticky parked up to three red toasts over the viewport on
    // opening a file with failing features, each to be closed by hand.
    expect(call).not.toMatch(/^\s*timeout: 0\b/m);
  });

  it("goes by itself once its feature builds again, and with its document", () => {
    expect(mainSrc).toMatch(/for \(const \[id, dismiss\] of failureToasts\) \{\s*if \(ids\.has\(id\)\) continue;\s*dismiss\(\);/);
    const replace = mainSrc.indexOf("store.onReplace(() => {\n  for (const dismiss of failureToasts.values()) dismiss();");
    expect(replace).toBeGreaterThan(-1);
  });

  it("Show selects the feature AND reveals its chip", () => {
    // Selecting alone was a visible no-op: the commit had already selected it.
    const fn = mainSrc.slice(mainSrc.indexOf("function showFeature("), mainSrc.indexOf("\n}", mainSrc.indexOf("function showFeature(")));
    expect(fn).toContain("selectFeature(id)");
    expect(fn).toContain("timeline.reveal(id)");
    expect(mainSrc).toContain('{ label: t("common.show"), onClick: () => showFeature(id) }');
    expect(mainSrc).toContain('action: { label: t("common.show"), onClick: () => showFeature(fid) }');
  });
});
