import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import {
  createLiveProjectImportController, createLiveProjectCatalogLoader, createLiveProjectImportUi,
  serializeLiveProjectImportClient, renderLiveProjectImportPane,
} from "../../src/presentation/live/live-project-import-client.mjs";
import { LIVE_PROJECT_IMPORT_COPY } from "../../src/presentation/live/live-ui-copy.mjs";
import { renderLiveControlRoomPage } from "../../src/presentation/live/live-control-room-page.mjs";
import { renderLiveWorkspaceNavigation, renderLiveWorkspaceSurface } from "../../src/presentation/live/live-workspace-view.mjs";

// Every request is an in-memory fixture. These tests never write a real registry.
const config = { enabled: true, projectImportEnabled: true, controlHeader: "x-meta-kim-workspace-token", controlToken: "test-import-token-1234567890" };
const schemaVersion = "meta-kim-live-project-import-v1";
const project = { projectId: "project-imported", displayName: "本机项目", projectPath: "/projects/local", profile: "default", evidenceCount: 3, previouslySkipped: false };
const preview = (overrides = {}) => ({ schemaVersion, status: "ready", previewToken: "preview-fixture", expiresAt: new Date(Date.now() + 60000).toISOString(), project: { ...project }, ...overrides });
const confirmed = () => ({ schemaVersion, status: "imported", projectId: project.projectId });
const catalog = (projects = [project]) => ({ projects });
const response = (value, status = 200) => ({ ok: status < 400, status, json: async () => value });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
async function settle() { for (let i = 0; i < 5; i += 1) await setImmediate(); }

function harness(t, overrides = {}) {
  const calls = [], selections = [], states = [];
  const controller = createLiveProjectImportController({ config,
    fetcher: async (url, request) => {
      calls.push({ url, ...request, jsonBody: JSON.parse(request.body) });
      return response(url.endsWith("preview") ? preview() : confirmed());
    },
    refreshCatalog: async () => ({ ok: true, catalog: catalog() }),
    selectProjectRun: async (...args) => selections.push(args), onChange: (state) => states.push(state),
    ...overrides,
  });
  t.after(() => controller.dispose());
  controller.open(); controller.setPath("/projects/local");
  return { controller, calls, selections, states };
}

test("input -> preview -> confirm -> fresh catalog -> explicit project selection, with private same-origin JSON", async (t) => {
  const h = harness(t);
  await h.controller.check();
  assert.equal(h.controller.getState().phase, "ready");
  assert.equal(h.controller.getState().preview.project.evidenceCount, 3);
  await h.controller.confirm();
  assert.deepEqual(h.calls.map((call) => [call.url, call.jsonBody]), [
    ["/api/projects/import/preview", { projectPath: "/projects/local" }],
    ["/api/projects/import/confirm", { previewToken: "preview-fixture" }],
  ]);
  for (const call of h.calls) {
    assert.equal(call.mode, "same-origin"); assert.equal(call.credentials, "same-origin");
    assert.equal(call.headers[config.controlHeader], config.controlToken);
    assert.equal(call.headers["Content-Type"], "application/json");
    assert.doesNotMatch(call.url, /projects\/local|preview-fixture|test-import-token|\?/);
  }
  assert.deepEqual(h.selections, [[project.projectId, ""]]);
  assert.equal(h.controller.getState().phase, "opened");
});

test("already-registered primary path still confirms the original token and opens without choosing the newest run", async (t) => {
  let confirmations = 0;
  const h = harness(t, { fetcher: async (url) => {
    if (url.endsWith("preview")) return response(preview({ status: "already_registered" }));
    confirmations += 1; return response({ ...confirmed(), status: "already_registered" });
  } });
  await h.controller.check(); await h.controller.confirm();
  assert.equal(confirmations, 1); assert.deepEqual(h.selections, [[project.projectId, ""]]);
});

