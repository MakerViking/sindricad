// Localisation. A small t() over nested JSON catalogues; no library, because the
// UI is vanilla DOM and the whole need is lookup, named parameters, plurals and
// an English fallback. See docs/I18N.md for the conventions every call site
// follows and locales/README.md for how a translation is added.
//
// Rules this module enforces, in order of how often they matter:
//   - A missing key falls back to English, then to the key itself. It never
//     yields an empty string, so a label can never be blank.
//   - In development a missing key is warned about ONCE, not on every render.
//   - Plurals come from Intl.PluralRules for the active locale, never from a
//     ternary at the call site.
//   - Every string t() produced is remembered (bounded) with its key and
//     parameters, so the bug reporter can log the English text and the key
//     instead of the translation. Support stays searchable that way.

import { pseudoize } from "./pseudo";
import { DEFAULT_LOCALE, LOCALES, asLocale, type Catalogue, type LocaleCode, type PluralForms } from "./registry";

export type { LocaleCode } from "./registry";
export { LOCALES, asLocale } from "./registry";

export type Params = Record<string, string | number>;

const STORAGE_KEY = "sindricad.locale";

type Flat = Map<string, string | PluralForms>;

/** CLDR plural categories, and the whole test for "is this entry a plural set".
 *
 *  The obvious test — "it has a string `other`" — is WRONG, and quietly: a
 *  perfectly ordinary group of keys that happens to contain one named `other`
 *  (bug.category.other, "Something else") is then read as a plural set, and
 *  every sibling key under it disappears from the catalogue. Requiring EVERY
 *  member to be a plural category cannot collide with a group of real keys
 *  unless that group is itself named only after plural categories. */
const PLURAL_KEYS: ReadonlySet<string> = new Set(["zero", "one", "two", "few", "many", "other"]);

function isPluralEntry(v: unknown): v is PluralForms {
  if (!v || typeof v !== "object") return false;
  const e = Object.entries(v as Record<string, unknown>);
  return (
    e.length > 0 &&
    e.every(([k, val]) => PLURAL_KEYS.has(k) && typeof val === "string") &&
    typeof (v as PluralForms).other === "string"
  );
}

function flatten(cat: Catalogue, prefix: string, into: Flat): Flat {
  for (const [k, v] of Object.entries(cat)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") into.set(key, v);
    else if (isPluralEntry(v)) into.set(key, v);
    else if (v && typeof v === "object") flatten(v as Catalogue, key, into);
  }
  return into;
}

const english: Flat = flatten(LOCALES.en.data, "", new Map());

function pseudoFlat(): Flat {
  const out: Flat = new Map();
  for (const [k, v] of english) {
    if (typeof v === "string") out.set(k, pseudoize(v));
    else {
      const forms = { other: pseudoize(v.other) } as PluralForms;
      for (const f of ["zero", "one", "two", "few", "many"] as const) if (v[f] !== undefined) forms[f] = pseudoize(v[f]);
      out.set(k, forms);
    }
  }
  return out;
}

function catalogueFor(code: LocaleCode): Flat {
  if (code === "en") return english;
  const def = LOCALES[code];
  return def.data ? flatten(def.data, "", new Map()) : pseudoFlat();
}

// --- active locale -----------------------------------------------------------

let current: LocaleCode = readStored() ?? detectLocale();
let active: Flat = catalogueFor(current);
let rules = new Intl.PluralRules(LOCALES[current].tag);
const listeners = new Set<(code: LocaleCode) => void>();

function readStored(): LocaleCode | null {
  try {
    return typeof localStorage !== "undefined" ? asLocale(localStorage.getItem(STORAGE_KEY)) : null;
  } catch {
    return null;
  }
}

/** The OS/webview language, narrowed to a registered locale, else English.
 *  `navigator.language` is what every Tauri webview exposes on all three
 *  platforms (WebKitGTK, WebView2, WKWebView) and it follows the OS setting;
 *  the pseudo-locale is never auto-detected. Exported for tests. */
export function detectLocale(lang: string | undefined = typeof navigator !== "undefined" ? navigator.language : undefined): LocaleCode {
  if (!lang) return DEFAULT_LOCALE;
  const base = lang.toLowerCase().split(/[-_]/)[0] ?? "";
  const hit = asLocale(lang) ?? asLocale(base);
  return hit && hit !== "qps-ploc" ? hit : DEFAULT_LOCALE;
}

export function getLocale(): LocaleCode {
  return current;
}

