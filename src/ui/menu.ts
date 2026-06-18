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