test("preview refusal vocabulary is safe, explicit and preserves input", async (t) => {
  const codes = {
    project_import_unavailable: "unavailable", project_import_invalid_path: "invalidPath", project_import_path_unavailable: "pathUnavailable",
    project_import_not_governed: "notGoverned", project_import_catalog_full: "full", workspace_token_required: "auth",
    project_import_same_origin_json_required: "request", project_import_failed: "failed", "private /Users/secret stacktrace": "failed",
  };
  for (const [code, expected] of Object.entries(codes)) {
    const h = harness(t, { fetcher: async () => response({ error: code }, 400) });
    await h.controller.check();
    assert.equal(h.controller.getState().error, expected);
    assert.equal(h.controller.getState().path, "/projects/local");
    assert.equal(h.controller.getState().preview, null);
  }
});

test("relative and control-character paths do not reach the preview endpoint; absolute Windows and Unicode paths are supported", async (t) => {
  const h = harness(t);
  for (const value of ["relative", "~/projects/local", "", "/tmp/x\ny"]) {
    h.controller.setPath(value); await h.controller.check();
    assert.equal(h.controller.getState().error, "invalidPath");
  }
  assert.equal(h.calls.length, 0);
  for (const value of ["C:\\Projects\\本机项目", "\\\\server\\share\\project", "/tmp/日韓项目"]) {
    h.controller.setPath(value); await h.controller.check();
    assert.equal(h.controller.getState().phase, "ready");
    assert.equal(h.calls.at(-1).jsonBody.projectPath, value);
  }
});

test("path edits immediately invalidate preview and reject a late preview from the old input", async (t) => {
  const old = deferred(); let count = 0;
  const h = harness(t, { fetcher: async () => ++count === 1 ? old.promise : response(preview({ previewToken: "new-preview" })) });
  const first = h.controller.check();
  h.controller.setPath("/projects/new");
  assert.equal(h.controller.getState().preview, null);
  const second = h.controller.check(); await second;
  old.resolve(response(preview())); await first;
  assert.equal(h.controller.getState().path, "/projects/new");
  assert.equal(h.controller.getState().preview.previewToken, "new-preview");
  h.controller.setPath("/projects/another");
  await h.controller.confirm();
  assert.equal(h.controller.getState().preview, null); assert.equal(count, 2);
});

test("preview and confirm double clicks submit once and cannot switch early", async (t) => {
  const check = deferred(), confirm = deferred(); let count = 0;
  const h = harness(t, { fetcher: () => ++count === 1 ? check.promise : confirm.promise });
  const first = h.controller.check(); await h.controller.check();
  assert.equal(count, 1);
  check.resolve(response(preview())); await first;
  const commit = h.controller.confirm(); await h.controller.confirm();
  assert.equal(count, 2); assert.deepEqual(h.selections, []);
  confirm.resolve(response(confirmed())); await commit;
  assert.equal(h.selections.length, 1);
});

test("cancel does not confirm; reopening clears errors and old preview; late results cannot reopen or change selection", async (t) => {
  const old = deferred(); const h = harness(t, { fetcher: () => old.promise });
  const pending = h.controller.check(); h.controller.close();
  old.resolve(response(preview())); await pending;
  assert.equal(h.controller.getState().preview, null); assert.deepEqual(h.selections, []);
  h.controller.open();
  assert.equal(h.controller.getState().phase, "idle"); assert.equal(h.controller.getState().error, "");
  assert.equal(h.controller.getState().preview, null); assert.equal(h.controller.getState().path, "/projects/local");
  h.controller.close(); await h.controller.confirm(); assert.deepEqual(h.selections, []);
});

test("closing during confirmation never opens the late result", async (t) => {
  const commit = deferred(); let count = 0;
  const h = harness(t, { fetcher: async () => ++count === 1 ? response(preview()) : commit.promise });
  await h.controller.check(); const pending = h.controller.confirm(); h.controller.close();
  commit.resolve(response(confirmed())); await pending;
  assert.deepEqual(h.selections, []); assert.equal(h.controller.getState().active, false);
});

