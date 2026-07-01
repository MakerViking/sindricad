// A tiny modal chooser: title + a row of buttons, returns the picked value (or
// null on Esc / backdrop click). Used for small one-shot decisions like the
// Split keep-mode or the Combine boolean operation, where a full dialog/tool
// would be overkill. Resolves once; cleans up its own DOM + listeners.

export interface ChoiceOption<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

export function choose<T extends string>(
  title: string,
  options: ChoiceOption<T>[],
): Promise<T | null> {
  return new Promise((resolve) => {
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
      b.innerHTML = `<span>${opt.label}</span>${opt.hint ? `<small>${opt.hint}</small>` : ""}`;
      b.addEventListener("click", () => done(opt.value));
      row.appendChild(b);
    }
    card.appendChild(row);
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") done(null);
    };
    backdrop.addEventListener("pointerdown", (e) => {
      if (e.target === backdrop) done(null);
    });
    window.addEventListener("keydown", onKey, true);

    function done(value: T | null) {
      window.removeEventListener("keydown", onKey, true);
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
    const backdrop = document.createElement("div");
    backdrop.className = "choice-backdrop";
    const card = document.createElement("div");
    card.className = "choice-card";
    card.innerHTML = `<div class="choice-title">${title}</div>`;

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
      label.insertAdjacentHTML("beforeend", `<span>${opt.label}</span>${opt.hint ? `<small>${opt.hint}</small>` : ""}`);
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
    ok.innerHTML = `<span>${opts.confirmLabel ?? "OK"}</span>`;
    row.append(cancel, ok);
    card.appendChild(row);
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);

    const selected = () => checks.filter((c) => c.checked).map((c) => c.value as T);
    const sync = () => (ok.disabled = selected().length < min);
    sync();
    for (const c of checks) c.addEventListener("change", sync);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") done(null);
    };
    backdrop.addEventListener("pointerdown", (e) => {
      if (e.target === backdrop) done(null);
    });
    window.addEventListener("keydown", onKey, true);
    cancel.addEventListener("click", () => done(null));
    ok.addEventListener("click", () => done(selected()));

    function done(value: T[] | null) {
      window.removeEventListener("keydown", onKey, true);
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
    const rows = items.map((it) => `<li title="${it}">${it}</li>`).join("");
    card.innerHTML =
      `<div class="choice-title">${title}</div>` +
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
