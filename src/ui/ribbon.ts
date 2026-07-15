// MCAD-style icon ribbon. Two contexts — modeling and sketch — each a row of
// grouped icon buttons (CREATE / MODIFY / …) with the group name underneath.
// The sketch context ends with the green Finish Sketch + a Sketch Palette toggle.

import { icon } from "./icons";
import { esc } from "./escape";

export type RibbonContext = "model" | "sketch";

interface ToolItem {
  action: string;
  label: string;
  iconName: string;
  key?: string;
  kind?: "finish" | "toggle";
}
// Split button: the FULL dropdown list lives in `children` (children[0] is the
// initial one-click primary; `label` names the family for the arrow tooltip).
// Picking a child runs it and makes it the primary — last-used-wins, mainstream MCAD
// convention. Each tool is defined exactly once, in `children`.
interface SplitItem {
  label: string;
  children: ToolItem[];
}
type Item = ToolItem | SplitItem;
interface Group {
  label: string;
  items: Item[];
}
export type { Item, ToolItem, Group };

/** a split button's tools, or the item itself — every consumer that needs the
 *  flat tool list (palette, overflow popup) goes through this. */
export function leavesOf(it: Item): ToolItem[] {
  return "children" in it ? it.children : [it];
}

export const MODEL: Group[] = [
  {
    label: "CREATE",
    items: [
      { action: "sketch", label: "Sketch", iconName: "sketch", key: "S" },
      { action: "extrude", label: "Extrude", iconName: "extrude", key: "E" },
      { action: "primitive", label: "Primitive", iconName: "primitive" },
      {
        label: "Revolve",
        children: [
          { action: "revolve", label: "Revolve", iconName: "revolve" },
          { action: "loft", label: "Loft", iconName: "loft" },
          { action: "sweep", label: "Sweep", iconName: "sweep" },
        ],
      },
    ],
  },
  {
    label: "MODIFY",
    items: [
      { action: "presspull", label: "Press/Pull", iconName: "presspull", key: "Q" },
      { action: "fillet", label: "Fillet", iconName: "fillet", key: "F" },
      { action: "chamfer", label: "Chamfer", iconName: "chamfer", key: "B" },
      {
        label: "Move",
        children: [
          { action: "move", label: "Move", iconName: "move", key: "M" },
          { action: "scale", label: "Scale", iconName: "scale" },
          { action: "mirror", label: "Mirror", iconName: "mirror" },
          { action: "pattern", label: "Pattern", iconName: "pattern" },
        ],
      },
      {
        label: "Combine",
        children: [
          { action: "combine", label: "Combine", iconName: "combine", key: "J" },
          { action: "split", label: "Split Body", iconName: "split", key: "K" },
        ],
      },
      {
        label: "Shell",
        children: [
          { action: "shell", label: "Shell", iconName: "shell" },
          { action: "draft", label: "Draft", iconName: "draft" },
        ],
      },
    ],
  },
  {
    label: "CONSTRUCT",
    items: [
      { action: "offset-plane", label: "Offset Plane", iconName: "offsetPlane", key: "O" },
      { action: "datum-plane", label: "Datum Plane", iconName: "datumPlane" },
    ],
  },
  {
    label: "INSPECT",
    items: [
      { action: "measure", label: "Measure", iconName: "measure", key: "I" },
      { action: "section", label: "Section", iconName: "section" },
      {
        label: "Analyze",
        children: [
          { action: "properties", label: "Properties", iconName: "properties" },
          { action: "interference", label: "Interference", iconName: "interference" },
          { action: "draft-analysis", label: "Overhang", iconName: "draftAnalysis" },
          { action: "zebra", label: "Zebra", iconName: "zebra" },
          { action: "curvature", label: "Curvature", iconName: "curvature" },
          { action: "component-colors", label: "Body Colors", iconName: "componentColors" },
        ],
      },
    ],
  },
  {
    label: "INSERT",
    items: [
      { action: "import", label: "Import Mesh", iconName: "import" },
      { action: "simplify-mesh", label: "Simplify Mesh", iconName: "simplifyMesh" },
      { action: "clean-up", label: "Clean Up", iconName: "cleanUp", key: "U" },
      { action: "compute-all", label: "Compute All", iconName: "computeAll" },
    ],
  },
  {
    label: "PRINT",
    items: [
      { action: "print-export", label: "Print Project", iconName: "print" },
      { action: "print-orca", label: "Open in OrcaSlicer", iconName: "slicer" },
      { action: "print-send", label: "Send to Printer", iconName: "printerSend" },
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
      { action: "text", label: "Text", iconName: "text", key: "T" },
    ],
  },
  {
    label: "MODIFY",
    items: [
      { action: "fillet-sketch", label: "Fillet", iconName: "fillet", key: "F" },
      { action: "trim", label: "Trim", iconName: "trim", key: "T" },
      { action: "extend", label: "Extend", iconName: "extend" },
      { action: "offset", label: "Offset", iconName: "offset", key: "O" },
      { action: "break", label: "Break", iconName: "break" },
      { action: "mirror-sketch", label: "Mirror", iconName: "mirror" },
      { action: "dimension", label: "Dimension", iconName: "dimension", key: "D" },
    ],
  },
  {
    label: "PATTERN",
    items: [
      { action: "patternRect", label: "Rect Pattern", iconName: "patternRect" },
      { action: "patternCircular", label: "Circular Pat.", iconName: "patternCircular" },
      { action: "boltCircle", label: "Bolt Circle", iconName: "boltCircle" },
      { action: "hexHoles", label: "Hex Holes", iconName: "hexHoles" },
      { action: "honeycomb", label: "Honeycomb", iconName: "honeycomb" },
      { action: "gridHoles", label: "Grid Holes", iconName: "gridHoles" },
    ],
  },
  {
    label: "CONSTRAINTS",
    items: [
      {
        label: "Constrain",
        children: [
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
    ],
  },
];

// Collapse priority: lower numbers fold into the "⋯ More" overflow first. PALETTE
// and FINISH are pinned (never collapse — Finish Sketch must stay reachable).
const PRIORITY: Record<string, number> = {
  CREATE: 100,
  MODIFY: 90,
  PRINT: 50,
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
  // per split-button: swap the primary when the given action is one of its
  // children (keeps the active sketch constraint visible on the button face)
  splitSync: ((action: string) => void)[];
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
  private overflowPopup: HTMLDivElement | null = null; // the ONE open popup (overflow or split ▾)
  private popupAnchor: HTMLElement | null = null; // which button owns it (for toggle)

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
    this.closePopup();
    this.reflow();
  }

  setActiveSketchTool(tool: string) {
    // a constraint/tool living inside a split button becomes its primary first,
    // so the .active highlight below has a button face to land on
    for (const g of this.sketch.groups) for (const sync of g.splitSync) sync(tool);
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
    const splitSync: ((action: string) => void)[] = [];
    for (const it of g.items) {
      tools.appendChild("children" in it ? this.buildSplit(it, splitSync) : this.buildBtn(it));
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
      splitSync,
    };
  }

  private buildBtn(it: ToolItem): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.className = "ribbon-btn";
    if (it.kind === "finish") btn.classList.add("finish");
    btn.dataset.action = it.action;
    btn.title = it.key ? `${it.label} (${it.key})` : it.label;
    btn.innerHTML = `${icon(it.iconName)}<span>${esc(it.label)}</span>`;
    btn.addEventListener("click", () => this.onAction?.(it.action));
    return btn;
  }

  /** Split button: a one-click primary tool + a ▾ dropdown of its siblings.
   *  Picking a sibling runs it AND makes it the primary (last-used-wins). */
  private buildSplit(it: SplitItem, splitSync: ((action: string) => void)[]): HTMLElement {
    const children = it.children;
    const wrap = document.createElement("div");
    wrap.className = "ribbon-split";
    const first = children[0];
    if (!first) return wrap; // a split always has children; nothing to build otherwise
    let primary = first;
    const btn = document.createElement("button");
    btn.className = "ribbon-btn";
    const apply = () => {
      btn.dataset.action = primary.action;
      btn.title = primary.key ? `${primary.label} (${primary.key})` : primary.label;
      btn.innerHTML = `${icon(primary.iconName)}<span>${esc(primary.label)}</span>`;
    };
    apply();
    btn.addEventListener("click", () => this.onAction?.(primary.action));

    const arrow = document.createElement("button");
    arrow.className = "ribbon-split-arrow";
    arrow.title = `More ${it.label} tools`;
    arrow.textContent = "▾";
    arrow.addEventListener("click", (e) => {
      e.stopPropagation();
      const wasMine = this.popupAnchor === arrow;
      this.closePopup();
      if (wasMine) return; // second click on the same arrow just closes
      this.openDropdown(arrow, children, (picked) => {
        primary = picked;
        apply();
        this.onAction?.(picked.action);
      });
    });

    splitSync.push((action) => {
      const child = children.find((c) => c.action === action);
      if (child && child !== primary) {
        primary = child;
        apply();
      }
    });
    wrap.append(btn, arrow);
    return wrap;
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
      this.closePopup();
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
      const w = widths[i];
      if (w === undefined) continue;
      g.el.classList.add("collapsed");
      total -= w;
      collapsed.unshift(g);
    }
    this.collapsed = collapsed;
    ctx.overflowBtn.classList.toggle("hidden", collapsed.length === 0);
    // a reflow moves or hides split-arrow anchors — close a stale split
    // dropdown; the overflow popup is instead rebuilt in place below
    if (this.overflowPopup && this.popupAnchor !== ctx.overflowBtn) this.closePopup();
    if (this.overflowPopup && this.popupAnchor === ctx.overflowBtn) this.buildOverflowPopup(); // keep an open popup in sync
  }

  private toggleOverflow() {
    const wasOpen = this.popupAnchor === this.current.overflowBtn;
    this.closePopup();
    if (!wasOpen) this.buildOverflowPopup();
  }

  /** one icon+label button for a popup list (overflow and split ▾ share the look) */
  private popupItem(it: ToolItem, onPick: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.className = "ribbon-overflow-item";
    b.innerHTML = `${icon(it.iconName)}<span>${esc(it.label)}</span>`;
    b.addEventListener("click", () => {
      this.closePopup();
      onPick();
    });
    return b;
  }

  private buildOverflowPopup() {
    this.closePopup();
    if (!this.collapsed.length) return;
    const pop = document.createElement("div");
    pop.className = "ribbon-overflow-popup";
    for (const g of this.collapsed) {
      const lab = document.createElement("div");
      lab.className = "ribbon-overflow-label";
      lab.textContent = g.label;
      pop.appendChild(lab);
      // split buttons flatten: every child tool stays reachable from the overflow
      for (const it of g.items) {
        for (const leaf of leavesOf(it)) {
          pop.appendChild(this.popupItem(leaf, () => this.onAction?.(leaf.action)));
        }
      }
    }
    const r = this.current.overflowBtn.getBoundingClientRect();
    pop.style.position = "fixed";
    pop.style.top = `${r.bottom + 2}px`;
    pop.style.right = `${Math.max(4, window.innerWidth - r.right)}px`;
    document.body.appendChild(pop);
    this.overflowPopup = pop;
    this.popupAnchor = this.current.overflowBtn;
    this.installDismiss(pop, this.current.overflowBtn);
  }

  /** A split button's ▾ dropdown — the overflow popup's look and dismissal,
   *  anchored under the arrow. */
  private openDropdown(anchor: HTMLElement, items: ToolItem[], onPick: (it: ToolItem) => void) {
    this.closePopup();
    const pop = document.createElement("div");
    pop.className = "ribbon-overflow-popup";
    for (const it of items) pop.appendChild(this.popupItem(it, () => onPick(it)));
    const r = anchor.getBoundingClientRect();
    pop.style.position = "fixed";
    pop.style.top = `${r.bottom + 2}px`;
    pop.style.left = `${Math.max(4, Math.min(r.left - 40, window.innerWidth - 190))}px`;
    document.body.appendChild(pop);
    this.overflowPopup = pop;
    this.popupAnchor = anchor;
    this.installDismiss(pop, anchor);
  }

  /** dismiss-on-outside-pointerdown, shared by the overflow + split dropdowns.
   *  Deferred so the opening click doesn't immediately close the popup. */
  private installDismiss(pop: HTMLDivElement, anchor: HTMLElement) {
    setTimeout(() => {
      if (this.overflowPopup !== pop) return; // already replaced/closed
      const onDown = (e: PointerEvent) => {
        const t = e.target as Node;
        if (this.overflowPopup === pop && !pop.contains(t) && t !== anchor && !anchor.contains(t)) {
          this.closePopup();
        }
      };
      document.addEventListener("pointerdown", onDown, true);
      (pop as unknown as { _cleanup: () => void })._cleanup = () =>
        document.removeEventListener("pointerdown", onDown, true);
    }, 0);
  }

  private closePopup() {
    if (!this.overflowPopup) return;
    (this.overflowPopup as unknown as { _cleanup?: () => void })._cleanup?.();
    this.overflowPopup.remove();
    this.overflowPopup = null;
    this.popupAnchor = null;
  }
}
