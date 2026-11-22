import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { request as httpRequest } from "node:http";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { createLiveControlRoomServer } from "../../src/infrastructure/live/live-control-room-server.mjs";
import { createLiveHubProjectCatalog } from "../../src/infrastructure/live/live-hub-project-catalog.mjs";
import { createInitialState, createMetaRunStatusEnvelope } from "../../canonical/runtime-assets/shared/hooks/spine-state.mjs";
import { getProjectRegistryPaths, inspectProjectRegistry, joinProjectRegistry } from "../../scripts/project-registry.mjs";

const SCHEMA = "meta-kim-live-project-import-v1";
const previewPath = "/api/projects/import/preview";
const confirmPath = "/api/projects/import/confirm";
const emptyService = { getSnapshot: async () => null, getReplay: async () => null, getShare: async () => null };
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-import-http-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const homeDir = path.join(root, "home"), projectRoot = path.join(root, "project");
  await fs.mkdir(projectRoot);
  const state = createInitialState({ taskClassification: "standard_path", triggerReason: "user_invocation", sourceRuntime: "codex" });
  state.currentStage = "fetch"; state.stages.critical.status = "completed"; state.stages.fetch.status = "in_progress";
  const envelope = createMetaRunStatusEnvelope(state);
  const statusFile = path.join(projectRoot, ".meta-kim/state/default/runs", envelope.runId, "status.json");
  await fs.mkdir(path.dirname(statusFile), { recursive: true }); await fs.writeFile(statusFile, JSON.stringify(envelope));
  return { root, homeDir, projectRoot };
}
async function start(t, f, options = {}) {
  const server = createLiveControlRoomServer({ homeDir: f.homeDir, globalHub: true, service: emptyService, port: 0, ...options });
  t.after(() => server.close());
  const address = await server.start();
  const page = await (await fetch(address.url)).text();
  const match = page.match(/id="live-workspace-config">([^<]+)</u);
  assert.ok(match, "page emits workspace configuration");
  const config = JSON.parse(match[1]);
  return { server, address, config, token: config.controlToken };
}
async function post(s, endpoint, body, headers = {}) {
  return fetch(`${s.address.url}${endpoint}`, { method: "POST", headers: {
    origin: s.address.url, "content-type": "application/json", "x-meta-kim-workspace-token": s.token, ...headers,
  }, body: typeof body === "string" ? body : JSON.stringify(body) });
}
async function preview(s, f) {
  const response = await post(s, previewPath, { projectPath: f.projectRoot });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
async function confirm(s, p) {
  const response = await post(s, confirmPath, { previewToken: p.previewToken });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
async function treeSnapshot(root) {
  const result = {};
  async function walk(directory) {
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      const relative = path.relative(root, file).split(path.sep).join("/");
      if (entry.isDirectory()) { result[relative] = "directory"; await walk(file); }
      else if (entry.isFile()) {
        const info = await fs.stat(file);
        result[relative] = `${info.size}:${info.mtimeMs}:${createHash("sha256").update(await fs.readFile(file)).digest("hex")}`;
      } else result[relative] = "link";
    }
  }
  await walk(root);
  return result;
}
function changedPaths(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => before[key] !== after[key])
    .sort();
}

for (const mode of ["global Hub", "bound Agent"]) {
  test(`${mode}: preview -> confirm -> fresh directory -> persisted restart`, async (t) => {
    const f = await fixture(t);
    const options = mode === "bound Agent" ? { globalHub: false, enableProjectCatalog: true, projectRoot: f.projectRoot } : {};
    const s = await start(t, f, options);
    assert.equal(s.config.projectImportEnabled, true);
    const p = await preview(s, f);
    await assert.rejects(fs.stat(getProjectRegistryPaths(f).projectRegistryPath), { code: "ENOENT" });
    assert.deepEqual(Object.keys(p).sort(), ["schemaVersion", "status", "previewToken", "expiresAt", "project"].sort());
    const c = await confirm(s, p);
    assert.deepEqual(c, { schemaVersion: SCHEMA, status: "imported", projectId: p.project.projectId });
    assert.doesNotMatch(JSON.stringify(c), new RegExp(f.root, "u"));
    const directory = await (await fetch(`${s.address.url}/api/projects`)).json();
    assert.equal(directory.projects.some((row) => row.projectId === c.projectId), true);
    assert.equal(directory.projects.find((row) => row.projectId === c.projectId).sessionCount, 1);
    assert.doesNotMatch(JSON.stringify(directory), new RegExp(f.root, "u"));
    await s.server.close();
    const restart = await start(t, f, options);
    const persisted = await (await fetch(`${restart.address.url}/api/projects`)).json();
    assert.ok(persisted.projects.some((row) => row.projectId === c.projectId));
    const expired = await post(restart, confirmPath, { previewToken: p.previewToken });
    assert.equal(expired.status, 410);
    assert.equal((await expired.json()).error, "project_import_preview_expired");
    const already = await preview(restart, f);
    assert.equal(already.status, "already_registered");
    assert.equal((await confirm(restart, already)).status, "already_registered");
  });
}

