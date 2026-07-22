// Lightweight toast notifications — a bottom-center stack above the timeline.
// The one job: make sure nothing important can happen SILENTLY. A committed
// feature that fails in the rebuild used to show only a small status line while
// the model stayed visually unchanged — indistinguishable from "nothing
// happened". Errors persist longer and carry an optional action button
// ("Show" → select the failing feature).

export interface ToastOptions {
  kind?: "error" | "warning" | "info";
  action?: { label: string; onClick: () => void };
  timeout?: number; // ms; errors default longer
}

let stack: HTMLDivElement | null = null;

function ensureStack(): HTMLDivElement {
  if (!stack) {
    stack = document.createElement("div");
    stack.className = "toast-stack";
    document.body.appendChild(stack);
  }
  return stack;
}

export function toast(message: string, opts: ToastOptions = {}) {
  const host = ensureStack();
  const kind = opts.kind ?? "info";
  // keep the stack short — oldest goes first
  while (host.children.length >= 3) host.firstElementChild?.remove();

  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  const msg = document.createElement("span");
  msg.className = "toast-msg";
  msg.textContent = message;
  el.appendChild(msg);

  let timer = 0;
  const dismiss = () => {
    window.clearTimeout(timer);
    el.classList.add("toast-out");
    window.setTimeout(() => el.remove(), 180);
  };

  if (opts.action) {
    const btn = document.createElement("button");
    btn.className = "toast-action";
    btn.textContent = opts.action.label;
    btn.addEventListener("click", () => {
      opts.action!.onClick();
      dismiss();
    });
    el.appendChild(btn);
  }
  const close = document.createElement("button");
  close.className = "toast-close";
  close.textContent = "✕";
  close.addEventListener("click", dismiss);
  el.appendChild(close);

  host.appendChild(el);
  timer = window.setTimeout(dismiss, opts.timeout ?? (kind === "error" ? 8000 : kind === "warning" ? 6000 : 3500));
}
