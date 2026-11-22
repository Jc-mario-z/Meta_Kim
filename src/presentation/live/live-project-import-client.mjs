import { LIVE_PROJECT_IMPORT_COPY } from "./live-ui-copy.mjs";

/** One catalog authority. A post-commit refresh queues behind an older read,
 * never borrows its stale result, and never competes with another fetch path. */
export function createLiveProjectCatalogLoader({ read, apply, onError }) {
  let running = null;
  let runningCatalogOnly = false;
  let queueTail = null;
  const queued = new Map();
  function load({ refresh = false, afterCurrent = false, catalogOnly = false } = {}) {
    if (running) {
      if (!afterCurrent && catalogOnly === runningCatalogOnly) return running;
      // Never borrow a refresh with a different navigation policy. In particular,
      // an import must not consume an already queued normal/default selection.
      const key = String(refresh) + ":" + String(catalogOnly);
      if (!queued.has(key)) {
        const pending = (queueTail || running).then(() => {
          queued.delete(key);
          if (queueTail === pending) queueTail = null;
          return load({ refresh, catalogOnly });
        });
        queued.set(key, pending);
        queueTail = pending;
      }
      return queued.get(key);
    }
    runningCatalogOnly = catalogOnly;
    running = (async () => {
      try {
        const catalog = await read();
        const selected = await apply(catalog, { refresh, catalogOnly });
        return { ok: true, catalog, selected: Boolean(selected) };
      } catch {
        onError?.({ refresh });
        return { ok: false, catalog: null, selected: false };
      }
    })().finally(() => { running = null; });
    return running;
  }
  return { load };
}

/** Bounded same-origin JSON only. No directory or token ever enters a URL. */
export async function requestLiveProjectImportJson({ fetcher, url, body, config, timeoutMs = 12000 }) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetcher(url, {
      method: "POST", mode: "same-origin", credentials: "same-origin", cache: "no-store",
      headers: { "Content-Type": "application/json", [config.controlHeader]: config.controlToken },
      body: JSON.stringify(body), signal: abort.signal,
    });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error("project import refused");
      error.importCode = typeof result?.error === "string" ? result.error : "project_import_failed";
      throw error;
    }
    return result;
  } finally { clearTimeout(timer); }
}

