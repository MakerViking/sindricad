// A small self-managed status pill for live print progress, shown above the
// toast stack. Kept separate from the geometry status line (main.ts setStatus)
// so printer progress never clobbers build/connection state. Pass null to hide.

let pill: HTMLDivElement | null = null;
let onPillClick: (() => void) | null = null;

export function setPrinterStatusText(text: string | null) {
  if (text == null) {
    pill?.remove();
    pill = null;
    return;
  }
  if (!pill) {
    pill = document.createElement("div");
    pill.className = "print-status-pill";
    if (onPillClick) {
      pill.style.cursor = "pointer";
      pill.title = "Show camera";
      pill.addEventListener("click", () => onPillClick?.());
    }
    document.body.appendChild(pill);
  }
  pill.textContent = text;
}

/** Make the pill clickable (e.g. open the camera panel). The pill is created
 *  lazily, so the handler is registered here and attached on creation. */
export function setPrinterPillClick(fn: () => void) {
  onPillClick = fn;
  if (pill) {
    pill.style.cursor = "pointer";
    pill.title = "Show camera";
    pill.addEventListener("click", () => onPillClick?.());
  }
}
