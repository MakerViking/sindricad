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