/** Run-scoped state, deliberately independent of the workspace execution binding. */
export function createLiveProjectImportController(options) {
  const config = options.config || {};
  const enabled = config.enabled === true && config.projectImportEnabled === true
    && config.controlHeader === "x-meta-kim-workspace-token" && typeof config.controlToken === "string" && Boolean(config.controlToken);
  const now = options.now || Date.now;
  let generation = 0;
  let expiryTimer = null;
  let attempt = null;
  let state = { active: false, enabled, path: "", phase: "idle", preview: null, skippedConsent: false, error: "", notice: "" };
  const busy = () => ["checking", "confirming", "refreshing"].includes(state.phase);
  const emit = () => options.onChange?.({ ...state });
  const clearExpiry = () => { clearTimeout(expiryTimer); expiryTimer = null; };
  function invalidate(error = "") {
    clearExpiry();
    state.preview = null;
    state.skippedConsent = false;
    state.phase = "idle";
    state.error = error;
  }
  const current = (version) => state.active && generation === version;
  const errorKey = (code) => ({
    project_import_unavailable: "unavailable", project_import_invalid_path: "invalidPath", project_import_path_unavailable: "pathUnavailable",
    project_import_not_governed: "notGoverned", project_import_preview_expired: "expired", project_import_preview_stale: "stale",
    project_import_skipped_confirmation_required: "skippedRequired", project_import_catalog_full: "full", workspace_token_required: "auth",
    project_import_same_origin_json_required: "request", invalid_json: "request", invalid_body: "request", body_too_large: "request",
  })[code] || "failed";
  const request = (action, body) => requestLiveProjectImportJson({ fetcher: options.fetcher, url: "/api/projects/import/" + action, body, config, timeoutMs: options.timeoutMs });
  function open() {
    generation += 1;
    clearExpiry();
    attempt = null;
    state = { ...state, active: true, phase: "idle", preview: null, skippedConsent: false, error: "", notice: "" };
    emit();
  }
  function close() {
    generation += 1;
    clearExpiry();
    attempt = null;
    state = { ...state, active: false, phase: "idle", preview: null, skippedConsent: false, error: "", notice: "" };
    emit();
  }
  function setPath(path) {
    if (["confirming", "refreshing", "unknown", "imported_pending"].includes(state.phase)) return;
    generation += 1;
    state.path = String(path);
    attempt = null;
    state.notice = "";
    invalidate();
    emit();
  }
  async function check() {
    if (!enabled || !state.active || busy() || attempt) return;
    const path = state.path.trim();
    const version = ++generation;
    invalidate();
    if (!path || !(/^(?:\/|[a-z]:[\\/]|\\\\[^\\]+\\)/iu.test(path)) || /[\u0000-\u001f\u007f]/u.test(path)) {
      state.error = "invalidPath"; emit(); return;
    }
    state.phase = "checking"; emit();
    try {
      const preview = await request("preview", { projectPath: path });
      if (!current(version)) return;
      const project = preview?.project;
      if (preview?.schemaVersion !== "meta-kim-live-project-import-v1" || !["ready", "already_registered"].includes(preview.status)
        || typeof preview.previewToken !== "string" || !preview.previewToken || !Number.isFinite(Date.parse(preview.expiresAt))
        || !project || typeof project.projectId !== "string" || !project.projectId || typeof project.displayName !== "string"
        || typeof project.projectPath !== "string" || typeof project.profile !== "string"
        || !Number.isSafeInteger(project.evidenceCount) || project.evidenceCount < 0 || typeof project.previouslySkipped !== "boolean") {
        throw new Error("invalid preview");
      }
      if (Date.parse(preview.expiresAt) <= now()) { invalidate("expired"); emit(); return; }
      state.preview = preview;
      state.phase = "ready";
      expiryTimer = setTimeout(() => {
        if (!current(version) || state.phase !== "ready") return;
        invalidate("expired"); emit();
      }, Math.min(2147483647, Date.parse(preview.expiresAt) - now()));
      emit();
    } catch (error) {
      if (!current(version)) return;
      state.phase = "idle";
      state.error = error.importCode ? errorKey(error.importCode) : "previewNetwork";
      emit();
    }
  }
  async function refreshAndOpen(version, { knownImported = true } = {}) {
    state.phase = "refreshing"; state.error = ""; emit();
    let result;
    try { result = await options.refreshCatalog({ refresh: true, afterCurrent: true, catalogOnly: true }); } catch {}
    if (!current(version)) return false;
    // A boolean or an old getCatalog() snapshot is not a successful refresh.
    if (result?.ok === true && result.catalog?.projects?.some((project) => project.projectId === attempt.projectId)) {
      await options.selectProjectRun(attempt.projectId, "");
      if (!current(version)) return true;
      state.phase = "opened"; state.notice = ""; emit();
      options.onOpened?.();
      return true;
    }
    state.phase = knownImported ? "imported_pending" : "unknown";
    state.notice = knownImported ? "importedPending" : "unknown";
    emit();
    return false;
  }
  async function submitAttempt(version) {
    state.phase = "confirming"; state.error = ""; state.notice = ""; clearExpiry(); emit();
    try {
      const result = await request("confirm", {
        previewToken: attempt.previewToken,
        ...(attempt.skippedConsent ? { confirmPreviouslySkipped: true } : {}),
      });
      if (!current(version)) return;
      if (result?.schemaVersion !== "meta-kim-live-project-import-v1" || !["imported", "already_registered"].includes(result.status)
        || result.projectId !== attempt.projectId) throw new Error("unknown confirmation result");
      await refreshAndOpen(version);
    } catch (error) {
      if (!current(version)) return;
      if (!error.importCode) {
        // The POST may have committed. Reconcile first; never mint another token.
        await refreshAndOpen(version, { knownImported: false });
        return;
      }
      attempt = null;
      const key = errorKey(error.importCode);
      if (["expired", "stale"].includes(key)) invalidate(key);
      else {
        state.phase = "ready"; state.error = key;
        if (key === "skippedRequired") state.skippedConsent = false;
      }
      emit();
    }
  }
  async function confirm() {
    if (!enabled || !state.active || busy()) return;
    const version = generation;
    if (attempt && state.phase === "imported_pending") { await refreshAndOpen(version); return; }
    if (attempt && state.phase === "unknown") {
      if (await refreshAndOpen(version, { knownImported: false }) || !current(version)) return;
      // This explicit retry reuses the exact original idempotent token.
      await submitAttempt(version); return;
    }
    if (!state.preview) return;
    if (Date.parse(state.preview.expiresAt) <= now()) { invalidate("expired"); emit(); return; }
    if (state.preview.project.previouslySkipped && !state.skippedConsent) { state.error = "skippedRequired"; emit(); return; }
    attempt = { projectId: state.preview.project.projectId, previewToken: state.preview.previewToken,
      skippedConsent: state.preview.project.previouslySkipped && state.skippedConsent };
    await submitAttempt(version);
  }
  function setSkippedConsent(value) { if (!busy() && !attempt) { state.skippedConsent = value === true; state.error = ""; emit(); } }
  return { open, close, setPath, check, confirm, setSkippedConsent, getState: () => ({ ...state }), dispose: close };
}

