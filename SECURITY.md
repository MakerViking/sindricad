# Security Policy

## Reporting a vulnerability

Please use GitHub's private reporting: the **Report a vulnerability** button under the repository's [Security tab](https://github.com/MakerViking/sindricad/security/advisories/new). Do not open a public issue for anything security-sensitive.

SindriCAD is a solo project. I read every report, and I aim to acknowledge within a few days. If a report is valid, the fix ships in the next rolling beta and the advisory is credited to you (unless you prefer otherwise).

## Supported versions

SindriCAD ships as a rolling `beta` release with an in-app updater. Only the **latest beta** is supported; older installers are not patched.

## Scope

In scope:

- the desktop app: Tauri shell (Rust), webview frontend (TypeScript), bundled Python geometry sidecar
- the localhost sidecar WebSocket (token-gated, bound to 127.0.0.1)
- the signed update pipeline (`beta` release artifacts and `latest.json`)
- document parsing: `.sindri` files and imported STL/3MF/STEP/OBJ
- the app's network calls to tinkeratlas.com (account, publish, bug reports) and to printers you configure on your own LAN

Issues in the tinkeratlas.com website itself can go through the same private channel; they reach the same person.

Out of scope: vulnerabilities that require an already-compromised machine, and reports from automated scanners without a plausible impact.
