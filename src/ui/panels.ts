// Floating "measure-panel"-styled popups: Properties, Interference, and the
// Overhang (Draft Analysis) settings panel. Deduplicated over one small
// FloatingPanel helper (element + optional Esc-listener + dismiss bookkeeping) —
// each panel keeps its own exact DOM/content/behavior.
import type { DocumentStore } from "../document/store";
import type { MassPropertiesResult } from "../types";
import type { Viewport } from "../viewport/viewport";
import type { GeometryBackend } from "../geometry/client";
import { esc } from "./escape";
import { getUnit, toDisplay, round } from "./units";
import { printerCameraStart, printerCameraStop, onPrinterCameraFrame, onPrinterCameraOffline } from "../print/printerClient";

/** One floating "measure-panel" element with optional Esc-to-dismiss. Only one
 *  instance's content is ever shown at a time per panel — open() replaces it.
 *  (Also used by paramsDialog.ts.) */
export class FloatingPanel {
  private el: HTMLDivElement | null = null;
  private onEsc: ((e: KeyboardEvent) => void) | null = null;
  private onClose: (() => void) | null = null;

  open(html: string, opts: { closeOnEsc?: boolean; onClose?: () => void } = {}): HTMLDivElement {
    this.close();
    const el = document.createElement("div");
    el.className = "measure-panel";
    el.innerHTML = html;
    document.body.appendChild(el);
    this.el = el;
    this.onClose = opts.onClose ?? null;
    if (opts.closeOnEsc) {
      this.onEsc = (e) => {
        if (e.key === "Escape") this.close();
      };
      window.addEventListener("keydown", this.onEsc, true);
    }
    return el;
  }

  close() {
    // fire the teardown hook first (and only once) — panels with live
    // subscriptions (camera) rely on EVERY dismissal path landing here.
    const hook = this.onClose;
    this.onClose = null;
    hook?.();
    this.el?.remove();
    this.el = null;
    if (this.onEsc) {
      window.removeEventListener("keydown", this.onEsc, true);
      this.onEsc = null;
    }
  }
}

export interface PanelsDeps {
  store: DocumentStore;
  viewport: Viewport;
  geometry: GeometryBackend;
  hasBody: () => boolean;
  setStatus: (text: string, cls: "" | "connected" | "error") => void;
  selBtn: HTMLButtonElement;
}

/** The Properties rows as [key, label, text], from the EXACT kernel reply.
 *
 *  Extracted and exported so it can be unit-tested without a DOM (this repo has
 *  no jsdom, and adding one for a formatter is not worth it — the same call the
 *  assembly-tree tests made). It carries the three things most likely to be got
 *  wrong, all of which are silent when wrong:
 *    - the reply is always in mm, so every value must go back through the unit
 *      conversion or an inch user sees millimetres
 *    - Mass is DERIVED here and absent from the reply, so it has to be recomputed
 *      or it keeps the mesh figure under a label claiming to be exact
 *    - the bounding box is deliberately ABSENT: that row shows dimensions taken
 *      from the same triangulation the sidecar measured, so there is nothing to
 *      correct */
export function exactPropsRows(t: MassPropertiesResult["total"]): [string, string][] {
  const unit = getUnit();
  const f = toDisplay(1);
  const rows: [string, string][] = [
    ["volume", `${round(t.volume * f * f * f)} ${unit}³`],
    ["area", `${round(t.area * f * f)} ${unit}²`],
    ["mass", `${round(t.volume / 1000)} g`],
  ];
  if (t.com) {
    rows.push(["com", `${round(toDisplay(t.com[0]))}, ${round(toDisplay(t.com[1]))}, ${round(toDisplay(t.com[2]))}`]);
  }
  return rows;
}

/** Wrap a listener so its FIRST invocation is ignored.
 *
 *  `store.onDocChange` calls its listener synchronously at subscribe time. A
 *  staleness guard registered naively therefore fires during setup and
 *  supersedes every request made afterwards — so the exact values never land,
 *  silently, and the panel reads "Approximate" forever in a way that is
 *  indistinguishable from the sidecar being down. Exported for the test. */