test("expired and changed-evidence previews require recheck, never another automatic confirmation", async (t) => {
  for (const [code, expected] of [["project_import_preview_expired", "expired"], ["project_import_preview_stale", "stale"]]) {
    let count = 0;
    const h = harness(t, { fetcher: async () => ++count === 1 ? response(preview()) : response({ error: code }, 409) });
    await h.controller.check(); await h.controller.confirm(); await h.controller.confirm();
    assert.equal(h.controller.getState().error, expected);
    assert.equal(h.controller.getState().preview, null); assert.equal(count, 2);
  }
  let now = Date.now(); const h = harness(t, { now: () => now });
  await h.controller.check(); now += 120000; await h.controller.confirm();
  assert.equal(h.controller.getState().error, "expired"); assert.equal(h.calls.length, 1);
});

test("previously excluded project requires an explicit checkbox and is the only case sending confirmPreviouslySkipped", async (t) => {
  const bodies = [];
  const h = harness(t, { fetcher: async (url, request) => {
    bodies.push(JSON.parse(request.body));
    return response(url.endsWith("preview") ? preview({ project: { ...project, previouslySkipped: true } }) : confirmed());
  } });
  await h.controller.check(); await h.controller.confirm();
  assert.equal(bodies.length, 1); assert.equal(h.controller.getState().error, "skippedRequired");
  h.controller.setSkippedConsent(true); await h.controller.confirm();
  assert.deepEqual(bodies[1], { previewToken: "preview-fixture", confirmPreviouslySkipped: true });
});

test("server-side skipped confirmation refusal is recoverable without silently setting consent", async (t) => {
  let posts = 0;
  const h = harness(t, { fetcher: async (url) => {
    if (url.endsWith("preview")) return response(preview({ project: { ...project, previouslySkipped: true } }));
    posts += 1;
    return response({ error: "project_import_skipped_confirmation_required" }, 409);
  } });
  await h.controller.check(); h.controller.setSkippedConsent(true); await h.controller.confirm();
  assert.equal(h.controller.getState().skippedConsent, false);
  assert.equal(h.controller.getState().error, "skippedRequired");
  await h.controller.confirm(); assert.equal(posts, 1);
});

test("successful import + failed/missing/legacy-boolean catalog keeps imported status and retries refresh only", async (t) => {
  for (const failed of [{ ok: false, catalog: null }, { ok: true, catalog: catalog([]) }, true]) {
    let reads = 0;
    const h = harness(t, { refreshCatalog: async () => ++reads === 1 ? failed : { ok: true, catalog: catalog() } });
    await h.controller.check(); await h.controller.confirm();
    assert.equal(h.controller.getState().phase, "imported_pending");
    assert.equal(h.controller.getState().notice, "importedPending"); assert.deepEqual(h.selections, []);
    await h.controller.confirm();
    assert.deepEqual(h.selections, [[project.projectId, ""]]); assert.equal(h.calls.length, 2);
  }
});

test("confirmation timeout first reconciles the target catalog and opens an actually registered target", async (t) => {
  let commits = 0;
  const h = harness(t, { timeoutMs: 5, fetcher: async (url, request) => {
    if (url.endsWith("preview")) return response(preview());
    commits += 1;
    return new Promise((_resolve, reject) => request.signal.addEventListener("abort", () => reject(new Error("timeout /private/path")), { once: true }));
  } });
  await h.controller.check(); await h.controller.confirm();
  assert.equal(commits, 1); assert.deepEqual(h.selections, [[project.projectId, ""]]);
});

test("unknown confirmation result uses explicit recovery, catalog check first, then the exact same idempotent token", async (t) => {
  const order = [], tokens = []; let commits = 0, reads = 0;
  const h = harness(t, { fetcher: async (url, request) => {
    if (url.endsWith("preview")) return response(preview());
    order.push("confirm"); tokens.push(JSON.parse(request.body).previewToken); commits += 1;
    if (commits === 1) throw new Error("connection lost /private/path");
    return response(confirmed());
  }, refreshCatalog: async () => {
    order.push("catalog"); reads += 1;
    return { ok: true, catalog: catalog(reads < 3 ? [] : [project]) };
  } });
  await h.controller.check(); await h.controller.confirm();
  assert.equal(h.controller.getState().phase, "unknown"); assert.equal(commits, 1);
  assert.deepEqual(order, ["confirm", "catalog"]); assert.deepEqual(h.selections, []);
  await h.controller.confirm();
  assert.deepEqual(order, ["confirm", "catalog", "catalog", "confirm", "catalog"]);
  assert.deepEqual(tokens, ["preview-fixture", "preview-fixture"]);
  assert.deepEqual(h.selections, [[project.projectId, ""]]);
});