/** True when the user has chosen a language explicitly (so the picker can show
 *  "system default" otherwise). */
export function hasStoredLocale(): boolean {
  return readStored() !== null;
}

/** Switch and persist. Listeners run so `<html lang>` and any live component
 *  can follow; the DOM built before the switch keeps its old text, which is why
 *  the picker offers a restart (see ui/languageSettings.ts). */
export function setLocale(code: LocaleCode): void {
  if (code === current) return;
  current = code;
  active = catalogueFor(code);
  rules = new Intl.PluralRules(LOCALES[code].tag);
  try {
    localStorage.setItem(STORAGE_KEY, code);
  } catch {
    /* ignore — a private-mode webview still gets the session */
  }
  for (const fn of listeners) fn(code);
}

/** Forget the explicit choice and follow the OS again. */
export function clearStoredLocale(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  setLocale(detectLocale());
}

export function onLocaleChange(fn: (code: LocaleCode) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The BCP 47 tag for Intl.NumberFormat / DateTimeFormat under the active locale. */
export function localeTag(): string {
  return LOCALES[current].tag;
}

// --- lookup ------------------------------------------------------------------

const warned = new Set<string>();
let reportMissing: (key: string, where: "locale" | "english") => void = (key, where) => {
  if (import.meta.env?.DEV && typeof console !== "undefined") {
    console.warn(where === "english" ? `[i18n] no English text for key "${key}"` : `[i18n] "${key}" missing in ${current}, using English`);
  }
};

/** Tests swap the reporter in; production keeps the console warning. */
export function setMissingKeyReporter(fn: typeof reportMissing): void {
  reportMissing = fn;
}

function warnOnce(key: string, where: "locale" | "english") {
  const tag = `${where}:${current}:${key}`;
  if (warned.has(tag)) return;
  warned.add(tag);
  reportMissing(key, where);
}

function pick(forms: PluralForms, count: number): string {
  if (count === 0 && forms.zero !== undefined) return forms.zero;
  const cat = rules.select(count);
  return forms[cat] ?? forms.other;
}

function interpolate(text: string, params: Params | undefined, key: string): string {
  // Runs even with no params: a placeholder left unfilled is a call-site bug
  // worth one warning, and it stays visible in the UI rather than vanishing.
  return text.replace(/\{(\w+)\}/g, (m, name: string) => {
    const v = params?.[name];
    if (v === undefined) {
      warnOnce(`${key}#${name}`, "english");
      return m;
    }
    return String(v);
  });
}

/** Bounded memory of what t() produced, newest last, for the bug reporter. */
const produced = new Map<string, { key: string; params: Params | undefined }>();
const PRODUCED_MAX = 400;

function remember(text: string, key: string, params: Params | undefined) {
  if (produced.has(text)) produced.delete(text);
  produced.set(text, { key, params });
  if (produced.size > PRODUCED_MAX) produced.delete(produced.keys().next().value as string);
}

function lookup(flat: Flat, key: string, params: Params | undefined): string | undefined {
  const entry = flat.get(key);
  if (entry === undefined) return undefined;
  if (typeof entry === "string") return interpolate(entry, params, key);
  const n = params?.count;
  if (typeof n !== "number") warnOnce(`${key}#count`, "english");
  return interpolate(pick(entry, typeof n === "number" ? n : 1), params, key);
}

/** The translated string for `key` under the active locale.
 *
 *  `params` fills `{name}` placeholders; a `count` param selects the plural
 *  form when the entry is a plural object. Falls back to English, then to the
 *  key itself, so the result is never empty. */
export function t(key: string, params?: Params): string {
  let text = lookup(active, key, params);
  if (text === undefined) {
    if (current !== "en") warnOnce(key, "locale");
    text = lookup(english, key, params);
  }
  if (text === undefined) {
    warnOnce(key, "english");
    text = key;
  }
  remember(text, key, params);
  return text;
}

/** The ENGLISH text for a key, regardless of the active locale. For log lines,
 *  breadcrumbs and anything else support has to grep. */
export function tEn(key: string, params?: Params): string {
  return lookup(english, key, params) ?? key;
}

/** True when `key` exists in English. For code→message maps that must know
 *  whether a code has a translation before they replace a message with it. */
export function hasKey(key: string): boolean {
  return english.has(key);
}

/** For a string t() produced recently: its key and English rendering, so a
 *  breadcrumb or a translation report can name the string instead of quoting
 *  the translation. Undefined for text that never went through t(). */
export function sourceOf(text: string): { key: string; english: string } | undefined {
  const hit = produced.get(text);
  return hit ? { key: hit.key, english: tEn(hit.key, hit.params) } : undefined;
}

// --- DOM helpers -------------------------------------------------------------

/** Stamp the key onto the element, when the element has a dataset to stamp.
 *
 *  The marker is a DIAGNOSTIC — it is what the bug reporter's translation
 *  category reads — so it must never be able to break a label. Several suites
 *  render real components against a small element stub that has no `dataset`
 *  (ui/fakeDom.testkit.ts and the per-suite stubs in the feature tools), and an
 *  unguarded write there throws from inside a tooltip update. */
function mark(el: Element, attr: "i18n" | "i18nTitle", key: string): void {
  const ds = (el as Partial<HTMLElement>).dataset;
  if (ds) ds[attr] = key;
}

/** Set an element's text from a key and tag it with `data-i18n` so the bug
 *  reporter can tell which string the user was looking at. Prefer this over
 *  `el.textContent = t(...)` wherever the element is at hand. */
export function setText(el: Element, key: string, params?: Params): void {
  el.textContent = t(key, params);
  mark(el, "i18n", key);
}

/** Same for a tooltip. */
export function setTitle(el: HTMLElement, key: string, params?: Params): void {
  el.title = t(key, params);
  mark(el, "i18nTitle", key);
}

let hovered: string | null = null;

/** Start tracking which translated element the pointer was last over. One
 *  listener, installed once from main.ts; `hoveredKey()` is what the bug
 *  reporter's "translation issue" category pre-fills. */
export function trackHoveredKey(root: Document = document): void {
  root.addEventListener(
    "pointerover",
    (e) => {
      const el = (e.target as Element | null)?.closest?.("[data-i18n],[data-i18n-title]") as HTMLElement | null;
      if (el) hovered = el.dataset.i18n ?? el.dataset.i18nTitle ?? null;
    },
    { passive: true },
  );
}

export function hoveredKey(): string | null {
  return hovered;
}

/** Apply the active locale to the document root so CSS `:lang()` and the
 *  webview's font fallback see it. Called at boot and on every switch. */
export function applyDocumentLang(doc: Document = document): void {
  doc.documentElement.lang = localeTag();
}

/** Translate the chrome that index.html ships as static markup (title-bar
 *  buttons, view controls, the units label). One pass at boot; main.ts owns
 *  the same elements' dynamic states through the same `chrome.*` keys. */
export function localizeStaticChrome(doc: Document = document): void {
  const byId = (id: string) => doc.getElementById(id) as HTMLElement | null;
  const titled = (el: HTMLElement | null, key: string, aria = false) => {
    if (!el) return;
    setTitle(el, key);
    if (aria) el.setAttribute("aria-label", t(key));
  };
  titled(byId("undo-btn"), "chrome.undoTitle");
  byId("undo-btn")?.setAttribute("aria-label", t("chrome.undo"));
  titled(byId("redo-btn"), "chrome.redoTitle");
  byId("redo-btn")?.setAttribute("aria-label", t("chrome.redo"));
  const ctx = byId("context-tab");
  if (ctx) setText(ctx, "chrome.context.solid");
  const status = byId("status");
  if (status) setText(status, "chrome.status.connecting");
  const fps = byId("fps");
  if (fps) setText(fps, "chrome.fps.idle");
  const units = doc.querySelector("label.units") as HTMLElement | null;
  if (units) {
    setTitle(units, "chrome.units.title");
    const text = Array.from(units.childNodes).find((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim());
    if (text) text.textContent = t("chrome.units.label") + " ";
    units.dataset.i18n = "chrome.units.label";
  }
  for (const v of ["iso", "top", "front", "right"] as const) {
    const b = doc.querySelector(`#viewcontrols [data-view="${v}"]`) as HTMLElement | null;
    if (!b) continue;
    setText(b, `chrome.view.${v}`);
    setTitle(b, `chrome.view.${v}Title`);
  }
  const fit = byId("fit");
  if (fit) {
    setText(fit, "chrome.fit");
    setTitle(fit, "chrome.fitTitle");
  }
  const proj = byId("proj");
  if (proj) {
    setText(proj, "chrome.proj.auto");
    setTitle(proj, "chrome.proj.title");
  }
  const sel = byId("selmode");
  if (sel) {
    setText(sel, "chrome.selmode.faces");
    setTitle(sel, "chrome.selmode.title");
  }
}
