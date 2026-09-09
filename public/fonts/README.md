# Bundled UI font — Noto Sans JP (subset)

`NotoSansJP-subset.woff2` is the only font SindriCAD ships. It exists so that
Japanese renders correctly on a machine where the user installed nothing: the
rest of the UI stack (`--font-ui` in `src/styles.css`) names Inter and the
platform's own Japanese faces, and none of those is guaranteed to be present.
Windows without the Japanese language pack and a minimal Linux install are the
two that actually fail.

It is loaded from here, never from a CDN. The packaged webview runs under a CSP
whose `connect-src` is localhost only (`font-src 'self' data:`), and a desktop
CAD app has to work with the network off.

## What is in it

| | |
|---|---|
| Family | Noto Sans JP |
| Axis | `wght` 100–900 (variable — one file covers every weight the UI uses) |
| Glyphs | 3135 |
| Size | 692 KiB |
| Coverage | Hiragana, katakana, katakana phonetic extensions, CJK symbols and punctuation, halfwidth/fullwidth forms, and the 2,140 jōyō kanji |

**No Latin, no digits.** That is deliberate, and it is what makes bundling this
safe: `@font-face`'s `unicode-range` in `src/styles.css` matches the coverage
above, so for an English UI the browser never even requests this file and
English rendering cannot change. It is downloaded the first time a Japanese
character is painted.

A character outside the subset (a rare kanji in a name, hanzi, hangul) simply
falls through to the next family in `--font-ui` — the platform's Hiragino Sans /
Yu Gothic UI / Meiryo / Noto Sans CJK JP. That is why the fallback list is still
there and must stay there.

## If this file is missing

The app still works and Japanese still renders, on any machine that has a system
CJK font — the stack degrades to the platform families. What breaks is the
guarantee for a machine with nothing installed: tofu boxes. Do not delete it
without saying so.

## How it was made

Reproducible from two public sources, with `fonttools` (`pip install fonttools
brotli`) — nothing else:

```sh
# 1. upstream variable font (SIL OFL 1.1) and its licence
curl -sSL -o NotoSansJP.ttf \
  'https://raw.githubusercontent.com/google/fonts/main/ofl/notosansjp/NotoSansJP%5Bwght%5D.ttf'
curl -sSL -o OFL.txt \
  'https://raw.githubusercontent.com/google/fonts/main/ofl/notosansjp/OFL.txt'

# 2. the jōyō kanji list, straight from Unicode's Unihan database (kJoyoKanji).
#    A hand-pasted list is how the wrong 2,136 ends up in a build; this is the
#    authoritative one.
curl -sSL -o Unihan.zip 'https://www.unicode.org/Public/UCD/latest/ucd/Unihan.zip'
unzip -q Unihan.zip -d unihan
python3 - <<'PY'
cps = []
for line in open('unihan/Unihan_OtherMappings.txt', encoding='utf-8'):
    if line.startswith('#'): continue
    p = line.rstrip('\n').split('\t')
    if len(p) >= 3 and p[1] == 'kJoyoKanji':
        cps.append(int(p[0][2:], 16))
open('joyo.txt', 'w', encoding='utf-8').write(''.join(chr(c) for c in sorted(set(cps))))
PY

# 3. subset. --name-IDs+=0,7,13,14 keeps the copyright, trademark and licence
#    records inside the font file itself, not only in OFL.txt beside it.
pyftsubset NotoSansJP.ttf \
  --output-file=NotoSansJP-subset.woff2 \
  --flavor=woff2 \
  --text-file=joyo.txt \
  --unicodes="U+3000-303F,U+3041-309F,U+30A0-30FF,U+31F0-31FF,U+FF01-FFEE" \
  --layout-features="ccmp,locl,kern,palt,vert,vrt2,liga,clig,calt,fwid,hwid,pwid" \
  --name-IDs+=0,7,13,14 \
  --no-hinting --notdef-outline
```

Built against Unihan 2025-07-24. `fonttools` output is not byte-reproducible
across versions, so the subset is committed rather than generated at build time
— and so that a clone with no network still builds.

## When `locales/ja.json` lands

Re-run step 3 with the translation's own characters added, so nothing in the UI
can fall out of the subset:

```sh
python3 -c "import json,sys; sys.stdout.write(''.join(sorted(set(json.dumps(json.load(open('locales/ja.json')), ensure_ascii=False)))))" >> joyo.txt
```

Then check the result covers every character in the catalogue before committing:

```sh
python3 - <<'PY'
import json
from fontTools.ttLib import TTFont
cmap = TTFont('NotoSansJP-subset.woff2').getBestCmap()
text = json.dumps(json.load(open('locales/ja.json')), ensure_ascii=False)
missing = {c for c in text if ord(c) > 0x2FFF and ord(c) not in cmap}
print('missing from the subset:', ''.join(sorted(missing)) or 'none')
PY
```

`missing` being non-empty is not fatal — those characters fall through to the
system font — but each one is a glyph that will look different from its
neighbours, so fix it rather than shipping it.

## Licence

SIL Open Font License 1.1 — see `OFL.txt`, which ships next to the font because
the OFL requires it to. AGPL-compatible: the OFL places no restriction on the
software the font is bundled with. Copyright 2014–2021 Adobe, Reserved Font Name
'Source'. Subsetting is a permitted modification and does not use the reserved
name.

Upstream `NotoSansJP[wght].ttf` sha256:

    c2f3b4d463500a2ddcd3849cded1fceeb9fd6d1c32e6cbecd568453ba50fc68f

This subset sha256:

    66c70da6e7813ffe24caf9a9c4fc54006a9ca412295165ee99b769116fa1bd3b
