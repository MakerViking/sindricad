// Reload keys must not throw the document away.
//
// Field report c2cac5f3 (0.1.181, Windows), while mid-way through a Press/Pull:
// "so I pressed F5 to see if it would refresh it... it took me to some dialogue
// which seemed to be a recovery document."
//
// F5 and Ctrl/Cmd+R are the browser's reload, and the app is a webview. The
// frontend OWNS the document — the sidecar holds no state and rebuilds from
// scratch on every change — so a reload discards everything unsaved and the app
// comes back offering to restore a recovery file. Nothing in the app bound
// either key, so both went straight through to the webview.
//
// The user's mental model was "refresh the viewport". A desktop modeller has
// nothing to refresh, so the correct behaviour is for the key to do nothing at
// all rather than silently discard work.
import { describe, it, expect } from "vitest";
import mainSrc from "../main.ts?raw";

/** The `{...}` block starting at `openAt`, brace-matched. */
function balancedBlock(src: string, openAt: number): string {
  let depth = 0;
  for (let i = openAt; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(openAt, i + 1);
  }
  throw new Error("unbalanced braces from index " + openAt);
}

function reloadHandler(): string {
  const marker = "// F5 and Ctrl/Cmd+R are the BROWSER's reload";
  const at = mainSrc.indexOf(marker);
  expect(
    at,
    "no reload guard in main.ts — F5 reloads the webview and discards the unsaved document "
      + "(field report c2cac5f3)",
  ).toBeGreaterThan(-1);
  const listenerAt = mainSrc.indexOf('window.addEventListener("keydown"', at);
  expect(listenerAt, "the marker comment is no longer followed by a keydown listener").toBeGreaterThan(-1);
  return balancedBlock(mainSrc, mainSrc.indexOf("{", mainSrc.indexOf("=>", listenerAt)));
}

describe("F5 and Ctrl+R do not reload the app", () => {
  it("swallows both spellings of reload", () => {
    const body = reloadHandler();
    expect(body, "F5 is no longer intercepted").toContain('"F5"');
    expect(body, "Ctrl/Cmd+R is no longer intercepted").toMatch(/ctrlKey \|\| e\.metaKey/);
    expect(body, "Cmd+R on macOS is not covered").toContain("metaKey");
    expect(body, "the reload is detected but never prevented").toContain("preventDefault()");
  });

  it("runs in the CAPTURE phase, ahead of every tool's own keydown", () => {
    // A tool that stops propagation on keydown (the sketcher and the dim inputs
    // both do) would otherwise let the reload through from underneath.
    const marker = "// F5 and Ctrl/Cmd+R are the BROWSER's reload";
    const listenerAt = mainSrc.indexOf('window.addEventListener("keydown"', mainSrc.indexOf(marker));
    const block = balancedBlock(mainSrc, mainSrc.indexOf("{", mainSrc.indexOf("=>", listenerAt)));
    const tail = mainSrc.slice(mainSrc.indexOf(block) + block.length, mainSrc.indexOf(block) + block.length + 40);
    expect(tail, "the reload guard is not registered in the capture phase").toMatch(/,\s*true\s*\)/);
  });

  it("stays out of the way in dev, where reloading by hand is the workflow", () => {
    const body = reloadHandler();
    expect(body, "the guard applies in dev too, so the shell can no longer be reloaded by hand")
      .toContain("import.meta.env.DEV");
  });

  it("does not swallow a bare R, which is the Rectangle tool", () => {
    // The guard must require a modifier for "r". Rectangle is bound to R in the
    // sketch ribbon; eating it would break drawing.
    const body = reloadHandler();
    const rBranch = body.slice(body.indexOf('e.key.toLowerCase() === "r"') - 60);
    expect(
      rBranch.slice(0, 120),
      "a bare R may now be swallowed — that is the Rectangle tool",
    ).toMatch(/ctrlKey \|\| e\.metaKey/);
  });
});
