// The one place a locale is registered. Adding a language is: drop
// locales/<code>.json in, add one line here, run `npm run i18n:check`.
// English is the source of truth (locales/en.json) and the runtime fallback for
// every other locale, so a partial translation is fine to ship.

import en from "../../locales/en.json";

/** A nested catalogue as it sits in a locales/*.json file. A leaf is either a
 *  string or a plural-forms object keyed by CLDR category (`other` required). */
export type Catalogue = { [key: string]: string | Catalogue | PluralForms };
export type PluralForms = { zero?: string; one?: string; two?: string; few?: string; many?: string; other: string };

export interface LocaleDef {
  /** Native name, shown in the language picker exactly as written here. */
  name: string;
  /** BCP 47 tag handed to Intl.* — differs from the code only for the pseudo-locale. */
  tag: string;
  /** The catalogue, or `null` for a locale generated at runtime (the pseudo-locale). */
  data: Catalogue | null;
}

export const LOCALES = {
  en: { name: "English", tag: "en", data: en as Catalogue },
  // Generated from English at load time (see pseudo.ts). Listed last in the
  // picker and labelled as a test, because it is one.
  // i18n-ignore a locale's own name is never translated
  "qps-ploc": { name: "Pseudo-locale (layout test)", tag: "en", data: null },
} satisfies Record<string, LocaleDef>;

export type LocaleCode = keyof typeof LOCALES;

export const DEFAULT_LOCALE: LocaleCode = "en";

/** Narrow an untrusted string — a <select> value, a stored setting — to a
 *  registered locale code, or null. Same rule as units.ts: never cast. */
export function asLocale(v: unknown): LocaleCode | null {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(LOCALES, v) ? (v as LocaleCode) : null;
}
