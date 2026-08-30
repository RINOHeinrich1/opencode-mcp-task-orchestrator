// db.mjs — Couche PostgreSQL du Task Registry.
// Écriture atomique (transaction), optimistic lock (colonne version),
// journal append-only (events).
import pg from "pg";
import Database from "better-sqlite3"; // lecture seule d'opencode.db (chaîne de sessions)
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadGlobalEnv } from "../../scripts/load-env.mjs";
import { canTaskTransition, canPlanTransition } from "./statemachine.mjs";

const { Pool } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));

// Charge le .env global AVANT de résoudre DATABASE_URL.
loadGlobalEnv();
const DATABASE_URL =
  process.env.DATABASE_URL || "postgres://orchestrator:orchestrator@localhost:5432/task_registry";

let _pool = null;
function pool() {
  if (_pool) return _pool;
  _pool = new Pool({ connectionString: DATABASE_URL, max: 10 });
  return _pool;
}

// Applique le schéma (idempotent CREATE TABLE IF NOT EXISTS) une fois par process.
let _schemaReady = false;
let _schemaPromise = null;
async function ensureSchema() {
  if (_schemaReady) return;
  if (!_schemaPromise) {
    _schemaPromise = (async () => {
      await pool().query(readFileSync(join(__dirname, "schema.sql"), "utf8"));
      await migrate();
      _schemaReady = true;
    })();
  }
  await _schemaPromise;
}

// Migrations idempotentes (colonnes ajoutées après coup).
async function migrate() {
  await pool().query("ALTER TABLE decisions ADD COLUMN IF NOT EXISTS plan_id TEXT");
  await pool().query("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS audit_target TEXT");
}

