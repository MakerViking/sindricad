// Publish the current design to TinkerAtlas as a 3D model (+ feed post when
// public). Pipeline: metadata form → sidecar exports into the Rust-owned
// staging dir (app_data/publish/) → viewport screenshot as the cover →
// Rust uploads everything to /api/desktop/publish with the desktop token.

import type { DocumentStore } from "../document/store";
import type { GeometryBackend } from "../geometry/client";
import type { Viewport } from "../viewport/viewport";
import { pushModal, popModal, choose, listModal } from "../ui/choice";
import { esc } from "../ui/escape";
import { toast } from "../ui/toast";
import { openExternal } from "../ui/welcome";
import { openSignInDialog } from "./account";
import { currentAccount, taStagingPath, taPublish, asTaError } from "./client";

const isTauri = () => "__TAURI_INTERNALS__" in window;

interface PublishMeta {
  title: string;
  description: string;
  publish: boolean;
}

export async function publishToTinkerAtlas(
  store: DocumentStore,
  geometry: GeometryBackend,
  viewport: Viewport,
): Promise<void> {
  if (!isTauri()) {
    toast("Publishing needs the native app", { kind: "error" });
    return;
  }
  const bodies = store.buildState.result?.bodies ?? [];
  if (!bodies.length) {
    toast("Nothing to publish yet — build a body first", { kind: "error" });
    return;
  }
  // publish requires an account; sign-in stays optional everywhere else.
  if (!currentAccount() && !(await openSignInDialog())) return;

  const fmt = await choose<"3mf" | "stl">("Publish — model format?", [
    { value: "3mf", label: "3MF", hint: "recommended" },
    { value: "stl", label: "STL" },
  ]);
  if (!fmt) return;

  const defaultTitle = store.fileName.replace(/\.sindri$/i, "") || "Untitled design";
  const meta = await publishForm(defaultTitle);
  if (!meta) return;

  toast("Publishing to TinkerAtlas…", { kind: "info" });
  try {
    const path = await taStagingPath(defaultTitle, fmt);
    const res = await geometry.export(store.document, fmt, path, {});
    if (!res.ok) {
      toast(`Export failed: ${res.message ?? "unknown error"}`, { kind: "error" });
      return;
    }
    if (res.warnings?.length) {
      // export-what-built: failed features are missing from the upload — say so
      // BEFORE it goes public, so the user can back out.
      const lines = res.warnings.map(
        (w) => `⚠ ${w.feature_id ?? "feature"} failed — its result is NOT in the upload: ${w.message}`,
      );
      await listModal("Publishing with warnings", lines);
    }

    const cover = viewport.screenshotPNG().replace(/^data:image\/png;base64,/, "");
    const { url } = await taPublish({
      title: meta.title,
      description: meta.description,
      publish: meta.publish,
      modelPath: res.path ?? path,
      coverPngBase64: cover,
    });
    toast(meta.publish ? "Published to TinkerAtlas" : "Saved to TinkerAtlas as a draft", {
      kind: "info",
      timeout: 10000,
      action: { label: "View on TinkerAtlas", onClick: () => void openExternal(url) },
    });
  } catch (e) {
    const ta = asTaError(e);
    if (ta?.code === "Unauthorized") {
      toast("TinkerAtlas sign-in expired or was revoked", {
        kind: "error",
        action: { label: "Sign in…", onClick: () => void openSignInDialog() },
      });
    } else if (ta?.code === "Unreachable") {
      toast("Can't reach TinkerAtlas — check your connection", { kind: "error" });
    } else {
      toast(`Publish failed: ${ta?.message ?? String(e)}`, { kind: "error" });
    }
  }
}

function publishForm(defaultTitle: string): Promise<PublishMeta | null> {
  return new Promise((resolve) => {
    pushModal();
    const backdrop = document.createElement("div");
    backdrop.className = "choice-backdrop";
    const card = document.createElement("div");
    card.className = "choice-card ta-publish";
    card.innerHTML = `<div class="choice-title">Publish to TinkerAtlas</div>`;

    const title = document.createElement("input");
    title.className = "ta-signin-input";
    title.maxLength = 200;
    title.value = defaultTitle;
    title.placeholder = "Title";
    card.appendChild(title);

    const desc = document.createElement("textarea");
    desc.className = "ta-signin-input ta-publish-desc";
    desc.rows = 4;
    desc.placeholder = "Description (optional)";
    card.appendChild(desc);

    const pub = document.createElement("label");
    pub.className = "ta-publish-public";
    const pubCb = document.createElement("input");
    pubCb.type = "checkbox";
    pubCb.checked = true;
    pub.append(pubCb, document.createTextNode(" Post publicly (off = private draft)"));
    card.appendChild(pub);

    const err = document.createElement("div");
    err.className = "ta-signin-error";
    card.appendChild(err);

    const row = document.createElement("div");
    row.className = "choice-row";
    const cancel = document.createElement("button");
    cancel.className = "choice-btn";
    cancel.innerHTML = "<span>Cancel</span>";
    const ok = document.createElement("button");
    ok.className = "choice-btn choice-primary";
    ok.innerHTML = `<span>${esc("Publish")}</span>`;
    row.append(cancel, ok);
    card.appendChild(row);
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);
    title.focus();
    title.select();

    const submit = () => {
      const t = title.value.trim();
      if (t.length < 3) {
        err.textContent = "Title needs at least 3 characters.";
        title.focus();
        return;
      }
      done({ title: t, description: desc.value.trim(), publish: pubCb.checked });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        done(null);
        return;
      }
      if (e.key === "Enter" && document.activeElement !== desc) {
        e.preventDefault();
        e.stopImmediatePropagation();
        submit();
        return;
      }
      // typing reaches the fields; global shortcuts stay gated by pushModal.
      e.stopPropagation();
    };
    backdrop.addEventListener("pointerdown", (e) => {
      if (e.target === backdrop) done(null);
    });
    window.addEventListener("keydown", onKey, true);
    cancel.addEventListener("click", () => done(null));
    ok.addEventListener("click", submit);

    function done(value: PublishMeta | null) {
      window.removeEventListener("keydown", onKey, true);
      popModal();
      backdrop.remove();
      resolve(value);
    }
  });
}
