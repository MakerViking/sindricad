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
export type { Item, Group };

export const MODEL: Group[] = [
  {
    label: "CREATE",
    items: [
      { action: "sketch", label: "Sketch", iconName: "sketch", key: "S" },
      { action: "extrude", label: "Extrude", iconName: "extrude", key: "E" },
      { action: "revolve", label: "Revolve", iconName: "revolve" },
      { action: "loft", label: "Loft", iconName: "loft" },
      { action: "sweep", label: "Sweep", iconName: "sweep" },
      { action: "primitive", label: "Primitive", iconName: "primitive" },
    ],
  },
  {
    label: "MODIFY",
    items: [
      { action: "presspull", label: "Press/Pull", iconName: "presspull", key: "Q" },
      { action: "fillet", label: "Fillet", iconName: "fillet", key: "F" },
      { action: "chamfer", label: "Chamfer", iconName: "chamfer" },
      { action: "shell", label: "Shell", iconName: "shell" },
      { action: "draft", label: "Draft", iconName: "draft" },
      { action: "scale", label: "Scale", iconName: "scale" },
      { action: "move", label: "Move", iconName: "move" },
      { action: "mirror", label: "Mirror", iconName: "mirror" },
      { action: "pattern", label: "Pattern", iconName: "pattern" },
      { action: "split", label: "Split Body", iconName: "split" },
      { action: "combine", label: "Combine", iconName: "combine" },
    ],
  },
  {
    label: "CONSTRUCT",
    items: [
      { action: "offset-plane", label: "Offset Plane", iconName: "offsetPlane" },
      { action: "datum-plane", label: "Datum Plane", iconName: "datumPlane" },
    ],
  },
  {
    label: "INSPECT",
    items: [
      { action: "measure", label: "Measure", iconName: "measure" },
      { action: "properties", label: "Properties", iconName: "properties" },
      { action: "section", label: "Section", iconName: "section" },
      { action: "interference", label: "Interference", iconName: "interference" },
      { action: "component-colors", label: "Body Colors", iconName: "componentColors" },
      { action: "draft-analysis", label: "Draft Analysis", iconName: "draftAnalysis" },
      { action: "zebra", label: "Zebra", iconName: "zebra" },
      { action: "curvature", label: "Curvature", iconName: "curvature" },
    ],
  },
  {
    label: "INSERT",
    items: [
      { action: "import", label: "Import Mesh", iconName: "import" },
      { action: "simplify-mesh", label: "Simplify Mesh", iconName: "simplifyMesh" },
    ],
  },
];

export const SKETCH: Group[] = [
  {
    label: "CREATE",
    items: [
      { action: "line", label: "Line", iconName: "line", key: "L" },
      { action: "rectangle", label: "Rectangle", iconName: "rectangle", key: "R" },
      { action: "centerRectangle", label: "Center Rect", iconName: "centerRectangle" },
      { action: "circle", label: "Circle", iconName: "circle", key: "C" },
      { action: "circle2", label: "Circle 2-Pt", iconName: "circle2" },
      { action: "circle3", label: "Circle 3-Pt", iconName: "circle3" },
      { action: "arc", label: "Arc", iconName: "arc", key: "A" },
      { action: "polygon", label: "Polygon", iconName: "polygon" },
      { action: "slot", label: "Slot", iconName: "slot" },
      { action: "spline", label: "Spline", iconName: "spline" },
      { action: "point", label: "Point", iconName: "point" },
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
      { action: "mirror-sketch", label: "Mirror", iconName: "mirror" },
      { action: "dimension", label: "Dimension", iconName: "dimension", key: "D" },
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
      { action: "tangent", label: "Tangent", iconName: "tangent" },
      { action: "coincident", label: "Coincident", iconName: "coincident" },
      { action: "concentric", label: "Concentric", iconName: "concentric" },
      { action: "midpoint", label: "Midpoint", iconName: "midpoint" },
      { action: "symmetric", label: "Symmetric", iconName: "symmetric" },
    ],
  },
];

// Collapse priority: lower numbers fold into the "⋯ More" overflow first. PALETTE
// and FINISH are pinned (never collapse — Finish Sketch must stay reachable).
const PRIORITY: Record<string, number> = {
  CREATE: 100,
  MODIFY: 90,
  INSPECT: 45,
  CONSTRUCT: 40,
  INSERT: 30,
  CONSTRAINTS: 20,
};
const PINNED = new Set(["PALETTE", "FINISH"]);

interface GroupMeta {
  el: HTMLElement;
  label: string;
  items: Item[];
  priority: number;
  pinned: boolean;
}
interface Ctx {
  el: HTMLElement;
  groups: GroupMeta[];
  overflowBtn: HTMLButtonElement;
}

export class Ribbon {
  onAction: ((action: string) => void) | null = null;
  private model: Ctx;
  private sketch: Ctx;
  private current: Ctx;
  private collapsed: GroupMeta[] = [];
  private overflowPopup: HTMLDivElement | null = null;

  constructor(container: HTMLElement) {
    this.model = this.buildContext(MODEL, false);
    this.sketch = this.buildContext(SKETCH, true);
    container.append(this.model.el, this.sketch.el);
    this.current = this.model;
    this.setContext("model");
    // priority+ overflow: re-pack whenever the ribbon's width changes
    new ResizeObserver(() => this.reflow()).observe(container);
  }

