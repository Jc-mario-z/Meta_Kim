import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { createLiveProjectImportService, LIVE_PROJECT_IMPORT_SCHEMA } from "../../src/application/live/live-project-import-service.mjs";
import { createLiveHubProjectCatalog } from "../../src/infrastructure/live/live-hub-project-catalog.mjs";
import { buildProjectRef, getProjectRegistryPaths, inspectProjectRegistry, joinProjectRegistry, readProjectRegistryEntry, skipProjectRegistry } from "../../scripts/project-registry.mjs";
import { createInitialState, createMetaRunStatusEnvelope } from "../../canonical/runtime-assets/shared/hooks/spine-state.mjs";
import { importDatabaseSync } from "../../src/data/sqlite/runtime.mjs";

async function fixture(t, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-project-import-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const homeDir = path.join(root, "home");
  const projectRoot = path.join(root, "project");
  await fs.mkdir(projectRoot);
  const profile = options.profile || "default";
  const service = createLiveProjectImportService({ homeDir, profile, ...options });
  return { root, projectRoot, homeDir, profile, service };
}
async function json(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value));
  return file;
}
function status(stage = "fetch", overrides = {}) {
  const state = createInitialState({ taskClassification: "standard_path", triggerReason: "user_invocation", sourceRuntime: "codex" });
  state.currentStage = stage;
  state.stages[stage].status = "in_progress";
  if (stage !== "critical") state.stages.critical.status = "completed";
  return { ...createMetaRunStatusEnvelope(state), ...overrides };
}
async function durable(f, record = status()) {
  return json(path.join(f.projectRoot, ".meta-kim", "state", f.profile, "runs", record.runId, "status.json"), record);
}
function analysis(overrides = {}) {
  return { schemaVersion: 1, runId: "meta-analysis-import", status: "partial", task: "Private analysis not for the response",
    taskFingerprint: "task-current-request", coreLoop: { intentPacket: { realIntent: "Understand existing project" }, fetchPacket: { evidence: [{ source: "local" }] } }, ...overrides };
}
async function artifact(f, record = analysis()) {
  return json(path.join(f.projectRoot, ".meta-kim", "state", f.profile, "governed-executions", `${record.runId}.json`), record);
}
async function snapshot(root) {
  const result = {};
  async function walk(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name), relative = path.relative(root, file);
      if (entry.isDirectory()) { result[relative] = "directory"; await walk(file); }
      else if (entry.isFile()) { const stat = await fs.stat(file); result[relative] = [stat.mtimeMs, createHash("sha256").update(await fs.readFile(file)).digest("hex")]; }
      else result[relative] = "link";
    }
  }
  await walk(root);
  return result;
}
const rejects = (action, code) => assert.rejects(action, (error) => error.code === code);

for (const kind of ["governed analysis", "ongoing status", "blocked status", "failed progressed status", "global-only analysis"]) {
  test(`preview is zero-write and admits ${kind}`, async (t) => {
    const f = await fixture(t);
    if (kind.includes("analysis")) await artifact(f, analysis({ status: kind === "global-only analysis" ? "failed" : "partial" }));
    else await durable(f, kind === "blocked status" ? status("critical", { blockedOn: "missing required evidence" })
      : kind === "failed progressed status" ? status("execution", { blockedOn: "execution worker failed", workerLifecycle: [{ status: "failed" }] }) : status());
    const before = await snapshot(f.root);
    const preview = await f.service.preview({ projectPath: f.projectRoot });
    assert.deepEqual(await snapshot(f.root), before);
    assert.equal(preview.schemaVersion, LIVE_PROJECT_IMPORT_SCHEMA);
    assert.equal(preview.status, "ready");
    assert.match(preview.previewToken, /^[A-Za-z0-9_-]{43}$/u);
    assert.equal(preview.project.projectPath, f.projectRoot);
    assert.equal(preview.project.evidenceCount, 1);
    assert.doesNotMatch(JSON.stringify(preview), /Private analysis|Understand existing project|missing required evidence/u);
    await assert.rejects(fs.stat(getProjectRegistryPaths(f).projectRegistryPath), { code: "ENOENT" });
  });
}

