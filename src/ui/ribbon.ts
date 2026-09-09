// MCAD-style icon ribbon. Two contexts — modeling and sketch — each a row of
// grouped icon buttons (CREATE / MODIFY / …) with the group name underneath.
// The sketch context ends with the green Finish Sketch + a Sketch Palette toggle.

import { icon, type IconName } from "./icons";
import { esc } from "./escape";
import { t, localeTag } from "../i18n";

export type RibbonContext = "model" | "sketch";

interface ToolItem {
  action: string;
  label: string;
  iconName: IconName;
  key?: string;
  kind?: "finish" | "toggle";
  /** A second tooltip line, for the pairs where the label alone does not say
   *  what makes this button different from the one beside it. */
  hint?: string;
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
  /** Stable identity (collapse priority, pinning, tests key on it); the label
   *  is translated and must never be used as one. */
  id: string;
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
    id: "CREATE", label: t("ribbon.group.create"),
    items: [
      { action: "sketch", label: t("tool.sketch"), iconName: "sketch", key: "S" },
      { action: "extrude", label: t("tool.extrude"), iconName: "extrude", key: "E" },
      { action: "primitive", label: t("tool.primitive"), iconName: "primitive" },
      {
        label: t("tool.revolve"),
        children: [
          { action: "revolve", label: t("tool.revolve"), iconName: "revolve" },
          { action: "loft", label: t("tool.loft"), iconName: "loft" },
          { action: "sweep", label: t("tool.sweep"), iconName: "sweep" },
        ],
      },
    ],
  },
  {
    id: "MODIFY", label: t("ribbon.group.modify"),
    items: [
      { action: "presspull", label: t("tool.presspull"), iconName: "presspull", key: "Q" },
      { action: "fillet", label: t("tool.fillet"), iconName: "fillet", key: "F" },
      { action: "chamfer", label: t("tool.chamfer"), iconName: "chamfer", key: "B" },
      {
        label: t("tool.move"),
        children: [
          { action: "move", label: t("tool.move"), iconName: "move", key: "M" },
          { action: "scale", label: t("tool.scale"), iconName: "scale" },
          { action: "mirror", label: t("tool.mirror"), iconName: "mirror" },
          { action: "pattern", label: t("tool.pattern"), iconName: "pattern" },
        ],
      },
      {
        label: t("tool.combine"),
        children: [
          { action: "combine", label: t("tool.combine"), iconName: "combine", key: "J" },
          { action: "split", label: t("tool.split"), iconName: "split", key: "K" },
        ],
      },
      {
        label: t("tool.shell"),
        children: [
          { action: "shell", label: t("tool.shell"), iconName: "shell" },
          { action: "draft", label: t("tool.draft"), iconName: "draft" },
          { action: "offset-face", label: t("tool.offsetFace"), iconName: "offsetFace" },
          { action: "thicken", label: t("tool.thicken"), iconName: "thicken" },
        ],
      },
      { action: "texture", label: t("tool.texture"), iconName: "texture" },
      { action: "text-on-face", label: t("tool.text"), iconName: "text" },
      { action: "change-parameters", label: t("tool.parameters"), iconName: "parameters" },
    ],
  },
  {
    id: "CONSTRUCT", label: t("ribbon.group.construct"),
    items: [
      // These two do the same pick and the same offset gizmo, and the labels do
      // not say that only one of them drops you into a sketch. A reporter who
      // wanted just the plane found Offset Plane, got a sketch he could not get
      // out of, and never knew Datum Plane was the button he wanted (d911463c).
      { action: "offset-plane", label: t("tool.offsetPlane"), iconName: "offsetPlane", key: "O",
        hint: t("ribbon.hint.offsetPlane") },
      { action: "datum-plane", label: t("tool.datumPlane"), iconName: "datumPlane",
        hint: t("ribbon.hint.datumPlane") },
    ],
  },
  {
    id: "INSPECT", label: t("ribbon.group.inspect"),
    items: [
      { action: "measure", label: t("tool.measure"), iconName: "measure", key: "I" },
      { action: "section", label: t("tool.section"), iconName: "section" },
      {
        label: t("tool.analyze"),
        children: [
          { action: "properties", label: t("tool.properties"), iconName: "properties" },
          { action: "interference", label: t("tool.interference"), iconName: "interference" },
          { action: "draft-analysis", label: t("tool.overhang"), iconName: "draftAnalysis" },
          { action: "zebra", label: t("tool.zebra"), iconName: "zebra" },
          { action: "curvature", label: t("tool.curvature"), iconName: "curvature" },
          { action: "component-colors", label: t("tool.bodyColors"), iconName: "componentColors" },
        ],
      },
    ],
  },
  {
    id: "INSERT", label: t("ribbon.group.insert"),
    items: [
      { action: "import", label: t("tool.importMesh"), iconName: "import" },
      { action: "simplify-mesh", label: t("tool.simplifyMesh"), iconName: "simplifyMesh" },
      { action: "clean-up", label: t("tool.cleanUp"), iconName: "cleanUp", key: "U" },
      { action: "compute-all", label: t("tool.computeAll"), iconName: "computeAll" },
    ],
  },
  {
    id: "PRINT", label: t("ribbon.group.print"),
    items: [
      { action: "print-export", label: t("tool.printProject"), iconName: "print" },
      { action: "print-orca", label: t("tool.openInOrca"), iconName: "slicer" },
      { action: "print-send", label: t("tool.sendToPrinter"), iconName: "printerSend" },
    ],
  },
];