export function afterFirstCall(fn: () => void): () => void {
  let primed = false;
  return () => {
    if (!primed) {
      primed = true;
      return;
    }
    fn();
  };
}

export function createPanels(deps: PanelsDeps) {
  const { store, viewport, geometry, hasBody, setStatus, selBtn } = deps;

  // --- Inspect: Properties readout (volume / area / mass / center / bbox) ---
  const propsPanel = new FloatingPanel();
  // Supersedes an in-flight exact-measure reply. Bumped when the panel is
  // reopened, when it closes, and whenever the document changes — a reply that
  // arrives after any of those describes geometry that is no longer on screen.
  let propsSeq = 0;
  // The refine round trip is only worth taking automatically for a bounded
  // selection. A whole-document measure on a large assembly runs for a long time
  // and is offered as an explicit action instead. Body COUNT is admittedly a
  // poor cost proxy — the tree says so itself about the viewport profile — but a
  // human selection is bounded by what a human clicked, which sidesteps that.
  const AUTO_REFINE_MAX_BODIES = 20;

  // Any document change invalidates an in-flight measure — the numbers would
  // describe geometry that is no longer on screen. See afterFirstCall for why
  // the first invocation must be ignored.
  store.onDocChange(afterFirstCall(() => { propsSeq++; }));

  function propsRows(p: NonNullable<ReturnType<typeof viewport.bodyProperties>>) {
    const unit = getUnit();
    const f = toDisplay(1);
    const cm3 = p.volume / 1000; // mm³ → cm³ (mass at 1 g/cm³ baseline)
    return [
      ["volume", "Volume", `${round(p.volume * f * f * f)} ${unit}³`],
      ["area", "Surface area", `${round(p.area * f * f)} ${unit}²`],
      ["mass", "Mass (≈1 g/cm³)", `${round(cm3)} g`],
      ["com", "Center of mass", `${round(toDisplay(p.com.x))}, ${round(toDisplay(p.com.y))}, ${round(toDisplay(p.com.z))}`],
      [
        "bbox",
        "Bounding box",
        `${round(toDisplay(p.bbox.max.x - p.bbox.min.x))} × ${round(toDisplay(p.bbox.max.y - p.bbox.min.y))} × ${round(toDisplay(p.bbox.max.z - p.bbox.min.z))} ${unit}`,
      ],
    ] as [string, string, string][];
  }

  /** Replace the mesh-derived numbers with the kernel's, in place.
   *
   *  In place, never by reopening: `open()` fires onClose and re-registers the
   *  Esc handler, which would bump propsSeq and drop the very reply being
   *  applied. */
  function applyExact(root: HTMLElement, r: MassPropertiesResult) {
    if (!root.isConnected) return; // the panel was closed and detached
    for (const [key, text] of exactPropsRows(r.total)) {
      const el = root.querySelector(`.measure-row[data-k="${key}"] .measure-v`);
      if (el) el.textContent = text;
    }
    const hint = root.querySelector(".measure-hint");
    if (hint) hint.textContent = "Exact — from the geometry kernel · Esc to close";
  }

  function showProperties() {
    if (!hasBody()) {
      setStatus("Properties: create or import a body first", "");
      return;
    }
    const sel = viewport.getSelectedBodies();
    const p = viewport.bodyProperties(sel.length ? sel : null);
    if (!p) return;
    const title = sel.length === 1 ? p.names[0] : sel.length ? `${sel.length} bodies` : "All bodies";
    const auto = sel.length > 0 && sel.length <= AUTO_REFINE_MAX_BODIES;
    const html =
      `<div class="measure-title">Properties — ${esc(title)}</div>` +
      propsRows(p)
        .map(([k, label, v]) => `<div class="measure-row" data-k="${k}"><span class="measure-k">${esc(label)}</span><span class="measure-v">${esc(v)}</span></div>`)
        .join("") +
      `<div class="measure-hint">${auto ? "Approximate — from the display mesh" : "Approximate — from the display mesh · select bodies for exact values"} · Esc to close</div>`;
    // Closing supersedes any in-flight reply too, so a stale one cannot patch a
    // panel the user has reopened on a different selection.
    // Render the mesh figures IMMEDIATELY. They are what the panel has always
    // shown and they need no round trip, so the panel stays as fast as it was;
    // the exact values replace them when they arrive.
    const root = propsPanel.open(html, { closeOnEsc: true, onClose: () => { propsSeq++; } });

    const seq = ++propsSeq;
    if (!auto || !geometry.massProperties) return;
    // Snapshot the BUILT document at request time. store.document would carry
    // features past the rollback marker and no body visibility, and body ids are
    // positional per rebuild — so it would answer about different bodies.
    const doc = store.buildDocument();
    void geometry.massProperties(doc, { bodies: sel }).then((res) => {
      // Dropped rather than cancelled: cancelling reaches the pool killer, which
      // SIGKILLs the single geometry worker and takes the rebuild cache, the
      // bbox and fingerprint memos and the mesh cache with it. Pressing Esc —
      // which this panel's own hint recommends — would restart the kernel.
      if (seq !== propsSeq || !res.ok || !res.result) return;
      applyExact(root, res.result);
    });
  }

  // --- Inspect: Interference (clash) check between bodies ---
  const clashPanel = new FloatingPanel();
  async function showInterference() {
    if (!hasBody()) {
      setStatus("Interference: create or import a body first", "");
      return;
    }
    if ((store.buildState.result?.bodies?.length ?? 0) < 2) {
      setStatus("Interference: needs at least two bodies", "");
      return;
    }
    setStatus("Checking interference…", "");
    // buildDocument(), not document: the same defect the Properties panel had.
    // The raw document carries suppressed and past-rollback features and no body
    // visibility, so a clash could be reported between bodies the app never built.
    const res = await geometry.interference(store.buildDocument());
    if (!res.ok) {
      setStatus(`Interference check failed: ${res.message ?? "error"}`, "error");
      return;
    }
    const pairs = res.pairs ?? [];
    setStatus(
      pairs.length ? `${pairs.length} interference${pairs.length > 1 ? "s" : ""} found` : "No interferences found",
      pairs.length ? "error" : "connected",
    );
    const unit = getUnit();
    const f = toDisplay(1);
    let html: string;
    if (!pairs.length) {
      html =
        `<div class="measure-title">Interference</div>` +
        `<div class="measure-row"><span class="measure-v">No overlapping bodies</span></div>` +
        `<div class="measure-hint">Esc to close</div>`;
    } else {
      html =
        `<div class="measure-title">Interference — ${pairs.length} clash${pairs.length > 1 ? "es" : ""}</div>` +
        pairs
          .map(
            (p, i) =>
              `<div class="measure-row clash-row" data-i="${i}"><span class="measure-k">${esc(p.aName)} ∩ ${esc(p.bName)}</span><span class="measure-v">${round(p.volume * f * f * f)} ${unit}³</span></div>`,
          )
          .join("") +
        `<div class="measure-hint">Click a clash to highlight the bodies · Esc to close</div>`;
    }
    const el = clashPanel.open(html, { closeOnEsc: true });
    el.querySelectorAll<HTMLElement>(".clash-row").forEach((row) => {
      row.style.cursor = "pointer";
      row.addEventListener("click", () => {
        const p = pairs[Number(row.dataset.i)];
        if (!p) return;
        viewport.setSelectionMode("bodies");
        selBtn.textContent = "Bodies";
        selBtn.classList.add("active");
        viewport.setSelectedBodies([p.a, p.b]);
      });
    });
  }

  // Overhang-analysis settings: a small floating panel (build direction + support
  // threshold) shown while Draft Analysis is active. Display-only/transient — the
  // settings live on the viewport, not the document. No Esc-dismiss on purpose —
  // it's closed programmatically when Draft Analysis is toggled off.
  const overhangPanel = new FloatingPanel();
  function closeOverhangSettings() {
    overhangPanel.close();
  }
  function showOverhangSettings() {
    const { dir, threshold } = viewport.draftConfig;
    const dirs = ["+Z", "-Z", "+X", "-X", "+Y", "-Y"];
    const html =
      `<div class="measure-title">Overhang analysis</div>` +
      `<div class="measure-row"><span class="measure-k">Build dir</span><select class="oh-dir">${dirs
        .map((d) => `<option${d === dir ? " selected" : ""}>${d}</option>`)
        .join("")}</select></div>` +
      `<div class="measure-row"><span class="measure-k">Threshold</span><span><input class="oh-thr" type="range" min="0" max="90" step="1" value="${threshold}" style="width:96px;vertical-align:middle"> <span class="oh-val">${threshold}°</span></span></div>` +
      `<div class="measure-row"><span class="measure-v" style="color:#e24a3b">red = unsupported overhang</span></div>` +
      `<div class="measure-hint">Faces past this angle from horizontal need support · toggle Draft to close</div>`;
    const el = overhangPanel.open(html);
    const dirSel = el.querySelector(".oh-dir") as HTMLSelectElement;
    const thr = el.querySelector(".oh-thr") as HTMLInputElement;
    const val = el.querySelector(".oh-val") as HTMLElement;
    const apply = () => {
      viewport.setDraftConfig(dirSel.value as "+X" | "-X" | "+Y" | "-Y" | "+Z" | "-Z", Number(thr.value));
      val.textContent = `${thr.value}°`;
    };
    dirSel.addEventListener("change", apply);
    thr.addEventListener("input", apply);
  }

  // --- Printer camera: live snapshot frames from the Rust poller. The webview
  // never dials the LAN — Rust polls the printer's webcam and pushes JPEG
  // data: URLs (CSP img-src already allows data:). Polling stops on ANY panel
  // dismissal via the onClose hook (Esc included).
  const cameraPanel = new FloatingPanel();
  async function showCameraPanel(printerId: string) {
    const html =
      `<div class="measure-title">Camera — ${esc(printerId)}</div>` +
      `<img class="camera-frame" alt="printer camera" style="display:block;max-width:480px;min-width:320px;min-height:180px;background:#111">` +
      `<div class="camera-offline" style="display:none;padding:8px;color:#e24a3b">camera unavailable <button class="camera-retry">Retry</button></div>` +
      `<div class="measure-hint">~1 frame/s · Esc to close</div>`;
    let unlistenFrame: (() => void) | null = null;
    let unlistenOffline: (() => void) | null = null;
    const el = cameraPanel.open(html, {
      closeOnEsc: true,
      onClose: () => {
        void printerCameraStop(printerId).catch(() => {});
        unlistenFrame?.();
        unlistenOffline?.();
      },
    });
    const img = el.querySelector(".camera-frame") as HTMLImageElement;
    const offline = el.querySelector(".camera-offline") as HTMLDivElement;
    const start = async () => {
      offline.style.display = "none";
      try {
        await printerCameraStart(printerId);
      } catch {
        offline.style.display = "block";
      }
    };
    unlistenFrame = await onPrinterCameraFrame((e) => {
      if (e.id !== printerId) return;
      offline.style.display = "none";
      img.src = e.data_url;
    });
    unlistenOffline = await onPrinterCameraOffline((id) => {
      if (id === printerId) offline.style.display = "block";
    });
    (el.querySelector(".camera-retry") as HTMLButtonElement).addEventListener("click", () => void start());
    await start();
  }

  return { showProperties, showInterference, showOverhangSettings, closeOverhangSettings, showCameraPanel };
}

export type Panels = ReturnType<typeof createPanels>;
