import { randomBytes } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { buildProjectRef, inspectProjectRegistry, joinProjectRegistry } from "../../../scripts/project-registry.mjs";
import { sanitizeLiveProfile } from "../../infrastructure/live/live-read-repository.mjs";
import { importError, inspectImportEvidence, resolveImportPath } from "./live-project-import-evidence.mjs";

export const LIVE_PROJECT_IMPORT_SCHEMA = "meta-kim-live-project-import-v1";
const MAX_PROJECTS = 128;
const MAX_TOKENS = 128;
const DEFAULT_TTL_MS = 5 * 60_000;
const RESULT_TTL_MS = 10 * 60_000;
const isObject = (body) => body && typeof body === "object" && !Array.isArray(body);

/** Per-server, bounded confirmation capabilities. No initialization or execution. */
export function createLiveProjectImportService(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const profile = sanitizeLiveProfile(options.profile);
  const now = typeof options.now === "function" ? options.now : Date.now;
  const ttlMs = Number.isInteger(options.ttlMs) && options.ttlMs > 0 ? Math.min(options.ttlMs, DEFAULT_TTL_MS) : DEFAULT_TTL_MS;
  const maxProjects = Number.isInteger(options.maxProjects) && options.maxProjects > 0 ? Math.min(options.maxProjects, MAX_PROJECTS) : MAX_PROJECTS;
  const reservedProjectRefs = options.seedProjectRoot ? [buildProjectRef({ repoPath: options.seedProjectRoot })] : [];
  const tokens = new Map();

  function assertCapacity(registry, projectId) {
    const refs = new Set([...registry.joinedProjectRefs, ...reservedProjectRefs, projectId]);
    if (refs.size > maxProjects) throw importError("project_import_catalog_full", 409);
  }
  function prune() {
    for (const [token, entry] of tokens) {
      if (!entry.pending && (entry.result ? entry.resultExpiresAt : entry.expiresAt) <= now()) tokens.delete(token);
    }
  }
  const unavailable = (error) => {
    if (/^project_import_[a-z_]+$/u.test(error?.code || "")) return error;
    return importError("project_import_failed", 500);
  };

  async function preview(body) {
    if (!isObject(body) || Object.keys(body).some((key) => key !== "projectPath")) throw importError("project_import_invalid_path");
    const root = await resolveImportPath(body.projectPath);
    try {
      const evidence = await inspectImportEvidence(root, profile);
      if (!evidence) throw importError("project_import_not_governed", 422);
      const registry = await inspectProjectRegistry({ homeDir, repoPath: root });
      const projectId = buildProjectRef({ repoPath: root });
      if (registry.project && registry.project.repoRoot !== root) throw importError("project_import_failed", 409);
      assertCapacity(registry, projectId);
      prune();
      if (tokens.size >= MAX_TOKENS) throw importError("project_import_unavailable", 503);
      const previewToken = randomBytes(32).toString("base64url");
      const expiresAt = now() + ttlMs;
      const previouslySkipped = registry.project?.enrollmentStatus === "skipped";
      tokens.set(previewToken, { requestedPath: body.projectPath, root, profile, evidence, expiresAt, previouslySkipped });
      return {
        schemaVersion: LIVE_PROJECT_IMPORT_SCHEMA,
        status: registry.project?.enrollmentStatus === "joined" ? "already_registered" : "ready",
        previewToken,
        expiresAt: new Date(expiresAt).toISOString(),
        project: { projectId, displayName: path.basename(root) || projectId, projectPath: root, profile, evidenceCount: 1, previouslySkipped },
      };
    } catch (error) { throw unavailable(error); }
  }

  async function commit(entry) {
    let root;
    try { root = await resolveImportPath(entry.requestedPath); }
    catch { throw importError("project_import_preview_stale", 409); }
    if (root !== entry.root || entry.profile !== profile) throw importError("project_import_preview_stale", 409);
    const evidence = await inspectImportEvidence(root, profile, entry.evidence);
    if (!evidence || evidence.sha256 !== entry.evidence.sha256) throw importError("project_import_preview_stale", 409);
    const registry = await inspectProjectRegistry({ homeDir, repoPath: root });
    if ((registry.project?.enrollmentStatus === "skipped") !== entry.previouslySkipped) throw importError("project_import_preview_stale", 409);
    const projectId = buildProjectRef({ repoPath: root });
    assertCapacity(registry, projectId);
    const joined = registry.project?.enrollmentStatus === "joined" ? { alreadyRegistered: true } : await joinProjectRegistry({
      homeDir, repoPath: root, runtimeFamily: "shared", sourceType: "governed_live", sourceRef: "meta-kim-live-import",
      importPolicy: { maxProjects, reservedProjectRefs, previouslySkipped: entry.previouslySkipped },
    });
    // Commit is the truth boundary. Cache refresh failure must not report a failed
    // enrollment and invite a second write after a successful transaction.
    entry.result = { schemaVersion: LIVE_PROJECT_IMPORT_SCHEMA, status: joined.alreadyRegistered ? "already_registered" : "imported", projectId };
    entry.resultExpiresAt = now() + RESULT_TTL_MS;
    try { await options.onRegistered?.(projectId); } catch { /* subsequent GET may rebuild */ }
    return entry.result;
  }

  async function confirm(body) {
    if (!isObject(body) || Object.keys(body).some((key) => !["previewToken", "confirmPreviouslySkipped"].includes(key)) ||
        typeof body.previewToken !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(body.previewToken) ||
        (body.confirmPreviouslySkipped !== undefined && typeof body.confirmPreviouslySkipped !== "boolean")) {
      throw importError("project_import_preview_expired", 410);
    }
    const entry = tokens.get(body.previewToken);
    if (!entry) throw importError("project_import_preview_expired", 410);
    if (entry.result && entry.resultExpiresAt > now()) return entry.result;
    if (entry.pending) return entry.pending;
    if (entry.expiresAt <= now()) { tokens.delete(body.previewToken); throw importError("project_import_preview_expired", 410); }
    if (entry.previouslySkipped && body.confirmPreviouslySkipped !== true) throw importError("project_import_skipped_confirmation_required", 409);
    entry.pending = commit(entry).catch((error) => { throw unavailable(error); }).finally(() => { entry.pending = null; });
    return entry.pending;
  }
  return { preview, confirm };
}