for (const kind of ["empty", "git-only", "installed", "bootstrap-only", "activation-only", "native-chat", "cross-project", "wrong-profile", "wrong-run", "wrong-schema", "empty-analysis", "fixture-analysis", "malformed", "state-link"]) {
  test(`rejects ${kind} without creating registry`, async (t) => {
    const f = await fixture(t);
    if (kind === "git-only") await fs.mkdir(path.join(f.projectRoot, ".git"));
    if (kind === "installed") await fs.mkdir(path.join(f.projectRoot, ".meta-kim"));
    if (kind === "bootstrap-only") await json(path.join(f.projectRoot, ".meta-kim/state/default/project-bootstrap.json"), { schemaVersion: 1 });
    if (kind === "activation-only") await durable(f, status("critical"));
    if (kind === "native-chat") await json(path.join(f.projectRoot, ".meta-kim/state/default/runs/native-codex-chat/status.json"), { ...status(), runId: "native-codex-chat" });
    if (kind === "cross-project") await artifact(f, analysis({ projectRoot: path.join(f.root, "unrelated") }));
    if (kind === "wrong-profile") await artifact(f, analysis({ profile: "another" }));
    if (kind === "wrong-run") await json(path.join(f.projectRoot, ".meta-kim/state/default/governed-executions/meta-other.json"), analysis());
    if (kind === "wrong-schema") await artifact(f, analysis({ schemaVersion: "unknown" }));
    if (kind === "empty-analysis") await artifact(f, analysis({ coreLoop: {} }));
    if (kind === "fixture-analysis") await artifact(f, analysis({ recordOrigin: "acceptance_fixture" }));
    if (kind === "malformed") { const file = await artifact(f); await fs.writeFile(file, "{broken"); }
    if (kind === "state-link") {
      const other = path.join(f.root, "other"); await fs.mkdir(other);
      await artifact({ ...f, projectRoot: other });
      await fs.symlink(path.join(other, ".meta-kim"), path.join(f.projectRoot, ".meta-kim"));
    }
    const before = await snapshot(f.root);
    await rejects(() => f.service.preview({ projectPath: f.projectRoot }), "project_import_not_governed");
    assert.deepEqual(await snapshot(f.root), before);
  });
}

test("analysis evidence is not starved by active activation and 31 bare run statuses", async (t) => {
  const f = await fixture(t);
  await json(path.join(f.projectRoot, ".meta-kim/state/default/active-run.json"), status("critical"));
  for (let i = 0; i < 31; i++) await durable(f, status("critical", { runId: `meta-bare-${String(i).padStart(3, "0")}` }));
  await artifact(f);
  const before = await snapshot(f.root);
  const p = await f.service.preview({ projectPath: f.projectRoot });
  assert.equal(p.status, "ready");
  assert.deepEqual(await snapshot(f.root), before);
  assert.equal((await f.service.confirm({ previewToken: p.previewToken })).status, "imported");
});

test("durable evidence is not starved by 32 nonqualifying analysis artifacts", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 32; i++) await artifact(f, analysis({ runId: `meta-empty-${String(i).padStart(3, "0")}`, coreLoop: {} }));
  await durable(f);
  assert.equal((await f.service.preview({ projectPath: f.projectRoot })).status, "ready");
});

test("unexamined records at read budget exhaustion mean unavailable, not not-governed", async (t) => {
  const f = await fixture(t);
  await json(path.join(f.projectRoot, ".meta-kim/state/default/active-run.json"), status("critical"));
  for (let i = 0; i < 32; i++) await durable(f, status("critical", { runId: `meta-bare-${String(i).padStart(3, "0")}` }));
  const before = await snapshot(f.root);
  await rejects(() => f.service.preview({ projectPath: f.projectRoot }), "project_import_unavailable");
  assert.deepEqual(await snapshot(f.root), before);
});

test("truncated directory discovery means unavailable, not absence of governance", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 129; i++) await json(path.join(f.projectRoot, ".meta-kim/state/default/governed-executions", `ignored-${i}.json`), {});
  await rejects(() => f.service.preview({ projectPath: f.projectRoot }), "project_import_unavailable");
  await assert.rejects(fs.stat(getProjectRegistryPaths(f).projectRegistryPath), { code: "ENOENT" });
});

