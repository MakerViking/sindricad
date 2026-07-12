// A small menu-bar with dropdown menus (File, …). Each menu is a button that
// opens a popup of items; clicking an item runs it and closes the popup, and
// clicking anywhere else closes it. Disabled items are skipped.

export interface MenuItem {
  label: string;
  shortcut?: string; // display hint, e.g. "Ctrl+S"
  onClick?: () => void;
  separator?: boolean;
  disabled?: () => boolean;
  checked?: () => boolean; // shows a ✓ when true (re-evaluated each time the menu opens)
}

export interface MenuDef {
  label: string;
  items: MenuItem[];
}

export class Menubar {
  private openPopup: HTMLDivElement | null = null;

  constructor(
    private root: HTMLElement,
    menus: MenuDef[],
  ) {
    this.root.classList.add("menubar");
    for (const menu of menus) this.root.appendChild(this.buildMenu(menu));
    // dismiss on outside click / Escape
    document.addEventListener("pointerdown", (e) => {
      if (this.openPopup && !this.root.contains(e.target as Node)) this.close();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.close();
    });
  }

  private buildMenu(menu: MenuDef): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "menu";

    const btn = document.createElement("button");
    btn.className = "menu-btn";
    btn.textContent = menu.label;
    wrap.appendChild(btn);

    const popup = document.createElement("div");
    popup.className = "menu-popup hidden";
    for (const item of menu.items) {
      popup.appendChild(item.separator ? sep() : this.buildItem(item));
    }
    wrap.appendChild(popup);

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const isOpen = this.openPopup === popup;
      this.close();
      if (!isOpen) this.open(popup, btn);
    });
    return wrap;
  }

  private buildItem(item: MenuItem): HTMLElement {
    const el = document.createElement("button");
    el.className = "menu-item";
    const label = document.createElement("span");
    label.textContent = item.label;
    el.appendChild(label);
    if (item.shortcut) {
      const sc = document.createElement("span");
      sc.className = "menu-shortcut";
      sc.textContent = item.shortcut;
      el.appendChild(sc);
    }
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      this.close();
      item.onClick?.();
    });
    // refresh disabled / checked state when the popup opens
    el.dataset.dynDisabled = item.disabled ? "1" : "";
    (el as any)._isDisabled = item.disabled;
    (el as any)._isChecked = item.checked;
    (el as any)._labelEl = label;
    (el as any)._baseLabel = item.label;
    return el;
  }

  private open(popup: HTMLDivElement, btn: HTMLElement) {
    // reflect any dynamic disabled / checked state before showing
    popup.querySelectorAll<HTMLButtonElement>(".menu-item").forEach((el) => {
      const fn = (el as any)._isDisabled as (() => boolean) | undefined;
      el.toggleAttribute("disabled", !!fn?.());
      const chk = (el as any)._isChecked as (() => boolean) | undefined;
      if (chk) {
        const labelEl = (el as any)._labelEl as HTMLElement;
        const base = (el as any)._baseLabel as string;
        labelEl.textContent = (chk() ? "✓ " : "    ") + base;
      }
    });
    popup.classList.remove("hidden");
    btn.classList.add("active");
    this.openPopup = popup;
  }

  private close() {
    if (!this.openPopup) return;
    this.openPopup.classList.add("hidden");
    this.openPopup.previousElementSibling?.classList.remove("active");
    this.openPopup = null;
  }
}

function sep(): HTMLElement {
  const s = document.createElement("div");
  s.className = "menu-sep";
  return s;
}

export interface CtxItem {
  label: string;
  onClick?: () => void; // omit for separators / pure submenu parents
  disabled?: boolean;
  separator?: boolean; // renders a divider; other fields ignored
  shortcut?: string | undefined; // right-aligned key hint, e.g. "Q" (undefined = no hint from keyHint)
  danger?: boolean; // destructive action (red)
  swatch?: string; // small color chip before the label (palette flyouts)
  children?: CtxItem[]; // one-level flyout submenu, opens on hover
}

// the currently-open context menu's close(), so tools can dismiss it on exit
let activeClose: (() => void) | null = null;

/** Close the open context menu (if any). For tool/mode exits — normal dismissal
 *  (outside pointerdown, Escape, item click) is handled by the menu itself. */
export function dismissContextMenu(): void {
  activeClose?.();
}

/** Pop a right-click context menu at (x,y) with the given items. Closes on an
 *  outside pointerdown or Escape. One shared engine for every right-click
 *  surface (viewport, timeline, browser tree, sketch mode). */
