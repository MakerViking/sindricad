# Contributing to SindriCAD

Thanks for your interest in SindriCAD! A few ground rules keep the project healthy
and its licensing clean.

## License of your contributions

SindriCAD is released under **AGPL-3.0-only** (see [`LICENSE`](LICENSE)). By
submitting a contribution (a pull request, patch, or any code or content), you
agree that:

1. Your contribution is licensed to the project and its users under
   **AGPL-3.0-only**; and
2. You grant the project maintainer (the copyright holder) a perpetual,
   irrevocable, worldwide, royalty-free right to **relicense your contribution
   under other terms**, including a commercial license.

This dual-licensing grant is what lets SindriCAD stay fully open-source under the
AGPL while the maintainer can also offer a commercial license to organizations that
can't use AGPL software, the revenue that keeps the project maintained. It's the
same inbound-relicensable model used by projects like GitLab and Qt.

You confirm you have the right to grant this (the work is yours, or your employer
has authorized it).

> This is a lightweight contributor agreement, not legal advice; a formal
> CLA/DCO document may replace this note later.

## Development

See the **Dev quickstart** in [`README.md`](README.md). Before opening a PR:

- `npm run build` (TypeScript + Vite) must pass.
- From `sidecar/`, `uv run python test_smoke.py` (geometry) and `uv run python
  test_ws.py` (transport) must pass.
- Keep geometry in the Python sidecar; the frontend owns the document and viewport.
- Reference geometry by **queryable selectors** (axis / normal / nearest-point),
  never by topology index, so references survive edits that renumber topology.

### Running a second stack beside the first

`npm run tauri:alt` puts vite on 5174 and the sidecar on 8766, so a second copy
can run while the first is up. It sets everything inside this repo that is keyed
to the port, including `SINDRI_EXTRA_ORIGINS` for the sidecar's own origin check.

One thing it cannot set: the TinkerAtlas server sends
`Content-Security-Policy: frame-ancestors ... http://localhost:5173`, so on 5174
the browser refuses to render the welcome screen's remote pane and it appears as
a **blank white rectangle**. Nothing is broken, and the app cannot detect it
either: a cross-origin iframe never reports a load failure, and the native
reachability ping still succeeds because `frame-ancestors` does not apply to it.
Sign-in and everything else work normally.

The general shape is worth remembering when adding anything port-dependent: a
coupling that lives OUTSIDE this repo (a CSP allowlist, a CORS origin, an OAuth
redirect registration) cannot be fixed by an alt-port script, so either register
the alt port there too or write down which feature goes dead.