test("a post-import refresh waits behind an in-flight old catalog and reads again without old-response overwrite", async (t) => {
  const old = deferred(); let reads = 0; const applied = [];
  const loader = createLiveProjectCatalogLoader({ read: async () => ++reads === 1 ? old.promise : catalog(),
    apply: async (value) => { applied.push(value); return true; } });
  const first = loader.load({ refresh: true });
  assert.equal(loader.load({ refresh: true }), first);
  const h = harness(t, { refreshCatalog: loader.load });
  await h.controller.check(); const commit = h.controller.confirm(); await settle();
  assert.equal(reads, 1); assert.deepEqual(h.selections, []);
  old.resolve(catalog([])); await first; await commit;
  assert.equal(reads, 2); assert.deepEqual(applied.map((value) => value.projects.length), [0, 1]);
  assert.deepEqual(h.selections, [[project.projectId, ""]]);
});

test("catalog failure reports ok:false, retains the caller's existing catalog and allows queued recovery", async () => {
  const old = deferred(); let reads = 0, errors = 0; const applied = [];
  const loader = createLiveProjectCatalogLoader({ read: async () => ++reads === 1 ? old.promise : catalog(),
    apply: async (value) => { applied.push(value); return false; }, onError: () => errors++ });
  const first = loader.load(); const second = loader.load({ refresh: true, afterCurrent: true });
  old.resolve(Promise.reject(new Error("offline")));
  assert.deepEqual(await first, { ok: false, catalog: null, selected: false });
  const fresh = await second;
  assert.equal(fresh.ok, true); assert.equal(fresh.selected, false); assert.equal(errors, 1); assert.equal(applied.length, 1);
});

test("missing import capability, disabled workspace, or missing authorization never posts or selects", async (t) => {
  for (const invalid of [{ ...config, projectImportEnabled: false }, { ...config, projectImportEnabled: undefined }, { ...config, enabled: false }, { ...config, controlToken: "" }]) {
    const h = harness(t, { config: invalid });
    await h.controller.check(); await h.controller.confirm();
    assert.equal(h.controller.getState().enabled, false); assert.deepEqual(h.calls, []); assert.deepEqual(h.selections, []);
  }
});

function domNode() {
  const events = new Map();
  return { hidden: false, disabled: false, value: "", checked: false, dataset: {}, attributes: {}, textContent: "",
    addEventListener(type, callback) { events.set(type, callback); },
    dispatch(type) { events.get(type)?.({ preventDefault() {} }); },
    setAttribute(key, value) { this.attributes[key] = value; }, focus() { this.focused = true; } };
}
function uiHarness(t, options = {}) {
  const names = ["pane", "form", "path", "check", "confirm", "consent", "preview", "name", "canonical", "evidence", "registration", "skipped", "error", "status", "dismiss", "availability"];
  const nodes = Object.fromEntries(names.map((key) => [key, domNode()]));
  const records = domNode(), entry = domNode(), empty = domNode();
  const labels = Object.keys(LIVE_PROJECT_IMPORT_COPY.en).map((key) => ({ ...domNode(), dataset: { projectImportCopy: key } }));
  let language = "zh", catalogRows = [];
  const dialogs = [], selections = [], calls = [];
  const app = {
    querySelector(selector) { if (selector === "[data-project-records-pane]") return records; return nodes[/^\[data-project-import-(.+)\]$/.exec(selector)?.[1]] || null; },
    querySelectorAll(selector) { return selector === "[data-project-import-entry]" ? [entry] : selector === "[data-project-import-copy]" ? labels : selector === "[data-project-import-empty]" ? [empty] : []; },
  };
  const ui = createLiveProjectImportUi({ app, config, language: () => language, getCatalog: () => catalogRows,
    fetcher: async (url, request) => { calls.push({ url, body: JSON.parse(request.body) }); return response(url.endsWith("preview") ? preview() : confirmed()); },
    refreshCatalog: async () => ({ ok: true, catalog: catalog() }), selectProjectRun: async (...args) => selections.push(args),
    setDialogOpen: (open) => dialogs.push(open), ...options,
  });
  t.after(() => ui.dispose());
  return { ui, nodes, records, entry, empty, labels, dialogs, selections, calls, setLanguage: (value) => { language = value; ui.render(); }, setCatalog: (value) => { catalogRows = value; ui.render(); } };
}