export function contextMenu(x: number, y: number, items: CtxItem[]): void {
  activeClose?.(); // close a previous menu properly (element + listeners)
  const menu = document.createElement("div");
  menu.className = "context-menu dynamic";
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  let submenu: HTMLDivElement | null = null;
  let subAnchor: HTMLElement | null = null;
  let subCloseTimer: number | undefined;
  const cancelSubClose = () => {
    clearTimeout(subCloseTimer);
    subCloseTimer = undefined;
  };
  const closeSub = () => {
    cancelSubClose();
    submenu?.remove();
    submenu = null;
    subAnchor = null;
  };
  // Hover-intent: moving diagonally from the parent item toward a lower flyout
  // entry crosses sibling rows — an instant close would retract the flyout mid-
  // travel, so sibling hover only *schedules* the close and entering the flyout
  // cancels it.
  const scheduleSubClose = () => {
    cancelSubClose();
    subCloseTimer = window.setTimeout(closeSub, 300);
  };
  let closed = false;
  const close = () => {
    closed = true;
    closeSub();
    menu.remove();
    document.removeEventListener("pointerdown", onDown, true);
    window.removeEventListener("keydown", onKey, true);
    if (activeClose === close) activeClose = null;
  };
  const onDown = (e: PointerEvent) => {
    const t = e.target as Node;
    if (!menu.contains(t) && !submenu?.contains(t)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation(); // Escape only closes the menu — not the app's selection
      close();
    }
  };

  const buildItem = (it: CtxItem, depth: number): HTMLElement => {
    if (it.separator) {
      return Object.assign(document.createElement("div"), { className: "ctx-sep" });
    }
    const el = document.createElement("div");
    el.className = "ctx-item";
    if (it.danger) el.classList.add("danger");
    if (it.disabled) el.classList.add("disabled");
    if (it.swatch) {
      const chip = document.createElement("span");
      chip.className = "ctx-swatch";
      chip.style.background = it.swatch;
      el.appendChild(chip);
    }
    const label = document.createElement("span");
    label.className = "ctx-label";
    label.textContent = it.label;
    el.appendChild(label);
    if (it.shortcut) {
      const key = document.createElement("span");
      key.className = "ctx-key";
      key.textContent = it.shortcut;
      el.appendChild(key);
    }
    if (it.children) {
      const caret = document.createElement("span");
      caret.className = "ctx-caret";
      caret.textContent = "▸";
      el.appendChild(caret);
    }
    if (it.disabled) return el;

    if (it.children && depth === 0) {
      const open = () => openSub(el, it.children!);
      el.addEventListener("pointerenter", open);
      el.addEventListener("click", open);
    } else {
      // hovering a plain top-level item retracts an open flyout (hover-intent delayed)
      if (depth === 0) el.addEventListener("pointerenter", scheduleSubClose);
      el.addEventListener("click", () => {
        close();
        it.onClick?.();
      });
    }
    return el;
  };

  const openSub = (anchor: HTMLElement, children: CtxItem[]) => {
    if (submenu && subAnchor === anchor) {
      cancelSubClose(); // re-hovering the parent keeps its open flyout
      return;
    }
    closeSub();
    const sub = document.createElement("div");
    sub.className = "context-menu dynamic submenu";
    for (const c of children) sub.appendChild(buildItem(c, 1));
    sub.addEventListener("pointerenter", cancelSubClose);
    document.body.appendChild(sub);
    // to the right of the parent item; flip left / shift up when it would overflow
    const a = anchor.getBoundingClientRect();
    const r = sub.getBoundingClientRect();
    let sx = a.right + 2;
    if (sx + r.width > window.innerWidth) sx = Math.max(4, a.left - r.width - 2);
    let sy = a.top - 5;
    if (sy + r.height > window.innerHeight) sy = Math.max(4, window.innerHeight - r.height - 4);
    sub.style.left = `${sx}px`;
    sub.style.top = `${sy}px`;
    submenu = sub;
    subAnchor = anchor;
  };

  for (const it of items) menu.appendChild(buildItem(it, 0));
  document.body.appendChild(menu);

  // nudge back on-screen if it would overflow
  const r = menu.getBoundingClientRect();
  if (r.bottom > window.innerHeight) menu.style.top = `${Math.max(4, y - r.height)}px`;
  if (r.right > window.innerWidth) menu.style.left = `${Math.max(4, x - r.width)}px`;

  activeClose = close;
  // defer listener install so the opening right-click doesn't immediately close
  // it (skip if something dismissed the menu before the deferral ran)
  setTimeout(() => {
    if (closed) return;
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
  }, 0);
}
