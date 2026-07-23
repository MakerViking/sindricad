// Diagnostic breadcrumbs: a tiny ring buffer of recent noteworthy events for
// the bug reporter. Fed automatically from window error events and from every
// toast (toast.ts calls crumb() — toasts already are the app's "something
// happened the user should know" channel, which makes them exactly the trail a
// bug triager wants). Never persisted; read once when a report is assembled.

const MAX = 20;
const buf: string[] = [];

export function crumb(message: string) {
  const ts = new Date().toISOString().slice(11, 19); // HH:MM:SS
  buf.push(`${ts} ${message}`.slice(0, 300));
  if (buf.length > MAX) buf.shift();
}

export function breadcrumbs(): string[] {
  return [...buf];
}

// self-installing listeners (imported once from main.ts)
window.addEventListener("error", (e) => {
  crumb(`[error] ${e.message} (${e.filename ?? "?"}:${e.lineno ?? "?"})`);
});
window.addEventListener("unhandledrejection", (e) => {
  const r = e.reason;
  crumb(`[unhandledrejection] ${r instanceof Error ? r.message : String(r)}`);
});