for (const location of ["top", "coreLoop", "run"]) {
  for (const field of ["projectRoot", "repoRoot", "projectRef", "profile", "runId"]) {
    test(`rejects conflicting ${location}.projectContextPacket.${field}`, async (t) => {
      const f = await fixture(t);
      const record = analysis();
      const context = { schemaVersion: 1, [field]: field === "profile" ? "other-profile"
        : field === "runId" ? "meta-other-run" : field === "projectRef" ? "project-000000000000" : path.join(f.root, "unrelated") };
      if (location === "top") record.projectContextPacket = context;
      else { record[location] ||= {}; record[location].projectContextPacket = context; }
      await artifact(f, record);
      await rejects(() => f.service.preview({ projectPath: f.projectRoot }), "project_import_not_governed");
      await assert.rejects(fs.stat(getProjectRegistryPaths(f).projectRegistryPath), { code: "ENOENT" });
    });
  }
}

test("producer projectContextPacket without a root is admitted; explicit matching context is admitted", async (t) => {
  const f = await fixture(t);
  const producerContext = { schemaVersion: 1, lifecycle: "new_project", modules: [], sources: [],
    worktree: { status: "not_a_git_worktree", changedPaths: [], truncated: false }, relatedCode: {}, limitations: [],
    stagePosition: "before_critical", nextStage: "Critical", authority: "observed_project_facts_not_user_intent_or_execution_permission" };
  await artifact(f, analysis({ projectContextPacket: producerContext }));
  assert.equal((await f.service.preview({ projectPath: f.projectRoot })).status, "ready");
  await artifact(f, analysis({ projectContextPacket: { ...producerContext, projectRoot: f.projectRoot,
    projectRef: buildProjectRef({ repoPath: f.projectRoot }), profile: f.profile, runId: analysis().runId } }));
  assert.equal((await f.service.preview({ projectPath: f.projectRoot })).status, "ready");
});

test("invalid paths, bodies and missing paths fail closed", async (t) => {
  const f = await fixture(t);
  for (const projectPath of [null, 5, "", "relative", "~/project", "//network/project", "/bad\0path"]) {
    await rejects(() => f.service.preview({ projectPath }), "project_import_invalid_path");
  }
  await rejects(() => f.service.preview({ projectPath: f.projectRoot, owner: "attacker" }), "project_import_invalid_path");
  await rejects(() => f.service.preview({ projectPath: path.join(f.root, "missing") }), "project_import_path_unavailable");
});

test("import persists exactly the governed_live source; repeated/concurrent confirms are idempotent", async (t) => {
  let invalidations = 0;
  const f = await fixture(t, { onRegistered: () => { invalidations++; } });
  await artifact(f);
  const preview = await f.service.preview({ projectPath: f.projectRoot });
  const body = { previewToken: preview.previewToken };
  const results = await Promise.all(Array.from({ length: 8 }, () => f.service.confirm(body)));
  for (const result of results) assert.deepEqual(result, { schemaVersion: LIVE_PROJECT_IMPORT_SCHEMA, status: "imported", projectId: preview.project.projectId });
  assert.deepEqual(await f.service.confirm(body), results[0]);
  assert.equal(invalidations, 1);
  const entry = await readProjectRegistryEntry({ homeDir: f.homeDir, repoPath: f.projectRoot });
  assert.equal(entry.project.enrollmentStatus, "joined");
  assert.deepEqual(entry.sources.map(({ sourceType, sourceRef }) => [sourceType, sourceRef]), [["governed_live", "meta-kim-live-import"]]);
  const next = await f.service.preview({ projectPath: f.projectRoot });
  assert.equal(next.status, "already_registered");
  const before = await snapshot(f.root);
  assert.equal((await f.service.confirm({ previewToken: next.previewToken })).status, "already_registered");
  assert.deepEqual(await snapshot(f.root), before);
});

test("existing registry preview and already-registered confirmation do not write", async (t) => {
  const f = await fixture(t); await durable(f);
  await joinProjectRegistry({ homeDir: f.homeDir, repoPath: f.projectRoot });
  const before = await snapshot(f.root);
  const p = await f.service.preview({ projectPath: f.projectRoot });
  assert.deepEqual(await snapshot(f.root), before);
  await f.service.confirm({ previewToken: p.previewToken });
  assert.deepEqual(await snapshot(f.root), before);
});

