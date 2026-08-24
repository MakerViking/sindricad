// The one screen a user sees when there is no 3D context.
//
// Field report, Debian Bookworm on an NVIDIA G105M (a 2009 card, so nouveau, so
// very likely no WebGL2): "it just comes up with a black screen with the logo in
// the top left. There is no menu or other features." That is index.html's static
// shell exactly: `new Viewport` threw, module evaluation of main.ts ended, and
// nothing from the ribbon down was ever constructed. The only thing he got was
// the generic 8-second "Something went wrong" toast, long faded by the time he
// wrote in. The logo BEING visible is what rules out the usual blank-window
// compositing bug: the webview itself is fine, our own code stopped.
//
// Deliberately not a normal modal: Escape must not be able to dismiss the only
// thing on screen that explains the situation, and there is nothing behind it to
// go back to. Hence no close button and no pushModal.

import { stickyFact } from "../diagnostics/breadcrumbs";
import type { DocumentStore } from "../document/store";
import type { GeometryBackend } from "../geometry/client";
import { NoWebGLError, type GpuFailure } from "../viewport/scene";
import { createBugReporter } from "./bugReporter";
import { esc } from "./escape";
import { icon } from "./icons";

let shown = false;

/** True once the panel is up. The last-resort handlers in main.ts read this and
 *  stay quiet: "Something went wrong" stacked on top of a panel that says
 *  exactly what went wrong is noise, and it is what this user got INSTEAD. */
export function gpuFatalShown(): boolean {
  return shown;
}

const WHY: Record<GpuFailure, string> = {
  "webgl1-only":
    "This computer's graphics driver offers OpenGL ES 2.0 only, and the 3D view needs WebGL 2. " +
    "That is a limit of the driver, not a damaged install. On Linux it usually means an older " +
    "NVIDIA card running on the open-source nouveau driver.",
  "no-webgl":
    "This computer could not create a 3D context of any kind. That usually means the graphics " +
    "driver is missing or is being blocked, rather than anything wrong with SindriCAD itself.",
  renderer:
    "This computer reports WebGL 2, but the 3D view still could not be created. That is unusual, " +
    "and I would like to see the report.",
};

// Shown as bare assignments rather than a full command line on purpose: the app
// may have been started from a .deb, an AppImage or a desktop icon, and naming
// the wrong binary sends someone in a circle. Both are one word in front of
// however they already launch it.
const WORKAROUNDS = ["LIBGL_ALWAYS_SOFTWARE=1", "WEBKIT_DISABLE_DMABUF_RENDERER=1"];

export function showGpuFatal(err: unknown, deps: { store: DocumentStore; geometry: GeometryBackend }) {
  if (shown) return;
  shown = true;

  const gpuErr = err instanceof NoWebGLError ? err : null;
  const failure: GpuFailure = gpuErr?.failure ?? "renderer";
  const facts = gpuErr?.facts ?? [];
  if (!gpuErr) stickyFact(`[gpu] viewport failed: ${String(err).slice(0, 200)}`);

  // The renderer string is fiction on Linux: WebKitGTK spoofs
  // WEBGL_debug_renderer_info and reports "Apple GPU" on any hardware (measured,
  // see recordGpu in viewport/scene.ts). Say so on screen rather than send
  // someone chasing a GPU they do not have.
  const spoofed = facts.some((f) => /renderer:.*apple/i.test(f)) && !/mac/i.test(navigator.userAgent);

  const back = document.createElement("div");
  back.className = "gpu-fatal-backdrop";
  const card = document.createElement("div");
  card.className = "gpu-fatal";
  card.setAttribute("role", "alertdialog");
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-labelledby", "gpu-fatal-title");
  card.innerHTML =
    `<div class="gpu-fatal-head"><span class="gpu-fatal-icon">${icon("warning")}</span>` +
    `<span class="gpu-fatal-title" id="gpu-fatal-title">The 3D view could not start</span></div>` +
    `<p class="gpu-fatal-why">${esc(WHY[failure])}</p>` +
    `<p class="gpu-fatal-why">Two things are worth trying. Close SindriCAD, then start it again ` +
    `from a terminal with one of these in front of the usual command:</p>` +
    `<pre class="gpu-fatal-cmds">${WORKAROUNDS.map(esc).join("\n")}</pre>` +
    `<p class="gpu-fatal-note">The first draws in software on the CPU. It is slower on large models, ` +
    `but it works where the driver does not. The second turns off the webview's shared-buffer path, ` +
    `which some drivers do not implement correctly.</p>` +
    `<div class="gpu-fatal-label">What this machine reports</div>` +
    `<pre class="gpu-fatal-facts">${esc(facts.join("\n") || "nothing readable")}</pre>` +
    (spoofed
      ? `<p class="gpu-fatal-note">The renderer name above comes from the Linux webview, which reports ` +
        `the same fake value on every machine. Ignore it. The WebGL version line is real.</p>`
      : "") +
    `<div class="gpu-fatal-row">` +
    `<button class="choice-btn gpu-fatal-copy" type="button"><span>Copy the details</span></button>` +
    `<button class="choice-btn choice-primary gpu-fatal-report" type="button"><span>Report this</span></button>` +
    `</div>`;
  back.appendChild(card);
  document.body.appendChild(back);

  // The bug button, with no Viewport and no SketchMode to give it. This is the
  // most valuable report the button ever sends: it is the only way a machine
  // that cannot draw anything gets its GL strings back to me.
  createBugReporter({ store: deps.store, geometry: deps.geometry });

  const copyBtn = card.querySelector(".gpu-fatal-copy span") as HTMLElement;
  card.querySelector(".gpu-fatal-copy")!.addEventListener("click", () => {
    void navigator.clipboard
      .writeText([`SindriCAD: 3D view could not start (${failure})`, ...facts, navigator.userAgent].join("\n"))
      .then(() => { copyBtn.textContent = "Copied"; })
      .catch(() => { copyBtn.textContent = "Could not copy"; });
  });
  card.querySelector(".gpu-fatal-report")!.addEventListener("click", () => {
    (document.querySelector(".bug-report-btn") as HTMLButtonElement | null)?.click();
  });
}