/** DOM adapter reuses the existing dialog/focus trap; no nested modal. */
export function createLiveProjectImportUi(options) {
  const { app } = options;
  const find = (name) => app.querySelector("[data-project-import-" + name + "]");
  const pane = find("pane");
  const records = app.querySelector("[data-project-records-pane]");
  const input = find("path");
  const checkButton = find("check");
  const confirmButton = find("confirm");
  const checkbox = find("consent");
  const entries = [...app.querySelectorAll("[data-project-import-entry]")];
  const copy = () => LIVE_PROJECT_IMPORT_COPY[options.language?.()] || LIVE_PROJECT_IMPORT_COPY.en;
  let controller;
  function render(state = controller?.getState()) {
    if (!state) return;
    const text = copy();
    for (const node of app.querySelectorAll("[data-project-import-copy]")) node.textContent = text[node.dataset.projectImportCopy] || "";
    for (const entry of entries) {
      entry.disabled = !state.enabled;
      entry.title = state.enabled ? text.title : text.unavailable;
    }
    const availability = find("availability");
    if (availability) availability.textContent = state.enabled ? text.help : text.unavailable;
    for (const empty of app.querySelectorAll("[data-project-import-empty]")) empty.hidden = (options.getCatalog?.() || []).length > 0;
    if (pane) pane.hidden = !state.active;
    if (records) records.hidden = state.active;
    if (!pane) return;
    const busy = ["checking", "confirming", "refreshing"].includes(state.phase);
    const locked = ["confirming", "refreshing", "unknown", "imported_pending"].includes(state.phase);
    pane.setAttribute("aria-busy", String(busy));
    if (input) {
      if (input.value !== state.path) input.value = state.path;
      input.disabled = !state.enabled || locked;
      input.placeholder = text.placeholder;
      input.setAttribute("aria-invalid", String(Boolean(state.error)));
    }
    if (checkButton) { checkButton.disabled = !state.enabled || busy || locked; checkButton.textContent = state.phase === "checking" ? text.checking : text.check; }
    const preview = state.preview;
    if (find("preview")) find("preview").hidden = !preview;
    if (preview) {
      // Exact data, not markup and not translation inputs.
      for (const [key, value] of Object.entries({ name: preview.project.displayName, canonical: preview.project.projectPath, evidence: preview.project.evidenceCount })) {
        if (find(key)) find(key).textContent = String(value);
      }
      if (find("registration")) find("registration").textContent = preview.status === "already_registered" ? text.registered : text.ready;
    }
    if (find("skipped")) find("skipped").hidden = !preview?.project.previouslySkipped;
    if (checkbox) { checkbox.checked = state.skippedConsent; checkbox.disabled = busy || locked; }
    if (confirmButton) {
      confirmButton.hidden = !preview;
      confirmButton.disabled = !state.enabled || busy || (preview?.project.previouslySkipped && !state.skippedConsent);
      confirmButton.textContent = state.phase === "imported_pending" ? text.retryOpen : state.phase === "unknown" ? text.retryUnknown
        : state.phase === "confirming" ? text.confirming : state.phase === "refreshing" ? text.refreshing
        : preview?.status === "already_registered" ? text.open : text.confirm;
    }
    if (find("error")) find("error").textContent = text[state.error] || "";
    if (find("status")) find("status").textContent = text[state.notice] || (state.phase === "checking" ? text.checking : state.phase === "confirming" ? text.confirming : state.phase === "refreshing" ? text.refreshing : "");
  }
  controller = createLiveProjectImportController({ ...options, onChange: render });
  for (const entry of entries) entry.addEventListener("click", () => {
    if (!controller.getState().enabled) return;
    controller.open();
    options.setDialogOpen(true);
    input?.focus();
  });
  input?.addEventListener("input", () => controller.setPath(input.value));
  find("form")?.addEventListener("submit", (event) => { event.preventDefault(); void controller.check(); });
  confirmButton?.addEventListener("click", () => { void controller.confirm(); });
  checkbox?.addEventListener("change", () => controller.setSkippedConsent(checkbox.checked));
  find("dismiss")?.addEventListener("click", () => { controller.close(); options.setDialogOpen(false); });
  render();
  return { render, close: controller.close, dispose: controller.dispose };
}