test("DOM adapter opens the existing pane, focuses input, checks, confirms, and cancels without nested modal or submission", async (t) => {
  const h = uiHarness(t);
  assert.equal(h.nodes.pane.hidden, true);
  h.entry.dispatch("click");
  assert.equal(h.nodes.pane.hidden, false); assert.equal(h.records.hidden, true);
  assert.equal(h.nodes.path.focused, true); assert.deepEqual(h.dialogs, [true]);
  h.nodes.path.value = "/projects/local"; h.nodes.path.dispatch("input"); h.nodes.form.dispatch("submit"); await settle();
  assert.equal(h.nodes.name.textContent, project.displayName); assert.equal(h.nodes.canonical.textContent, project.projectPath);
  assert.equal(h.nodes.evidence.textContent, "3"); assert.equal(h.nodes.confirm.textContent, LIVE_PROJECT_IMPORT_COPY.zh.confirm);
  h.nodes.confirm.dispatch("click"); await settle();
  assert.deepEqual(h.selections, [[project.projectId, ""]]);
  h.nodes.dismiss.dispatch("click"); assert.equal(h.nodes.pane.hidden, true); assert.equal(h.records.hidden, false);
  assert.deepEqual(h.dialogs, [true, false]); assert.equal(h.calls.length, 2);
  h.entry.dispatch("click"); h.nodes.dismiss.dispatch("click"); assert.equal(h.calls.length, 2);
});

test("DOM renders exact hostile names/paths with textContent, never HTML or translation; all four languages cover every visible key", async (t) => {
  const hostile = { ...project, displayName: '<img src=x onerror="alert(1)"> critical', projectPath: '/projects/<script>"日本語한국어</script>' };
  const h = uiHarness(t, { fetcher: async () => response(preview({ project: hostile, status: "already_registered" })) });
  for (const node of Object.values(h.nodes)) Object.defineProperty(node, "innerHTML", { set() { assert.fail("untrusted data must never be HTML"); } });
  h.entry.dispatch("click"); h.nodes.path.value = "/projects/local"; h.nodes.path.dispatch("input"); h.nodes.form.dispatch("submit"); await settle();
  for (const language of ["en", "zh", "ja", "ko"]) {
    const text = LIVE_PROJECT_IMPORT_COPY[language];
    assert.deepEqual(Object.keys(text).sort(), Object.keys(LIVE_PROJECT_IMPORT_COPY.en).sort());
    for (const value of Object.values(text)) assert.ok(typeof value === "string" && value.length);
    h.setLanguage(language);
    for (const label of h.labels) assert.equal(label.textContent, text[label.dataset.projectImportCopy]);
    assert.equal(h.nodes.path.placeholder, text.placeholder); assert.equal(h.nodes.confirm.textContent, text.open);
    assert.equal(h.nodes.name.textContent, hostile.displayName); assert.equal(h.nodes.canonical.textContent, hostile.projectPath);
  }
});

test("disabled DOM entry has localized explanation and empty-state entry tracks catalog, not Tauri detection", (t) => {
  const h = uiHarness(t, { config: { ...config, projectImportEnabled: false } });
  assert.equal(h.entry.disabled, true); assert.equal(h.entry.title, LIVE_PROJECT_IMPORT_COPY.zh.unavailable);
  h.entry.dispatch("click"); assert.deepEqual(h.dialogs, []);
  h.setLanguage("ja"); assert.equal(h.nodes.availability.textContent, LIVE_PROJECT_IMPORT_COPY.ja.unavailable);
  assert.equal(h.empty.hidden, false); h.setCatalog([project]); assert.equal(h.empty.hidden, true);
});

