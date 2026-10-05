// The Sketch Palette (mainstream MCAD's right-docked panel shown while sketching).
// Toggles control drawing/display options; "Look At" re-squares the camera; the
// constraint tools sit in an icon grid below them. Every row carries a tooltip
// saying what it does: "I don't know what a 'reference dim' or 'show profile'
// do, tooltip text may help" (report 9b764625).

import { t, setText, setTitle } from "../i18n";
import { esc } from "./escape";
import { icon } from "./icons";
import { SKETCH, leavesOf, type ToolItem } from "./ribbon";

export type PaletteToggle =
  | "lockView" | "construction" | "reference" | "grid" | "snap" | "autoConstrain" | "profile" | "dimensions" | "constraints";

interface ToggleDef {
  key: PaletteToggle;
  label: string;
  /** locale key of the row's tooltip */
  title: string;
  default: boolean;
}
const TOGGLES: ToggleDef[] = [
  // Off by default, and SketchMode.viewLocked agrees. Entering a sketch always
  // squares the camera to the plane; locking additionally forbids orbiting away
  // from it, which is not what mainstream MCAD does and is not what a user
  // wants when the geometry they need to project sits BEHIND the sketch face:
  // "In the Sketch workspace, it is not possible to rotate the view. As a
  // result, it is impossible to select geometry located behind the sketch
  // support face in order to project it onto the sketch" (field report
  // 9e3da3c7). The lock stays available for anyone who wants it.
  { key: "lockView", label: t("palette.toggle.lockView"), title: "palette.toggleTitle.lockView", default: false },
  { key: "construction", label: t("palette.toggle.construction"), title: "palette.toggleTitle.construction", default: false },
  { key: "reference", label: t("palette.toggle.reference"), title: "palette.toggleTitle.reference", default: false },
  { key: "grid", label: t("palette.toggle.grid"), title: "palette.toggleTitle.grid", default: true },
  { key: "snap", label: t("palette.toggle.snap"), title: "palette.toggleTitle.snap", default: true },
  // On by default, and SketchMode.autoConstrainOff agrees (the same two-places
  // rule as lockView above). Off draws exactly what the cursor placed: no
  // Horizontal, Vertical, Perpendicular or Tangent. Snapped and chained joins
  // stay, since a join is where the user put the point, not a guess.
  { key: "autoConstrain", label: t("palette.toggle.autoConstrain"), default: true, title: "palette.toggleTitle.autoConstrain" },
  { key: "profile", label: t("palette.toggle.profile"), title: "palette.toggleTitle.profile", default: true },
  { key: "dimensions", label: t("palette.toggle.dimensions"), title: "palette.toggleTitle.dimensions", default: true },
  { key: "constraints", label: t("palette.toggle.constraints"), title: "palette.toggleTitle.constraints", default: true },
];

/** The constraint tools, exactly as the ribbon's Constrain button lists them,
 *  so the palette and the ribbon cannot offer different sets. The ribbon folds
 *  its constraints into one dropdown, which is the first group to fall into
 *  "More" on a narrow window; the grid keeps all of them one click away
 *  (Doug L1). */
const CONSTRAINT_TOOLS: ToolItem[] = (() => {
  const split = SKETCH.find((g) => g.id === "CONSTRAINTS")?.items.find((it) => "children" in it);
  return split ? leavesOf(split) : [];
})();

export class SketchPalette {
  /** The shipped default for one toggle. Exposed so the defaults can be asserted
   *  against SketchMode's own copy — `lockView` is declared in both places and
   *  a disagreement means the checkbox lies about what the camera is doing. */
  static defaultFor(key: PaletteToggle): boolean {
    return TOGGLES.find((t) => t.key === key)!.default;
  }
  /** Every toggle the palette offers, in display order. */
  static toggleKeys(): PaletteToggle[] {
    return TOGGLES.map((t) => t.key);
  }

  private el: HTMLElement;
  private state: Record<PaletteToggle, boolean>;
  /** the constraint grid's buttons, in CONSTRAINT_TOOLS order */
  private tools: HTMLButtonElement[] = [];
  private switches = new Map<PaletteToggle, HTMLInputElement>();
  onToggle: ((key: PaletteToggle, value: boolean) => void) | null = null;
  onLookAt: (() => void) | null = null;
  /** A constraint tool picked in the grid: the ribbon's action name, for the
   *  same dispatcher the ribbon uses. */
  onAction: ((action: string) => void) | null = null;

