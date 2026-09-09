# Translating SindriCAD

Every string a user sees lives in `en.json`; a translation is a copy of that
file in another language. A partial translation is fine to ship: anything
missing falls back to English at runtime.

## Add a language in five steps

1. Copy `en.json` to `<code>.json`, where `<code>` is the BCP 47 tag
   (`ja`, `de`, `pt-BR`).
2. Translate the values. Keep the keys, keep `{placeholders}` exactly as they
   are, and keep `one`/`other` (and any other plural category your language
   needs: `zero`, `two`, `few`, `many`). Leave product and format names alone:
   SindriCAD, TinkerAtlas, STEP, STL, 3MF, mm.
3. Register it in ONE place, `src/i18n/registry.ts`: import the file and add a
   line to `LOCALES` with the language's native name.
4. Run `npm run i18n:check`. A key that is not in `en.json` fails; keys you
   have not translated yet only warn.
5. Open a pull request. Add yourself to `CREDITS.md` under your language; the
   About dialog reads that file.

To see the result: Edit → Settings… → Language, then restart.

## Testing a translation without translating

Settings → Language → "Pseudo-locale (layout test)" wraps every string in
brackets and lengthens it by a third. Text WITHOUT brackets is hardcoded and
should be reported; text that clips is a layout bug. Both are worth a bug
report with the "translation" category, which records the string's key.

## Rules the checks enforce

- `npm run i18n:check`: no keys outside `en.json`, placeholders match English.
- `npm run i18n:lint`: no English prose in the code outside `t()`.
- Conventions for developers are in `docs/I18N.md`.
