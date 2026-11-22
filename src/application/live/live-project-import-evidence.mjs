import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { buildProjectRef } from "../../../scripts/project-registry.mjs";
import { classifyRunSubstance, validateRunId, RUN_LIFECYCLE_STATUSES } from "../../../canonical/runtime-assets/shared/hooks/spine-state.mjs";
import { liveRecordIsGovernedRun } from "./live-record-origin.mjs";

const STAGES = ["critical", "fetch", "thinking", "execution", "review", "meta-review", "verification", "evolution"];
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 128;
const MAX_READS = 32;
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const meaningful = (value) => typeof value === "string" ? Boolean(value.trim())
  : Array.isArray(value) ? value.some(meaningful) : object(value) ? Object.values(value).some(meaningful) : false;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const importError = (code, status = 400) => Object.assign(new Error(code), { code, status });

export async function resolveImportPath(requested) {
  if (typeof requested !== "string" || !requested || requested.length > 4096 || requested.includes("\0") ||
      !path.isAbsolute(requested) || /^(?:\\\\|\/\/)/u.test(requested)) {
    throw importError("project_import_invalid_path");
  }
  try {
    const canonical = await fs.realpath(requested);
    if (!(await fs.stat(canonical)).isDirectory()) throw new Error("not directory");
    return canonical;
  } catch { throw importError("project_import_path_unavailable", 404); }
}

/** No traversal outside the explicitly requested project's fixed state tree. */
async function safeStatePath(root, relative, { directory = false } = {}) {
  if (!relative.startsWith(`.meta-kim${path.sep}state${path.sep}`)) return null;
  const segments = relative.split(path.sep);
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  let current = root;
  try {
    for (let index = 0; index < segments.length; index++) {
      current = path.join(current, segments[index]);
      const info = await fs.lstat(current);
      if (info.isSymbolicLink() || (index < segments.length - 1 || directory ? !info.isDirectory() : !info.isFile())) return null;
    }
    if (await fs.realpath(current) !== current) return null;
    return current;
  } catch { return null; }
}