export function renderLiveProjectImportPane() {
  const text = LIVE_PROJECT_IMPORT_COPY.zh;
  const label = (key) => `<span data-project-import-copy="${key}">${text[key]}</span>`;
  return `<section class="project-import-pane" data-project-import-pane hidden aria-labelledby="project-import-title">
    <h3 id="project-import-title" data-project-import-copy="title">${text.title}</h3>
    <p id="project-import-help" data-project-import-copy="help">${text.help}</p>
    <form data-project-import-form autocomplete="off">
      <label for="project-import-path" data-project-import-copy="path">${text.path}</label>
      <div class="project-import-path-row"><input id="project-import-path" data-project-import-path type="text" spellcheck="false" autocapitalize="off" autocomplete="off" maxlength="4096" placeholder="${text.placeholder}" aria-describedby="project-import-help project-import-error"><button class="replay-button" type="submit" data-project-import-check>${text.check}</button></div>
    </form>
    <div data-project-import-preview hidden><dl class="project-import-facts"><dt>${label("name")}</dt><dd data-project-import-name></dd><dt>${label("canonicalPath")}</dt><dd data-project-import-canonical></dd><dt>${label("evidence")}</dt><dd data-project-import-evidence></dd><dt>${label("registration")}</dt><dd data-project-import-registration></dd></dl>
      <div class="project-import-warning" data-project-import-skipped hidden><p data-project-import-copy="skipped">${text.skipped}</p><label class="project-import-consent"><input type="checkbox" data-project-import-consent>${label("skippedConsent")}</label></div>
    </div>
    <p data-project-import-status role="status" aria-live="polite" aria-atomic="true"></p><p id="project-import-error" data-project-import-error role="alert"></p>
    <div class="project-import-actions"><button class="replay-button" type="button" data-project-import-confirm hidden>${text.confirm}</button><button class="replay-button" type="button" data-project-import-dismiss>${label("cancel")}</button></div>
  </section>`;
}

export function serializeLiveProjectImportClient() {
  const copy = JSON.stringify(LIVE_PROJECT_IMPORT_COPY).replaceAll("<", "\\u003c");
  return `const LIVE_PROJECT_IMPORT_COPY = ${copy};\n${[createLiveProjectCatalogLoader, requestLiveProjectImportJson, createLiveProjectImportController, createLiveProjectImportUi].map((fn) => fn.toString()).join("\n")}`;
}
