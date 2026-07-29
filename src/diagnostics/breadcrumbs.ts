// Diagnostic breadcrumbs: a tiny ring buffer of recent noteworthy events for
// the bug reporter. Fed automatically from window error events and from every
// toast (toast.ts calls crumb() — toasts already are the app's "something
// happened the user should know" channel, which makes them exactly the trail a
// bug triager wants). Never persisted; read once when a report is assembled.

const MAX = 20;
const buf: string[] = [];

// Sticky facts sit OUTSIDE the ring. A one-off captured at startup — the HID
// inventory is the case this exists for — would otherwise be evicted by twenty
// ordinary toasts, i.e. by the user doing anything at all before opening the bug
// reporter. Which is precisely when they'd open it.
//
// CONTRACT with src-tauri/src/tinkeratlas.rs: a sticky fact carries NO "HH:MM:SS "
// prefix, and an ordinary crumb always does. Rust uses that timestamp to tell them
// apart when it trims the report, keeping every sticky fact and only the last 20
// ordinary ones. Do not add a timestamp here — it would make these droppable again.
const STICKY_MAX = 24;
const sticky: string[] = [];

export function stickyFact(message: string) {
  if (sticky.length >= STICKY_MAX) return;
  sticky.push(message.slice(0, 300));
}

export function crumb(message: string) {
  const ts = new Date().toISOString().slice(11, 19); // HH:MM:SS
  buf.push(`${ts} ${message}`.slice(0, 300));
  if (buf.length > MAX) buf.shift();
}

export function breadcrumbs(): string[] {
  return [...sticky, ...buf];
}

// Self-installing listeners (imported once from main.ts). Guarded so the module
// stays importable without a DOM — the rest of this codebase keeps its logic
// DOM-free for exactly this reason, and there is no jsdom in the test setup.
if (typeof window !== "undefined") {
  window.addEventListener("error", (e) => {
    crumb(`[error] ${e.message} (${e.filename ?? "?"}:${e.lineno ?? "?"})`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    crumb(`[unhandledrejection] ${r instanceof Error ? r.message : String(r)}`);
  });
}