test("serialized client is the tested controller and the full shipped page script compiles", () => {
  const browser = new Function(serializeLiveProjectImportClient() + "\nreturn { createLiveProjectImportController, createLiveProjectCatalogLoader };" )();
  assert.equal(browser.createLiveProjectImportController.toString(), createLiveProjectImportController.toString());
  assert.equal(browser.createLiveProjectCatalogLoader.toString(), createLiveProjectCatalogLoader.toString());
  const html = renderLiveControlRoomPage({ workspaceConfig: config });
  new Function(html.match(/<script>([\s\S]*)<\/script>/u)[1]);
  const embedded = JSON.parse(html.match(/id="live-workspace-config">([^<]*)<\/script>/u)[1]);
  assert.equal(embedded.projectImportEnabled, true);
  const legacy = renderLiveControlRoomPage({ workspaceConfig: { ...config, projectImportEnabled: undefined } });
  assert.equal(JSON.parse(legacy.match(/id="live-workspace-config">([^<]*)<\/script>/u)[1]).projectImportEnabled, false);
  const disabled = renderLiveControlRoomPage({ workspaceConfig: { ...config, enabled: false } });
  assert.deepEqual(JSON.parse(disabled.match(/id="live-workspace-config">([^<]*)<\/script>/u)[1]), { enabled: false });
  assert.match(html, /reloadCatalog: \(\) => loadProjectCatalog\(\{ refresh: true, afterCurrent: true \}\)/u);
  assert.doesNotMatch(html, /catalogRequestInFlight/u);
});

test("actual refreshed catalog application preserves the current tab's selection and handles empty-session projects", async () => {
  const html = renderLiveControlRoomPage();
  const start = html.indexOf("  async function applyProjectCatalog(");
  const end = html.indexOf("  function loadProjectCatalog(", start);
  // Supply only the original function's dependencies, without copying its implementation.
  const run = new Function("catalog", `
    let catalogAvailable = true, projectCatalog = [], selectedProjectId = "keep-project", selectedRunId = "keep-run";
    const projectImportUi = null, currentSnapshot = {}, selections = [];
    const populateProjectSelect = () => {}, populateSessionSelect = () => {}, renderRunOverview = () => {}, setHubStatus = () => {};
    const switchSelection = async (...args) => selections.push(args);
    ${html.slice(start, end)}
    return applyProjectCatalog(catalog, { refresh: true }).then(() => ({ projectCatalog, selectedProjectId, selectedRunId, selections }));
  `);
  const result = await run({ projects: [{ projectId: "keep-project", displayName: "keep", sessions: [{ runId: "keep-run" }] }, { ...project, sessions: [] }] });
  assert.equal(result.projectCatalog.length, 2); assert.equal(result.selectedProjectId, "keep-project"); assert.equal(result.selectedRunId, "keep-run");
  assert.deepEqual(result.selections, []);
  const absentRun = await run({ projects: [{ projectId: "keep-project", sessions: [] }, { ...project, sessions: [] }] });
  assert.deepEqual(absentRun.selections, [["keep-project", "keep-run", { updateUrl: false }]]);
  const defaultStart = html.indexOf("  function defaultSessionFor(");
  const defaultEnd = html.indexOf("  function setHubStatus(", defaultStart);
  const defaultSessionFor = new Function("pickDefaultRow", "sessionSelectionRow", "DEFAULT_SELECTION", html.slice(defaultStart, defaultEnd) + "return defaultSessionFor;")(
    (rows) => rows[0] || null, (session) => ({ identity: session.runId }), {},
  );
  assert.equal(defaultSessionFor({ sessions: [] }, ""), "");
  assert.equal(defaultSessionFor({ sessions: [{ runId: "policy-chosen" }, { runId: "newest" }] }, ""), "policy-chosen");
});