export const SKETCH: Group[] = [
  {
    // Select comes first, and alone, because it is the way OUT of every tool to
    // its right. Field report c9db7ec2 (0.1.148) — "there doesn't seem to be any
    // way to select elements in sketch mode" — was reported against a ribbon
    // where the only route back was Escape, and Escape is the third branch of
    // that key's chain, so it can take two presses to reach the tool.
    id: "SELECT", label: t("ribbon.group.select"),
    items: [{ action: "select", label: t("tool.select"), iconName: "select", key: "S" }],
  },
  {
    id: "CREATE", label: t("ribbon.group.create"),
    items: [
      { action: "line", label: t("tool.line"), iconName: "line", key: "L" },
      { action: "rectangle", label: t("tool.rectangle"), iconName: "rectangle", key: "R" },
      { action: "centerRectangle", label: t("tool.centerRectangle"), iconName: "centerRectangle" },
      { action: "circle", label: t("tool.circle"), iconName: "circle", key: "C" },
      { action: "circle2", label: t("tool.circle2"), iconName: "circle2" },
      { action: "circle3", label: t("tool.circle3"), iconName: "circle3" },
      { action: "arc", label: t("tool.arc"), iconName: "arc", key: "A" },
      { action: "polygon", label: t("tool.polygon"), iconName: "polygon" },
      { action: "slot", label: t("tool.slot"), iconName: "slot" },
      { action: "spline", label: t("tool.spline"), iconName: "spline" },
      { action: "point", label: t("tool.point"), iconName: "point" },
      { action: "text", label: t("tool.text"), iconName: "text", key: "T" },
      { action: "project", label: t("tool.project"), iconName: "project", key: "P" },
    ],
  },
  {
    id: "MODIFY", label: t("ribbon.group.modify"),
    items: [
      { action: "fillet-sketch", label: t("tool.fillet"), iconName: "fillet", key: "F" },
      { action: "chamfer-sketch", label: t("tool.chamfer"), iconName: "chamfer" },
      { action: "trim", label: t("tool.trim"), iconName: "trim", key: "T" },
      { action: "extend", label: t("tool.extend"), iconName: "extend" },
      { action: "offset", label: t("tool.offset"), iconName: "offset", key: "O" },
      { action: "break", label: t("tool.break"), iconName: "break" },
      { action: "mirror-sketch", label: t("tool.mirror"), iconName: "mirror" },
      { action: "move-sketch", label: t("tool.move"), iconName: "move" },
      { action: "copy-sketch", label: t("tool.copy"), iconName: "copy" },
      { action: "rotate-sketch", label: t("tool.rotate"), iconName: "rotate" },
      { action: "scale-sketch", label: t("tool.scale"), iconName: "scale" },
      { action: "dimension", label: t("tool.dimension"), iconName: "dimension", key: "D" },
    ],
  },
  {
    id: "PATTERN", label: t("ribbon.group.pattern"),
    items: [
      { action: "patternRect", label: t("tool.patternRect"), iconName: "patternRect" },
      { action: "patternCircular", label: t("ribbon.abbrev.patternCircular"), iconName: "patternCircular" },
      { action: "boltCircle", label: t("tool.boltCircle"), iconName: "boltCircle" },
      { action: "hexHoles", label: t("tool.hexHoles"), iconName: "hexHoles" },
      { action: "honeycomb", label: t("tool.honeycomb"), iconName: "honeycomb" },
      { action: "gridHoles", label: t("tool.gridHoles"), iconName: "gridHoles" },
    ],
  },
  {
    id: "CONSTRAINTS", label: t("ribbon.group.constraints"),
    items: [
      // TOP LEVEL, not inside the split. A tester asked where Sweep and Loft
      // were while both sat behind a caret; a tool whose whole job is to tell
      // you what is wrong with your profile cannot be the one that hides.
      { action: "check-sketch", label: t("tool.checkSketch"), iconName: "properties" },
      {
        label: t("tool.constrain"),
        children: [
          { action: "horizontal", label: t("tool.horizontal"), iconName: "horizontal" },
          { action: "vertical", label: t("tool.vertical"), iconName: "vertical" },
          { action: "parallel", label: t("tool.parallel"), iconName: "parallel" },
          { action: "perpendicular", label: t("ribbon.abbrev.perpendicular"), iconName: "perpendicular" },
          { action: "equal", label: t("tool.equal"), iconName: "equal" },
          { action: "tangent", label: t("tool.tangent"), iconName: "tangent" },
          { action: "coincident", label: t("tool.coincident"), iconName: "coincident" },
          { action: "concentric", label: t("tool.concentric"), iconName: "concentric" },
          { action: "midpoint", label: t("tool.midpoint"), iconName: "midpoint" },
          { action: "collinear", label: t("tool.collinear"), iconName: "collinear" },
          { action: "symmetric", label: t("tool.symmetric"), iconName: "symmetric" },
          { action: "fix", label: t("tool.fix"), iconName: "fix" },
        ],
      },
    ],
  },
];