// Transaction (BEGIN/COMMIT/ROLLBACK) sur une connexion dédiée.
async function withTransaction(fn) {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

export function nowIso() {
  return new Date().toISOString();
}

// --- Tasks ----------------------------------------------------------------
export async function createTask(task) {
  await ensureSchema();
  await pool().query(
    `INSERT INTO tasks
       (id, request, project, workspace, type, audit_target, priority, deadline,
        budget_maxsteps, budget_maxcost, scope, acceptance_criteria,
        constraints, dependencies, created_at, created_by, session_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [
      task.id,
      task.request,
      task.project,
      task.workspace ?? null,
      task.type || "feature",
      task.auditTarget ?? null,
      task.priority || "normal",
      task.deadline ?? null,
      task.budgetMaxSteps ?? null,
      task.budgetMaxCost ?? null,
      task.scope ? JSON.stringify(task.scope) : null,
      task.acceptanceCriteria ? JSON.stringify(task.acceptanceCriteria) : null,
      task.constraints ? JSON.stringify(task.constraints) : null,
      task.dependencies ? JSON.stringify(task.dependencies) : null,
      nowIso(),
      task.createdBy ?? null,
      task.sessionId ?? null,
    ],
  );
  // Exécution initiale (statut queued).
  await pool().query(
    `INSERT INTO executions (execution_id, task_id, attempt, rework_count, status, started_at, updated_at)
     VALUES ($1,$2,1,0,'queued',$3,$3)`,
    [task.executionId, task.id, nowIso()],
  );
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
    auditTarget: row.audit_target ?? null,
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

export async function getTask(id) {
  await ensureSchema();
  const res = await pool().query("SELECT * FROM tasks WHERE id = $1", [id]);
  return rowToTask(res.rows[0]);
}

// Garde-fou (défense en profondeur) : toute opération rattachée à une tâche
// exige une tâche préalablement enregistrée. Complète la contrainte FOREIGN KEY.
export async function assertTaskExists(taskId) {
  if (!taskId || !(await getTask(taskId))) {
    throw new Error(`tâche inconnue : ${taskId}`);
  }
}

// Retrouve la tâche créée par une session opencode donnée (dernière d'abord).
export async function findTaskBySession(sessionId) {
  if (!sessionId) return null;
  await ensureSchema();
  const res = await pool().query(
    "SELECT * FROM tasks WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1",
    [sessionId],
  );
  return rowToTask(res.rows[0]);
}

// Remonte la chaîne parent (sous-agent → … → orchestrateur) jusqu'à trouver la
// tâche liée à l'une des sessions de la chaîne. Permet de rattacher une demande
// de permission émise par un sous-agent à la tâche de l'orchestrateur.
export async function findTaskBySessionChain(sessionId) {
  if (!sessionId) return null;
  const direct = await findTaskBySession(sessionId);
  if (direct) return direct;
  try {
    const path = process.env.OPENCODE_DB || join(homedir(), ".local", "share", "opencode", "opencode.db");
    const db = new Database(path, { readonly: true });
    let cur = sessionId;
    for (let i = 0; i < 12; i++) {
      const row = db.prepare("SELECT parent_id FROM session WHERE id = ?").get(cur);
      if (!row || !row.parent_id) break;
      cur = row.parent_id;
      const t = await findTaskBySession(cur);
      if (t) return t;
    }
  } catch {
    /* base opencode illisible → on reste sur null */
  }
  return null;
}

export async function listTasks(filter = {}) {
  await ensureSchema();
  let res;
  if (filter.project) {
    res = await pool().query("SELECT * FROM tasks WHERE project = $1 ORDER BY created_at DESC", [filter.project]);
  } else {
    res = await pool().query("SELECT * FROM tasks ORDER BY created_at DESC");
  }
  return res.rows.map(rowToTask);
}

// --- Executions -----------------------------------------------------------
export async function getExecutions(taskId) {
  await ensureSchema();
  const res = await pool().query("SELECT * FROM executions WHERE task_id = $1 ORDER BY attempt DESC", [taskId]);
  return res.rows.map((r) => ({
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

export async function getCurrentExecution(taskId) {
  const list = await getExecutions(taskId);
  return list[0] || null;
}

export async function updateExecutionStatus(executionId, status, extra = {}) {
  await ensureSchema();
  await pool().query(
    `UPDATE executions SET status = $1, checkpoint = $2, updated_at = $3 WHERE execution_id = $4`,
    [status, extra.checkpoint ?? null, nowIso(), executionId],
  );
}

// --- Worktrees ------------------------------------------------------------
export async function registerWorktree(wt) {
  await ensureSchema();
  await pool().query(
    `INSERT INTO worktrees (worktree_id, project, path, branch, status)
     VALUES ($1,$2,$3,$4,'AVAILABLE')`,
    [wt.worktreeId, wt.project, wt.path, wt.branch ?? null],
  );
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

export async function getWorktree(id) {
  await ensureSchema();
  const res = await pool().query("SELECT * FROM worktrees WHERE worktree_id = $1", [id]);
  return rowToWorktree(res.rows[0]);
}

export async function listWorktrees(project) {
  await ensureSchema();
  let res;
  if (project) {
    res = await pool().query("SELECT * FROM worktrees WHERE project = $1 ORDER BY status", [project]);
  } else {
    res = await pool().query("SELECT * FROM worktrees ORDER BY project, status");
  }
  return res.rows.map(rowToWorktree);
}

export async function updateWorktree(id, fields) {
  await ensureSchema();
  const existing = await getWorktree(id);
  if (!existing) return null;
  const next = { ...existing, ...fields };
  await pool().query(
    `UPDATE worktrees SET status=$1, agent=$2, task_id=$3,
       reserved_at=$4, lease_until=$5, last_heartbeat=$6, lock=$7
     WHERE worktree_id=$8`,
    [
      next.status,
      next.agent ?? null,
      next.taskId ?? null,
      next.reservedAt ?? null,
      next.leaseUntil ?? null,
      next.lastHeartbeat ?? null,
      next.lock ?? 0,
      id,
    ],
  );
  return getWorktree(id);
}

// --- Events ---------------------------------------------------------------
export async function appendEvent({ eventId, taskId, type, by, detail }) {
  await assertTaskExists(taskId);
  await pool().query(
    `INSERT INTO events (event_id, task_id, ts, type, by, detail)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [eventId, taskId ?? null, nowIso(), type, by ?? null, detail ? JSON.stringify(detail) : null],
  );
}

export async function listEvents(taskId, limit = 100) {
  await ensureSchema();
  let res;
  if (taskId) {
    res = await pool().query("SELECT * FROM events WHERE task_id = $1 ORDER BY seq DESC LIMIT $2", [taskId, limit]);
  } else {
    res = await pool().query("SELECT * FROM events ORDER BY seq DESC LIMIT $1", [limit]);
  }
  return res.rows
    .map((r) => ({ seq: r.seq, eventId: r.event_id, taskId: r.task_id, ts: r.ts, type: r.type, by: r.by, detail: r.detail ? JSON.parse(r.detail) : null }))
    .reverse();
}

// --- Transition (transaction atomique + optimistic lock + event) ----------
export async function applyTransition({ taskId, to, by, note }) {
  await ensureSchema();
  const result = await withTransaction(async (client) => {
    const taskRes = await client.query("SELECT * FROM tasks WHERE id = $1", [taskId]);
    const task = rowToTask(taskRes.rows[0]);
    if (!task) throw new Error(`tâche inconnue : ${taskId}`);
    const execRes = await client.query(
      "SELECT * FROM executions WHERE task_id = $1 ORDER BY attempt DESC LIMIT 1",
      [taskId],
    );
    const exec = execRes.rows[0];
    if (!exec) throw new Error(`aucune exécution pour la tâche : ${taskId}`);
    const from = exec.status;

    // Mise à jour atomique avec optimistic lock.
    const lockRes = await client.query(
      "UPDATE tasks SET version = version + 1 WHERE id = $1 AND version = $2",
      [taskId, task.version],
    );
    if (lockRes.rowCount === 0) throw new Error(`conflit d'écriture (version) sur ${taskId}`);

    await client.query(
      "UPDATE executions SET status = $1, checkpoint = $2, updated_at = $3 WHERE execution_id = $4",
      [to, note ?? null, nowIso(), exec.execution_id],
    );
    await client.query(
      "INSERT INTO events (event_id, task_id, ts, type, by, detail) VALUES ($1,$2,$3,'TRANSITION',$4,$5)",
      [`${taskId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, taskId, nowIso(), by, JSON.stringify({ from, to, note: note ?? null })],
    );
    return { from, to };
  });
  return {
    ok: true,
    taskId,
    from: result.from,
    to: result.to,
    task: await getTask(taskId),
    execution: await getCurrentExecution(taskId),
  };
}

// --- Deployments ----------------------------------------------------------
export async function recordDeployment({ taskId, status, pipelineUrl, verifiedAt }) {
  await assertTaskExists(taskId);
  const deploymentId = `DEP-${taskId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  await pool().query(
    `INSERT INTO deployments (deployment_id, task_id, status, triggered_at, pipeline_url, verified_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [deploymentId, taskId, status, nowIso(), pipelineUrl ?? null, verifiedAt ?? null],
  );
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

export async function getDeployment(taskId) {
  await ensureSchema();
  const res = await pool().query("SELECT * FROM deployments WHERE task_id = $1 ORDER BY id DESC LIMIT 1", [taskId]);
  return rowToDeployment(res.rows[0]);
}

export async function listDeployments(taskId) {
  await ensureSchema();
  const res = await pool().query("SELECT * FROM deployments WHERE task_id = $1 ORDER BY id DESC", [taskId]);
  return res.rows.map(rowToDeployment);
}

// --- Conflits de scope ----------------------------------------------------
const ACTIVE_STATUSES = [
  "started", "planning", "awaiting_validation", "planned", "in_progress", "blocked",
];

function normalizeScopePath(p) {
  return String(p).replace(/\/+$/, "").replace(/\/\*+$/, "");
}

function scopeOverlap(a, b) {
  const na = normalizeScopePath(a);
  const nb = normalizeScopePath(b);
  return na === nb || na.startsWith(nb + "/") || nb.startsWith(na + "/");
}

export async function findScopeConflicts(project, scope, excludeTaskId) {
  const conflicts = [];
  for (const t of await listTasks({ project })) {
    if (t.id === excludeTaskId) continue;
    const exec = await getCurrentExecution(t.id);
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
  const reservedWorktrees = (await listWorktrees(project)).filter(
    (w) => ["RESERVED", "IN_USE"].includes(w.status) && w.taskId !== excludeTaskId,
  );
  return { conflicts, reservedWorktrees };
}

// --- Décisions humaines ---------------------------------------------------
export async function requestDecision({ taskId, kind, expiresAt, ttlMinutes, detail, permissionId, requestedBy, sessionId, planId }) {
  await assertTaskExists(taskId);
  // Dédoublonnage : une même permission (même permission_id) → une seule décision.
  if (permissionId) {
    const existing = await pool().query(
      "SELECT * FROM decisions WHERE permission_id = $1 ORDER BY id LIMIT 1",
      [permissionId],
    );
    if (existing.rows[0]) return rowToDecision(existing.rows[0]);
  }
  const decisionId = `DEC-${taskId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const expires = expiresAt || (ttlMinutes ? new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString() : null);
  await pool().query(
    `INSERT INTO decisions (decision_id, task_id, kind, status, requested_at, requested_by, session_id, expires_at, detail, permission_id, plan_id)
     VALUES ($1,$2,$3,'awaiting',$4,$5,$6,$7,$8,$9,$10)`,
    [decisionId, taskId, kind, nowIso(), requestedBy ?? null, sessionId ?? null, expires, detail ?? null, permissionId ?? null, planId ?? null],
  );
  return getDecision(decisionId);
}

// Résout la décision associée à une permission opencode (par permission_id).
export async function resolveDecisionByPermissionId(permissionId, status, resolution) {
  if (!permissionId) return null;
  await ensureSchema();
  const row = (await pool().query("SELECT decision_id FROM decisions WHERE permission_id = $1 ORDER BY id LIMIT 1", [permissionId])).rows[0];
  if (!row) return null;
  await pool().query(
    "UPDATE decisions SET status = $1, resolved_at = $2, resolution = $3 WHERE decision_id = $4",
    [status, nowIso(), resolution ?? null, row.decision_id],
  );
  return getDecision(row.decision_id);
}

// Retrouve une décision par permission_id (pour le dédoublonnage).
export async function findDecisionByPermissionId(permissionId) {
  if (!permissionId) return null;
  await ensureSchema();
  const res = await pool().query("SELECT * FROM decisions WHERE permission_id = $1 ORDER BY id LIMIT 1", [permissionId]);
  return rowToDecision(res.rows[0]);
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
    planId: r.plan_id,
  };
}

export async function getDecision(decisionId) {
  await ensureSchema();
  const res = await pool().query("SELECT * FROM decisions WHERE decision_id = $1", [decisionId]);
  return rowToDecision(res.rows[0]);
}

export async function resolveDecision(decisionId, status, resolution) {
  await ensureSchema();
  await pool().query(
    "UPDATE decisions SET status = $1, resolved_at = $2, resolution = $3 WHERE decision_id = $4",
    [status, nowIso(), resolution ?? null, decisionId],
  );
  return getDecision(decisionId);
}

export async function listExpiredDecisions(taskId) {
  await ensureSchema();
  const now = Date.now();
  const res = taskId
    ? await pool().query("SELECT * FROM decisions WHERE task_id = $1 AND status = 'awaiting'", [taskId])
    : await pool().query("SELECT * FROM decisions WHERE status = 'awaiting'");
  return res.rows
    .map(rowToDecision)
    .filter((d) => d.expiresAt && new Date(d.expiresAt).getTime() < now);
}

export async function escalateDecision(decisionId) {
  await ensureSchema();
  await pool().query("UPDATE decisions SET escalations = escalations + 1 WHERE decision_id = $1", [decisionId]);
  return getDecision(decisionId);
}

// --- Artifacts (documents/livrables liés à une tâche) ----------------------
export async function addArtifact({ taskId, kind, title, path }) {
  await assertTaskExists(taskId);
  // Idempotence : renvoyer l'artifact existant si (task_id, kind, path) identique.
  const existing = (await pool().query(
    "SELECT * FROM artifacts WHERE task_id = $1 AND kind = $2 AND path = $3 ORDER BY id LIMIT 1",
    [taskId, kind, path],
  )).rows[0];
  if (existing) return rowToArtifact(existing);
  const artifactId = `ART-${taskId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  await pool().query(
    `INSERT INTO artifacts (artifact_id, task_id, kind, title, path, created_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [artifactId, taskId, kind, title ?? null, path, nowIso()],
  );
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

export async function getArtifact(artifactId) {
  await ensureSchema();
  const res = await pool().query("SELECT * FROM artifacts WHERE artifact_id = $1", [artifactId]);
  return rowToArtifact(res.rows[0]);
}

export async function listArtifacts(taskId) {
  await ensureSchema();
  const res = taskId
    ? await pool().query("SELECT * FROM artifacts WHERE task_id = $1 ORDER BY id DESC", [taskId])
    : await pool().query("SELECT * FROM artifacts ORDER BY id DESC");
  return res.rows.map(rowToArtifact);
}

export async function deleteArtifact(artifactId) {
  await ensureSchema();
  await pool().query("DELETE FROM artifacts WHERE artifact_id = $1", [artifactId]);
}

// --- Participants ----------------------------------------------------------
export async function registerParticipant({ taskId, agent, role }) {
  await assertTaskExists(taskId);
  await pool().query(
    `INSERT INTO participants (task_id, agent, role, joined_at)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT(task_id, agent) DO UPDATE SET role = COALESCE(EXCLUDED.role, participants.role)`,
    [taskId, agent, role ?? null, nowIso()],
  );
  return listParticipants(taskId);
}

export async function listParticipants(taskId) {
  await ensureSchema();
  const res = await pool().query("SELECT * FROM participants WHERE task_id = $1 ORDER BY joined_at ASC", [taskId]);
  return res.rows.map((r) => ({ taskId: r.task_id, agent: r.agent, role: r.role, joinedAt: r.joined_at }));
}

// --- Session de tâche (lien session opencode lancée par le panneau) --------
export async function updateTaskSession(taskId, sessionId) {
  await assertTaskExists(taskId);
  await pool().query("UPDATE tasks SET session_id = $1 WHERE id = $2", [sessionId ?? null, taskId]);
  return getTask(taskId);
}

// Lie une session opencode à une tâche ET l'enregistre dans la trace
// append-only `task_sessions` (une ligne par lancement/reprise).
export async function linkTaskSession(taskId, sessionId, kind) {
  await assertTaskExists(taskId);
  await pool().query("UPDATE tasks SET session_id = $1 WHERE id = $2", [sessionId ?? null, taskId]);
  if (sessionId) {
    await pool().query(
      `INSERT INTO task_sessions (task_id, session_id, kind, created_at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (task_id, session_id) DO NOTHING`,
      [taskId, sessionId, kind || "launch", nowIso()],
    );
  }
  return { task: await getTask(taskId), sessions: await listTaskSessions(taskId) };
}

// Liste des sessions liées à une tâche (ordre chronologique d'ajout).
export async function listTaskSessions(taskId) {
  await ensureSchema();
  const res = await pool().query("SELECT * FROM task_sessions WHERE task_id = $1 ORDER BY id ASC", [taskId]);
  return res.rows.map((r) => ({
    id: r.id,
    taskId: r.task_id,
    sessionId: r.session_id,
    kind: r.kind,
    createdAt: r.created_at,
  }));
}

// --- Projets (entité de première classe — enregistrement explicite) --------
function rowToProject(r) {
  if (!r) return null;
  return { id: r.id, name: r.name, workspace: r.workspace, gitPath: r.git_path, createdAt: r.created_at, createdBy: r.created_by };
}

export async function registerProject({ id, name, workspace, gitPath, createdBy }) {
  await ensureSchema();
  await pool().query(
    `INSERT INTO projects (id, name, workspace, git_path, created_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT(id) DO UPDATE SET name = EXCLUDED.name, workspace = EXCLUDED.workspace, git_path = EXCLUDED.git_path`,
    [id, name, workspace ?? null, gitPath ?? null, nowIso(), createdBy ?? null],
  );
  return getProject(id);
}

export async function getProject(id) {
  await ensureSchema();
  const res = await pool().query("SELECT * FROM projects WHERE id = $1", [id]);
  return rowToProject(res.rows[0]);
}

export async function listProjects() {
  await ensureSchema();
  const res = await pool().query("SELECT * FROM projects ORDER BY name ASC");
  return res.rows.map(rowToProject);
}

// Garde : toute tâche doit référencer un projet existant (règle "projet obligatoire").
export async function assertProjectExists(project) {
  if (!project || !(await getProject(project))) {
    throw new Error(`projet inconnu : ${project} — enregistrer le projet avant de créer la tâche`);
  }
}

// Supprime un projet du registre (les tâches existantes gardent leur chaîne `project`).
export async function deleteProject(id) {
  await ensureSchema();
  const existing = await getProject(id);
  if (!existing) return null;
  await pool().query("DELETE FROM projects WHERE id = $1", [id]);
  return { id, deleted: true };
}

// --- Suppression physique d'une tâche et de tout son rattaché ---------------
export async function deleteTask(taskId) {
  await ensureSchema();
  if (!(await getTask(taskId))) return null;
  await withTransaction(async (client) => {
    await client.query("DELETE FROM events WHERE task_id = $1", [taskId]);
    await client.query("DELETE FROM executions WHERE task_id = $1", [taskId]);
    await client.query("DELETE FROM task_sessions WHERE task_id = $1", [taskId]);
    await client.query("DELETE FROM deployments WHERE task_id = $1", [taskId]);
    await client.query("DELETE FROM decisions WHERE task_id = $1", [taskId]);
    await client.query("DELETE FROM artifacts WHERE task_id = $1", [taskId]);
    await client.query("DELETE FROM worktrees WHERE task_id = $1", [taskId]);
    await client.query("DELETE FROM plan_steps WHERE plan_id IN (SELECT id FROM plans WHERE task_id = $1)", [taskId]);
    await client.query("DELETE FROM plan_incidents WHERE plan_id IN (SELECT id FROM plans WHERE task_id = $1)", [taskId]);
    await client.query("DELETE FROM plan_inconsistencies WHERE plan_id IN (SELECT id FROM plans WHERE task_id = $1)", [taskId]);
    await client.query("DELETE FROM plan_commits WHERE plan_id IN (SELECT id FROM plans WHERE task_id = $1)", [taskId]);
    await client.query("DELETE FROM plans WHERE task_id = $1", [taskId]);
    await client.query("DELETE FROM tasks WHERE id = $1", [taskId]);
  });
  return { taskId, deleted: true };
}

// --- Recette (acceptation humaine après déploiement) ------------------------
export async function resolveRecette({ taskId, status, resolution, by }) {
  await ensureSchema();
  const task = await getTask(taskId);
  if (!task) throw new Error(`tâche inconnue : ${taskId}`);
  const exec = await getCurrentExecution(taskId);
  if (!exec || exec.status !== "done") {
    throw new Error(`recette impossible : la tâche ${taskId} doit être au statut "done" (actuel : ${exec?.status || "inconnu"})`);
  }
  if (!["approved", "rejected"].includes(status)) throw new Error(`statut de recette invalide : ${status}`);

  const ts = nowIso();
  const by_ = by || "human";
  let decisionId = null;

  await withTransaction(async (client) => {
    const lockRes = await client.query(
      "UPDATE tasks SET version = version + 1 WHERE id = $1 AND version = $2",
      [taskId, task.version],
    );
    if (lockRes.rowCount === 0) throw new Error(`conflit d'écriture (version) sur ${taskId}`);

    const existing = (await client.query(
      "SELECT decision_id FROM decisions WHERE task_id = $1 AND kind = 'recette' AND status = 'awaiting' ORDER BY id LIMIT 1",
      [taskId],
    )).rows[0];
    if (existing) {
      decisionId = existing.decision_id;
      await client.query(
        "UPDATE decisions SET status = $1, resolved_at = $2, resolution = $3 WHERE decision_id = $4",
        [status, ts, resolution ?? null, decisionId],
      );
    } else {
      decisionId = `DEC-${taskId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      await client.query(
        `INSERT INTO decisions (decision_id, task_id, kind, status, requested_at, requested_by, session_id, expires_at, detail, permission_id)
         VALUES ($1,$2,'recette',$3,$4,$5,NULL,NULL,$6,NULL)`,
        [decisionId, taskId, status, ts, by_, "Validation de recette (acceptation humaine après déploiement)"],
      );
    }

    await client.query("UPDATE tasks SET recette_status = $1 WHERE id = $2", [status, taskId]);

    await client.query(
      "INSERT INTO events (event_id, task_id, ts, type, by, detail) VALUES ($1,$2,$3,'CLOSED',$4,$5)",
      [`${taskId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, taskId, ts, by_, JSON.stringify({ kind: "recette", status, remarks: resolution ?? null, at: ts })],
    );
  });

  return { ok: true, taskId, recetteStatus: status, decisionId, task: await getTask(taskId) };
}

// Remet la recette à `pending` (début d'une reprise après rejet de recette).
export async function resetRecette(taskId) {
  await ensureSchema();
  if (!(await getTask(taskId))) throw new Error(`tâche inconnue : ${taskId}`);
  await pool().query("UPDATE tasks SET recette_status = 'pending' WHERE id = $1", [taskId]);
  return getTask(taskId);
}

// --- Exécution d'un plan (sous-tâche, cycle de vie INDÉPENDANT) --------------
export async function getPlanExecution(planId) {
  await ensureSchema();
  const res = await pool().query("SELECT * FROM plan_executions WHERE plan_id = $1 ORDER BY id DESC LIMIT 1", [planId]);
  const r = res.rows[0];
  if (!r) return null;
  return { id: r.id, planId: r.plan_id, attempt: r.attempt, status: r.status, checkpoint: r.checkpoint, startedAt: r.started_at, updatedAt: r.updated_at };
}

export async function createPlanExecution(planId) {
  await ensureSchema();
  await pool().query(
    "INSERT INTO plan_executions (plan_id, attempt, status, started_at, updated_at) VALUES ($1, 1, 'planned', $2, $2)",
    [planId, nowIso()],
  );
  return getPlanExecution(planId);
}

export async function listPlanExecutions(taskId) {
  await ensureSchema();
  const res = await pool().query(
    `SELECT pe.* FROM plan_executions pe
     JOIN plans p ON p.id = pe.plan_id
     WHERE p.task_id = $1 ORDER BY pe.id DESC`,
    [taskId],
  );
  return res.rows.map((r) => ({ id: r.id, planId: r.plan_id, attempt: r.attempt, status: r.status, checkpoint: r.checkpoint, startedAt: r.started_at, updatedAt: r.updated_at }));
}

// Transitionne l'exécution d'un plan (validée par la même machine à états).
export async function applyPlanTransition({ planId, to, by, note }) {
  await ensureSchema();
  let exec = await getPlanExecution(planId);
  if (!exec) {
    await createPlanExecution(planId);
    exec = await getPlanExecution(planId);
  }
  const from = exec.status;
  if (!canPlanTransition(from, to)) {
    throw new Error(`transition refusée (plan ${planId}) : ${from} -> ${to}`);
  }
  await pool().query(
    "UPDATE plan_executions SET status = $1, checkpoint = $2, updated_at = $3 WHERE id = $4",
    [to, note ?? null, nowIso(), exec.id],
  );
  return { ok: true, planId, from, to, planExecution: await getPlanExecution(planId) };
}

// --- Commits rattachés à un plan (trace append-only) -------------------------
function rowToPlanCommit(r) {
  if (!r) return null;
  let files = [];
  try { files = r.files ? JSON.parse(r.files) : []; } catch { files = []; }
  return {
    id: r.id,
    planId: r.plan_id,
    executionId: r.execution_id,
    branch: r.branch,
    sha: r.sha,
    message: r.message,
    author: r.author,
    committedAt: r.committed_at,
    files,
    createdAt: r.created_at,
  };
}

export async function addPlanCommit({ planId, executionId, branch, sha, message, author, committedAt, files }) {
  await ensureSchema();
  await pool().query(
    `INSERT INTO plan_commits (plan_id, execution_id, branch, sha, message, author, committed_at, files, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      planId,
      executionId ?? null,
      branch ?? null,
      sha,
      message ?? null,
      author ?? null,
      committedAt ?? null,
      JSON.stringify(Array.isArray(files) ? files : []),
      nowIso(),
    ],
  );
  return listPlanCommits(planId);
}

export async function listPlanCommits(planId) {
  await ensureSchema();
  const res = await pool().query("SELECT * FROM plan_commits WHERE plan_id = $1 ORDER BY id ASC", [planId]);
  return res.rows.map(rowToPlanCommit);
}

// Commits de tous les plans d'une tâche (jointure plans → plan_commits).
export async function listTaskPlanCommits(taskId) {
  await ensureSchema();
  const res = await pool().query(
    `SELECT pc.* FROM plan_commits pc
     JOIN plans p ON p.id = pc.plan_id
     WHERE p.task_id = $1 ORDER BY pc.id ASC`,
    [taskId],
  );
  return res.rows.map(rowToPlanCommit);
}

// --- Résolution de décision (source de vérité unique) ------------------------
// Décision résolue PAR SOUS-TÂCHE (plan), indépendamment des autres :
//  - validation : agrégation au niveau TÂCHE → `planned` (toutes acceptées) / `aborted` (au moins un rejet) ;
//  - review : transition du PLAN (`review` → `approved`/`rejected`), pas de transition tâche.
export async function resolveDecisionAndTransition({ decisionId, status, resolution, by }) {
  await ensureSchema();
  const decision = await getDecision(decisionId);
  if (!decision) throw new Error(`décision inconnue : ${decisionId}`);
  if (!["approved", "rejected"].includes(status)) throw new Error(`statut de décision invalide : ${status}`);
  if (decision.status !== "awaiting") return { decision, transitioned: false };
  if (decision.kind === "permission") {
    await resolveDecision(decisionId, status, resolution);
    return { decision: await getDecision(decisionId), transitioned: false };
  }
  if (decision.kind === "recette") {
    const r = await resolveRecette({ taskId: decision.taskId, status, resolution, by });
    return { decision: await getDecision(decisionId), transitioned: false, recetteStatus: r.recetteStatus };
  }

  const task = await getTask(decision.taskId);
  if (!task) throw new Error(`tâche introuvable pour la décision : ${decisionId}`);

  const ts = nowIso();
  const by_ = by || "human";

  await withTransaction(async (client) => {
    // Optimistic lock.
    const lockRes = await client.query(
      "UPDATE tasks SET version = version + 1 WHERE id = $1 AND version = $2",
      [decision.taskId, task.version],
    );
    if (lockRes.rowCount === 0) throw new Error(`conflit d'écriture (version) sur ${decision.taskId}`);

    // Résolution de la décision.
    await client.query(
      "UPDATE decisions SET status = $1, resolved_at = $2, resolution = $3 WHERE decision_id = $4",
      [status, ts, resolution ?? null, decisionId],
    );

    // Événement CLOSED (remarques).
    await client.query(
      "INSERT INTO events (event_id, task_id, ts, type, by, detail) VALUES ($1,$2,$3,'CLOSED',$4,$5)",
      [`${decision.taskId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, decision.taskId, ts, by_, JSON.stringify({ kind: decision.kind, decisionId, status, remarks: resolution ?? null, at: ts })],
    );
  });

  // Validation : agrégation au niveau TÂCHE → planned (toutes acceptées) / aborted (au moins un rejet).
  if (decision.kind === "validation") {
    const remaining = await pool().query(
      "SELECT COUNT(*) AS n FROM decisions WHERE task_id = $1 AND kind = 'validation' AND status = 'awaiting'",
      [decision.taskId],
    );
    if (Number(remaining.rows[0].n) === 0) {
      const rejected = await pool().query(
        "SELECT COUNT(*) AS n FROM decisions WHERE task_id = $1 AND kind = 'validation' AND status = 'rejected'",
        [decision.taskId],
      );
      const to = Number(rejected.rows[0].n) > 0 ? "aborted" : "planned";
      const exec = await getCurrentExecution(decision.taskId);
      if (exec && canTaskTransition(exec.status, to)) {
        await applyTransition({ taskId: decision.taskId, to, by: by_ });
      }
    }
  }

  // Review : transition du PLAN (review → approved/rejected), indépendante de la tâche.
  if (decision.kind === "review" && decision.planId) {
    try {
      const pe = await getPlanExecution(decision.planId);
      if (pe && canPlanTransition(pe.status, status)) {
        await applyPlanTransition({ planId: decision.planId, to: status, by: by_, note: resolution ?? null });
      }
    } catch {}
  }

  return { decision: await getDecision(decisionId), transitioned: false };
}
