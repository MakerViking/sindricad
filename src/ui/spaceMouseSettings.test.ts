// 3D Mouse Settings says whether a 3D mouse was found (882cf869).
//
// Field report 882cf869, "Mouse test not working": the test cube in this dialog
// moves ONLY with a SpaceMouse's puck, and the dialog never said whether one had
// been found. With no device, or with one the OS would not let us open, the
// axis bars and the cube sat still and nothing on screen said why. The report
// could not tell those cases apart either.
//
// The dialog is opened the way the menu opens it (`new SpaceMouseSettings()
// .open()`), and the device arrives the way the HID inventory delivers it, so
// these read the line the user reads. Only the WebGL renderer of the test cube is
// stood in for: there is no GPU in a node test run.
//
// What it does NOT cover, stated rather than implied: the native reader that
// fills in the device (src-tauri/src/spacemouse.rs) and main.ts passing it on.
// Those were checked by compiling the shell and driving the app headless.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeEl, installFakeDocument } from "./fakeDom.testkit";

vi.mock("three", async (importOriginal) => {
  const real = await importOriginal<typeof import("three")>();
  class WebGLRenderer {
    setPixelRatio() {}
    setSize() {}
    render() {}
    dispose() {}
  }
  return { ...real, WebGLRenderer };
});

beforeEach(() => {
  vi.resetModules(); // a fresh input module: no device reported yet
  installFakeDocument();
  const doc = globalThis.document as unknown as Record<string, unknown> & { body: FakeEl };
  doc.createTextNode = (s: string) => Object.assign(new FakeEl("#text"), { textContent: s });
  // close() takes the overlay off the page; the stub has no remove() of its own
  const make = doc.createElement as (tag: string) => FakeEl;
  doc.createElement = (tag: string) =>
    Object.assign(make(tag), {
      remove(this: FakeEl) {
        const kids = doc.body.children;
        if (kids.includes(this)) kids.splice(kids.indexOf(this), 1);
      },
    });
  vi.stubGlobal("window", { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function openDialog() {
  const input = await import("../input/spacemouse");
  const { SpaceMouseSettings } = await import("./spaceMouseSettings");
  const { t } = await import("../i18n");
  return { input, t, dialog: new SpaceMouseSettings() };
}

/** The status line, wherever the dialog put it. */
function statusLine(): FakeEl | undefined {
  const body = (globalThis.document as unknown as { body: FakeEl }).body;
  const walk = (el: FakeEl): FakeEl | undefined =>
    el.className.split(" ").includes("sm-status") ? el : el.children.map(walk).find(Boolean);
  return walk(body);
}

const shown = (el: FakeEl | undefined) => !!el && !(el as unknown as { hidden?: boolean }).hidden;

describe("3D Mouse Settings: is there a 3D mouse? (882cf869)", () => {
  it("names the device it is reading", async () => {
    const { input, t, dialog } = await openDialog();
    input.setSpaceMouseDevice({ product: "SpaceMouse Compact", unreadable: null });
    dialog.open();
    const line = statusLine();
    expect(shown(line), "the dialog says nothing about the device").toBe(true);
    expect(line!.textContent).toBe(t("settings.spaceMouse.status.connected", { name: "SpaceMouse Compact" }));
    expect(line!.textContent).toContain("SpaceMouse Compact");
    expect(line!.className).toContain("sm-status-ok");
    dialog.close();
  });

  it("says when none was found, and that the cube moves only with one", async () => {
    const { input, t, dialog } = await openDialog();
    input.setSpaceMouseDevice({ product: null, unreadable: null });
    dialog.open();
    const line = statusLine();
    expect(shown(line), "no device, and still no word about it").toBe(true);
    expect(line!.textContent).toBe(t("settings.spaceMouse.status.none"));
    // the sentence the reporter needed: an ordinary mouse does not drive the test
    expect(line!.textContent).toMatch(/No 3D mouse found/);
    expect(line!.textContent).toMatch(/only with a SpaceMouse/);
    dialog.close();
  });

  it("names a device it found but cannot open, and where the fix is", async () => {
    const { input, t, dialog } = await openDialog();
    input.setSpaceMouseDevice({ product: null, unreadable: "SpaceNavigator" });
    dialog.open();
    const line = statusLine();
    expect(line!.textContent).toBe(t("status.spaceMouseBlocked", { name: "SpaceNavigator" }));
    expect(line!.textContent).toContain("README");
    expect(line!.className).toContain("sm-status-blocked");
    dialog.close();
  });

  it("follows the device while the dialog is open, and lets go when it closes", async () => {
    const { input, t, dialog } = await openDialog();
    input.setSpaceMouseDevice({ product: null, unreadable: null });
    dialog.open();
    const line = statusLine();
    // plugged in with the dialog up: the reader's next pass reports it
    input.setSpaceMouseDevice({ product: "SpaceMouse Wireless", unreadable: null });
    expect(line!.textContent).toBe(t("settings.spaceMouse.status.connected", { name: "SpaceMouse Wireless" }));
    dialog.close();
    input.setSpaceMouseDevice({ product: null, unreadable: null });
    expect(line!.textContent, "a closed dialog was still being written to").toContain("SpaceMouse Wireless");
  });

  it("says nothing before the reader has reported, rather than guess", async () => {
    const { input, t, dialog } = await openDialog();
    expect(input.getSpaceMouseDevice(), "precondition: nothing reported yet").toBeNull();
    dialog.open();
    expect(shown(statusLine()), "a status was invented with no report behind it").toBe(false);
    input.setSpaceMouseDevice({ product: "SpaceMouse Compact", unreadable: null });
    expect(shown(statusLine())).toBe(true);
    expect(statusLine()!.textContent).toBe(t("settings.spaceMouse.status.connected", { name: "SpaceMouse Compact" }));
    dialog.close();
  });
});
