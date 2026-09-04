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
  await pool().query("ALTER TABLE projects ADD COLUMN IF NOT EXISTS main_branch TEXT");
  await pool().query("ALTER TABLE recettes ADD COLUMN IF NOT EXISTS project TEXT");
  await pool().query("ALTER TABLE recettes ADD COLUMN IF NOT EXISTS title TEXT");
  await pool().query("ALTER TABLE recettes ADD COLUMN IF NOT EXISTS description TEXT");
  await pool().query("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS title TEXT");
  await pool().query("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS recette_id TEXT");
  await pool().query("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS direct_execution INTEGER NOT NULL DEFAULT 0");
  await pool().query(`CREATE TABLE IF NOT EXISTS recette_tasks (
    recette_id TEXT NOT NULL REFERENCES recettes(recette_id) ON DELETE CASCADE,
    task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    PRIMARY KEY (recette_id, task_id)
  )`);
  await pool().query("CREATE INDEX IF NOT EXISTS idx_recette_tasks_task ON recette_tasks(task_id)");
  await pool().query("ALTER TABLE recette_items ADD COLUMN IF NOT EXISTS title TEXT");
  await pool().query("ALTER TABLE recette_items ADD COLUMN IF NOT EXISTS acceptance TEXT");
  await pool().query("ALTER TABLE recette_items ADD COLUMN IF NOT EXISTS exec_order INTEGER");
  await pool().query("ALTER TABLE recette_items ADD COLUMN IF NOT EXISTS vigilance TEXT");
  // Recette multi-projets : 1 recette = 1..N projets + 1 item = 1 projet cible.
  await pool().query("ALTER TABLE recette_items ADD COLUMN IF NOT EXISTS project TEXT");
  await pool().query(`CREATE TABLE IF NOT EXISTS recette_projects (
    recette_id TEXT NOT NULL REFERENCES recettes(recette_id) ON DELETE CASCADE,
    project    TEXT NOT NULL,
    PRIMARY KEY (recette_id, project)
  )`);
  await pool().query("CREATE INDEX IF NOT EXISTS idx_recette_projects_project ON recette_projects(project)");
  // Rétro-remplissage idempotent : chaque recette existante a ≥1 projet (son projet legacy).
  await pool().query(
    `INSERT INTO recette_projects (recette_id, project)
     SELECT r.recette_id, r.project FROM recettes r
     WHERE r.project IS NOT NULL
     ON CONFLICT DO NOTHING`,
  );
  // Items legacy sans projet cible → premier projet de leur recette.
  await pool().query(
    `UPDATE recette_items i SET project = COALESCE(i.project, (
       SELECT rp.project FROM recette_projects rp WHERE rp.recette_id = i.recette_id ORDER BY rp.project LIMIT 1
     ))
     WHERE i.project IS NULL`,
  );
  // Tests E2E (cadrage 07) : registre, liens tâche<->test, exécutions/preuves.
  await pool().query(`CREATE TABLE IF NOT EXISTS e2e_tests (
    id TEXT PRIMARY KEY, project TEXT NOT NULL, spec_file TEXT NOT NULL,
    scenario TEXT NOT NULL, title TEXT,
    status TEXT NOT NULL DEFAULT 'ACTIVE', version INTEGER NOT NULL DEFAULT 1,
    meta JSONB, first_seen_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    CONSTRAINT uq_e2e_tests_scenario UNIQUE (project, spec_file, scenario)
  )`);
  await pool().query("CREATE INDEX IF NOT EXISTS idx_e2e_tests_project ON e2e_tests(project)");
  await pool().query(`CREATE TABLE IF NOT EXISTS task_e2e (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    e2e_test_id TEXT NOT NULL REFERENCES e2e_tests(id) ON DELETE CASCADE,
    relation_type TEXT NOT NULL DEFAULT 'REGRESSION', reason TEXT,
    PRIMARY KEY (task_id, e2e_test_id)
  )`);
  await pool().query("CREATE INDEX IF NOT EXISTS idx_task_e2e_test ON task_e2e(e2e_test_id)");
  await pool().query(`CREATE TABLE IF NOT EXISTS e2e_executions (
    id TEXT PRIMARY KEY, e2e_test_id TEXT NOT NULL REFERENCES e2e_tests(id) ON DELETE CASCADE,
    task_id TEXT, deployment_id TEXT, plan_id TEXT, env TEXT, commit_sha TEXT, branch TEXT,
    pipeline_ref TEXT, status TEXT NOT NULL DEFAULT 'PENDING', duration_ms INTEGER,
    attempts INTEGER NOT NULL DEFAULT 1, executed_at TEXT, report_artifact_id TEXT,
    logs_url TEXT, video_url TEXT, summary TEXT, verdict_by TEXT, created_at TEXT NOT NULL
  )`);
  await pool().query("CREATE INDEX IF NOT EXISTS idx_e2e_executions_task ON e2e_executions(task_id)");
  await pool().query("CREATE INDEX IF NOT EXISTS idx_e2e_executions_test ON e2e_executions(e2e_test_id)");
  await pool().query("CREATE INDEX IF NOT EXISTS idx_e2e_executions_created ON e2e_executions(created_at)");
  await pool().query(`CREATE TABLE IF NOT EXISTS recette_documents (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    recette_id TEXT NOT NULL REFERENCES recettes(recette_id) ON DELETE CASCADE,
    title TEXT, nature TEXT, source TEXT NOT NULL DEFAULT 'import',
    path TEXT, artifact_id TEXT, created_at TEXT NOT NULL
  )`);
  await pool().query("CREATE INDEX IF NOT EXISTS idx_recette_documents_recette ON recette_documents(recette_id)");
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
       (id, request, title, project, workspace, type, audit_target, priority, deadline,
        budget_maxsteps, budget_maxcost, scope, acceptance_criteria,
        constraints, dependencies, created_at, created_by, session_id, recette_class, recette_id, direct_execution)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
    [
      task.id,
      task.request,
      task.title || String(task.request || "").slice(0, 60),
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
      task.recetteClass ?? null,
      task.recetteId ?? null,
      task.directExecution ? 1 : 0,
    ],
  );
  // Exécution initiale (statut queued).
  await pool().query(
    `INSERT INTO executions (execution_id, task_id, attempt, rework_count, status, started_at, updated_at)
     VALUES ($1,$2,1,0,'queued',$3,$3)`,
    [task.executionId, task.id, nowIso()],
  );
  // Tâches liées éventuelles (nature de liaison).
  for (const l of task.linkedTasks || []) {
    if (l && l.taskId) {
      await addTaskLink({ taskId: task.id, linkedTaskId: l.taskId, description: l.description ?? null });
    }
  }
  return getTask(task.id);
}