test("skipped projects require explicit confirmation; preview and reject preserve skip", async (t) => {
  const f = await fixture(t); await durable(f);
  await skipProjectRegistry({ homeDir: f.homeDir, repoPath: f.projectRoot });
  const p = await f.service.preview({ projectPath: f.projectRoot });
  assert.equal(p.project.previouslySkipped, true);
  const before = await snapshot(f.root);
  await rejects(() => f.service.confirm({ previewToken: p.previewToken }), "project_import_skipped_confirmation_required");
  assert.deepEqual(await snapshot(f.root), before);
  assert.equal((await f.service.confirm({ previewToken: p.previewToken, confirmPreviouslySkipped: true })).status, "imported");
});

test("expiry, unguessable/instance-local tokens, and completed retry retention", async (t) => {
  let clock = 1000;
  const f = await fixture(t, { now: () => clock, ttlMs: 10 }); await durable(f);
  const first = await f.service.preview({ projectPath: f.projectRoot });
  const second = await f.service.preview({ projectPath: f.projectRoot });
  assert.notEqual(first.previewToken, second.previewToken);
  const other = createLiveProjectImportService({ homeDir: f.homeDir });
  await rejects(() => other.confirm({ previewToken: first.previewToken }), "project_import_preview_expired");
  clock = 1011;
  await rejects(() => f.service.confirm({ previewToken: first.previewToken }), "project_import_preview_expired");
  const fresh = await f.service.preview({ projectPath: f.projectRoot });
  const result = await f.service.confirm({ previewToken: fresh.previewToken });
  clock = 1030;
  assert.deepEqual(await f.service.confirm({ previewToken: fresh.previewToken }), result);
});

test("token storage is bounded without evicting usable previews", async (t) => {
  const f = await fixture(t); await durable(f);
  const previews = [];
  for (let i = 0; i < 128; i++) previews.push(await f.service.preview({ projectPath: f.projectRoot }));
  await rejects(() => f.service.preview({ projectPath: f.projectRoot }), "project_import_unavailable");
  assert.equal((await f.service.confirm({ previewToken: previews[0].previewToken })).status, "imported");
});

for (const mutation of ["content", "delete", "symlink", "skip", "redirect"]) {
  test(`confirmation rechecks ${mutation}`, async (t) => {
    const f = await fixture(t); const file = await durable(f);
    const alias = path.join(f.root, "alias");
    if (mutation === "redirect") await fs.symlink(f.projectRoot, alias);
    const p = await f.service.preview({ projectPath: mutation === "redirect" ? alias : f.projectRoot });
    if (mutation === "content") await fs.appendFile(file, " ");
    if (mutation === "delete") await fs.rm(file);
    if (mutation === "symlink") { const copy = path.join(f.root, "copy.json"); await fs.copyFile(file, copy); await fs.rm(file); await fs.symlink(copy, file); }
    if (mutation === "skip") await skipProjectRegistry({ homeDir: f.homeDir, repoPath: f.projectRoot });
    if (mutation === "redirect") { const other = path.join(f.root, "other"); await fs.mkdir(other); await fs.unlink(alias); await fs.symlink(other, alias); }
    await rejects(() => f.service.confirm({ previewToken: p.previewToken }), "project_import_preview_stale");
    assert.equal((await inspectProjectRegistry({ homeDir: f.homeDir, repoPath: f.projectRoot })).joinedProjectRefs.length, 0);
  });
}

test("only selected evidence content matters, not unrelated runs or logs", async (t) => {
  const f = await fixture(t); await durable(f);
  const p = await f.service.preview({ projectPath: f.projectRoot });
  await artifact(f); await fs.writeFile(path.join(f.projectRoot, "unrelated.log"), "noise");
  assert.equal((await f.service.confirm({ previewToken: p.previewToken })).status, "imported");
});

test("canonicalizes explicit symlink alias while persisting canonical root", async (t) => {
  const f = await fixture(t); await durable(f);
  const alias = path.join(f.root, "alias"); await fs.symlink(f.projectRoot, alias);
  const p = await f.service.preview({ projectPath: alias });
  assert.equal(p.project.projectPath, f.projectRoot);
  await f.service.confirm({ previewToken: p.previewToken });
  assert.equal((await inspectProjectRegistry({ homeDir: f.homeDir, repoPath: f.projectRoot })).project.repoRoot, f.projectRoot);
});

test("profile-specific evidence does not bleed between server instances", async (t) => {
  const f = await fixture(t, { profile: "work" }); await durable(f);
  await rejects(() => createLiveProjectImportService({ homeDir: f.homeDir, profile: "default" }).preview({ projectPath: f.projectRoot }), "project_import_not_governed");
  assert.equal((await f.service.preview({ projectPath: f.projectRoot })).project.profile, "work");
});

