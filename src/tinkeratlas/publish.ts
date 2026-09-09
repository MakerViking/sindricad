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
import { t } from "../i18n";
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
    toast(t("tinkeratlas.publish.needsNative"), { kind: "error" });
    return;
  }
  const bodies = store.buildState.result?.bodies ?? [];
  if (!bodies.length) {
    toast(t("tinkeratlas.publish.nothing"), { kind: "error" });
    return;
  }
  // publish requires an account; sign-in stays optional everywhere else.
  if (!currentAccount() && !(await openSignInDialog())) return;

  const fmt = await choose<"3mf" | "stl">(t("tinkeratlas.publish.formatPrompt"), [
    { value: "3mf", label: "3MF", hint: t("tinkeratlas.publish.recommended") },
    { value: "stl", label: "STL" },
  ]);
  if (!fmt) return;

  const defaultTitle = store.fileName.replace(/\.sindri$/i, "") || t("tinkeratlas.publish.untitled");
  const meta = await publishForm(defaultTitle);
  if (!meta) return;

  toast(t("tinkeratlas.publish.inProgress"), { kind: "info" });
  try {
    const path = await taStagingPath(defaultTitle, fmt);
    const res = await geometry.export(store.document, fmt, path, {});
    if (!res.ok) {
      toast(t("file.error.export", { reason: res.message ?? t("common.unknownError") }), { kind: "error" });
      return;
    }
    if (res.warnings?.length) {
      // export-what-built: failed features are missing from the upload — say so
      // BEFORE it goes public, so the user can back out.
      const lines = res.warnings.map(
        (w) => t("tinkeratlas.publish.featureMissing", { feature: w.feature_id ?? t("file.export.unnamedFeature"), reason: w.message }),
      );
      await listModal(t("tinkeratlas.publish.warningsTitle"), lines);
    }

    const cover = viewport.screenshotPNG().replace(/^data:image\/png;base64,/, "");
    const { url } = await taPublish({
      title: meta.title,
      description: meta.description,
      publish: meta.publish,
      modelPath: res.path ?? path,
      coverPngBase64: cover,
    });
    toast(meta.publish ? t("tinkeratlas.publish.published") : t("tinkeratlas.publish.savedDraft"), {
      kind: "info",
      timeout: 10000,
      action: { label: t("tinkeratlas.publish.view"), onClick: () => void openExternal(url) },
    });
  } catch (e) {
    const ta = asTaError(e);
    if (ta?.code === "Unauthorized") {
      toast(t("tinkeratlas.error.expired"), {
        kind: "error",
        action: { label: t("tinkeratlas.signIn.action"), onClick: () => void openSignInDialog() },
      });
    } else if (ta?.code === "Unreachable") {
      toast(t("tinkeratlas.error.unreachable"), { kind: "error" });
    } else {
      toast(t("tinkeratlas.publish.failed", { reason: ta?.message ?? String(e) }), { kind: "error" });
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
    card.innerHTML = `<div class="choice-title" data-i18n="tinkeratlas.publish.title">${esc(t("tinkeratlas.publish.title"))}</div>`;

    const title = document.createElement("input");
    title.className = "ta-signin-input";
    title.maxLength = 200;
    title.value = defaultTitle;
    title.placeholder = t("tinkeratlas.publish.titlePlaceholder");
    card.appendChild(title);

    const desc = document.createElement("textarea");
    desc.className = "ta-signin-input ta-publish-desc";
    desc.rows = 4;
    desc.placeholder = t("tinkeratlas.publish.descriptionPlaceholder");
    card.appendChild(desc);

    const pub = document.createElement("label");
    pub.className = "ta-publish-public";
    const pubCb = document.createElement("input");
    pubCb.type = "checkbox";
    pubCb.checked = true;
    // the leading space keeps the label off the checkbox; it is layout, not text
    pub.append(pubCb, document.createTextNode(` ${t("tinkeratlas.publish.postPublicly")}`));
    card.appendChild(pub);

    const err = document.createElement("div");
    err.className = "ta-signin-error";
    card.appendChild(err);

    const row = document.createElement("div");
    row.className = "choice-row";
    const cancel = document.createElement("button");
    cancel.className = "choice-btn";
    cancel.innerHTML = `<span data-i18n="common.cancel">${esc(t("common.cancel"))}</span>`;
    const ok = document.createElement("button");
    ok.className = "choice-btn choice-primary";
    ok.innerHTML = `<span data-i18n="tinkeratlas.publish.submit">${esc(t("tinkeratlas.publish.submit"))}</span>`;
    row.append(cancel, ok);
    card.appendChild(row);
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);
    title.focus();
    title.select();

    const submit = () => {
      const titleText = title.value.trim();
      if (titleText.length < 3) {
        err.textContent = t("tinkeratlas.publish.titleTooShort");
        title.focus();
        return;
      }
      done({ title: titleText, description: desc.value.trim(), publish: pubCb.checked });
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