// --- Tâches liées (task_links) ----------------------------------------------
export async function addTaskLink({ taskId, linkedTaskId, description }) {
  await ensureSchema();
  if (!linkedTaskId) throw new Error("linkedTaskId requis");
  if (linkedTaskId === taskId) throw new Error("une tâche ne peut pas être liée à elle-même");
  const target = (await pool().query("SELECT id FROM tasks WHERE id = $1", [linkedTaskId])).rows[0];
  if (!target) throw new Error(`tâche liée inconnue : ${linkedTaskId}`);
  await pool().query(
    `INSERT INTO task_links (task_id, linked_task_id, description, created_at)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (task_id, linked_task_id) DO UPDATE SET description = EXCLUDED.description`,
    [taskId, linkedTaskId, description ?? null, nowIso()],
  );
  return listTaskLinks(taskId);
}

export async function removeTaskLink({ taskId, linkedTaskId }) {
  await ensureSchema();
  await pool().query("DELETE FROM task_links WHERE task_id = $1 AND linked_task_id = $2", [taskId, linkedTaskId]);
  return listTaskLinks(taskId);
}

// Liste des tâches liées, enrichie de l'état de la tâche liée (pour atomic-plan).
export async function listTaskLinks(taskId) {
  await ensureSchema();
  const res = await pool().query(
    `SELECT l.linked_task_id, l.description, l.created_at,
            t.request AS linked_request, t.recette_status AS linked_recette,
            (SELECT x.status FROM executions x WHERE x.task_id = l.linked_task_id ORDER BY attempt DESC LIMIT 1) AS linked_status,
            (SELECT COUNT(*) FROM plans p WHERE p.task_id = l.linked_task_id) AS linked_plans,
            (SELECT COUNT(*) FROM artifacts a WHERE a.task_id = l.linked_task_id) AS linked_artifacts
     FROM task_links l
     LEFT JOIN tasks t ON t.id = l.linked_task_id
     WHERE l.task_id = $1
     ORDER BY l.id ASC`,
    [taskId],
  );
  return res.rows.map((r) => ({
    linkedTaskId: r.linked_task_id,
    description: r.description,
    createdAt: r.created_at,
    linkedRequest: r.linked_request ?? null,
    linkedRecette: r.linked_recette ?? null,
    linkedStatus: r.linked_status ?? null,
    linkedPlans: Number(r.linked_plans) || 0,
    linkedArtifacts: Number(r.linked_artifacts) || 0,
  }));
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
    recetteClass: row.recette_class ?? null,
    recetteId: row.recette_id ?? null,
    title: row.title ?? null,
    directExecution: !!row.direct_execution,
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
    // v0.8.0 : PLUS de recette automatique par tâche — la recette est une
    // opération de PROJET (0..N tâches), créée par l'utilisateur (onglet Recettes).
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

// --- Mise à jour d'une tâche (uniquement en statut queued) -----------------
export async function updateTask({ taskId, request, title, acceptanceCriteria, scope, priority, directExecution, linkedTasks }) {
  await ensureSchema();
  const task = await getTask(taskId);
  if (!task) throw new Error(`tâche inconnue : ${taskId}`);
  const exec = await getCurrentExecution(taskId);
  if (!exec || exec.status !== "queued") {
    throw new Error(`seule une tâche 'queued' est modifiable (actuel : ${exec?.status || "inconnu"})`);
  }
  const sets = [];
  const params = [];
  if (request !== undefined) { params.push(request); sets.push(`request = $${params.length}`); }
  if (title !== undefined) { params.push(title); sets.push(`title = $${params.length}`); }
  if (acceptanceCriteria !== undefined) { params.push(JSON.stringify(acceptanceCriteria)); sets.push(`acceptance_criteria = $${params.length}`); }
  if (scope !== undefined) { params.push(JSON.stringify(scope)); sets.push(`scope = $${params.length}`); }
  if (priority !== undefined) { params.push(priority); sets.push(`priority = $${params.length}`); }
  if (directExecution !== undefined) { params.push(directExecution ? 1 : 0); sets.push(`direct_execution = $${params.length}`); }
  // Remplacement des tâches liées si fournies (AVANT le early-return des champs).
  if (linkedTasks !== undefined) {
    await pool().query("DELETE FROM task_links WHERE task_id = $1", [taskId]);
    for (const l of linkedTasks || []) {
      if (l && l.taskId) await addTaskLink({ taskId, linkedTaskId: l.taskId, description: l.description ?? null });
    }
  }
  if (!sets.length) return getTask(taskId);
  params.push(taskId);
  await pool().query(`UPDATE tasks SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
  return getTask(taskId);
}

// --- Conflits de scope : persistance (KPI d'orchestration) -----------------
export async function recordScopeConflicts({ project, scope, conflicts, reservedWorktrees }) {
  await ensureSchema();
  for (const c of conflicts || []) {
    await pool().query(
      `INSERT INTO scope_conflicts (project, scope, conflicting_task_id, created_at, status)
       VALUES ($1,$2,$3,$4,'open')`,
      [project, JSON.stringify(scope || []), c.taskId ?? null, nowIso()],
    );
  }
  for (const w of reservedWorktrees || []) {
    await pool().query(
      `INSERT INTO scope_conflicts (project, scope, worktree_id, created_at, status)
       VALUES ($1,$2,$3,$4,'open')`,
      [project, JSON.stringify(scope || []), w.worktreeId ?? w.id ?? null, nowIso()],
    );
  }
}

export async function countScopeConflicts() {
  await ensureSchema();
  const r = await pool().query(
    "SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'open')::int AS open FROM scope_conflicts",
  );
  return { total: r.rows[0].total, open: r.rows[0].open };
}

// Retrouve la tâche liée à un plan (pour tracer une erreur de transition de plan).
export async function findPlanTask(planId) {
  await ensureSchema();
  const r = await pool().query("SELECT task_id FROM plans WHERE id = $1", [planId]);
  return r.rows[0] ? r.rows[0].task_id : null;
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
  return { id: r.id, name: r.name, workspace: r.workspace, gitPath: r.git_path, mainBranch: r.main_branch ?? null, createdAt: r.created_at, createdBy: r.created_by };
}

export async function registerProject({ id, name, workspace, gitPath, mainBranch, createdBy }) {
  await ensureSchema();
  await pool().query(
    `INSERT INTO projects (id, name, workspace, git_path, main_branch, created_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT(id) DO UPDATE SET name = EXCLUDED.name, workspace = EXCLUDED.workspace, git_path = EXCLUDED.git_path, main_branch = EXCLUDED.main_branch`,
    [id, name, workspace ?? null, gitPath ?? null, mainBranch ?? null, nowIso(), createdBy ?? null],
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

// ===========================================================================
// Recette (opération de vérification) — v0.8.0 (objet de premier niveau, projet)
// ===========================================================================

// Crée une recette de PROJET (titre + 0..N tâches couvertes) et la passe en cours.
export async function startRecette({ project, projects, title, description, taskIds, status = "pending", sessionId = null }) {
  await ensureSchema();
  // 1 recette = 1..N projets (jamais nulle). `projects` prioritaire, sinon `project`.
  const projs = [...new Set(((projects && projects.length ? projects : (project ? [project] : [])).map((p) => p && String(p).trim()).filter(Boolean)))];
  if (projs.length === 0) throw new Error("au moins un projet requis pour une recette");
  const first = projs[0];
  const recetteId = `RECT-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  await pool().query(
    "INSERT INTO recettes (recette_id, project, title, description, session_id, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [recetteId, first, title || `Recette ${projs.join(", ")}`, description ?? null, sessionId, status, nowIso()],
  );
  for (const p of projs) {
    await pool().query(
      "INSERT INTO recette_projects (recette_id, project) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [recetteId, p],
    );
  }
  for (const t of taskIds || []) {
    if (t) await linkRecetteTask(recetteId, t);
  }
  return getRecetteById(recetteId);
}

// Rattache une tâche à une recette (couverture). Garde : la tâche doit appartenir
// à l'un des projets rattachés à la recette (1 recette = projets couverts).
export async function linkRecetteTask(recetteId, taskId) {
  await ensureSchema();
  const rec = (await pool().query("SELECT 1 FROM recettes WHERE recette_id = $1", [recetteId])).rows[0];
  if (!rec) throw new Error(`recette inconnue : ${recetteId}`);
  const t = (await pool().query("SELECT project FROM tasks WHERE id = $1", [taskId])).rows[0];
  if (!t) throw new Error(`tâche inconnue : ${taskId}`);
  const projs = (await pool().query(
    "SELECT project FROM recette_projects WHERE recette_id = $1",
    [recetteId],
  )).rows.map((x) => x.project);
  if (projs.length && t.project && !projs.includes(t.project)) {
    throw new Error(`la tâche ${taskId} appartient au projet ${t.project}, non rattaché à la recette (projets : ${projs.join(", ")})`);
  }
  await pool().query(
    "INSERT INTO recette_tasks (recette_id, task_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
    [recetteId, taskId],
  );
  return recetteId;
}

// Détache une tâche d'une recette (la tâche reste historiquement intacte).
export async function unlinkRecetteTask(recetteId, taskId) {
  await ensureSchema();
  await pool().query(
    "DELETE FROM recette_tasks WHERE recette_id = $1 AND task_id = $2",
    [recetteId, taskId],
  );
  return getRecetteById(recetteId);
}

// Ajoute un projet à une recette existante (recette_projects). Ne modifie pas
// `recettes.project` (legacy = 1er projet). 1 recette = 1..N projets.
export async function addRecetteProject({ recetteId, project }) {
  await ensureSchema();
  if (!project || !String(project).trim()) throw new Error("projet requis");
  const p = String(project).trim();
  const r = (await pool().query("SELECT project FROM recettes WHERE recette_id = $1", [recetteId])).rows[0];
  if (!r) throw new Error(`recette inconnue : ${recetteId}`);
  await pool().query(
    "INSERT INTO recette_projects (recette_id, project) VALUES ($1,$2) ON CONFLICT DO NOTHING",
    [recetteId, p],
  );
  return getRecetteById(recetteId);
}

// Retire un projet d'une recette existante. Refus si : c'est le dernier projet,
// ou si la recette couvre encore des tâches appartenant à ce projet.
export async function removeRecetteProject({ recetteId, project }) {
  await ensureSchema();
  if (!project) throw new Error("projet requis");
  const r = (await pool().query("SELECT project FROM recettes WHERE recette_id = $1", [recetteId])).rows[0];
  if (!r) throw new Error(`recette inconnue : ${recetteId}`);
  const projs = (await pool().query(
    "SELECT project FROM recette_projects WHERE recette_id = $1",
    [recetteId],
  )).rows.map((x) => x.project);
  if (projs.length <= 1) throw new Error("impossible de retirer le dernier projet d'une recette");
  if (!projs.includes(project)) return getRecetteById(recetteId);
  const covered = (await pool().query(
    `SELECT 1 FROM recette_tasks rt JOIN tasks t ON t.id = rt.task_id
     WHERE rt.recette_id = $1 AND t.project = $2 LIMIT 1`,
    [recetteId, project],
  )).rows.length;
  if (covered) throw new Error(`impossible : la recette couvre encore des tâches du projet ${project} (détachez-les d'abord)`);
  await pool().query(
    "DELETE FROM recette_projects WHERE recette_id = $1 AND project = $2",
    [recetteId, project],
  );
  // Maintient le legacy `recettes.project` sur le 1er projet restant.
  const rest = (await pool().query(
    "SELECT project FROM recette_projects WHERE recette_id = $1 ORDER BY project LIMIT 1",
    [recetteId],
  )).rows[0];
  if (rest) await pool().query("UPDATE recettes SET project = $1 WHERE recette_id = $2", [rest.project, recetteId]);
  return getRecetteById(recetteId);
}

// Liste les recettes d'un projet (ou toutes) — un projet = présent dans recette_projects.
export async function listProjectRecettes(project) {
  await ensureSchema();
  const rows = (await pool().query(
    `SELECT r.*,
            (SELECT COUNT(*) FROM recette_tasks rt WHERE rt.recette_id = r.recette_id) AS tasks_count,
            (SELECT COUNT(*) FROM recette_items i WHERE i.recette_id = r.recette_id) AS items_count
     FROM recettes r
     ${project ? "WHERE EXISTS (SELECT 1 FROM recette_projects rp WHERE rp.recette_id = r.recette_id AND rp.project = $1)" : ""}
     ORDER BY r.created_at DESC`,
    project ? [project] : [],
  )).rows;
  const ids = rows.map((r) => r.recette_id);
  const projectsByRec = {};
  if (ids.length) {
    const rp = await pool().query(
      "SELECT recette_id, project FROM recette_projects WHERE recette_id = ANY($1) ORDER BY project",
      [ids],
    );
    for (const x of rp.rows) (projectsByRec[x.recette_id] = projectsByRec[x.recette_id] || []).push(x.project);
  }
  return rows.map((r) => ({
    recetteId: r.recette_id,
    project: r.project,
    projects: projectsByRec[r.recette_id] || (r.project ? [r.project] : []),
    title: r.title,
    description: r.description ?? null,
    sessionId: r.session_id,
    status: r.status,
    createdAt: r.created_at,
    confirmedAt: r.confirmed_at,
    confirmedBy: r.confirmed_by,
    tasksCount: Number(r.tasks_count),
    itemsCount: Number(r.items_count),
  }));
}

// Recette couvrant une tâche (via recette_tasks) — pour l'affichage côté tâche.
export async function getRecette(taskId) {
  await ensureSchema();
  const r = (await pool().query(
    `SELECT r.* FROM recettes r
     JOIN recette_tasks rt ON rt.recette_id = r.recette_id
     WHERE rt.task_id = $1 ORDER BY r.created_at DESC LIMIT 1`,
    [taskId],
  )).rows[0];
  if (!r) return null;
  return getRecetteById(r.recette_id);
}

export async function getRecetteById(recetteId) {
  await ensureSchema();
  const r = (await pool().query(
    `SELECT r.*, (SELECT COUNT(*) FROM recette_tasks rt WHERE rt.recette_id = r.recette_id) AS tasks_count,
            (SELECT COUNT(*) FROM recette_items i WHERE i.recette_id = r.recette_id) AS items_count
     FROM recettes r WHERE r.recette_id = $1`,
    [recetteId],
  )).rows[0];
  if (!r) return null;
  const tasks = (await pool().query(
    "SELECT task_id FROM recette_tasks WHERE recette_id = $1 ORDER BY task_id",
    [recetteId],
  )).rows.map((x) => x.task_id);
  const projs = (await pool().query(
    "SELECT project FROM recette_projects WHERE recette_id = $1 ORDER BY project",
    [recetteId],
  )).rows.map((x) => x.project);
  const projects = projs.length ? projs : (r.project ? [r.project] : []);
  const items = (await pool().query(
    "SELECT id, content, classification, discussion, scope, project, title, acceptance, exec_order, vigilance, status, created_task_id, created_at FROM recette_items WHERE recette_id = $1 ORDER BY id ASC",
    [recetteId],
  )).rows.map((i) => ({
    itemId: Number(i.id),
    content: i.content,
    classification: i.classification,
    discussion: i.discussion,
    scope: i.scope ? JSON.parse(i.scope) : [],
    project: i.project ?? null,
    title: i.title ?? null,
    acceptance: i.acceptance ?? null,
    execOrder: i.exec_order ?? null,
    vigilance: i.vigilance ?? null,
    status: i.status,
    createdTaskId: i.created_task_id ?? null,
    createdAt: i.created_at,
  }));
  const documents = await listRecetteDocuments(recetteId);
  return {
    recetteId: r.recette_id,
    project: r.project,
    projects,
    title: r.title,
    description: r.description ?? null,
    sessionId: r.session_id,
    status: r.status,
    createdAt: r.created_at,
    confirmedAt: r.confirmed_at,
    confirmedBy: r.confirmed_by,
    tasks,
    items,
    documents,
  };
}

// --- Documents de recette --------------------------------------------------
export async function addRecetteDocument({ recetteId, title, nature, source, path, artifactId }) {
  await ensureSchema();
  const r = (await pool().query(
    `INSERT INTO recette_documents (recette_id, title, nature, source, path, artifact_id, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [recetteId, title ?? null, nature ?? null, source || "import", path ?? null, artifactId ?? null, nowIso()],
  )).rows[0];
  return listRecetteDocuments(recetteId);
}

export async function listRecetteDocuments(recetteId) {
  await ensureSchema();
  const rows = (await pool().query(
    `SELECT d.id, d.recette_id, d.title, d.nature, d.source, d.path, d.artifact_id, d.created_at,
            a.title AS artifact_title, a.task_id AS artifact_task
     FROM recette_documents d
     LEFT JOIN artifacts a ON a.artifact_id = d.artifact_id
     WHERE d.recette_id = $1 ORDER BY d.id ASC`,
    [recetteId],
  )).rows;
  return rows.map((r) => ({
    documentId: Number(r.id),
    recetteId: r.recette_id,
    title: r.title || r.artifact_title || (r.path ? r.path.split("/").pop() : null) || null,
    nature: r.nature,
    source: r.source,
    path: r.path,
    artifactId: r.artifact_id ?? null,
    artifactTask: r.artifact_task ?? null,
    createdAt: r.created_at,
  }));
}

export async function removeRecetteDocument(documentId) {
  await ensureSchema();
  const r = (await pool().query(
    "DELETE FROM recette_documents WHERE id = $1 RETURNING recette_id",
    [documentId],
  )).rows[0];
  return r ? r.recette_id : null;
}

export async function addRecetteItem({ recetteId, project, content, classification, discussion, scope, title, acceptance, execOrder, vigilance }) {
  await ensureSchema();
  if (!content || !String(content).trim()) throw new Error("contenu requis pour un élément de recette");
  // 1 item = 1 projet cible. Défaut si absent : premier projet de la recette.
  const target = project && String(project).trim()
    ? String(project).trim()
    : (await pool().query(
        "SELECT project FROM recette_projects WHERE recette_id = $1 ORDER BY project LIMIT 1",
        [recetteId],
      )).rows[0]?.project ?? null;
  const r = (await pool().query(
    `INSERT INTO recette_items (recette_id, project, content, classification, discussion, scope, title, acceptance, exec_order, vigilance, status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'open',$11) RETURNING id`,
    [recetteId, target, String(content).trim(), classification || "rework", discussion ?? null, scope && scope.length ? JSON.stringify(scope) : null, title ?? null, acceptance ?? null, execOrder ?? null, vigilance ?? null, nowIso()],
  )).rows[0];
  return getRecetteItem(Number(r.id));
}

export async function updateRecetteItem({ itemId, classification, discussion, scope, project, title, acceptance, execOrder, vigilance, status, createdTaskId }) {
  await ensureSchema();
  const sets = [];
  const params = [];
  if (classification) { params.push(classification); sets.push(`classification = $${params.length}`); }
  if (discussion !== undefined) { params.push(discussion); sets.push(`discussion = $${params.length}`); }
  if (scope !== undefined) { params.push(scope && scope.length ? JSON.stringify(scope) : null); sets.push(`scope = $${params.length}`); }
  if (project !== undefined) { params.push(project ? String(project).trim() : null); sets.push(`project = $${params.length}`); }
  if (title !== undefined) { params.push(title); sets.push(`title = $${params.length}`); }
  if (acceptance !== undefined) { params.push(acceptance); sets.push(`acceptance = $${params.length}`); }
  if (execOrder !== undefined) { params.push(execOrder ?? null); sets.push(`exec_order = $${params.length}`); }
  if (vigilance !== undefined) { params.push(vigilance); sets.push(`vigilance = $${params.length}`); }
  if (status) { params.push(status); sets.push(`status = $${params.length}`); }
  if (createdTaskId !== undefined) { params.push(createdTaskId); sets.push(`created_task_id = $${params.length}`); }
  if (!sets.length) return getRecetteItem(itemId);
  params.push(itemId);
  await pool().query(`UPDATE recette_items SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
  return getRecetteItem(itemId);
}

async function getRecetteItem(itemId) {
  const r = (await pool().query(
    "SELECT id, recette_id, project, content, classification, discussion, scope, title, acceptance, exec_order, vigilance, status, created_task_id, created_at FROM recette_items WHERE id = $1",
    [itemId],
  )).rows[0];
  return r ? {
    itemId: Number(r.id),
    recetteId: r.recette_id,
    project: r.project ?? null,
    content: r.content,
    classification: r.classification,
    discussion: r.discussion,
    scope: r.scope ? JSON.parse(r.scope) : [],
    title: r.title ?? null,
    acceptance: r.acceptance ?? null,
    execOrder: r.exec_order ?? null,
    vigilance: r.vigilance ?? null,
    status: r.status,
    createdTaskId: r.created_task_id ?? null,
    createdAt: r.created_at,
  } : null;
}


// Supprime un élément de recette. Garde : refus si une tâche a déjà été créée
// depuis cet élément (statut task_created) — on ne supprime pas une preuve.
export async function deleteRecetteItem({ itemId }) {
  await ensureSchema();
  const r = (await pool().query(
    "SELECT id, status, created_task_id FROM recette_items WHERE id = $1",
    [Number(itemId)],
  )).rows[0];
  if (!r) throw new Error(`élément de recette introuvable : ${itemId}`);
  if (r.status === "task_created" || r.created_task_id) {
    throw new Error(`impossible de supprimer : une tâche (${r.created_task_id || "?"}) a déjà été créée depuis cet élément`);
  }
  await pool().query("DELETE FROM recette_items WHERE id = $1", [Number(itemId)]);
  return { ok: true, itemId: Number(itemId) };
}

// Associe une session lancée à une recette + passe en cours.
export async function setRecetteSession({ recetteId, sessionId }) {
  await ensureSchema();
  await pool().query(
    "UPDATE recettes SET status = 'in_progress', session_id = COALESCE($1, session_id) WHERE recette_id = $2",
    [sessionId ?? null, recetteId],
  );
  return getRecetteById(recetteId);
}

// Marque la recette TERMINÉE (faite) + toutes les tâches couvertes recette_status='done'.
export async function confirmRecette({ recetteId, confirmedBy }) {
  await ensureSchema();
  const r = (await pool().query(
    "UPDATE recettes SET status = 'done', confirmed_at = $1, confirmed_by = $2 WHERE recette_id = $3 RETURNING recette_id",
    [nowIso(), confirmedBy ?? "human", recetteId],
  )).rows[0];
  if (!r) throw new Error(`recette inconnue : ${recetteId}`);
  const tasks = (await pool().query("SELECT task_id FROM recette_tasks WHERE recette_id = $1", [recetteId])).rows.map((x) => x.task_id);
  for (const t of tasks) {
    await pool().query("UPDATE tasks SET recette_status = 'done' WHERE id = $1", [t]);
    // Résout les décisions recette legacy encore 'awaiting' de la tâche couverte.
    await pool().query(
      `UPDATE decisions SET status = 'approved', resolved_at = $1, resolution = 'Recette close via le framework recette (v0.8)'
       WHERE task_id = $2 AND kind = 'recette' AND status = 'awaiting'`,
      [nowIso(), t],
    );
  }
  return getRecetteById(recetteId);
}

// ===========================================================================
// Tests E2E Playwright — registre + exécutions (cadrage 07-tests-e2e.md)
// ===========================================================================

// ID stable d'un test : déterministe pour (project, spec_file, scenario).
function e2eStableId(project, specFile, scenario) {
  let h = 0x811c9dc5;
  for (const part of [project, specFile, scenario]) {
    for (let i = 0; i < part.length; i++) { h ^= part.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  }
  const hash = (h >>> 0).toString(36).slice(0, 8);
  const proj = String(project).toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "APP";
  return `E2E-${proj}-${hash}`;
}

// Enregistre (ou réactive) un test dans le référentiel central. 1 test() = 1 entité.
export async function upsertE2ETest({ project, specFile, scenario, title }) {
  await ensureSchema();
  if (!project || !specFile || !scenario) throw new Error("project, specFile et scenario requis");
  const p = String(project).trim();
  const now = nowIso();
  const r = (await pool().query(
    `INSERT INTO e2e_tests (id, project, spec_file, scenario, title, status, version, first_seen_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,'ACTIVE',1,$6,$6)
     ON CONFLICT (project, spec_file, scenario)
     DO UPDATE SET title = EXCLUDED.title, status = 'ACTIVE', updated_at = $6
     RETURNING id`,
    [e2eStableId(p, specFile, scenario), p, String(specFile).trim(), String(scenario).trim(), title ?? null, now],
  )).rows[0];
  return { id: r.id, project: p, specFile: String(specFile).trim(), scenario: String(scenario).trim() };
}

// Associe un test à une tâche (N:N typé : CREATED|UPDATED|REGRESSION|EXISTING + raison).
export async function linkTaskE2E({ taskId, e2eTestId, relationType, reason }) {
  await ensureSchema();
  await pool().query(
    `INSERT INTO task_e2e (task_id, e2e_test_id, relation_type, reason)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (task_id, e2e_test_id) DO UPDATE SET relation_type = EXCLUDED.relation_type, reason = EXCLUDED.reason`,
    [taskId, e2eTestId, relationType || "REGRESSION", reason ?? null],
  );
  return { ok: true, taskId, e2eTestId };
}

export async function unlinkTaskE2E({ taskId, e2eTestId }) {
  await ensureSchema();
  await pool().query("DELETE FROM task_e2e WHERE task_id = $1 AND e2e_test_id = $2", [taskId, e2eTestId]);
  return { ok: true };
}

// Liste les tests associés à une tâche (avec leur dernière exécution).
export async function listTaskE2E(taskId) {
  await ensureSchema();
  const rows = (await pool().query(
    `SELECT t.id, t.project, t.spec_file, t.scenario, t.title, t.status, t.version,
            te.relation_type, te.reason,
            (SELECT x.status FROM e2e_executions x WHERE x.e2e_test_id = t.id AND x.task_id = $1 ORDER BY x.created_at DESC LIMIT 1) AS last_status,
            (SELECT x.duration_ms FROM e2e_executions x WHERE x.e2e_test_id = t.id AND x.task_id = $1 ORDER BY x.created_at DESC LIMIT 1) AS last_duration_ms,
            (SELECT x.id FROM e2e_executions x WHERE x.e2e_test_id = t.id AND x.task_id = $1 ORDER BY x.created_at DESC LIMIT 1) AS last_execution_id
     FROM task_e2e te JOIN e2e_tests t ON t.id = te.e2e_test_id
     WHERE te.task_id = $1 ORDER BY t.scenario`,
    [taskId],
  )).rows;
  return rows.map((r) => ({
    e2eTestId: r.id,
    project: r.project,
    specFile: r.spec_file,
    scenario: r.scenario,
    title: r.title,
    status: r.status,
    version: r.version,
    relationType: r.relation_type,
    reason: r.reason,
    lastExecutionId: r.last_execution_id,
    lastStatus: r.last_status,
    lastDurationMs: r.last_duration_ms,
  }));
}

// Enregistre une exécution E2E (statut PENDING/RUNNING puis mis à jour via update).
export async function recordE2EExecution({ taskId, e2eTestId, deploymentId, planId, env, commitSha, branch, pipelineRef, status = "RUNNING", attempts = 1 }) {
  await ensureSchema();
  if (!e2eTestId) throw new Error("e2eTestId requis");
  const id = `EXE-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  await pool().query(
    `INSERT INTO e2e_executions (id, e2e_test_id, task_id, deployment_id, plan_id, env, commit_sha, branch, pipeline_ref, status, attempts, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, e2eTestId, taskId ?? null, deploymentId ?? null, planId ?? null, env ?? null, commitSha ?? null, branch ?? null, pipelineRef ?? null, status, attempts || 1, nowIso()],
  );
  return { id, e2eTestId, taskId: taskId ?? null, status };
}

// Met à jour une exécution (verdict, preuves, durée).
export async function updateE2EExecution({ executionId, status, durationMs, reportArtifactId, logsUrl, videoUrl, summary, verdictBy, executedAt }) {
  await ensureSchema();
  const sets = [];
  const params = [];
  if (status) { params.push(status); sets.push(`status = $${params.length}`); }
  if (durationMs !== undefined) { params.push(durationMs); sets.push(`duration_ms = $${params.length}`); }
  if (reportArtifactId !== undefined) { params.push(reportArtifactId); sets.push(`report_artifact_id = $${params.length}`); }
  if (logsUrl !== undefined) { params.push(logsUrl); sets.push(`logs_url = $${params.length}`); }
  if (videoUrl !== undefined) { params.push(videoUrl); sets.push(`video_url = $${params.length}`); }
  if (summary !== undefined) { params.push(summary); sets.push(`summary = $${params.length}`); }
  if (verdictBy !== undefined) { params.push(verdictBy); sets.push(`verdict_by = $${params.length}`); }
  if (executedAt !== undefined) { params.push(executedAt); sets.push(`executed_at = $${params.length}`); }
  if (!sets.length) throw new Error("aucun champ à mettre à jour");
  params.push(executionId);
  await pool().query(`UPDATE e2e_executions SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
  return getE2EExecution(executionId);
}

export async function getE2EExecution(executionId) {
  await ensureSchema();
  const r = (await pool().query("SELECT * FROM e2e_executions WHERE id = $1", [executionId])).rows[0];
  if (!r) return null;
  return {
    id: r.id,
    e2eTestId: r.e2e_test_id,
    taskId: r.task_id,
    deploymentId: r.deployment_id,
    planId: r.plan_id,
    env: r.env,
    commitSha: r.commit_sha,
    branch: r.branch,
    pipelineRef: r.pipeline_ref,
    status: r.status,
    durationMs: r.duration_ms,
    attempts: r.attempts,
    executedAt: r.executed_at,
    reportArtifactId: r.report_artifact_id,
    logsUrl: r.logs_url,
    videoUrl: r.video_url,
    summary: r.summary,
    verdictBy: r.verdict_by,
    createdAt: r.created_at,
  };
}

export async function listE2EExecutions({ taskId, e2eTestId, limit = 50 }) {
  await ensureSchema();
  const conds = [];
  const params = [];
  if (taskId) { params.push(taskId); conds.push(`task_id = $${params.length}`); }
  if (e2eTestId) { params.push(e2eTestId); conds.push(`e2e_test_id = $${params.length}`); }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  params.push(Number(limit) || 50);
  const rows = (await pool().query(
    `SELECT * FROM e2e_executions ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params,
  )).rows;
  return rows.map((r) => ({
    id: r.id,
    e2eTestId: r.e2e_test_id,
    taskId: r.task_id,
    deploymentId: r.deployment_id,
    planId: r.plan_id,
    env: r.env,
    commitSha: r.commit_sha,
    branch: r.branch,
    pipelineRef: r.pipeline_ref,
    status: r.status,
    durationMs: r.duration_ms,
    attempts: r.attempts,
    executedAt: r.executed_at,
    reportArtifactId: r.report_artifact_id,
    logsUrl: r.logs_url,
    videoUrl: r.video_url,
    summary: r.summary,
    verdictBy: r.verdict_by,
    createdAt: r.created_at,
  }));
}
