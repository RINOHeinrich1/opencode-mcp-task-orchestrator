// db.mjs — Couche SQLite du Task Registry.
// Écriture atomique (transaction), optimistic lock (colonne version),
// journal append-only (events).
import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadGlobalEnv } from "../../scripts/load-env.mjs";
import { canTransition } from "./statemachine.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(homedir(), ".config", "opencode", "task-registry");

// Charge le .env global (~/.config/opencode/.env) AVANT de résoudre DB_PATH,
// afin que TASK_REGISTRY_DB (chemin/connexion de la base partagée) soit pris
// en compte sans écraser un éventuel env déjà défini.
loadGlobalEnv();
const DB_PATH = process.env.TASK_REGISTRY_DB || join(DATA_DIR, "registry.db");

let _db = null;

export function nowIso() {
  return new Date().toISOString();
}

export function openDb() {
  if (_db) return _db;
  mkdirSync(DATA_DIR, { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  _db.exec(readFileSync(join(__dirname, "schema.sql"), "utf8"));
  migrate(_db);
  return _db;
}

// Migrations idempotentes (colonnes ajoutées après coup).
function migrate(db) {
  const tcols = db.prepare("PRAGMA table_info(tasks)").all().map((c) => c.name);
  if (!tcols.includes("session_id")) {
    db.exec("ALTER TABLE tasks ADD COLUMN session_id TEXT");
  }
  if (!tcols.includes("recette_status")) {
    db.exec("ALTER TABLE tasks ADD COLUMN recette_status TEXT NOT NULL DEFAULT 'pending'");
  }
  const dcols = db.prepare("PRAGMA table_info(decisions)").all().map((c) => c.name);
  if (!dcols.includes("permission_id")) {
    db.exec("ALTER TABLE decisions ADD COLUMN permission_id TEXT");
  }
  if (!dcols.includes("detail")) {
    db.exec("ALTER TABLE decisions ADD COLUMN detail TEXT");
  }
  if (!dcols.includes("requested_by")) {
    db.exec("ALTER TABLE decisions ADD COLUMN requested_by TEXT");
  }
  if (!dcols.includes("session_id")) {
    db.exec("ALTER TABLE decisions ADD COLUMN session_id TEXT");
  }
  const pcols = db.prepare("PRAGMA table_info(plans)").all().map((c) => c.name);
  if (pcols.length > 0 && !pcols.includes("branch")) {
    db.exec("ALTER TABLE plans ADD COLUMN branch TEXT");
  }
  migrateEventsTable(db);
}

// Répare la table `events` si elle a été créée avec un ancien schéma (task_id
// nullable, sans FK ON DELETE CASCADE). Reconstruit la table alignée sur
// schema.sql et purge les événements orphelins (tâche supprimée).
function migrateEventsTable(db) {
  const fks = db.prepare("PRAGMA foreign_key_list(events)").all();
  if (fks.length > 0) return; // déjà conforme
  const prev = db.pragma("foreign_keys", { simple: true });
  db.pragma("foreign_keys = OFF");
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS events_new (
        seq       INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id  TEXT NOT NULL UNIQUE,
        task_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        ts        TEXT NOT NULL,
        type      TEXT NOT NULL,
        by        TEXT,
        detail    TEXT
      );
      INSERT INTO events_new (seq, event_id, task_id, ts, type, by, detail)
        SELECT seq, event_id, task_id, ts, type, by, detail
        FROM events
        WHERE task_id IS NOT NULL AND task_id IN (SELECT id FROM tasks);
      DROP TABLE events;
      ALTER TABLE events_new RENAME TO events;
      CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id);
    `);
  } finally {
    db.pragma(`foreign_keys = ${prev ? "ON" : "OFF"}`);
  }
}

// --- Tasks ----------------------------------------------------------------
export function createTask(task) {
  const db = openDb();
  const stmt = db.prepare(
    `INSERT INTO tasks
       (id, request, project, workspace, type, priority, deadline,
        budget_maxsteps, budget_maxcost, scope, acceptance_criteria,
        constraints, dependencies, created_at, created_by, session_id)
     VALUES
       (@id, @request, @project, @workspace, @type, @priority, @deadline,
        @budget_maxsteps, @budget_maxcost, @scope, @acceptance_criteria,
        @constraints, @dependencies, @created_at, @created_by, @session_id)`,
  );
  const params = {
    id: task.id,
    request: task.request,
    project: task.project,
    workspace: task.workspace ?? null,
    type: task.type || "feature",
    priority: task.priority || "normal",
    deadline: task.deadline ?? null,
    budget_maxsteps: task.budgetMaxSteps ?? null,
    budget_maxcost: task.budgetMaxCost ?? null,
    scope: task.scope ? JSON.stringify(task.scope) : null,
    acceptance_criteria: task.acceptanceCriteria ? JSON.stringify(task.acceptanceCriteria) : null,
    constraints: task.constraints ? JSON.stringify(task.constraints) : null,
    dependencies: task.dependencies ? JSON.stringify(task.dependencies) : null,
    created_at: nowIso(),
    created_by: task.createdBy ?? null,
    session_id: task.sessionId ?? null,
  };
  stmt.run(params);
  // Exécution initiale (statut queued).
  db.prepare(
    `INSERT INTO executions (execution_id, task_id, attempt, rework_count, status, started_at, updated_at)
     VALUES (@execution_id, @task_id, 1, 0, 'queued', @ts, @ts)`,
  ).run({ execution_id: task.executionId, task_id: task.id, ts: nowIso() });
  return getTask(task.id);
}

function rowToTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    request: row.request,
    project: row.project,
    workspace: row.workspace,
    type: row.type,
    priority: row.priority,
    deadline: row.deadline,
    budgetMaxSteps: row.budget_maxsteps,
    budgetMaxCost: row.budget_maxcost,
    scope: row.scope ? JSON.parse(row.scope) : [],
    acceptanceCriteria: row.acceptance_criteria ? JSON.parse(row.acceptance_criteria) : [],
    constraints: row.constraints ? JSON.parse(row.constraints) : [],
    dependencies: row.dependencies ? JSON.parse(row.dependencies) : [],
    createdAt: row.created_at,
    createdBy: row.created_by,
    sessionId: row.session_id,
    recetteStatus: row.recette_status ?? "pending",
    version: row.version,
  };
}

export function getTask(id) {
  return rowToTask(openDb().prepare("SELECT * FROM tasks WHERE id = ?").get(id));
}

// Garde-fou (défense en profondeur) : toute opération rattachée à une tâche
// exige une tâche préalablement enregistrée. Complète la contrainte FOREIGN KEY.
export function assertTaskExists(taskId) {
  if (!taskId || !getTask(taskId)) {
    throw new Error(`tâche inconnue : ${taskId}`);
  }
}

// Retrouve la tâche créée par une session opencode donnée (dernière d'abord).
export function findTaskBySession(sessionId) {
  if (!sessionId) return null;
  return rowToTask(
    openDb().prepare("SELECT * FROM tasks WHERE session_id = ? ORDER BY created_at DESC LIMIT 1").get(sessionId),
  );
}

// Remonte la chaîne parent (sous-agent → … → orchestrateur) jusqu'à trouver la
// tâche liée à l'une des sessions de la chaîne. Permet de rattacher une demande
// de permission émise par un sous-agent à la tâche de l'orchestrateur.
export function findTaskBySessionChain(sessionId) {
  if (!sessionId) return null;
  const direct = findTaskBySession(sessionId);
  if (direct) return direct;
  try {
    const path = process.env.OPENCODE_DB || join(homedir(), ".local", "share", "opencode", "opencode.db");
    const db = new Database(path, { readonly: true });
    let cur = sessionId;
    for (let i = 0; i < 12; i++) {
      const row = db.prepare("SELECT parent_id FROM session WHERE id = ?").get(cur);
      if (!row || !row.parent_id) break;
      cur = row.parent_id;
      const t = findTaskBySession(cur);
      if (t) return t;
    }
  } catch {
    /* base opencode illisible → on reste sur null */
  }
  return null;
}

export function listTasks(filter = {}) {
  const db = openDb();
  let rows;
  if (filter.project) {
    rows = db.prepare("SELECT * FROM tasks WHERE project = ? ORDER BY created_at DESC").all(filter.project);
  } else {
    rows = db.prepare("SELECT * FROM tasks ORDER BY created_at DESC").all();
  }
  return rows.map(rowToTask);
}

// --- Executions -----------------------------------------------------------
export function getExecutions(taskId) {
  return openDb()
    .prepare("SELECT * FROM executions WHERE task_id = ? ORDER BY attempt DESC")
    .all(taskId)
    .map((r) => ({
      executionId: r.execution_id,
      taskId: r.task_id,
      attempt: r.attempt,
      reworkCount: r.rework_count,
      status: r.status,
      checkpoint: r.checkpoint,
      startedAt: r.started_at,
      updatedAt: r.updated_at,
    }));
}

export function getCurrentExecution(taskId) {
  const list = getExecutions(taskId);
  return list[0] || null;
}

export function updateExecutionStatus(executionId, status, extra = {}) {
  const db = openDb();
  db.prepare(
    `UPDATE executions SET status = @status, checkpoint = @checkpoint, updated_at = @ts
     WHERE execution_id = @execution_id`,
  ).run({ status, checkpoint: extra.checkpoint ?? null, ts: nowIso(), execution_id: executionId });
}

// --- Worktrees ------------------------------------------------------------
export function registerWorktree(wt) {
  const db = openDb();
  db.prepare(
    `INSERT INTO worktrees
       (worktree_id, project, path, branch, status)
     VALUES (@worktree_id, @project, @path, @branch, 'AVAILABLE')`,
  ).run({
    worktree_id: wt.worktreeId,
    project: wt.project,
    path: wt.path,
    branch: wt.branch ?? null,
  });
  return getWorktree(wt.worktreeId);
}

function rowToWorktree(r) {
  if (!r) return null;
  return {
    worktreeId: r.worktree_id,
    project: r.project,
    path: r.path,
    branch: r.branch,
    status: r.status,
    agent: r.agent,
    taskId: r.task_id,
    reservedAt: r.reserved_at,
    leaseUntil: r.lease_until,
    lastHeartbeat: r.last_heartbeat,
    lock: r.lock,
  };
}

export function getWorktree(id) {
  return rowToWorktree(openDb().prepare("SELECT * FROM worktrees WHERE worktree_id = ?").get(id));
}

export function listWorktrees(project) {
  let rows;
  if (project) {
    rows = openDb().prepare("SELECT * FROM worktrees WHERE project = ? ORDER BY status").all(project);
  } else {
    rows = openDb().prepare("SELECT * FROM worktrees ORDER BY project, status").all();
  }
  return rows.map(rowToWorktree);
}

export function updateWorktree(id, fields) {
  const db = openDb();
  const existing = getWorktree(id);
  if (!existing) return null;
  const next = { ...existing, ...fields };
  db.prepare(
    `UPDATE worktrees SET status=@status, agent=@agent, task_id=@task_id,
       reserved_at=@reserved_at, lease_until=@lease_until, last_heartbeat=@last_heartbeat, lock=@lock
     WHERE worktree_id=@worktree_id`,
  ).run({
    status: next.status,
    agent: next.agent ?? null,
    task_id: next.taskId ?? null,
    reserved_at: next.reservedAt ?? null,
    lease_until: next.leaseUntil ?? null,
    last_heartbeat: next.lastHeartbeat ?? null,
    lock: next.lock ?? 0,
    worktree_id: id,
  });
  return getWorktree(id);
}

// --- Events ---------------------------------------------------------------
export function appendEvent({ eventId, taskId, type, by, detail }) {
  assertTaskExists(taskId);
  const db = openDb();
  db.prepare(
    `INSERT INTO events (event_id, task_id, ts, type, by, detail)
     VALUES (@event_id, @task_id, @ts, @type, @by, @detail)`,
  ).run({
    event_id: eventId,
    task_id: taskId ?? null,
    ts: nowIso(),
    type,
    by: by ?? null,
    detail: detail ? JSON.stringify(detail) : null,
  });
}

export function listEvents(taskId, limit = 100) {
  let rows;
  if (taskId) {
    rows = openDb().prepare("SELECT * FROM events WHERE task_id = ? ORDER BY seq DESC LIMIT ?").all(taskId, limit);
  } else {
    rows = openDb().prepare("SELECT * FROM events ORDER BY seq DESC LIMIT ?").all(limit);
  }
  return rows
    .map((r) => ({ seq: r.seq, eventId: r.event_id, taskId: r.task_id, ts: r.ts, type: r.type, by: r.by, detail: r.detail ? JSON.parse(r.detail) : null }))
    .reverse();
}

// --- Transition (transaction atomique + optimistic lock + event) ----------
export function applyTransition({ taskId, to, by, note }) {
  const db = openDb();
  const tx = db.transaction(() => {
    const task = getTask(taskId);
    if (!task) throw new Error(`tâche inconnue : ${taskId}`);
    const exec = getCurrentExecution(taskId);
    if (!exec) throw new Error(`aucune exécution pour la tâche : ${taskId}`);
    const from = exec.status;

    // Mise à jour atomique avec optimistic lock.
    const res = db
      .prepare("UPDATE tasks SET version = version + 1 WHERE id = ? AND version = ?")
      .run(taskId, task.version);
    if (res.changes === 0) throw new Error(`conflit d'écriture (version) sur ${taskId}`);

    updateExecutionStatus(exec.executionId, to, { checkpoint: note ?? exec.checkpoint });
    appendEvent({
      eventId: `${taskId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      taskId,
      type: "TRANSITION",
      by,
      detail: { from, to, note: note ?? null },
    });
    return { from, to };
  });
  const result = tx();
  return {
    ok: true,
    taskId,
    from: result.from,
    to: result.to,
    task: getTask(taskId),
    execution: getCurrentExecution(taskId),
  };
}

// --- Deployments ----------------------------------------------------------
export function recordDeployment({ taskId, status, pipelineUrl, verifiedAt }) {
  assertTaskExists(taskId);
  const db = openDb();
  const deploymentId = `DEP-${taskId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  db.prepare(
    `INSERT INTO deployments (deployment_id, task_id, status, triggered_at, pipeline_url, verified_at)
     VALUES (@deployment_id, @task_id, @status, @ts, @pipeline_url, @verified_at)`,
  ).run({
    deployment_id: deploymentId,
    task_id: taskId,
    status,
    ts: nowIso(),
    pipeline_url: pipelineUrl ?? null,
    verified_at: verifiedAt ?? null,
  });
  return getDeployment(taskId);
}

function rowToDeployment(r) {
  if (!r) return null;
  return {
    deploymentId: r.deployment_id,
    taskId: r.task_id,
    status: r.status,
    triggeredAt: r.triggered_at,
    pipelineUrl: r.pipeline_url,
    verifiedAt: r.verified_at,
    attempt: r.attempt,
  };
}

export function getDeployment(taskId) {
  return rowToDeployment(
    openDb().prepare("SELECT * FROM deployments WHERE task_id = ? ORDER BY rowid DESC LIMIT 1").get(taskId),
  );
}

export function listDeployments(taskId) {
  return openDb()
    .prepare("SELECT * FROM deployments WHERE task_id = ? ORDER BY rowid DESC")
    .all(taskId)
    .map(rowToDeployment);
}

// --- Conflits de scope ----------------------------------------------------
const ACTIVE_STATUSES = [
  "started", "planning", "awaiting_validation", "planned", "in_progress", "validating",
  "review", "approved", "rejected", "rework", "merge_pending", "merged", "deploy_pending", "deploying",
  "deployed", "blocked",
];

function normalizeScopePath(p) {
  return String(p).replace(/\/+$/, "").replace(/\/\*+$/, "");
}

function scopeOverlap(a, b) {
  const na = normalizeScopePath(a);
  const nb = normalizeScopePath(b);
  return na === nb || na.startsWith(nb + "/") || nb.startsWith(na + "/");
}

export function findScopeConflicts(project, scope, excludeTaskId) {
  const conflicts = [];
  for (const t of listTasks({ project })) {
    if (t.id === excludeTaskId) continue;
    const exec = getCurrentExecution(t.id);
    if (!exec || !ACTIVE_STATUSES.includes(exec.status)) continue;
    const tScope = t.scope || [];
    for (const sp of scope || []) {
      for (const tsp of tScope) {
        if (scopeOverlap(sp, tsp)) {
          conflicts.push({ taskId: t.id, status: exec.status, overlappingScope: [sp, tsp], request: t.request });
          break;
        }
      }
    }
  }
  const reservedWorktrees = listWorktrees(project).filter(
    (w) => ["RESERVED", "IN_USE"].includes(w.status) && w.taskId !== excludeTaskId,
  );
  return { conflicts, reservedWorktrees };
}

// --- Décisions humaines ---------------------------------------------------
export function requestDecision({ taskId, kind, expiresAt, ttlMinutes, detail, permissionId, requestedBy, sessionId }) {
  assertTaskExists(taskId);
  const db = openDb();
  // Dédoublonnage : une même permission (même permission_id) → une seule décision.
  if (permissionId) {
    const existing = db.prepare("SELECT * FROM decisions WHERE permission_id = ? ORDER BY rowid LIMIT 1").get(permissionId);
    if (existing) return rowToDecision(existing);
  }
  const decisionId = `DEC-${taskId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const expires = expiresAt || (ttlMinutes ? new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString() : null);
  db.prepare(
    `INSERT INTO decisions (decision_id, task_id, kind, status, requested_at, requested_by, session_id, expires_at, detail, permission_id)
     VALUES (@id, @task_id, @kind, 'awaiting', @ts, @requested_by, @session_id, @expires, @detail, @permission_id)`,
  ).run({
    id: decisionId,
    task_id: taskId,
    kind,
    ts: nowIso(),
    requested_by: requestedBy ?? null,
    session_id: sessionId ?? null,
    expires,
    detail: detail ?? null,
    permission_id: permissionId ?? null,
  });
  return getDecision(decisionId);
}

// Résout la décision associée à une permission opencode (par permission_id).
export function resolveDecisionByPermissionId(permissionId, status, resolution) {
  if (!permissionId) return null;
  const db = openDb();
  const row = db.prepare("SELECT decision_id FROM decisions WHERE permission_id = ? ORDER BY rowid LIMIT 1").get(permissionId);
  if (!row) return null;
  db.prepare("UPDATE decisions SET status = @status, resolved_at = @ts, resolution = @resolution WHERE decision_id = @id")
    .run({ status, ts: nowIso(), resolution: resolution ?? null, id: row.decision_id });
  return getDecision(row.decision_id);
}

// Retrouve une décision par permission_id (pour le dédoublonnage).
export function findDecisionByPermissionId(permissionId) {
  if (!permissionId) return null;
  return rowToDecision(
    openDb().prepare("SELECT * FROM decisions WHERE permission_id = ? ORDER BY rowid LIMIT 1").get(permissionId),
  );
}

function rowToDecision(r) {
  if (!r) return null;
  return {
    decisionId: r.decision_id,
    taskId: r.task_id,
    kind: r.kind,
    status: r.status,
    requestedAt: r.requested_at,
    requestedBy: r.requested_by,
    sessionId: r.session_id,
    expiresAt: r.expires_at,
    escalations: r.escalations,
    resolvedAt: r.resolved_at,
    resolution: r.resolution,
    detail: r.detail,
    permissionId: r.permission_id,
  };
}

export function getDecision(decisionId) {
  return rowToDecision(openDb().prepare("SELECT * FROM decisions WHERE decision_id = ?").get(decisionId));
}

export function resolveDecision(decisionId, status, resolution) {
  openDb()
    .prepare("UPDATE decisions SET status = @status, resolved_at = @ts, resolution = @resolution WHERE decision_id = @id")
    .run({ status, ts: nowIso(), resolution: resolution ?? null, id: decisionId });
  return getDecision(decisionId);
}

export function listExpiredDecisions(taskId) {
  const now = Date.now();
  const rows = taskId
    ? openDb().prepare("SELECT * FROM decisions WHERE task_id = ? AND status = 'awaiting'").all(taskId)
    : openDb().prepare("SELECT * FROM decisions WHERE status = 'awaiting'").all();
  return rows
    .map(rowToDecision)
    .filter((d) => d.expiresAt && new Date(d.expiresAt).getTime() < now);
}

export function escalateDecision(decisionId) {
  openDb().prepare("UPDATE decisions SET escalations = escalations + 1 WHERE decision_id = ?").run(decisionId);
  return getDecision(decisionId);
}

// --- Artifacts (documents/livrables liés à une tâche) ----------------------
export function addArtifact({ taskId, kind, title, path }) {
  assertTaskExists(taskId);
  const db = openDb();
  // Idempotence : renvoyer l'artifact existant si (task_id, kind, path) identique.
  const existing = db
    .prepare("SELECT * FROM artifacts WHERE task_id = ? AND kind = ? AND path = ? ORDER BY rowid LIMIT 1")
    .get(taskId, kind, path);
  if (existing) return rowToArtifact(existing);
  const artifactId = `ART-${taskId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  db.prepare(
    `INSERT INTO artifacts (artifact_id, task_id, kind, title, path, created_at)
     VALUES (@id, @task_id, @kind, @title, @path, @ts)`,
  ).run({ id: artifactId, task_id: taskId, kind, title: title ?? null, path, ts: nowIso() });
  return getArtifact(artifactId);
}

function rowToArtifact(r) {
  if (!r) return null;
  return {
    artifactId: r.artifact_id,
    taskId: r.task_id,
    kind: r.kind,
    title: r.title,
    path: r.path,
    createdAt: r.created_at,
  };
}

export function getArtifact(artifactId) {
  return rowToArtifact(openDb().prepare("SELECT * FROM artifacts WHERE artifact_id = ?").get(artifactId));
}

export function listArtifacts(taskId) {
  const rows = taskId
    ? openDb().prepare("SELECT * FROM artifacts WHERE task_id = ? ORDER BY rowid DESC").all(taskId)
    : openDb().prepare("SELECT * FROM artifacts ORDER BY rowid DESC").all();
  return rows.map(rowToArtifact);
}

export function deleteArtifact(artifactId) {
  openDb().prepare("DELETE FROM artifacts WHERE artifact_id = ?").run(artifactId);
}

// --- Participants ----------------------------------------------------------
export function registerParticipant({ taskId, agent, role }) {
  assertTaskExists(taskId);
  const db = openDb();
  db.prepare(
    `INSERT INTO participants (task_id, agent, role, joined_at)
     VALUES (@task_id, @agent, @role, @ts)
     ON CONFLICT(task_id, agent) DO UPDATE SET role = COALESCE(@role, role)`,
  ).run({ task_id: taskId, agent, role: role ?? null, ts: nowIso() });
  return listParticipants(taskId);
}

export function listParticipants(taskId) {
  return openDb()
    .prepare("SELECT * FROM participants WHERE task_id = ? ORDER BY joined_at ASC")
    .all(taskId)
    .map((r) => ({ taskId: r.task_id, agent: r.agent, role: r.role, joinedAt: r.joined_at }));
}

// --- Session de tâche (lien session opencode lancée par le panneau) --------
export function updateTaskSession(taskId, sessionId) {
  assertTaskExists(taskId);
  openDb().prepare("UPDATE tasks SET session_id = @session_id WHERE id = @id")
    .run({ session_id: sessionId ?? null, id: taskId });
  return getTask(taskId);
}

// --- Projets (entité de première classe — enregistrement explicite) --------
function hasTable(db, name) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function rowToProject(r) {
  if (!r) return null;
  return { id: r.id, name: r.name, workspace: r.workspace, gitPath: r.git_path, createdAt: r.created_at, createdBy: r.created_by };
}

export function registerProject({ id, name, workspace, gitPath, createdBy }) {
  const db = openDb();
  db.prepare(
    `INSERT INTO projects (id, name, workspace, git_path, created_at, created_by)
     VALUES (@id, @name, @workspace, @git_path, @ts, @created_by)
     ON CONFLICT(id) DO UPDATE SET name = @name, workspace = @workspace, git_path = @git_path`,
  ).run({ id, name, workspace: workspace ?? null, git_path: gitPath ?? null, ts: nowIso(), created_by: createdBy ?? null });
  return getProject(id);
}

export function getProject(id) {
  return rowToProject(openDb().prepare("SELECT * FROM projects WHERE id = ?").get(id));
}

export function listProjects() {
  return openDb().prepare("SELECT * FROM projects ORDER BY name ASC").all().map(rowToProject);
}

// Garde : toute tâche doit référencer un projet existant (règle "projet obligatoire").
export function assertProjectExists(project) {
  if (!project || !getProject(project)) {
    throw new Error(`projet inconnu : ${project} — enregistrer le projet avant de créer la tâche`);
  }
}

// Supprime un projet du registre (les tâches existantes gardent leur chaîne `project`).
export function deleteProject(id) {
  const db = openDb();
  const existing = getProject(id);
  if (!existing) return null;
  db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  return { id, deleted: true };
}

// --- Suppression physique d'une tâche et de tout son rattaché ---------------
export function deleteTask(taskId) {
  const db = openDb();
  if (!getTask(taskId)) return null;
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM events WHERE task_id = ?").run(taskId);
    db.prepare("DELETE FROM executions WHERE task_id = ?").run(taskId);
    db.prepare("DELETE FROM deployments WHERE task_id = ?").run(taskId);
    db.prepare("DELETE FROM decisions WHERE task_id = ?").run(taskId);
    db.prepare("DELETE FROM artifacts WHERE task_id = ?").run(taskId);
    db.prepare("DELETE FROM worktrees WHERE task_id = ?").run(taskId);
    if (hasTable(db, "plans")) {
      db.prepare("DELETE FROM plan_steps WHERE plan_id IN (SELECT id FROM plans WHERE task_id = ?)").run(taskId);
      db.prepare("DELETE FROM plan_incidents WHERE plan_id IN (SELECT id FROM plans WHERE task_id = ?)").run(taskId);
      db.prepare("DELETE FROM plan_inconsistencies WHERE plan_id IN (SELECT id FROM plans WHERE task_id = ?)").run(taskId);
      db.prepare("DELETE FROM plans WHERE task_id = ?").run(taskId);
    }
    db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
  });
  tx();
  return { taskId, deleted: true };
}

// --- Recette (acceptation humaine après déploiement) ------------------------
// Colonne `recette_status` INDÉPENDANTE du statut d'exécution : `done` reste
// terminal côté orchestrateur ; la recette (pending → approved/rejected) est
// tranchée par l'humain après test sur la plateforme, et tracée comme une
// décision kind="recette" (choix « Décision humaine »).

export function resolveRecette({ taskId, status, resolution, by }) {
  const db = openDb();
  const task = getTask(taskId);
  if (!task) throw new Error(`tâche inconnue : ${taskId}`);
  const exec = getCurrentExecution(taskId);
  if (!exec || exec.status !== "done") {
    throw new Error(`recette impossible : la tâche ${taskId} doit être au statut "done" (actuel : ${exec?.status || "inconnu"})`);
  }
  if (!["approved", "rejected"].includes(status)) throw new Error(`statut de recette invalide : ${status}`);

  const ts = nowIso();
  const by_ = by || "human";
  let decisionId = null;

  const tx = db.transaction(() => {
    // optimistic lock
    const lockRes = db.prepare("UPDATE tasks SET version = version + 1 WHERE id = ? AND version = ?")
      .run(taskId, task.version);
    if (lockRes.changes === 0) throw new Error(`conflit d'écriture (version) sur ${taskId}`);

    // décision recette : réutilise l'awaiting existante, sinon en crée une (tracée).
    const existing = db.prepare(
      "SELECT decision_id FROM decisions WHERE task_id = ? AND kind = 'recette' AND status = 'awaiting' ORDER BY rowid LIMIT 1",
    ).get(taskId);
    if (existing) {
      decisionId = existing.decision_id;
      db.prepare("UPDATE decisions SET status = @status, resolved_at = @ts, resolution = @resolution WHERE decision_id = @id")
        .run({ status, ts, resolution: resolution ?? null, id: decisionId });
    } else {
      decisionId = `DEC-${taskId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      db.prepare(
        `INSERT INTO decisions (decision_id, task_id, kind, status, requested_at, requested_by, session_id, expires_at, detail, permission_id)
         VALUES (@id, @task_id, 'recette', @status, @ts, @by, NULL, NULL, @detail, NULL)`,
      ).run({
        id: decisionId,
        task_id: taskId,
        status,
        ts,
        by: by_,
        detail: "Validation de recette (acceptation humaine après déploiement)",
      });
    }

    // colonne recette_status (source d'affichage du panneau)
    db.prepare("UPDATE tasks SET recette_status = @status WHERE id = @id")
      .run({ status, id: taskId });

    // événement CLOSED (remarques de recette)
    db.prepare("INSERT INTO events (event_id, task_id, ts, type, by, detail) VALUES (@eid, @tid, @ts, 'CLOSED', @by, @detail)")
      .run({
        eid: `${taskId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        tid: taskId,
        ts,
        by: by_,
        detail: JSON.stringify({ kind: "recette", status, remarks: resolution ?? null, at: ts }),
      });
  });
  tx();

  return { ok: true, taskId, recetteStatus: status, decisionId, task: getTask(taskId) };
}

// Remet la recette à `pending` (début d'une reprise après rejet de recette).
export function resetRecette(taskId) {
  const db = openDb();
  if (!getTask(taskId)) throw new Error(`tâche inconnue : ${taskId}`);
  db.prepare("UPDATE tasks SET recette_status = 'pending' WHERE id = ?").run(taskId);
  return getTask(taskId);
}

// --- Résolution de décision couplée à la transition (source de vérité unique) ---
// Décision n°1 : la résolution humaine (approved/rejected) provoque une transition
// atomique vers le statut correspondant + un événement CLOSED portant les remarques.
// S'applique aux décisions kind ∈ {validation, review} ; les permissions (flux
// permission-hook) restent résolues sans transition via resolveDecisionByPermissionId.
export function resolveDecisionAndTransition({ decisionId, status, resolution, by }) {
  const db = openDb();
  const decision = getDecision(decisionId);
  if (!decision) throw new Error(`décision inconnue : ${decisionId}`);
  if (!["approved", "rejected"].includes(status)) throw new Error(`statut de décision invalide : ${status}`);
  if (decision.status !== "awaiting") return { decision, transitioned: false };
  if (decision.kind === "permission") {
    resolveDecision(decisionId, status, resolution);
    return { decision: getDecision(decisionId), transitioned: false };
  }
  if (decision.kind === "recette") {
    // La recette ne touche PAS au statut d'exécution (colonne recette_status).
    const r = resolveRecette({ taskId: decision.taskId, status, resolution, by });
    return { decision: getDecision(decisionId), transitioned: false, recetteStatus: r.recetteStatus };
  }

  const task = getTask(decision.taskId);
  const exec = getCurrentExecution(decision.taskId);
  if (!task || !exec) throw new Error(`tâche ou exécution introuvable pour la décision : ${decisionId}`);

  const from = exec.status;
  const to = status; // "approved" | "rejected"
  if (!canTransition(from, to)) throw new Error(`transition refusée : ${from} -> ${to} (décision ${decisionId})`);

  const ts = nowIso();
  const tx = db.transaction(() => {
    // 1. optimistic lock sur la tâche
    const lockRes = db.prepare("UPDATE tasks SET version = version + 1 WHERE id = ? AND version = ?")
      .run(decision.taskId, task.version);
    if (lockRes.changes === 0) throw new Error(`conflit d'écriture (version) sur ${decision.taskId}`);
    // 2. résolution de la décision
    db.prepare("UPDATE decisions SET status = @status, resolved_at = @ts, resolution = @resolution WHERE decision_id = @id")
      .run({ status, ts, resolution: resolution ?? null, id: decisionId });
    // 3. transition d'exécution
    db.prepare("UPDATE executions SET status = @status, checkpoint = @checkpoint, updated_at = @ts WHERE execution_id = @execution_id")
      .run({ status: to, checkpoint: null, ts, execution_id: exec.executionId });
    // 4. événement TRANSITION
    db.prepare("INSERT INTO events (event_id, task_id, ts, type, by, detail) VALUES (@eid, @tid, @ts, 'TRANSITION', @by, @detail)")
      .run({ eid: `${decision.taskId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, tid: decision.taskId, ts, by: by || "human", detail: JSON.stringify({ from, to, note: null }) });
    // 5. événement CLOSED (remarques de clôture)
    db.prepare("INSERT INTO events (event_id, task_id, ts, type, by, detail) VALUES (@eid, @tid, @ts, 'CLOSED', @by, @detail)")
      .run({ eid: `${decision.taskId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, tid: decision.taskId, ts, by: by || "human", detail: JSON.stringify({ remarks: resolution ?? null, at: ts }) });
  });
  tx();
  return { decision: getDecision(decisionId), transitioned: true, from, to };
}