// Exercise both shipped page functions with the real controller and loader.
// Only network, rendering and the final navigation sink are substituted.
function pageCatalogHarness({ read, selectedProjectId = "", selectedRunId = "" }) {
  const html = renderLiveControlRoomPage();
  const start = html.indexOf("  async function applyProjectCatalog(");
  const end = html.indexOf("  function showEmpty(", start);
  const initial = { selectedProjectId, selectedRunId };
  return new Function("read", "initial", "createLiveProjectCatalogLoader", "URL", "AbortController", "setTimeout", "clearTimeout", `
    let catalogAvailable = false, projectCatalog = [], catalogLoader = null;
    let selectedProjectId = initial.selectedProjectId, selectedRunId = initial.selectedRunId;
    const navigation = [], requests = [], projectImportUi = null, currentSnapshot = {};
    const projectsEndpoint = "/api/projects", DEFAULT_SELECTION = {};
    const window = { location: { href: "http://127.0.0.1:4319/?keep=current" }, setTimeout, clearTimeout };
    const fetch = async (url) => { requests.push(url); return { ok: true, json: read }; };
    const normalizeCatalog = (catalog) => catalog;
    const selectionFromLocation = () => ({ projectId: "", runId: "" });
    const populateProjectSelect = () => {}, populateSessionSelect = () => {}, renderRunOverview = () => {}, setHubStatus = () => {}, showEmpty = () => {};
    const projectSelectionRow = (project) => ({ project });
    const pickDefaultRow = (rows) => rows[0] || null;
    const switchSelection = async (projectId, runId, { updateUrl = true } = {}) => {
      navigation.push([projectId, runId, updateUrl]);
      selectedProjectId = projectId; selectedRunId = runId;
      if (updateUrl) window.location.href = "http://127.0.0.1:4319/?projectId=" + projectId + "&runId=" + runId;
    };
    ${html.slice(start, end)}
    return { applyProjectCatalog, loadProjectCatalog, switchSelection,
      inspect: () => ({ projectCatalog, selectedProjectId, selectedRunId, url: window.location.href, navigation, requests }) };
  `)(read, initial, createLiveProjectCatalogLoader, URL, AbortController, setTimeout, clearTimeout);
}
const indexedCatalog = (projects) => ({ projects, selected: { projectId: projects[0]?.projectId || "", runId: projects[0]?.sessions?.[0]?.runId || "" } });
const importedWithRun = { ...project, sessions: [{ runId: "imported-run" }] };
const otherWithRun = { projectId: "other-project", displayName: "Other", sessions: [{ runId: "other-run" }] };

test("real page apply+load/controller: cancel while the first post-import catalog is delayed never selects or changes URL", async (t) => {
  const pending = deferred();
  const page = pageCatalogHarness({ read: () => pending.promise });
  const before = page.inspect();
  const h = harness(t, { refreshCatalog: page.loadProjectCatalog, selectProjectRun: page.switchSelection });
  await h.controller.check(); const commit = h.controller.confirm(); await settle();
  assert.equal(h.controller.getState().phase, "refreshing");
  assert.equal(page.inspect().requests.length, 1);
  h.controller.close();
  pending.resolve(indexedCatalog([importedWithRun])); await commit;
  const after = page.inspect();
  assert.deepEqual(after.projectCatalog, [importedWithRun]);
  assert.deepEqual(after.navigation, []);
  assert.equal(after.url, before.url); assert.equal(after.selectedProjectId, ""); assert.equal(after.selectedRunId, "");
  assert.equal(h.controller.getState().active, false);
});

test("real page apply+load/controller: missing imported target never defaults to another project, including an initially empty selection", async (t) => {
  for (const initial of [{ selectedProjectId: "", selectedRunId: "" }, { selectedProjectId: "keep-project", selectedRunId: "keep-run" }]) {
    const page = pageCatalogHarness({ read: async () => indexedCatalog([otherWithRun]), ...initial });
    const before = page.inspect();
    const h = harness(t, { refreshCatalog: page.loadProjectCatalog, selectProjectRun: page.switchSelection });
    await h.controller.check(); await h.controller.confirm();
    const after = page.inspect();
    assert.deepEqual(after.projectCatalog, [otherWithRun]); assert.deepEqual(after.navigation, []);
    assert.equal(after.url, before.url); assert.equal(after.selectedProjectId, before.selectedProjectId); assert.equal(after.selectedRunId, before.selectedRunId);
    assert.equal(h.controller.getState().phase, "imported_pending"); assert.equal(h.controller.getState().notice, "importedPending");
  }
});