test("HTTP double-click confirmation and retry return one completed result", async (t) => {
  const f = await fixture(t), s = await start(t, f), p = await preview(s, f);
  const results = await Promise.all(Array.from({ length: 6 }, () => confirm(s, p)));
  for (const result of results) assert.deepEqual(result, results[0]);
  assert.equal((await inspectProjectRegistry({ homeDir: f.homeDir, repoPath: f.projectRoot })).joinedProjectRefs.length, 1);
});

test("import writes only the registry: no project service, task state or binding change", async (t) => {
  const f = await fixture(t);
  let serviceCreations = 0;
  const s = await start(t, f, {
    createProjectService: () => { serviceCreations += 1; return emptyService; },
  });
  const { projectRegistryPath } = getProjectRegistryPaths({ homeDir: f.homeDir });
  const registryPrefix = path.relative(f.homeDir, projectRegistryPath).split(path.sep).join("/");
  // Enrollment may create the registry database (and SQLite sidecars) only.
  const allowed = new Set([".meta-kim", ".meta-kim/global", registryPrefix,
    `${registryPrefix}-wal`, `${registryPrefix}-shm`, `${registryPrefix}-journal`]);
  const projectBefore = await treeSnapshot(f.projectRoot);
  const homeBefore = await treeSnapshot(f.homeDir);
  const p = await preview(s, f);
  assert.equal(serviceCreations, 0);
  assert.deepEqual(await treeSnapshot(f.projectRoot), projectBefore);
  assert.deepEqual(changedPaths(homeBefore, await treeSnapshot(f.homeDir)), []);
  assert.equal((await confirm(s, p)).status, "imported");
  assert.equal(serviceCreations, 0);
  // A task start or Agent binding write would land under the project state or
  // home tree; any such path is rejected here, not merely left unobserved.
  assert.deepEqual(await treeSnapshot(f.projectRoot), projectBefore);
  const homeAfter = await treeSnapshot(f.homeDir);
  for (const changed of changedPaths(homeBefore, homeAfter)) {
    assert.ok(allowed.has(changed), `import wrote an unexpected path: ${changed}`);
  }
  // The same server instance keeps serving: import never restarts the backend.
  const directory = await (await fetch(`${s.address.url}/api/projects`)).json();
  assert.equal(directory.projects.some((row) => row.projectId === p.project.projectId), true);
  assert.equal(serviceCreations, 0);
});

test("both endpoints require exact same-origin authority, workspace token and JSON", async (t) => {
  const f = await fixture(t), s = await start(t, f), p = await preview(s, f);
  for (const [endpoint, body] of [[previewPath, { projectPath: f.projectRoot }], [confirmPath, { previewToken: p.previewToken }]]) {
    for (const headers of [{ "x-meta-kim-workspace-token": "bad" }, { "x-meta-kim-workspace-token": "" }]) {
      const r = await post(s, endpoint, body, headers);
      assert.equal(r.status, 403); assert.equal((await r.json()).error, "workspace_token_required");
    }
    for (const headers of [{ origin: "http://evil.invalid" }, { origin: "" }, { "content-type": "text/plain" },
      { "content-type": "application/jsonp" }, { "content-type": "application/json-not-really" }]) {
      const r = await post(s, endpoint, body, headers);
      assert.equal(r.status, 403); assert.equal((await r.json()).error, "project_import_same_origin_json_required");
    }
    const badHost = await new Promise((resolve, reject) => {
      const url = new URL(`${s.address.url}${endpoint}`);
      const request = httpRequest(url, { method: "POST", headers: { host: `localhost:${s.address.port}`, origin: s.address.url,
        "content-type": "application/json", "x-meta-kim-workspace-token": s.token } }, (response) => {
        const chunks = []; response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
      });
      request.on("error", reject); request.end(JSON.stringify(body));
    });
    assert.equal(badHost.status, 403); assert.equal(badHost.body.error, "project_import_same_origin_json_required");
    const acceptedJsonType = await post(s, previewPath, { projectPath: f.projectRoot }, { "content-type": "Application/JSON; charset=utf-8" });
    assert.equal(acceptedJsonType.status, 200);
  }
  assert.equal((await inspectProjectRegistry({ homeDir: f.homeDir, repoPath: f.projectRoot })).project, null);
});