// Collapse priority: lower numbers fold into the "⋯ More" overflow first. SELECT,
// PALETTE and FINISH are pinned (never collapse — Finish Sketch must stay
// reachable, and so must the tool that gets you back to picking geometry).
const PRIORITY: Record<string, number> = {
  CREATE: 100,
  MODIFY: 90,
  PRINT: 50,
  INSPECT: 45,
  CONSTRUCT: 40,
  INSERT: 30,
  CONSTRAINTS: 20,
};
export const PINNED = new Set(["SELECT", "PALETTE", "FINISH"]);

interface GroupMeta {
  el: HTMLElement;
  id: string;
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
  /** Fired when a ribbon popup (the ⋯ overflow list or a split button's ▾)
   *  opens or closes. Both are `position: fixed` on document.body at z-index
   *  3000, directly under the ribbon and right-anchored — which is exactly
   *  where the Sketch Palette is docked, so on a narrower window the popup
   *  paints over the palette AND takes its clicks (report e50b83c7). The
   *  ribbon does not know the palette exists; the host decides what to do. */
  onPopupToggle: ((open: boolean) => void) | null = null;
  private model: Ctx;
  private sketch: Ctx;
  private current: Ctx;
  private collapsed: GroupMeta[] = [];
  private overflowPopup: HTMLDivElement | null = null; // the ONE open popup (overflow or split ▾)
  private popupAnchor: HTMLElement | null = null; // which button owns it (for toggle)
  private popupOpen = false; // last state reported through onPopupToggle

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
    overflowBtn.title = t("ribbon.moreTools");
    overflowBtn.setAttribute("aria-label", t("ribbon.moreTools"));
    overflowBtn.innerHTML = icon("overflow");
    overflowBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleOverflow();
    });
    el.appendChild(overflowBtn);

    if (isSketch) {
      const spacer = document.createElement("div");
      spacer.className = "ribbon-spacer";
      el.appendChild(spacer);
      add({ id: "PALETTE", label: t("ribbon.group.palette"), items: [{ action: "palette", label: t("tool.sketchPalette"), iconName: "palette", kind: "toggle" }] });
      add({
        id: "FINISH", label: t("ribbon.group.finish"),
        items: [
          // A sketch had no exit that wasn't a commit: Escape only drops back to
          // the select tool, and every 3D command finishes the sketch first. Two
          // reporters entered a sketch by accident (Offset Plane opens one) and
          // could only get out by committing it (d911463c, 40c85f97).
          { action: "cancel-sketch", label: t("tool.cancelSketch"), iconName: "close",
            hint: t("ribbon.hint.cancelSketch") },
          { action: "finish", label: t("tool.finishSketch"), iconName: "check", kind: "finish" },
        ],
      });
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
      id: g.id,
      label: g.label,
      items: g.items,
      priority: PINNED.has(g.id) ? Infinity : (PRIORITY[g.id] ?? 50),
      pinned: PINNED.has(g.id),
      splitSync,
    };
  }

  private buildBtn(it: ToolItem): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.className = "ribbon-btn";
    if (it.kind === "finish") btn.classList.add("finish");
    btn.dataset.action = it.action;
    const base = it.key ? t("ribbon.toolWithKey", { label: it.label, key: it.key }) : it.label;
    btn.title = it.hint ? `${base}\n${it.hint}` : base;
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
    // Both tooltips are DERIVED from the children, never hand-written. The old
    // text was `More ${it.label} tools`, and it.label is the FAMILY name, which
    // for four of the six splits is also the first child's name — so the arrow
    // on the Revolve button read "More Revolve tools" while the thing it was
    // hiding was Loft and Sweep. A beta tester asked where Sweep and Loft were
    // while both were one click away behind exactly that arrow.
    const others = () => children.filter((c) => c !== primary).map((c) => c.label);
    const apply = () => {
      btn.dataset.action = primary.action;
      const base = primary.key ? t("ribbon.toolWithKey", { label: primary.label, key: primary.key }) : primary.label;
      const rest = others();
      const alsoHere = rest.length ? t("ribbon.alsoHere", { tools: new Intl.ListFormat(localeTag(), { type: "unit", style: "short" }).format(rest) }) : "";
      btn.title = alsoHere ? `${base}\n${alsoHere}` : base;
      btn.innerHTML = `${icon(primary.iconName)}<span>${esc(primary.label)}</span>`;
      const label = alsoHere || t("ribbon.moreFamilyTools", { name: it.label });
      arrow.title = label;
      arrow.setAttribute("aria-label", label);
    };
    btn.addEventListener("click", () => this.onAction?.(primary.action));

    const arrow = document.createElement("button");
    arrow.className = "ribbon-split-arrow";
    arrow.innerHTML = icon("caretDown");
    arrow.setAttribute("aria-haspopup", "menu");
    arrow.setAttribute("aria-expanded", "false");
    apply(); // after `arrow` exists: apply() now writes the arrow's tooltip too
    arrow.addEventListener("click", (e) => {
      e.stopPropagation();
      const wasMine = this.popupAnchor === arrow;
      this.closePopup();
      if (wasMine) return; // second click on the same arrow just closes
      arrow.setAttribute("aria-expanded", "true");
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
    this.setPopupOpen(true);
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
    this.setPopupOpen(true);
  }

  /** Report an open/close through `onPopupToggle`, but only on a real change,
   *  so what the host gets is a STATE and not an event stream: never two opens
   *  in a row, never a close for a popup that was not open. Worth the three
   *  lines because the close path is diffuse — a popup also closes on an
   *  outside click, on Escape, on leaving the sketch and on a reflow, and
   *  `buildOverflowPopup()`/`openDropdown()` each begin by closing whatever was
   *  there. (It does NOT collapse the close+reopen `reflow()` does while
   *  resizing with the overflow popup open: that pair is a genuine change each
   *  way. It is invisible because both happen synchronously in one
   *  ResizeObserver callback, with no paint in between.) */
  private setPopupOpen(open: boolean) {
    if (this.popupOpen === open) return;
    this.popupOpen = open;
    this.onPopupToggle?.(open);
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
    // Reset the split arrow's state HERE rather than at the click site: a popup
    // also closes on an outside click, on Escape and on a reflow, and none of
    // those go back through the arrow's own handler.
    if (this.popupAnchor?.hasAttribute("aria-expanded")) {
      this.popupAnchor.setAttribute("aria-expanded", "false");
    }
    this.popupAnchor = null;
    this.setPopupOpen(false);
  }
}