test("real page apply+load/controller: target present navigates exactly once through the current controller, not the catalog default", async (t) => {
  const page = pageCatalogHarness({ read: async () => indexedCatalog([otherWithRun, importedWithRun]) });
  const h = harness(t, { refreshCatalog: page.loadProjectCatalog, selectProjectRun: page.switchSelection });
  await h.controller.check(); await h.controller.confirm();
  assert.deepEqual(page.inspect().navigation, [[project.projectId, "", true]]);
  assert.equal(h.controller.getState().phase, "opened");
});

test("real page load: normal startup and polling retain default selection and explicit-current preservation", async () => {
  const first = pageCatalogHarness({ read: async () => indexedCatalog([otherWithRun]) });
  await first.loadProjectCatalog();
  assert.deepEqual(first.inspect().navigation, [[otherWithRun.projectId, "other-run", true]]);
  const poll = pageCatalogHarness({ read: async () => indexedCatalog([otherWithRun]) });
  await poll.loadProjectCatalog({ refresh: true });
  assert.deepEqual(poll.inspect().navigation, [[otherWithRun.projectId, "other-run", true]]);
  const selected = pageCatalogHarness({ read: async () => indexedCatalog([otherWithRun]), selectedProjectId: "keep-project", selectedRunId: "keep-run" });
  await selected.loadProjectCatalog({ refresh: true });
  assert.deepEqual(selected.inspect().navigation, [["keep-project", "keep-run", false]]);
});

test("queued catalog refreshes retain their own selection policy instead of merging import with normal navigation", async () => {
  const firstRead = deferred(); const policies = []; let reads = 0;
  const loader = createLiveProjectCatalogLoader({ read: async () => ++reads === 1 ? firstRead.promise : indexedCatalog([importedWithRun]),
    apply: async (_catalog, options) => { policies.push(options.catalogOnly); return !options.catalogOnly; } });
  const first = loader.load();
  const normal = loader.load({ refresh: true, afterCurrent: true });
  const imported = loader.load({ refresh: true, afterCurrent: true, catalogOnly: true });
  assert.notEqual(normal, imported);
  firstRead.resolve(indexedCatalog([]));
  await first; assert.equal((await normal).selected, true); assert.equal((await imported).selected, false);
  assert.deepEqual(policies, [false, false, true]);
  assert.equal(reads, 3);
});

test("actual entry markup reuses one dialog, labels path/errors, and retains focus-trap/Escape/restoration and narrow-screen touch rules", () => {
  const pane = renderLiveProjectImportPane(); const html = renderLiveControlRoomPage();
  assert.doesNotMatch(pane, /role="dialog"|aria-modal/u);
  assert.match(pane, /label for="project-import-path"/u);
  assert.match(pane, /aria-describedby="project-import-help project-import-error"/u);
  assert.match(pane, /data-project-import-status role="status" aria-live="polite"/u);
  assert.match(pane, /data-project-import-error role="alert"/u);
  assert.match(html, /data-live-sessions-dialog[\s\S]*data-project-import-pane[\s\S]*data-project-records-pane/u);
  assert.match(html, /class="topbar-button project-import-entry"/u);
  assert.match(renderLiveWorkspaceNavigation(), /data-uw-project-switch[\s\S]*data-project-import-entry/u);
  assert.doesNotMatch(renderLiveWorkspaceSurface(), /data-uw-chat-switch-repo[^\n]*data-project-import-entry/u);
  assert.match(html, /\.shell:not\(\[data-nav-collapsed="true"\]\) \.topbar-actions > \[data-project-import-entry\] \{ display: none/u);
  assert.match(renderLiveWorkspaceSurface(), /data-project-import-empty/u);
  assert.match(html, /function trapDialogFocus\(event\)/u); assert.match(html, /dialogOpener\.focus\(\)/u);
  assert.match(html, /event\.key === "Escape"/u);
  assert.match(html, /\[data-project-import-entry\], \.project-import-pane button \{ min-height: 44px/u);
  assert.match(html, /white-space: pre-wrap; overflow-wrap: anywhere/u);
  assert.match(html, /\.live-dialog:has\(\.project-import-pane:not\(\[hidden\]\)\) \.dialog-card \{ max-height: calc\(100dvh - 32px\)/u);
});