  setContext(ctx: RibbonContext) {
    this.model.el.classList.toggle("hidden", ctx !== "model");
    this.sketch.el.classList.toggle("hidden", ctx !== "sketch");
    this.current = ctx === "model" ? this.model : this.sketch;
    this.closeOverflow();
    this.reflow();
  }

  setActiveSketchTool(tool: string) {
    this.sketch.el.querySelectorAll<HTMLElement>("[data-action]").forEach((b) => {
      b.classList.toggle("active", b.dataset.action === tool);
    });
  }

  private buildContext(groups: Group[], isSketch: boolean): Ctx {
    const el = document.createElement("div");
    el.className = "ribbon-context";
    const metas: GroupMeta[] = [];
    const add = (g: Group) => {
      const m = this.buildGroup(g);
      el.appendChild(m.el);
      metas.push(m);
    };
    for (const g of groups) add(g);

    const overflowBtn = document.createElement("button");
    overflowBtn.className = "ribbon-overflow hidden";
    overflowBtn.title = "More tools";
    overflowBtn.textContent = "⋯";
    overflowBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleOverflow();
    });
    el.appendChild(overflowBtn);

    if (isSketch) {
      const spacer = document.createElement("div");
      spacer.className = "ribbon-spacer";
      el.appendChild(spacer);
      add({ label: "PALETTE", items: [{ action: "palette", label: "Sketch Palette", iconName: "palette", kind: "toggle" }] });
      add({ label: "FINISH", items: [{ action: "finish", label: "Finish Sketch", iconName: "check", kind: "finish" }] });
    }
    return { el, groups: metas, overflowBtn };
  }

  private buildGroup(g: Group): GroupMeta {
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
    return {
      el: group,
      label: g.label,
      items: g.items,
      priority: PINNED.has(g.label) ? Infinity : (PRIORITY[g.label] ?? 50),
      pinned: PINNED.has(g.label),
    };
  }

  /** priority+ pack: collapse lowest-priority panels into the overflow dropdown
   *  until the row fits the available width. */
  private reflow() {
    const ctx = this.current;
    if (ctx.el.classList.contains("hidden")) return;
    for (const g of ctx.groups) g.el.classList.remove("collapsed");
    ctx.overflowBtn.classList.add("hidden");

    const available = ctx.el.clientWidth - 12;
    const widths = ctx.groups.map((g) => g.el.offsetWidth); // measured with all shown
    let total = widths.reduce((a, b) => a + b, 0);
    if (total <= available) {
      this.collapsed = [];
      this.closeOverflow();
      return;
    }
    total += 40; // reserve the overflow button
    const order = ctx.groups
      .map((g, i) => ({ g, i }))
      .filter((x) => !x.g.pinned)
      .sort((a, b) => a.g.priority - b.g.priority || b.i - a.i); // low priority, then rightmost
    const collapsed: GroupMeta[] = [];
    for (const { g, i } of order) {
      if (total <= available) break;
      g.el.classList.add("collapsed");
      total -= widths[i];
      collapsed.unshift(g);
    }
    this.collapsed = collapsed;
    ctx.overflowBtn.classList.toggle("hidden", collapsed.length === 0);
    if (this.overflowPopup) this.buildOverflowPopup(); // keep an open popup in sync
  }

  private toggleOverflow() {
    if (this.overflowPopup) this.closeOverflow();
    else this.buildOverflowPopup();
  }

  private buildOverflowPopup() {
    this.closeOverflow();
    if (!this.collapsed.length) return;
    const pop = document.createElement("div");
    pop.className = "ribbon-overflow-popup";
    for (const g of this.collapsed) {
      const lab = document.createElement("div");
      lab.className = "ribbon-overflow-label";
      lab.textContent = g.label;
      pop.appendChild(lab);
      for (const it of g.items) {
        const b = document.createElement("button");
        b.className = "ribbon-overflow-item";
        b.innerHTML = `${icon(it.iconName)}<span>${it.label}</span>`;
        b.addEventListener("click", () => {
          this.closeOverflow();
          this.onAction?.(it.action);
        });
        pop.appendChild(b);
      }
    }
    const r = this.current.overflowBtn.getBoundingClientRect();
    pop.style.position = "fixed";
    pop.style.top = `${r.bottom + 2}px`;
    pop.style.right = `${Math.max(4, window.innerWidth - r.right)}px`;
    document.body.appendChild(pop);
    this.overflowPopup = pop;
    setTimeout(() => {
      const onDown = (e: PointerEvent) => {
        if (this.overflowPopup && !this.overflowPopup.contains(e.target as Node) && e.target !== this.current.overflowBtn) {
          this.closeOverflow();
        }
      };
      document.addEventListener("pointerdown", onDown, true);
      (pop as unknown as { _cleanup: () => void })._cleanup = () =>
        document.removeEventListener("pointerdown", onDown, true);
    }, 0);
  }

  private closeOverflow() {
    if (!this.overflowPopup) return;
    (this.overflowPopup as unknown as { _cleanup?: () => void })._cleanup?.();
    this.overflowPopup.remove();
    this.overflowPopup = null;
  }
}
