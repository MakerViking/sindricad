// Fusion-style icon ribbon. Two contexts — modeling and sketch — each a row of
// grouped icon buttons (CREATE / MODIFY / …) with the group name underneath.
// The sketch context ends with the green Finish Sketch + a Sketch Palette toggle.

import { icon } from "./icons";

export type RibbonContext = "model" | "sketch";

interface Item {
  action: string;
  label: string;
  iconName: string;
  key?: string;
  kind?: "finish" | "toggle";
  soon?: boolean; // shown but not yet wired (roadmap visibility)
}
interface Group {
  label: string;
  items: Item[];
}

const MODEL: Group[] = [
  {
    label: "CREATE",
    items: [
      { action: "sketch", label: "Sketch", iconName: "sketch", key: "S" },
      { action: "extrude", label: "Extrude", iconName: "extrude", key: "E" },
      { action: "revolve", label: "Revolve", iconName: "revolve", soon: true },
      { action: "loft", label: "Loft", iconName: "loft", soon: true },
    ],
  },
  {
    label: "MODIFY",
    items: [
      { action: "fillet", label: "Fillet", iconName: "fillet", key: "F" },
      { action: "chamfer", label: "Chamfer", iconName: "chamfer" },
      { action: "mirror", label: "Mirror", iconName: "mirror" },
    ],
  },
  {
    label: "CONSTRUCT",
    items: [
      { action: "offset-plane", label: "Offset Plane", iconName: "offsetPlane" },
    ],
  },
];

const SKETCH: Group[] = [
  {
    label: "CREATE",
    items: [
      { action: "line", label: "Line", iconName: "line", key: "L" },
      { action: "rectangle", label: "Rectangle", iconName: "rectangle", key: "R" },
      { action: "circle", label: "Circle", iconName: "circle", key: "C" },
      { action: "arc", label: "Arc", iconName: "arc", key: "A" },
      { action: "spline", label: "Spline", iconName: "spline" },
    ],
  },
  {
    label: "MODIFY",
    items: [
      { action: "fillet-sketch", label: "Fillet", iconName: "fillet" },
      { action: "trim", label: "Trim", iconName: "trim", key: "T" },
      { action: "extend", label: "Extend", iconName: "extend" },
      { action: "offset", label: "Offset", iconName: "offset", key: "O" },
      { action: "break", label: "Break", iconName: "break" },
    ],
  },
  {
    label: "CONSTRAINTS",
    items: [
      { action: "horizontal", label: "Horizontal", iconName: "horizontal" },
      { action: "vertical", label: "Vertical", iconName: "vertical" },
      { action: "parallel", label: "Parallel", iconName: "parallel" },
      { action: "perpendicular", label: "Perpendic.", iconName: "perpendicular" },
      { action: "equal", label: "Equal", iconName: "equal" },
    ],
  },
];

export class Ribbon {
  onAction: ((action: string) => void) | null = null;
  private model: HTMLElement;
  private sketch: HTMLElement;

  constructor(container: HTMLElement) {
    this.model = this.buildContext(MODEL, false);
    this.sketch = this.buildContext(SKETCH, true);
    container.append(this.model, this.sketch);
    this.setContext("model");
  }

  setContext(ctx: RibbonContext) {
    this.model.classList.toggle("hidden", ctx !== "model");
    this.sketch.classList.toggle("hidden", ctx !== "sketch");
  }

  setActiveSketchTool(tool: string) {
    this.sketch.querySelectorAll<HTMLElement>("[data-action]").forEach((b) => {
      b.classList.toggle("active", b.dataset.action === tool);
    });
  }

  private buildContext(groups: Group[], isSketch: boolean): HTMLElement {
    const ctx = document.createElement("div");
    ctx.className = "ribbon-context";
    for (const g of groups) ctx.appendChild(this.buildGroup(g));
    if (isSketch) {
      const spacer = document.createElement("div");
      spacer.className = "ribbon-spacer";
      ctx.appendChild(spacer);
      ctx.appendChild(
        this.buildGroup({
          label: "PALETTE",
          items: [{ action: "palette", label: "Sketch Palette", iconName: "palette", kind: "toggle" }],
        }),
      );
      ctx.appendChild(
        this.buildGroup({
          label: "FINISH",
          items: [{ action: "finish", label: "Finish Sketch", iconName: "check", kind: "finish" }],
        }),
      );
    }
    return ctx;
  }

  private buildGroup(g: Group): HTMLElement {
    const group = document.createElement("div");
    group.className = "ribbon-group";
    const tools = document.createElement("div");
    tools.className = "ribbon-tools";
    for (const it of g.items) {
      const btn = document.createElement("button");
      btn.className = "ribbon-btn";
      if (it.kind === "finish") btn.classList.add("finish");
      if (it.soon) btn.classList.add("soon");
      btn.dataset.action = it.action;
      btn.title = it.key ? `${it.label} (${it.key})` : it.label + (it.soon ? " — coming soon" : "");
      btn.innerHTML = `${icon(it.iconName)}<span>${it.label}</span>`;
      btn.addEventListener("click", () => this.onAction?.(it.action));
      tools.appendChild(btn);
    }
    const label = document.createElement("div");
    label.className = "ribbon-group-label";
    label.textContent = g.label;
    group.append(tools, label);
    return group;
  }
}
