// Cmd/Ctrl-K command palette: fuzzy-search every command and run it. The
// discoverability safety net (Fusion's "S" key equivalent) — so nothing is lost
// when the ribbon collapses tools into overflow, and shortcut-less / right-click-
// only commands become findable by name.

import { allCommands, type Command } from "./commands";

export class CommandPalette {
  private backdrop: HTMLDivElement | null = null;
  private input!: HTMLInputElement;
  private list!: HTMLDivElement;
  private items: { cmd: Command; el: HTMLDivElement }[] = [];
  private active = 0;
  private context: "model" | "sketch" = "model";

  constructor(private run: (id: string) => void) {}

  get isOpen() {
    return !!this.backdrop;
  }

  toggle(context: "model" | "sketch") {
    if (this.backdrop) this.close();
    else this.open(context);
  }

  open(context: "model" | "sketch") {
    if (this.backdrop) return;
    this.context = context;
    const backdrop = document.createElement("div");
    backdrop.className = "cmdk-backdrop";
    const card = document.createElement("div");
    card.className = "cmdk-card";
    this.input = document.createElement("input");
    this.input.className = "cmdk-input";
    this.input.placeholder = "Search commands…";
    this.input.spellcheck = false;
    this.list = document.createElement("div");
    this.list.className = "cmdk-list";
    card.append(this.input, this.list);
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);
    this.backdrop = backdrop;

    backdrop.addEventListener("pointerdown", (e) => {
      if (e.target === backdrop) this.close();
    });
    this.input.addEventListener("input", () => this.refresh());
    this.input.addEventListener("keydown", (e) => this.onKey(e));
    this.refresh();
    this.input.focus();
  }

  close() {
    this.backdrop?.remove();
    this.backdrop = null;
    this.items = [];
  }

  private candidates(): Command[] {
    return allCommands().filter((c) => c.context === "global" || c.context === this.context);
  }

  private refresh() {
    const q = this.input.value.trim().toLowerCase();
    const scored = this.candidates()
      .map((c) => ({ c, s: score(q, c.label.toLowerCase()) }))
      .filter((x) => q === "" || x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 40);
    this.list.innerHTML = "";
    this.items = [];
    this.active = 0;
    scored.forEach(({ c }, i) => {
      const el = document.createElement("div");
      el.className = "cmdk-item" + (i === 0 ? " active" : "");
      el.innerHTML =
        `<span class="cmdk-label">${c.label}</span>` +
        `<span class="cmdk-group">${c.group}</span>` +
        (c.key ? `<span class="cmdk-key">${c.key}</span>` : "");
      el.addEventListener("pointermove", () => this.setActive(i));
      el.addEventListener("click", () => this.runIndex(i));
      this.list.appendChild(el);
      this.items.push({ cmd: c, el });
    });
    if (!this.items.length) {
      const empty = document.createElement("div");
      empty.className = "cmdk-empty";
      empty.textContent = "No matching command";
      this.list.appendChild(empty);
    }
  }

  private setActive(i: number) {
    if (i < 0 || i >= this.items.length) return;
    this.items[this.active]?.el.classList.remove("active");
    this.active = i;
    const el = this.items[i].el;
    el.classList.add("active");
    el.scrollIntoView({ block: "nearest" });
  }

  private runIndex(i: number) {
    const item = this.items[i];
    if (!item) return;
    this.close();
    this.run(item.cmd.id);
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      this.setActive(Math.min(this.active + 1, this.items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      this.setActive(Math.max(this.active - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      this.runIndex(this.active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      this.close();
    }
  }
}

// subsequence fuzzy score: every query char must appear in order; contiguous runs
// and start-of-string matches score higher; mild preference for short labels.
function score(q: string, text: string): number {
  if (!q) return 1;
  let ti = 0;
  let s = 0;
  let streak = 0;
  for (const ch of q) {
    const idx = text.indexOf(ch, ti);
    if (idx === -1) return 0;
    s += idx === ti ? 2 + streak : 1;
    streak = idx === ti ? streak + 1 : 0;
    if (idx === 0) s += 3;
    ti = idx + 1;
  }
  return s + Math.max(0, 10 - text.length) * 0.1;
}
