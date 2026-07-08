// A small self-managed status pill for live print progress, shown above the
// toast stack. Kept separate from the geometry status line (main.ts setStatus)
// so printer progress never clobbers build/connection state. Pass null to hide.

let pill: HTMLDivElement | null = null;

export function setPrinterStatusText(text: string | null) {
  if (text == null) {
    pill?.remove();
    pill = null;
    return;
  }
  if (!pill) {
    pill = document.createElement("div");
    pill.className = "print-status-pill";
    document.body.appendChild(pill);
  }
  pill.textContent = text;
}
