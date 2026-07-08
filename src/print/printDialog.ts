// Filament-mapping dialog for "Send to Printer": for each colored slot the job
// uses (logical gcode tool Tn = palette slot index), pick which physical U1
// toolhead is loaded with that filament. Pre-matched by material type, then
// nearest color — the same client-side reconciliation Snapmaker Orca does.
//
// choice.ts's chooseMulti can't express per-row dropdowns, so this is a bespoke
// modal built on the shared .choice-* styles.

import { esc } from "../ui/escape";
import type { StartOpts, ToolheadFilament } from "./printerClient";

export interface LogicalSlot {
  index: number; // palette slot index = logical gcode tool Tn
  name: string;
  color: string; // "#RRGGBB"
  material?: string;
}

export interface MappingResult {
  mapTable: [number, number][]; // [logical slot, physical toolhead]
  opts: StartOpts;
}

function rgb(hex: string): [number, number, number] {
  const s = hex.replace("#", "");
  return [parseInt(s.slice(0, 2), 16) || 0, parseInt(s.slice(2, 4), 16) || 0, parseInt(s.slice(4, 6), 16) || 0];
}

function colorDist(a: string, b: string): number {
  const [r1, g1, b1] = rgb(a);
  const [r2, g2, b2] = rgb(b);
  return (r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2;
}

/** Best physical toolhead for a logical slot: prefer a present toolhead whose
 *  material matches, break ties (and material-less palettes) by nearest color. */
function autoMatch(slot: LogicalSlot, toolheads: ToolheadFilament[]): number {
  const present = toolheads.filter((t) => t.present);
  const pool = present.length ? present : toolheads;
  let best = pool[0]?.index ?? slot.index;
  let bestScore = Infinity;
  for (const t of pool) {
    const materialMiss = slot.material && t.material && slot.material.toLowerCase() !== t.material.toLowerCase() ? 1e9 : 0;
    const score = materialMiss + colorDist(slot.color, t.color);
    if (score < bestScore) {
      bestScore = score;
      best = t.index;
    }
  }
  return best;
}

export function filamentMappingDialog(
  slots: LogicalSlot[],
  toolheads: ToolheadFilament[],
): Promise<MappingResult | null> {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "choice-backdrop";
    const card = document.createElement("div");
    card.className = "choice-card print-map-card";
    card.innerHTML = `<div class="choice-title">Send to printer — filament mapping</div>`;

    const swatch = (c: string) => `<span class="print-swatch" style="background:${esc(c)}"></span>`;
    const thLabel = (t: ToolheadFilament) => {
      const name = `${t.vendor} ${t.material}`.trim() || `Toolhead ${t.index + 1}`;
      return `${t.index + 1}: ${name}${t.present ? "" : " (empty)"}`;
    };

    const table = document.createElement("div");
    table.className = "print-map-rows";
    const selects: HTMLSelectElement[] = [];
    for (const slot of slots) {
      const row = document.createElement("div");
      row.className = "print-map-row";
      const def = autoMatch(slot, toolheads);
      const optionsHtml = toolheads
        .map((t) => `<option value="${t.index}"${t.index === def ? " selected" : ""}>${esc(thLabel(t))}</option>`)
        .join("");
      row.innerHTML =
        `<span class="print-map-slot">${swatch(slot.color)}<span>${esc(slot.name || `Filament ${slot.index + 1}`)}</span></span>` +
        `<span class="print-map-arrow">→</span>` +
        `<select class="print-map-select" data-logical="${slot.index}">${optionsHtml}</select>`;
      const sel = row.querySelector("select")!;
      selects.push(sel);
      table.appendChild(row);
    }
    card.appendChild(table);

    // print options (mirror the U1 start_local_print flags)
    const optWrap = document.createElement("div");
    optWrap.className = "print-map-opts";
    const optRow = (id: string, label: string, checked = false) =>
      `<label class="choice-check"><input type="checkbox" data-opt="${id}"${checked ? " checked" : ""}><span>${esc(label)}</span></label>`;
    optWrap.innerHTML =
      optRow("bedLevel", "Auto bed leveling") +
      optRow("flowCalibrate", "Flow calibrate") +
      optRow("timeLapseCamera", "Timelapse");
    card.appendChild(optWrap);

    const rowBtns = document.createElement("div");
    rowBtns.className = "choice-row";
    const cancel = document.createElement("button");
    cancel.className = "choice-btn";
    cancel.innerHTML = "<span>Cancel</span>";
    const ok = document.createElement("button");
    ok.className = "choice-btn choice-primary";
    ok.innerHTML = "<span>Upload &amp; Print</span>";
    rowBtns.append(cancel, ok);
    card.appendChild(rowBtns);
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);

    const readOpt = (id: string) =>
      (optWrap.querySelector<HTMLInputElement>(`[data-opt="${id}"]`)?.checked) ?? false;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") done(null);
    };
    backdrop.addEventListener("pointerdown", (e) => {
      if (e.target === backdrop) done(null);
    });
    cancel.addEventListener("click", () => done(null));
    ok.addEventListener("click", () => {
      const mapTable = selects.map(
        (s) => [Number(s.dataset.logical), Number(s.value)] as [number, number],
      );
      done({
        mapTable,
        opts: {
          bedLevel: readOpt("bedLevel"),
          flowCalibrate: readOpt("flowCalibrate"),
          timeLapseCamera: readOpt("timeLapseCamera"),
        },
      });
    });
    window.addEventListener("keydown", onKey, true);

    function done(v: MappingResult | null) {
      window.removeEventListener("keydown", onKey, true);
      backdrop.remove();
      resolve(v);
    }
  });
}
