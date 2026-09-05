// A ~90-line element stub, enough to run a real UI component's render() in a
// plain node vitest run and read the result back. Deliberately NOT jsdom: it
// covers the handful of DOM calls our panels actually make (createElement,
// append/appendChild, innerHTML = "", classList, title/textContent/dataset,
// addEventListener, querySelector by TAG, focus, scrollIntoView), so a test can
// assert what the user sees instead of what the source file says.
//
// It lives outside any *.test.ts so both inspectorPanel.test.ts (where it was
// born) and featureEditReachable.test.ts can render against the same stub;
// vitest's include glob is src/**/*.test.ts, so this file is never collected as
// a suite and nothing in the app imports it.
//
// What it does NOT do, stated rather than implied: it parses no markup (the
// innerHTML getter is always ""), and querySelector matches a TAG NAME only —
// no class or attribute selectors. A component that reads its own markup back
// needs jsdom, not this.

/** The element that most recently had focus() called on it, so a test can ask
 *  "did the caret land here" the way a user would notice it. A box rather than
 *  a bare export so importers see the writes. */
export const fakeFocus: { el: FakeEl | null } = { el: null };

export class FakeEl {
  className = "";
  title = "";
  type = "";
  step = "";
  value = "";
  textContent = "";
  draggable = false;
  disabled = false;
  scrollLeft = 0;
  scrollWidth = 0;
  /** Nothing here lays out, so these stay 0 unless a test sets them. A layer
   *  that has to keep a badge fully inside a clip reads them to know how much
   *  of the badge to inset. */
  offsetWidth = 0;
  offsetHeight = 0;
  readonly children: FakeEl[] = [];
  readonly style: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  readonly attrs: Record<string, string> = {};
  private classes = new Set<string>();
  readonly classList = {
    add: (c: string) => this.classes.add(c),
    remove: (c: string) => this.classes.delete(c),
    contains: (c: string) => this.classes.has(c),
    toggle: (c: string, force?: boolean) => {
      const on = force ?? !this.classes.has(c);
      if (on) this.classes.add(c);
      else this.classes.delete(c);
      return on;
    },
  };

  constructor(readonly tagName: string) {}

  // render() clears the panel with `innerHTML = ""` — the stub only has to
  // honour the clear, nothing here parses markup.
  get innerHTML(): string {
    return "";
  }
  set innerHTML(_v: string) {
    this.children.length = 0;
  }

  appendChild(c: FakeEl): FakeEl {
    this.children.push(c);
    return c;
  }
  append(...cs: FakeEl[]) {
    this.children.push(...cs);
  }
  setAttribute(name: string, value: string) {
    this.attrs[name] = value;
  }
  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }
  private handlers: Record<string, ((e?: unknown) => void)[]> = {};
  addEventListener(type: string, fn: (e?: unknown) => void) {
    (this.handlers[type] ??= []).push(fn);
  }
  /** what the user pressing Enter in this input does */
  dispatch(type: string, ev?: unknown) {
    for (const fn of this.handlers[type] ?? []) fn(ev);
  }
  querySelector(sel: string): FakeEl | null {
    for (const c of this.children) {
      if (c.tagName === sel) return c;
      const hit = c.querySelector(sel);
      if (hit) return hit;
    }
    return null;
  }
  focus() {
    fakeFocus.el = this;
  }
  /** <input>.select(). Real inputs have it and the dim box calls it right after
   *  focus(), so a stub without it cannot construct a tool that opens one. */
  select() {}
  scrollIntoView() {}
}

/** Point the global `document` at the stub. Idempotent; call at module scope
 *  before constructing anything that calls document.createElement.
 *
 *  `body` is a real FakeEl rather than a no-op: a component that mounts a
 *  floating layer (DimInput, SketchGlyphs) appends to it in its CONSTRUCTOR, so
 *  without one it cannot be constructed at all — and a test that cannot
 *  construct the thing falls back to asserting source text.
 *
 *  `ids` populates getElementById. Pass the ids a test actually cares about
 *  (`{ "viewport-overlay": host }`) so the component takes its REAL mounting
 *  path instead of the off-page fallback; anything else still resolves to null,
 *  which every caller already handles (setPrompt bails on a missing #prompt). */
export function installFakeDocument(ids: Record<string, FakeEl> = {}): void {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
    body: new FakeEl("body"),
    getElementById: (id: string) => ids[id] ?? null,
  };
}

/** Every descendant (and the root) whose className is exactly `cls`, in
 *  document order. className is used rather than classList because the panels
 *  set the base class as a string and only ever classList.add() modifiers. */
export function byClass(root: FakeEl, cls: string): FakeEl[] {
  const out: FakeEl[] = [];
  const walk = (el: FakeEl) => {
    if (el.className === cls) out.push(el);
    for (const c of el.children) walk(c);
  };
  walk(root);
  return out;
}