  constructor(container: HTMLElement) {
    this.el = container;
    this.state = Object.fromEntries(
      TOGGLES.map((t) => [t.key, t.default]),
    ) as Record<PaletteToggle, boolean>;
    this.render();
  }

  setVisible(on: boolean) {
    this.el.classList.toggle("hidden", !on);
  }

  get(key: PaletteToggle): boolean {
    return this.state[key];
  }

  /** Light the grid button of the armed sketch tool, as the ribbon does. */
  setActiveTool(tool: string) {
    for (const b of this.tools) b.classList.toggle("active", b.dataset.action === tool);
  }

  /** push every toggle's current value to listeners (call on sketch enter) */
  emitAll() {
    for (const t of TOGGLES) this.onToggle?.(t.key, this.state[t.key]);
  }

  /** The sketch changed an option itself (the Dimension tool's right-click
   *  menu has its own Reference switch). Remember it, so emitAll does not hand
   *  the next sketch the old value, and show it. Never calls onToggle back. */
  set(key: PaletteToggle, on: boolean) {
    this.state[key] = on;
    this.show(key, on);
  }

  /** Draw `on` in a box without changing what the switch holds. The
   *  Construction box shows the SELECTION while geometry is selected (report
   *  9b764625: with a construction line selected the box read unticked, so
   *  ticking it changed nothing), and `mixed` draws a part-construction
   *  selection as neither. Clicking a mixed box applies the opposite of `on`,
   *  so pass the majority: that is the way the right-click item goes. */
  show(key: PaletteToggle, on: boolean, mixed = false) {
    const sw = this.switches.get(key);
    if (!sw) return;
    sw.checked = on;
    sw.indeterminate = mixed;
  }

  private render() {
    this.el.innerHTML = `<div class="palette-title" data-i18n="palette.title">${esc(t("palette.title"))}</div><div class="palette-section" data-i18n="palette.options">${esc(t("palette.options"))}</div>`;

    const lookAt = document.createElement("button");
    lookAt.className = "palette-btn";
    setText(lookAt, "palette.lookAt");
    setTitle(lookAt, "palette.lookAtTitle");
    lookAt.addEventListener("click", () => this.onLookAt?.());
    this.el.appendChild(lookAt);

    for (const t of TOGGLES) {
      const row = document.createElement("label");
      row.className = "palette-row";
      setTitle(row, t.title);
      const span = document.createElement("span");
      span.textContent = t.label;
      const sw = document.createElement("input");
      sw.type = "checkbox";
      sw.className = "palette-switch";
      sw.checked = this.state[t.key];
      // A click left keyboard focus on the box, and every sketch key skips a
      // focused input (isEditableTarget), so after converting a line with the
      // Construction box, Escape, Delete and Ctrl+Z did nothing until the
      // canvas was clicked. A box clicked with the pointer hands focus back; one
      // toggled from the keyboard (Tab, Space) keeps it, so the palette can
      // still be walked with Tab.
      let pressed = false;
      row.addEventListener("pointerdown", () => { pressed = true; });
      sw.addEventListener("keydown", () => { pressed = false; });
      sw.addEventListener("change", () => {
        this.state[t.key] = sw.checked;
        this.onToggle?.(t.key, sw.checked);
        if (pressed) sw.blur();
        pressed = false;
      });
      row.append(span, sw);
      this.el.appendChild(row);
      this.switches.set(t.key, sw);
    }

    const section = document.createElement("div");
    section.className = "palette-section";
    setText(section, "palette.constraints");
    const grid = document.createElement("div");
    grid.className = "palette-grid";
    this.tools = [];
    for (const tool of CONSTRAINT_TOOLS) {
      const btn = document.createElement("button");
      btn.className = "palette-tool";
      btn.dataset.action = tool.action;
      const name = tool.name ?? tool.label;
      btn.title = name;
      btn.setAttribute("aria-label", name);
      btn.innerHTML = icon(tool.iconName);
      btn.addEventListener("click", () => this.onAction?.(tool.action));
      grid.appendChild(btn);
      this.tools.push(btn);
    }
    this.el.append(section, grid);
  }
}
