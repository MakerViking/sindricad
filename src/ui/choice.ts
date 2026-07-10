// A tiny modal chooser: title + a row of buttons, returns the picked value (or
// null on Esc / backdrop click). Used for small one-shot decisions like the
// Split keep-mode or the Combine boolean operation, where a full dialog/tool
// would be overkill. Resolves once; cleans up its own DOM + listeners.

import { esc } from "./escape";

export interface ChoiceOption<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

// Module-level modal-open counter: true for the lifetime of any open choose()/
// chooseMulti(). main.ts ORs this into toolBusy() so a global shortcut (e.g.
// "e" -> Extrude) can't fire underneath an awaiting modal (Mirror, Split,
// Combine, Revolve, Sweep, Primitive, Pattern, Section axis-pick, ...).
let openModals = 0;
export function isChoiceOpen(): boolean {
  return openModals > 0;
}

export function choose<T extends string>(
  title: string,
  options: ChoiceOption<T>[],
): Promise<T | null> {
  return new Promise((resolve) => {
    openModals++;
    const backdrop = document.createElement("div");
    backdrop.className = "choice-backdrop";

    const card = document.createElement("div");
    card.className = "choice-card";
    const h = document.createElement("div");
    h.className = "choice-title";
    h.textContent = title;
    card.appendChild(h);

    const row = document.createElement("div");
    row.className = "choice-row";
    for (const opt of options) {
      const b = document.createElement("button");
      b.className = "choice-btn";
      b.innerHTML = `<span>${esc(opt.label)}</span>${opt.hint ? `<small>${esc(opt.hint)}</small>` : ""}`;
      b.addEventListener("click", () => done(opt.value));
      row.appendChild(b);
    }
    card.appendChild(row);
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);

    // Keyboard-first: the FIRST option is the caller's default (callers pre-sort
    // it there), so focus it — Enter then commits the default without a mouse.
    // This modal used to be click-only with a silently-cancelling backdrop; a
    // user pressing Enter (dead) and then clicking (backdrop = cancel) got
    // "nothing happened" with no feedback.
    const buttons = [...row.querySelectorAll<HTMLButtonElement>("button")];
    buttons[0]?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        done(null);
        return;
      }
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const n = buttons.length;
        const j = i < 0 ? 0 : (i + (e.key === "ArrowRight" ? 1 : n - 1)) % n;
        buttons[j]?.focus();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopImmediatePropagation();
        const el = document.activeElement as HTMLButtonElement | null;
        (el && buttons.includes(el) ? el : buttons[0])?.click();
        return;
      }
      // this modal owns the keyboard while open: swallow everything else so a
      // global shortcut (e.g. "e" -> Extrude) can't fire underneath it.
      e.preventDefault();
      e.stopPropagation();
    };
    backdrop.addEventListener("pointerdown", (e) => {
      if (e.target === backdrop) done(null);
    });
    window.addEventListener("keydown", onKey, true);

    function done(value: T | null) {
      window.removeEventListener("keydown", onKey, true);
      openModals--;
      backdrop.remove();
      resolve(value);
    }
  });
}

/** A multi-select variant of `choose`: a checkbox list + Combine/Cancel buttons.
 *  Returns the checked values (>= `min`), or null on cancel/Esc. Used where the
 *  data model takes several items (e.g. Combine's tool bodies). */
export function chooseMulti<T extends string>(
  title: string,
  options: ChoiceOption<T>[],
  opts: { min?: number; confirmLabel?: string } = {},
): Promise<T[] | null> {
  const min = opts.min ?? 1;
  return new Promise((resolve) => {
    openModals++;
    const backdrop = document.createElement("div");
    backdrop.className = "choice-backdrop";
    const card = document.createElement("div");
    card.className = "choice-card";
    card.innerHTML = `<div class="choice-title">${esc(title)}</div>`;

    const list = document.createElement("div");
    list.className = "choice-checklist";
    const checks: HTMLInputElement[] = [];
    for (const opt of options) {
      const label = document.createElement("label");
      label.className = "choice-check";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = opt.value;
      checks.push(cb);
      label.appendChild(cb);
          label.insertAdjacentHTML("beforeend", `<span>${esc(opt.label)}</span>${opt.hint ? `<small>${esc(opt.hint)}</small>` : ""}`);
      list.appendChild(label);
    }
    card.appendChild(list);

    const row = document.createElement("div");
    row.className = "choice-row";
    const cancel = document.createElement("button");
    cancel.className = "choice-btn";
    cancel.innerHTML = "<span>Cancel</span>";
    const ok = document.createElement("button");
    ok.className = "choice-btn choice-primary";
    ok.innerHTML = `<span>${esc(opts.confirmLabel ?? "OK")}</span>`;
    row.append(cancel, ok);
    card.appendChild(row);
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);

    const selected = () => checks.filter((c) => c.checked).map((c) => c.value as T);
    const sync = () => (ok.disabled = selected().length < min);
    sync();
    for (const c of checks) c.addEventListener("change", sync);

    // Keyboard-first, mirroring choose(): focus the first control so Enter
    // commits without a mouse (Enter = confirm, same as choose()'s default-click).
    checks[0]?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        done(null);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        if (!ok.disabled) ok.click();
        return;
      }
      // this modal owns the keyboard while open: swallow everything else so a
      // global shortcut (e.g. "e" -> Extrude) can't fire underneath it.
      e.preventDefault();
      e.stopPropagation();
    };
    backdrop.addEventListener("pointerdown", (e) => {
      if (e.target === backdrop) done(null);
    });
    window.addEventListener("keydown", onKey, true);
    cancel.addEventListener("click", () => done(null));
    ok.addEventListener("click", () => done(selected()));

    function done(value: T[] | null) {
      window.removeEventListener("keydown", onKey, true);
      openModals--;
      backdrop.remove();
      resolve(value);
    }
  });
}

/** A read-only modal that lists `items` (e.g. the files an export wrote) with a
 *  single dismiss button. Resolves when closed. */
export function listModal(title: string, items: string[]): Promise<void> {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "choice-backdrop";
    const card = document.createElement("div");
    card.className = "choice-card";
    const rows = items.map((it) => `<li title="${esc(it)}">${esc(it)}</li>`).join("");
    card.innerHTML =
      `<div class="choice-title">${esc(title)}</div>` +
      `<ul class="choice-list">${rows}</ul>` +
      `<div class="choice-row"><button class="choice-btn choice-primary"><span>Done</span></button></div>`;
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter") done();
    };
    backdrop.addEventListener("pointerdown", (e) => {
      if (e.target === backdrop) done();
    });
    card.querySelector("button")!.addEventListener("click", () => done());
    window.addEventListener("keydown", onKey, true);

    function done() {
      window.removeEventListener("keydown", onKey, true);
      backdrop.remove();
      resolve();
    }
  });
}