test("full catalog refuses preview before registry creation, including bound seed", async (t) => {
  const f = await fixture(t, { maxProjects: 1, seedProjectRoot: "/reserved/agent" }); await durable(f);
  await rejects(() => f.service.preview({ projectPath: f.projectRoot }), "project_import_catalog_full");
  await assert.rejects(fs.stat(getProjectRegistryPaths(f).projectRegistryPath), { code: "ENOENT" });
});

test("capacity rechecked at confirmation and atomically in registry transaction", async (t) => {
  const f = await fixture(t, { maxProjects: 1 }); await durable(f);
  const p = await f.service.preview({ projectPath: f.projectRoot });
  await joinProjectRegistry({ homeDir: f.homeDir, repoPath: path.join(f.root, "external-enrollment") });
  await rejects(() => f.service.confirm({ previewToken: p.previewToken }), "project_import_catalog_full");
  await rejects(() => joinProjectRegistry({ homeDir: f.homeDir, repoPath: f.projectRoot,
    importPolicy: { maxProjects: 1, reservedProjectRefs: [], previouslySkipped: false } }), "project_import_catalog_full");
  assert.equal((await inspectProjectRegistry({ homeDir: f.homeDir, repoPath: f.projectRoot })).project, null);
});

test("different preview tokens race for last slot: one transaction wins", async (t) => {
  const f = await fixture(t, { maxProjects: 1 }); await durable(f);
  const second = { ...f, projectRoot: path.join(f.root, "second") }; await fs.mkdir(second.projectRoot); await durable(second);
  const previews = await Promise.all([f.service.preview({ projectPath: f.projectRoot }), f.service.preview({ projectPath: second.projectRoot })]);
  const independent = createLiveProjectImportService({ homeDir: f.homeDir, maxProjects: 1 });
  const independentPreview = await independent.preview({ projectPath: second.projectRoot });
  const results = await Promise.allSettled([f.service.confirm({ previewToken: previews[0].previewToken }), independent.confirm({ previewToken: independentPreview.previewToken })]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.find((r) => r.status === "rejected").reason.code, "project_import_catalog_full");
  assert.equal((await inspectProjectRegistry({ homeDir: f.homeDir, repoPath: f.projectRoot })).joinedProjectRefs.length, 1);
});

test("commit survives cache refresh failure and retry returns completed result", async (t) => {
  const f = await fixture(t, { onRegistered: () => { throw new Error("cache rebuild failed"); } }); await durable(f);
  const p = await f.service.preview({ projectPath: f.projectRoot });
  const first = await f.service.confirm({ previewToken: p.previewToken });
  assert.equal(first.status, "imported");
  assert.deepEqual(await f.service.confirm({ previewToken: p.previewToken }), first);
});

test("corrupt registry is not initialized or repaired by preview", async (t) => {
  const f = await fixture(t); await artifact(f);
  const { projectRegistryPath } = getProjectRegistryPaths(f);
  await fs.mkdir(path.dirname(projectRegistryPath), { recursive: true }); await fs.writeFile(projectRegistryPath, "not sqlite");
  const before = await snapshot(f.root);
  await rejects(() => f.service.preview({ projectPath: f.projectRoot }), "project_import_failed");
  assert.deepEqual(await snapshot(f.root), before);
});

test("import policy preserves skipped state under transaction race", async (t) => {
  const f = await fixture(t); await durable(f);
  await skipProjectRegistry({ homeDir: f.homeDir, repoPath: f.projectRoot });
  await rejects(() => joinProjectRegistry({ homeDir: f.homeDir, repoPath: f.projectRoot,
    importPolicy: { maxProjects: 128, reservedProjectRefs: [], previouslySkipped: false } }), "project_import_preview_stale");
  assert.equal((await inspectProjectRegistry({ homeDir: f.homeDir, repoPath: f.projectRoot })).project.enrollmentStatus, "skipped");
});

