// Frame-rate readout in the viewport's bottom-right corner.
//
// The viewport renders ON DEMAND (see Viewport.loop): when the camera is still
// and nothing is dirty, no frame is drawn at all. A naive counter would then sit
// at "0 fps" on a perfectly healthy idle app, so this reports `idle` instead —
// which also makes the render-on-demand behaviour visible rather than looking
// like a stall.
//
// The number that actually matters when something feels slow is the frame TIME,
// not the rate: a rate is capped by the display's refresh, so it reads 60 right
// up until it falls off a cliff, while the millisecond figure degrades smoothly
// and is directly comparable to a budget (16.7ms at 60Hz).

/** Frames older than this are dropped from the rolling window. */
const WINDOW_MS = 1000;
/** No rendered frame for this long = the app is idle, not slow. */
const IDLE_AFTER_MS = 400;
/** DOM writes per second. The readout only has to be readable, not live. */
const REFRESH_MS = 250;

export class FpsMeter {
  private stamps: number[] = [];
  private el: HTMLElement | null;
  private timer = 0;

  constructor(host: HTMLElement | null = document.getElementById("fps")) {
    this.el = host;
    if (this.el) this.timer = window.setInterval(() => this.paint(), REFRESH_MS);
  }

  /** Call once per ACTUALLY RENDERED frame (not once per rAF tick — the loop
   *  skips the draw when nothing changed, and counting skipped ticks would
   *  report a steady 60 no matter how slow the real frames were). */
  frame(now = performance.now()) {
    this.stamps.push(now);
    // bounded by refresh rate * WINDOW_MS, so a plain shift-while is fine
    while (this.stamps.length && now - this.stamps[0]! > WINDOW_MS) this.stamps.shift();
  }

  private paint() {
    if (!this.el) return;
    const gpu = (window as { __gpu?: string }).__gpu;
    const gpuLine = gpu ? `\nGPU: ${gpu}` : "";
    const now = performance.now();
    const last = this.stamps[this.stamps.length - 1];
    if (last === undefined || now - last > IDLE_AFTER_MS) {
      this.el.textContent = "idle";
      this.el.title = "The viewport only draws when something changes — nothing to render right now." + gpuLine;
      return;
    }
    // Rate over the window, and the mean interval between the frames in it.
    // Both come from the same samples, so they can't disagree.
    const first = this.stamps[0]!;
    const span = last - first;
    const n = this.stamps.length;
    if (n < 2 || span <= 0) return; // too few samples this tick; keep the last text
    const fps = ((n - 1) / span) * 1000;
    const ms = span / (n - 1);
    this.el.textContent = `${Math.round(fps)} fps · ${ms.toFixed(1)} ms`;
    this.el.title = `${n} frames drawn in the last ${Math.round(span)}ms. `
      + "The viewport renders on demand, so this only counts frames that were actually drawn."
      + gpuLine;
  }

  /** Most recent mean frame time in ms, or null when idle. Read by the bug
   *  reporter so a performance complaint carries the number with it. */
  lastFrameMs(): number | null {
    const now = performance.now();
    const last = this.stamps[this.stamps.length - 1];
    if (last === undefined || now - last > IDLE_AFTER_MS) return null;
    const n = this.stamps.length;
    if (n < 2) return null;
    return (last - this.stamps[0]!) / (n - 1);
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.timer = 0;
  }
}