test("GET, HEAD and OPTIONS never preview, confirm or create registry", async (t) => {
  const f = await fixture(t), s = await start(t, f);
  for (const endpoint of [previewPath, confirmPath]) for (const method of ["GET", "HEAD", "OPTIONS", "PUT"]) {
    const r = await fetch(`${s.address.url}${endpoint}`, { method, headers: { origin: s.address.url, "x-meta-kim-workspace-token": s.token } });
    assert.equal(r.status, 405); assert.equal(r.headers.get("allow"), "POST");
  }
  await assert.rejects(fs.stat(getProjectRegistryPaths(f).projectRegistryPath), { code: "ENOENT" });
});

test("input whitelist, malformed JSON and bounded byte errors expose no internals", async (t) => {
  const f = await fixture(t), s = await start(t, f, { maxJsonBytes: 256 });
  const p = await preview(s, f);
  for (const [endpoint, body, error] of [
    [previewPath, { projectPath: f.projectRoot, runtime: "shell" }, "project_import_invalid_path"],
    [confirmPath, { previewToken: p.previewToken, projectPath: f.projectRoot }, "project_import_preview_expired"],
    [previewPath, "{broken", "project_import_invalid_path"],
    [previewPath, "[]", "project_import_invalid_path"],
    [confirmPath, "null", "project_import_preview_expired"],
    [confirmPath, { previewToken: p.previewToken, confirmPreviouslySkipped: "true" }, "project_import_preview_expired"],
  ]) {
    const r = await post(s, endpoint, body);
    assert.ok(r.status >= 400); assert.deepEqual(await r.json(), { error });
  }
  for (const endpoint of [previewPath, confirmPath]) {
    const r = await post(s, endpoint, JSON.stringify({ projectPath: "x".repeat(300) }));
    assert.equal(r.status, 413); assert.deepEqual(await r.json(), { error: "project_import_failed" });
  }
  await assert.rejects(fs.stat(getProjectRegistryPaths(f).projectRegistryPath), { code: "ENOENT" });
});

for (const disabled of [{ enableProjectImport: false }, { workspaceEnabled: false }, { globalHub: false, enableProjectCatalog: false }]) {
  test(`import unavailable when ${JSON.stringify(disabled)}`, async (t) => {
    const f = await fixture(t), s = await start(t, f, disabled);
    assert.notEqual(s.config.projectImportEnabled, true);
    for (const endpoint of [previewPath, confirmPath]) {
      const r = await post(s, endpoint, { projectPath: f.projectRoot });
      assert.equal(r.status, 403); assert.equal((await r.json()).error, "project_import_unavailable");
    }
  });
}

test("import is independent of runtime control enableControl", async (t) => {
  const f = await fixture(t), s = await start(t, f, { enableControl: false });
  assert.equal(s.address.controlEnabled, false);
  const p = await preview(s, f); assert.equal((await confirm(s, p)).status, "imported");
});

test("cached and in-flight old catalogs cannot overwrite post-import generation", async (t) => {
  const f = await fixture(t);
  const base = createLiveHubProjectCatalog({ homeDir: f.homeDir });
  let clock = 100, hold = false, release, entered;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const releasePromise = new Promise((resolve) => { release = resolve; });
  const hubCatalog = { ...base, listProjects: async () => {
    const captured = await base.listProjects();
    if (hold) { hold = false; entered(); await releasePromise; }
    return captured;
  } };
  const s = await start(t, f, { hubCatalog, hubCatalogClock: () => clock,
    scanPolicy: { cacheTtlMs: 10, staleWhileRevalidateMs: 0, projectScanConcurrency: 1 } });
  assert.equal((await (await fetch(`${s.address.url}/api/projects`)).json()).projects.length, 0);
  hold = true; clock = 111;
  const oldRequest = fetch(`${s.address.url}/api/projects`);
  await enteredPromise;
  const p = await preview(s, f); const c = await confirm(s, p);
  const immediate = await (await fetch(`${s.address.url}/api/projects`)).json();
  assert.ok(immediate.projects.some((project) => project.projectId === c.projectId));
  release();
  assert.ok((await (await oldRequest).json()).projects.some((project) => project.projectId === c.projectId));
  const after = await (await fetch(`${s.address.url}/api/projects`)).json();
  assert.ok(after.projects.some((project) => project.projectId === c.projectId));
});

test("HTTP capacity refuses import before mutation and leaves directory unchanged", async (t) => {
  const f = await fixture(t);
  await joinProjectRegistry({ homeDir: f.homeDir, repoPath: f.root });
  const s = await start(t, f, { maxProjects: 1 });
  const r = await post(s, previewPath, { projectPath: f.projectRoot });
  assert.equal(r.status, 409); assert.equal((await r.json()).error, "project_import_catalog_full");
  assert.equal((await inspectProjectRegistry({ homeDir: f.homeDir, repoPath: f.projectRoot })).project, null);
});