async function readEvidence(root, relative, budget) {
  if (budget.reads >= MAX_READS || budget.bytes >= MAX_TOTAL_BYTES) {
    budget.incomplete = true;
    return null;
  }
  budget.reads++;
  const target = await safeStatePath(root, relative);
  if (!target) return null;
  let handle;
  try {
    handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    const limit = Math.min(MAX_FILE_BYTES, MAX_TOTAL_BYTES - budget.bytes);
    if (!stat.isFile()) return null;
    if (stat.size > limit) { budget.incomplete = true; return null; }
    const bytes = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
    let size = 0;
    while (size < bytes.length) {
      const read = await handle.read(bytes, size, bytes.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    budget.bytes += size;
    if (size > stat.size || size > limit) { budget.incomplete = true; return null; }
    if (!(await safeStatePath(root, relative))) return null;
    const value = JSON.parse(bytes.subarray(0, size).toString("utf8"));
    return object(value) ? { value, sha256: digest(bytes.subarray(0, size)), relative } : null;
  } catch { return null; }
  finally { await handle?.close(); }
}

async function boundedNames(root, relative, directory, budget) {
  const target = await safeStatePath(root, relative, { directory: true });
  if (!target) return [];
  const names = [];
  try {
    const dir = await fs.opendir(target);
    let visited = 0;
    for await (const entry of dir) {
      if (++visited > MAX_ENTRIES) { budget.incomplete = true; break; }
      if (!entry.isSymbolicLink() && (directory ? entry.isDirectory() : entry.isFile())) names.push(entry.name);
    }
  } catch { return []; }
  return names.sort().reverse();
}

function validIdentity(value, root, profile, expectedRunId = null) {
  try { validateRunId(value.runId); } catch { return false; }
  if ((expectedRunId && value.runId !== expectedRunId) ||
      (value.run?.runId && value.run.runId !== value.runId) || !liveRecordIsGovernedRun(value) ||
      (value.recordOrigin !== undefined && value.recordOrigin !== "governed_run") || value.observationKind === "native_execution") return false;
  // inspectProjectContext currently emits facts/digests, not a mandatory root.
  // Check the actual projectContextPacket slot too whenever it declares identity;
  // absent identity still inherits the fixed in-project evidence path.
  const envelopes = [value, value.run, value.coreLoop];
  const contexts = envelopes.filter(object).map((record) => record.projectContextPacket);
  if (contexts.some((record) => record != null && !object(record))) return false;
  for (const record of [...envelopes, ...contexts]) {
    if (!object(record)) continue;
    if (record.runId !== undefined && record.runId !== value.runId) return false;
    if (record.profile !== undefined && record.profile !== profile) return false;
    for (const key of ["projectRoot", "projectPath", "workspaceRoot", "repoRoot"]) {
      if (record[key] !== undefined && (typeof record[key] !== "string" || !path.isAbsolute(record[key]) || path.resolve(record[key]) !== root)) return false;
    }
    for (const key of ["projectRef", "projectId"]) {
      if (record[key] !== undefined && record[key] !== buildProjectRef({ repoPath: root })) return false;
    }
  }
  return true;
}

function qualifies(value, kind, root, profile, runId) {
  if (!validIdentity(value, root, profile, runId)) return false;
  if (kind === "durable_status") {
    return [1, 2].includes(value.schemaVersion) && typeof value.active === "boolean" &&
      STAGES.includes(value.currentStageKey) && value.stageIndex === STAGES.indexOf(value.currentStageKey) + 1 &&
      value.stageTotal === STAGES.length && Array.isArray(value.completed) &&
      typeof value.startedAt === "string" && Number.isFinite(Date.parse(value.startedAt)) &&
      typeof value.updatedAt === "string" && Number.isFinite(Date.parse(value.updatedAt)) &&
      (value.schemaVersion !== 2 || (value.publicReadyAuthority === false && RUN_LIFECYCLE_STATUSES.includes(value.lifecycleStatus) &&
        (value.active ? value.lifecycleStatus === "active" : value.lifecycleStatus !== "active"))) &&
      classifyRunSubstance(value).substanceClass === "substantive";
  }
  if (value.schemaVersion !== 1 || !object(value.coreLoop) || !meaningful(value.task) || !meaningful(value.taskFingerprint)) return false;
  const critical = value.intentPacket || value.coreLoop.intentPacket || value.coreLoop.criticalPacket;
  const fetch = value.fetchPacket || value.coreLoop.fetchPacket;
  const thinking = value.thinkingPacket || value.coreLoop.thinkingPacket;
  return meaningful(critical?.realIntent) || meaningful(critical?.successCriteria) ||
    meaningful(fetch?.evidence) || meaningful(fetch?.decisionImpactMap) ||
    meaningful(thinking?.designFrame) || meaningful(thinking?.workerTaskPackets);
}

/** Returns only selected evidence descriptors, never task content. */
export async function inspectImportEvidence(root, profile, selected = null) {
  const base = path.join(".meta-kim", "state", profile);
  const budget = { bytes: 0, reads: 0, incomplete: false };
  const check = async ({ relative, kind, runId = null }) => {
    const read = await readEvidence(root, relative, budget);
    return read && qualifies(read.value, kind, root, profile, runId)
      ? { relative, kind, runId: read.value.runId, sha256: read.sha256 } : null;
  };
  if (selected) return check(selected);
  const active = await check({ relative: path.join(base, "active-run.json"), kind: "durable_status" });
  if (active) return active;
  const statuses = [];
  for (const name of await boundedNames(root, path.join(base, "runs"), true, budget)) {
    try { validateRunId(name); } catch { continue; }
    statuses.push({ relative: path.join(base, "runs", name, "status.json"), kind: "durable_status", runId: name });
  }
  const analyses = [];
  for (const name of await boundedNames(root, path.join(base, "governed-executions"), false, budget)) {
    if (!name.endsWith(".json")) continue;
    const runId = name.slice(0, -5);
    try { validateRunId(runId); } catch { continue; }
    // Sidecars share the run prefix but are projections/reservations, not analysis.
    if (/\.(?:live|reservation|staging)$/u.test(runId)) continue;
    analyses.push({ relative: path.join(base, "governed-executions", name), kind: "governed_analysis", runId });
  }
  // Bare status histories must not consume the entire budget before analysis is
  // considered, nor may an analysis backlog starve durable status. Interleave
  // the bounded candidates, beginning with analysis after the active pointer.
  for (let index = 0; index < Math.max(analyses.length, statuses.length); index++) {
    for (const candidate of [analyses[index], statuses[index]]) {
      if (!candidate) continue;
      if (budget.reads >= MAX_READS || budget.bytes >= MAX_TOTAL_BYTES) {
        throw importError("project_import_unavailable", 503);
      }
      const evidence = await check(candidate);
      if (evidence) return evidence;
    }
  }
  // An omitted/oversized candidate or directory tail is unknown, not proof that
  // this project lacks governance. Preserve the existing public error vocabulary.
  if (budget.incomplete) throw importError("project_import_unavailable", 503);
  return null;
}
