// Per-GPU rendering workarounds, decided from the GL renderer WebKit really
// uses (webkit://gpu, read by the shell: src-tauri/src/webkit.rs).
//
// That name arrives after the WebGL context exists, and context attributes
// (antialias) are fixed at creation. So the name is remembered, and a quirk
// takes effect from the next start (diagnostics/glRenderer.ts says so once).

const KEY = "sindri.gpu.glRenderer";

/** Intel Ivy Bridge (HD Graphics 2500/4000, Mesa's "IVB"). Chromium has turned
 *  framebuffer multisampling off on it for years ("Multisampling is buggy in
 *  Intel IvyBridge", Chromium bug 116370); WebKitGTK has no such list. Doug's
 *  HD 4000 kept stair-steps and ghost edges through two depth fixes
 *  (.fable/doug-squiggles3/RESULT.md). */
export function msaaBroken(glRenderer: string | null | undefined): boolean {
  return !!glRenderer && /\bIVB\b|ivy ?bridge|\bHD Graphics (2500|4000)\b/i.test(glRenderer);
}

export function rememberedRenderer(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function rememberRenderer(name: string): void {
  try {
    localStorage.setItem(KEY, name);
  } catch {
    /* private mode or a full store: the quirk just waits for a later start */
  }
}

// ---- graphics compatibility switches ----------------------------------------
//
// Four ways the viewport can avoid a part of GL that a driver gets wrong, each
// one a thing the squiggles on Doug's Ivy Bridge could come from. They are in
// the View menu so whoever has the problem can try each and see the answer at
// once, and they apply from the next start (the context and the shaders are
// built at startup). The polygon-offset one also turns itself on when the
// startup self-test measures an offset far from what GL specifies.

export type CompatSwitch =
  | "shaderOffset" // faces sit behind their edges by an offset the shader writes, in both projections
  | "plainDepth" // no logarithmic depth buffer
  | "noStencil" // no stencil buffer (section caps go)
  | "frontFaces"; // draw only the outside of faces

export const COMPAT_SWITCHES: readonly CompatSwitch[] = ["shaderOffset", "plainDepth", "noStencil", "frontFaces"];
const COMPAT_KEY = "sindri.gpu.compat";

/** The switches the user turned on. */
export function compatSwitches(): Set<CompatSwitch> {
  try {
    const raw = JSON.parse(localStorage.getItem(COMPAT_KEY) ?? "[]");
    return new Set((Array.isArray(raw) ? raw : []).filter((s): s is CompatSwitch => COMPAT_SWITCHES.includes(s)));
  } catch {
    return new Set();
  }
}

export function setCompatSwitch(s: CompatSwitch, on: boolean): void {
  const cur = compatSwitches();
  if (on) cur.add(s);
  else cur.delete(s);
  try {
    localStorage.setItem(COMPAT_KEY, JSON.stringify([...cur]));
  } catch {
    /* nothing to remember it in: it lasts this session's menu only */
  }
}

let autoShaderOffset = false;
/** The startup self-test found the hardware polygon offset far off. */
export function setAutoShaderOffset(on: boolean): void {
  autoShaderOffset = on;
}

/** Offset written by the shader in ortho as well, hardware offset off. */
export function shaderOffsetEverywhere(): boolean {
  return autoShaderOffset || compatSwitches().has("shaderOffset");
}
