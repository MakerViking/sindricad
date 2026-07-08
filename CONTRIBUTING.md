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
