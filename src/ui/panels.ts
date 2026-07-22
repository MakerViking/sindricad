// Floating "measure-panel"-styled popups: Properties, Interference, and the
// Overhang (Draft Analysis) settings panel. Deduplicated over one small
// FloatingPanel helper (element + optional Esc-listener + dismiss bookkeeping) —
// each panel keeps its own exact DOM/content/behavior.
import type { DocumentStore } from "../document/store";
import type { Viewport } from "../viewport/viewport";
import type { GeometryBackend } from "../geometry/client";
import { esc } from "./escape";
import { getUnit, toDisplay, round } from "./units";
import { printerCameraStart, printerCameraStop, onPrinterCameraFrame, onPrinterCameraOffline } from "../print/printerClient";

/** One floating "measure-panel" element with optional Esc-to-dismiss. Only one
 *  instance's content is ever shown at a time per panel — open() replaces it. */
class FloatingPanel {
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

export function createPanels(deps: PanelsDeps) {
  const { store, viewport, geometry, hasBody, setStatus, selBtn } = deps;

  // --- Inspect: Properties readout (volume / area / mass / center / bbox) ---
  const propsPanel = new FloatingPanel();
  function showProperties() {
    if (!hasBody()) {
      setStatus("Properties: create or import a body first", "");
      return;
    }
    const sel = viewport.getSelectedBodies();
    const p = viewport.bodyProperties(sel.length ? sel : null);
    if (!p) return;
    const unit = getUnit();
    const f = toDisplay(1);
    const cm3 = p.volume / 1000; // mm³ → cm³ (mass at 1 g/cm³ baseline)
    const title = sel.length === 1 ? p.names[0] : sel.length ? `${sel.length} bodies` : "All bodies";
    const rows: [string, string][] = [
      ["Volume", `${round(p.volume * f * f * f)} ${unit}³`],
      ["Surface area", `${round(p.area * f * f)} ${unit}²`],
      ["Mass (≈1 g/cm³)", `${round(cm3)} g`],
      ["Center of mass", `${round(toDisplay(p.com.x))}, ${round(toDisplay(p.com.y))}, ${round(toDisplay(p.com.z))}`],
      [
        "Bounding box",
        `${round(toDisplay(p.bbox.max.x - p.bbox.min.x))} × ${round(toDisplay(p.bbox.max.y - p.bbox.min.y))} × ${round(toDisplay(p.bbox.max.z - p.bbox.min.z))} ${unit}`,
      ],
    ];
    const html =
      `<div class="measure-title">Properties — ${esc(title)}</div>` +
      rows
        .map(([k, v]) => `<div class="measure-row"><span class="measure-k">${esc(k)}</span><span class="measure-v">${esc(v)}</span></div>`)
        .join("") +
      `<div class="measure-hint">Select a body for its own properties · Esc to close</div>`;
    propsPanel.open(html, { closeOnEsc: true });
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
    const res = await geometry.interference(store.document);
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