test("nonempty WAL refuses uncertain readonly inspection without touching sidecars", async (t) => {
  const f = await fixture(t); await durable(f);
  await joinProjectRegistry({ homeDir: f.homeDir, repoPath: path.join(f.root, "existing") });
  const Database = await importDatabaseSync();
  const db = new Database(getProjectRegistryPaths(f).projectRegistryPath);
  try {
    db.exec("PRAGMA wal_autocheckpoint=0; UPDATE projects SET display_name='pending checkpoint'");
    const before = await snapshot(f.root);
    await rejects(() => f.service.preview({ projectPath: f.projectRoot }), "project_import_unavailable");
    assert.deepEqual(await snapshot(f.root), before);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    assert.equal((await f.service.preview({ projectPath: f.projectRoot })).status, "ready");
  } finally { db.close(); }
});

test("actual 128-entry catalog boundary rejects the 129th without registration", async (t) => {
  const f = await fixture(t); await durable(f);
  for (let i = 0; i < 128; i++) await joinProjectRegistry({ homeDir: f.homeDir, repoPath: path.join(f.root, `enrolled-${i}`) });
  const before = await snapshot(f.root);
  await rejects(() => f.service.preview({ projectPath: f.projectRoot }), "project_import_catalog_full");
  assert.deepEqual(await snapshot(f.root), before);
  assert.equal((await inspectProjectRegistry({ homeDir: f.homeDir, repoPath: f.projectRoot })).joinedProjectRefs.length, 128);
});

test("filling the last catalog slot is visible in the catalog immediately", async (t) => {
  const f = await fixture(t, { maxProjects: 2 }); await durable(f);
  const existingRoot = path.join(f.root, "existing");
  await fs.mkdir(path.join(existingRoot, ".git"), { recursive: true });
  await joinProjectRegistry({ homeDir: f.homeDir, repoPath: existingRoot });
  const p = await f.service.preview({ projectPath: f.projectRoot });
  assert.equal(p.status, "ready");
  const c = await f.service.confirm({ previewToken: p.previewToken });
  assert.equal(c.status, "imported");
  // The same maxProjects bound applies to registration and the catalog: the
  // last accepted slot must be listed, never enrolled-but-invisible.
  const catalog = createLiveHubProjectCatalog({ homeDir: f.homeDir, maxProjects: 2 });
  const projects = await catalog.listProjects();
  assert.deepEqual(projects.map((project) => project.projectRef).sort(),
    [buildProjectRef({ repoPath: existingRoot }), c.projectId].sort());
});

test("oversized evidence is rejected without unrestricted file reading", async (t) => {
  const f = await fixture(t);
  const file = await artifact(f);
  await fs.truncate(file, 8 * 1024 * 1024 + 1);
  await rejects(() => f.service.preview({ projectPath: f.projectRoot }), "project_import_unavailable");
  await assert.rejects(fs.stat(getProjectRegistryPaths(f).projectRegistryPath), { code: "ENOENT" });
});

test("zero-byte/schema-incomplete registries are not initialized on preview", async (t) => {
  const f = await fixture(t); await durable(f);
  const file = getProjectRegistryPaths(f).projectRegistryPath;
  await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, "");
  const before = await snapshot(f.root);
  await rejects(() => f.service.preview({ projectPath: f.projectRoot }), "project_import_failed");
  assert.deepEqual(await snapshot(f.root), before);
});

test("a second preview for one project observes concurrent enrollment without another source write", async (t) => {
  const f = await fixture(t); await durable(f);
  const first = await f.service.preview({ projectPath: f.projectRoot });
  const second = await f.service.preview({ projectPath: f.projectRoot });
  const results = await Promise.all([f.service.confirm({ previewToken: first.previewToken }), f.service.confirm({ previewToken: second.previewToken })]);
  assert.equal(results.filter((r) => r.status === "imported").length, 1);
  assert.equal(results.filter((r) => r.status === "already_registered").length, 1);
});

test("transaction write failure rolls back all enrollment rows", async (t) => {
  const f = await fixture(t);
  await assert.rejects(joinProjectRegistry({ homeDir: f.homeDir, repoPath: f.projectRoot,
    importPolicy: { maxProjects: 128, reservedProjectRefs: [], previouslySkipped: false },
    onWriteStep(step) { if (step === "source") throw new Error("injected transaction fault"); } }), /injected transaction fault/u);
  const Database = await importDatabaseSync(); const db = new Database(getProjectRegistryPaths(f).projectRegistryPath, { readOnly: true });
  try { for (const table of ["projects", "project_platforms", "project_sources"]) assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0); }
  finally { db.close(); }
});
