#!/usr/bin/env node
/**
 * task-orchestrator MCP — Moteur d'orchestration de tâches.
 *
 * Principes :
 *  - L'orchestrateur (agent) est le SEUL propriétaire des transitions d'état.
 *    Les agents de fond publient des événements (task_event), jamais des états.
 *  - La machine à états (statemachine.mjs) valide toute transition ; une
 *    transition non listée est refusée.
 *  - Registre SQLite (db.mjs) : source de vérité LOGIQUE (tâches, exécutions,
 *    worktrees, journal). L'état PHYSIQUE reste Git.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { canTaskTransition, isValidState, allowedFrom, VALID_STATES } from "./statemachine.mjs";
import {
  createTask,
  getTask,
  listTasks,
  getExecutions,
  getCurrentExecution,
  appendEvent,
  listEvents,
  applyTransition,
  registerWorktree,
  getWorktree,
  listWorktrees,
  updateWorktree,
  nowIso,
  recordDeployment,
  getDeployment,
  listDeployments,
  findScopeConflicts,
  requestDecision,
  resolveDecision,
  listExpiredDecisions,
  addArtifact,
  listArtifacts,
  registerParticipant,
  listParticipants,
  updateTaskSession,
  linkTaskSession,
  listTaskSessions,
  registerProject,
  getProject,
  listProjects,
  deleteProject,
  deleteTask,
  resolveDecisionAndTransition,
  resolveRecette,
  resetRecette,
  applyPlanTransition,
  createPlanExecution,
  getPlanExecution,
  listPlanExecutions,
  addPlanCommit,
  listPlanCommits,
  listTaskPlanCommits,
} from "./db.mjs";

function text(content) {
  return { content: [{ type: "text", text: content }] };
}

function err(content) {
  return { content: [{ type: "text", text: `ERREUR : ${content}` }], isError: true };
}

// Garde déterministe : un événement ou artefact d'audit ne peut être rattaché
// qu'à une tâche de type "audit". Empêche tout audit automatique sur une tâche
// feature/debug (cohérent avec norme-environnement-travail §23/§25).
function isAuditEvent(type) {
  return typeof type === "string" && /^AUDIT/i.test(type);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function newTaskId() {
  return `T-${stamp()}`;
}

function newExecutionId(taskId) {
  return `E-${taskId}-${Math.random().toString(36).slice(2, 8)}`;
}

const server = new McpServer({ name: "task-orchestrator", version: "0.1.0" });

// === task_register ===
server.registerTool("task_register", {
  description:
    "Crée une tâche dans le registre (contexte immuable) et initialise son exécution au statut 'queued'. Retourne taskId et executionId.",
  inputSchema: {
    request: z.string().describe("Demande d'origine (objectif)."),
    project: z.string().describe("Projet cible."),
    workspace: z.string().optional().describe("Workspace Coder associé."),
    type: z.enum(["feature", "debug", "audit"]).default("feature"),
    auditTarget: z.enum(["backend", "frontend", "both"]).optional().describe("Cible d'un audit : backend | frontend | both."),
    priority: z.enum(["low", "normal", "high", "critical"]).default("normal"),
    deadline: z.string().optional().describe("Échéance ISO 8601."),
    budgetMaxSteps: z.number().int().optional().describe("Itérations agentiques max."),
    scope: z.array(z.string()).optional().describe("Périmètres (chemins) réservés par la tâche."),
    acceptanceCriteria: z.array(z.string()).optional(),
    constraints: z.array(z.string()).optional(),
    dependencies: z.array(z.string()).optional().describe("taskId dont cette tâche dépend."),
    taskId: z.string().optional(),
    sessionId: z.string().optional().describe("Session opencode qui crée la tâche (liée par le plugin permission-hook)."),
  },
}, async (input) => {
  try {
    const taskId = input.taskId || newTaskId();
    if (await getTask(taskId)) return err(`tâche déjà enregistrée : ${taskId}`);
    if (!await getProject(input.project)) {
      return err(`projet inconnu : ${input.project} — enregistrer le projet avant de créer la tâche`);
    }
    const executionId = newExecutionId(taskId);
    const task = await createTask({ ...input, id: taskId, executionId });
    return text(JSON.stringify({ ok: true, taskId, executionId, task }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === project_register ===
server.registerTool("project_register", {
  description: "Enregistre (ou met à jour) un projet dans le registre. Toute tâche doit référencer un projet existant.",
  inputSchema: {
    id: z.string().describe("Identifiant du projet (ex: oniria)."),
    name: z.string().describe("Nom lisible du projet."),
    workspace: z.string().optional().describe("Workspace Coder associé."),
    gitPath: z.string().optional().describe("Chemin du dépôt git (hôte ou /home/coder)."),
    createdBy: z.string().optional(),
  },
}, async ({ id, name, workspace, gitPath, createdBy }) => {
  try {
    const project = await registerProject({ id, name, workspace, gitPath, createdBy });
    return text(JSON.stringify({ ok: true, project }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === project_list ===
server.registerTool("project_list", {
  description: "Liste les projets enregistrés dans le registre.",
  inputSchema: {},
}, async () => {
  try {
    const projects = await listProjects();
    return text(JSON.stringify({ count: projects.length, projects }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === project_delete ===
server.registerTool("project_delete", {
  description: "Supprime un projet du registre.",
  inputSchema: { id: z.string() },
}, async ({ id }) => {
  try {
    const r = await deleteProject(id);
    if (!r) return err(`projet inconnu : ${id}`);
    return text(JSON.stringify({ ok: true, ...r }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === task_get ===
server.registerTool("task_get", {
  description: "Renvoie le détail d'une tâche (contexte + exécutions + participants + exécutions des plans).",
  inputSchema: { taskId: z.string() },
}, async ({ taskId }) => {
  try {
    const task = await getTask(taskId);
    if (!task) return err(`tâche inconnue : ${taskId}`);
    const executions = await getExecutions(taskId);
    const participants = await listParticipants(taskId);
    const planExecutions = await listPlanExecutions(taskId);
    const planCommits = await listTaskPlanCommits(taskId);
    const sessions = await listTaskSessions(taskId);
    return text(JSON.stringify({ task, executions, participants, planExecutions, planCommits, sessions }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === task_link_session ===
server.registerTool("task_link_session", {
  description:
    "Lie une session opencode (ex: lancée par le panneau) à une tâche existante, et l'enregistre dans la trace des sessions (append-only, pour le suivi de consommation par session/rework).",
  inputSchema: {
    taskId: z.string(),
    sessionId: z.string().describe("Identifiant de session opencode à lier."),
    kind: z.enum(["launch", "rework", "relaunch"]).optional().describe("Type de lien : launch | rework | relaunch (défaut launch)."),
  },
}, async ({ taskId, sessionId, kind }) => {
  try {
    if (!await getTask(taskId)) return err(`tâche inconnue : ${taskId}`);
    const r = await linkTaskSession(taskId, sessionId, kind || "launch");
    return text(JSON.stringify({ ok: true, taskId, task: r.task, sessions: r.sessions }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === task_clear_session ===
server.registerTool("task_clear_session", {
  description: "Détache la session opencode d'une tâche (met session_id à NULL).",
  inputSchema: { taskId: z.string() },
}, async ({ taskId }) => {
  try {
    if (!await getTask(taskId)) return err(`tâche inconnue : ${taskId}`);
    const task = await updateTaskSession(taskId, null);
    return text(JSON.stringify({ ok: true, task }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === task_list ===
server.registerTool("task_list", {
  description: "Liste les tâches (avec statut courant), filtrables par projet.",
  inputSchema: { project: z.string().optional() },
}, async ({ project }) => {
  try {
    const list = await listTasks({ project });
    const tasks = [];
    for (const t of list) {
      const exec = await getCurrentExecution(t.id);
      tasks.push({ taskId: t.id, project: t.project, type: t.type, priority: t.priority, status: exec?.status || "queued", request: t.request });
    }
    return text(JSON.stringify({ count: tasks.length, tasks }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === task_transition ===
server.registerTool("task_transition", {
  description:
    "Applique une transition d'état validée par la machine à états. Seule voie de changement de statut. Toute transition non listée est refusée.",
  inputSchema: {
    taskId: z.string(),
    to: z.string().describe(`Statut cible (parmi ${VALID_STATES.join(", ")}).`),
    by: z.string().optional().describe("Acteur de la transition (ex: orchestrator, humain)."),
    note: z.string().optional(),
  },
}, async ({ taskId, to, by, note }) => {
  try {
    const exec = await getCurrentExecution(taskId);
    if (!exec) return err(`tâche inconnue : ${taskId}`);
    if (!isValidState(to)) return err(`statut invalide : ${to}`);
    if (!canTaskTransition(exec.status, to)) {
      return err(`transition refusée : ${exec.status} -> ${to}. Autorisé depuis ${exec.status} : ${allowedFrom(exec.status).join(", ") || "(terminal)"}`);
    }
    const r = await applyTransition({ taskId, to, by: by || "orchestrator", note });
    return text(JSON.stringify(r, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === task_event ===
server.registerTool("task_event", {
  description:
    "Publie un événement (append-only) rattaché à une tâche. Les agents de fond publient des événements, jamais des états.",
  inputSchema: {
    taskId: z.string(),
    type: z.string().describe("Type d'événement (ex: PLAN_CREATED, EXECUTION_STARTED, CHECKPOINT, BLOCKED, EXECUTION_COMPLETED, AUDIT_COMPLETED)."),
    by: z.string().optional(),
    detail: z.record(z.any()).optional(),
  },
}, async ({ taskId, type, by, detail }) => {
  try {
    const task = await getTask(taskId);
    if (!task) return err(`tâche inconnue : ${taskId}`);
    if (isAuditEvent(type) && task.type !== "audit") {
      return err(`événement d'audit refusé : la tâche ${taskId} est de type "${task.type}" (un audit n'est rattaché qu'à une tâche type="audit").`);
    }
    await appendEvent({
      eventId: `${taskId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      taskId,
      type,
      by: by || "agent",
      detail,
    });
    return text(JSON.stringify({ ok: true, taskId, type }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === events_list ===
server.registerTool("events_list", {
  description: "Liste le journal d'événements (append-only) d'une tâche ou global.",
  inputSchema: { taskId: z.string().optional(), limit: z.number().int().default(100) },
}, async ({ taskId, limit }) => {
  try {
    return text(JSON.stringify({ events: await listEvents(taskId, limit) }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === worktree_register ===
server.registerTool("worktree_register", {
  description: "Enregistre un worktree existant (physique) dans le registre, statut AVAILABLE.",
  inputSchema: {
    worktreeId: z.string(),
    project: z.string(),
    path: z.string(),
    branch: z.string().optional(),
  },
}, async ({ worktreeId, project, path, branch }) => {
  try {
    if (await getWorktree(worktreeId)) return err(`worktree déjà enregistré : ${worktreeId}`);
    const wt = await registerWorktree({ worktreeId, project, path, branch });
    return text(JSON.stringify({ ok: true, worktree: wt }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === worktree_list ===
server.registerTool("worktree_list", {
  description: "Liste les worktrees enregistrés (cycle de vie + lease), filtrables par projet.",
  inputSchema: { project: z.string().optional() },
}, async ({ project }) => {
  try {
    return text(JSON.stringify({ worktrees: await listWorktrees(project) }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === worktree_reserve ===
server.registerTool("worktree_reserve", {
  description: "Réserve un worktree (AVAILABLE -> RESERVED) pour une tâche/agent avec un lease (leaseUntil).",
  inputSchema: {
    worktreeId: z.string(),
    taskId: z.string(),
    agent: z.string(),
    leaseMinutes: z.number().int().default(30),
  },
}, async ({ worktreeId, taskId, agent, leaseMinutes }) => {
  try {
    const wt = await getWorktree(worktreeId);
    if (!wt) return err(`worktree inconnu : ${worktreeId}`);
    if (wt.status !== "AVAILABLE") return err(`worktree ${worktreeId} non disponible (statut ${wt.status})`);
    const now = Date.now();
    const leaseUntil = new Date(now + leaseMinutes * 60 * 1000).toISOString();
    const updated = await updateWorktree(worktreeId, {
      status: "RESERVED",
      agent,
      taskId,
      reservedAt: nowIso(),
      leaseUntil,
      lastHeartbeat: nowIso(),
      lock: 1,
    });
    return text(JSON.stringify({ ok: true, worktree: updated }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === worktree_release ===
server.registerTool("worktree_release", {
  description: "Libère un worktree (RESERVED/IN_USE -> RELEASED), lève le verrou et détache la tâche.",
  inputSchema: { worktreeId: z.string() },
}, async ({ worktreeId }) => {
  try {
    const wt = await getWorktree(worktreeId);
    if (!wt) return err(`worktree inconnu : ${worktreeId}`);
    if (!["RESERVED", "IN_USE"].includes(wt.status)) return err(`worktree ${worktreeId} non réservé (statut ${wt.status})`);
    const updated = await updateWorktree(worktreeId, {
      status: "RELEASED",
      agent: null,
      taskId: null,
      leaseUntil: null,
      lastHeartbeat: null,
      lock: 0,
    });
    return text(JSON.stringify({ ok: true, worktree: updated }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === lease_renew ===
server.registerTool("lease_renew", {
  description: "Renouvelle le lease d'un worktree (prolonge leaseUntil de leaseMinutes).",
  inputSchema: { worktreeId: z.string(), leaseMinutes: z.number().int().default(30) },
}, async ({ worktreeId, leaseMinutes }) => {
  try {
    const wt = await getWorktree(worktreeId);
    if (!wt) return err(`worktree inconnu : ${worktreeId}`);
    if (!["RESERVED", "IN_USE"].includes(wt.status)) return err(`worktree ${worktreeId} sans lease actif (statut ${wt.status})`);
    const leaseUntil = new Date(Date.now() + leaseMinutes * 60 * 1000).toISOString();
    const updated = await updateWorktree(worktreeId, { leaseUntil, lastHeartbeat: nowIso() });
    return text(JSON.stringify({ ok: true, worktree: updated }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === lease_expired ===
server.registerTool("lease_expired", {
  description: "Liste les worktrees dont le lease est expiré (récupérables).",
  inputSchema: { project: z.string().optional() },
}, async ({ project }) => {
  try {
    const now = Date.now();
    const expired = (await listWorktrees(project)).filter(
      (w) => ["RESERVED", "IN_USE"].includes(w.status) && w.leaseUntil && new Date(w.leaseUntil).getTime() < now,
    );
    return text(JSON.stringify({ count: expired.length, expired }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === deployment_record ===
server.registerTool("deployment_record", {
  description:
    "Enregistre/marque l'état d'un déploiement CI/CD d'une tâche (deploy_pending/deploying/deployed/deploy_failed/post_deploy_verified).",
  inputSchema: {
    taskId: z.string(),
    status: z.string().describe("Statut du déploiement."),
    pipelineUrl: z.string().optional(),
    verifiedAt: z.string().optional(),
  },
}, async ({ taskId, status, pipelineUrl, verifiedAt }) => {
  try {
    if (!await getTask(taskId)) return err(`tâche inconnue : ${taskId}`);
    const d = await recordDeployment({ taskId, status, pipelineUrl, verifiedAt });
    return text(JSON.stringify({ ok: true, deployment: d }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === scope_conflict ===
server.registerTool("scope_conflict", {
  description:
    "Détecte les conflits de scope (périmètre) entre une tâche candidate et les tâches actives / worktrees réservés d'un projet.",
  inputSchema: {
    project: z.string(),
    scope: z.array(z.string()).describe("Périmètres (chemins) de la tâche candidate."),
    excludeTaskId: z.string().optional(),
  },
}, async ({ project, scope, excludeTaskId }) => {
  try {
    const r = await findScopeConflicts(project, scope, excludeTaskId);
    return text(
      JSON.stringify(
        { ok: true, conflict: r.conflicts.length > 0 || r.reservedWorktrees.length > 0, conflicts: r.conflicts, reservedWorktrees: r.reservedWorktrees },
        null,
        2,
      ),
    );
  } catch (e) {
    return err(e.message);
  }
});

// === decision_request ===
server.registerTool("decision_request", {
  description:
    "Enregistre une décision humaine en attente (validation de plan, review/merge ou permission) avec échéance (expiresAt).",
  inputSchema: {
    taskId: z.string(),
    kind: z.enum(["validation", "review", "permission", "recette"]).default("validation"),
    ttlMinutes: z.number().int().optional().describe("Durée de validité avant expiration (défaut 2880 = 48h)."),
    expiresAt: z.string().optional().describe("Échéance ISO 8601 (sinon calculée via ttlMinutes)."),
    detail: z.string().optional().describe("Contexte/détail de la décision (ex: nom du plan, résumé des changements)."),
    by: z.string().optional().describe("Sous-agent à l'origine de la demande (ex: atomic-plan, build-notify)."),
    sessionId: z.string().optional().describe("Session opencode de la demande."),
    planId: z.string().optional().describe("Plan (sous-tâche) rattaché à la décision."),
  },
}, async ({ taskId, kind, ttlMinutes, expiresAt, detail, by, sessionId, planId }) => {
  try {
    if (!(await getTask(taskId))) return err(`tâche inconnue : ${taskId}`);
    const d = await requestDecision({ taskId, kind, expiresAt, ttlMinutes: ttlMinutes ?? 2880, detail, requestedBy: by, sessionId, planId });
    return text(JSON.stringify({ ok: true, decision: d }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === decision_resolve ===
server.registerTool("decision_resolve", {
  description: "Clôt une décision humaine (approved/rejected). Pour kind=validation/review, provoque la transition atomique vers approved/rejected + événement CLOSED (remarques). Pour kind=recette, tranche la recette (colonne recette_status) sans toucher au statut d'exécution.",
  inputSchema: {
    decisionId: z.string(),
    status: z.enum(["approved", "rejected"]),
    resolution: z.string().optional(),
    by: z.string().optional().describe("Acteur (ex: human, admin)."),
  },
}, async ({ decisionId, status, resolution, by }) => {
  try {
    const r = await resolveDecisionAndTransition({ decisionId, status, resolution, by });
    if (!r || !r.decision) return err(`décision inconnue : ${decisionId}`);
    return text(JSON.stringify({ ok: true, ...r }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === task_recette ===
server.registerTool("task_recette", {
  description:
    "Tranche la recette (acceptation humaine après déploiement) d'une tâche au statut 'done' : approved/rejected + remarques, tracée comme décision kind='recette'. Colonne recette_status (indépendante du statut d'exécution).",
  inputSchema: {
    taskId: z.string(),
    status: z.enum(["approved", "rejected"]),
    resolution: z.string().optional().describe("Remarques de recette (ex: ce qui manque en cas de rejet)."),
    by: z.string().optional().describe("Acteur (ex: human)."),
  },
}, async ({ taskId, status, resolution, by }) => {
  try {
    const r = await resolveRecette({ taskId, status, resolution, by });
    return text(JSON.stringify(r, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === task_recette_reset ===
server.registerTool("task_recette_reset", {
  description: "Remet la recette d'une tâche à 'pending' (début d'une reprise après rejet de recette).",
  inputSchema: { taskId: z.string() },
}, async ({ taskId }) => {
  try {
    const task = await resetRecette(taskId);
    return text(JSON.stringify({ ok: true, taskId, recetteStatus: task.recetteStatus }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === plan_transition ===
server.registerTool("plan_transition", {
  description:
    "Transitionne l'exécution d'un plan (sous-tâche) — cycle de vie indépendant : planned → in_progress → validating → review → approved → merge_pending → merged → deploy… → done (+ rework/blocked/failed/aborted).",
  inputSchema: {
    planId: z.string(),
    to: z.string().describe(`Statut cible (parmi ${VALID_STATES.join(", ")}).`),
    by: z.string().optional(),
    note: z.string().optional(),
  },
}, async ({ planId, to, by, note }) => {
  try {
    const r = await applyPlanTransition({ planId, to, by: by || "orchestrator", note });
    return text(JSON.stringify(r, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === plan_execution_get ===
server.registerTool("plan_execution_get", {
  description: "Renvoie l'exécution courante d'un plan (statut, tentative).",
  inputSchema: { planId: z.string() },
}, async ({ planId }) => {
  try {
    const pe = await getPlanExecution(planId);
    return text(JSON.stringify({ planExecution: pe }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === plan_execution_create ===
server.registerTool("plan_execution_create", {
  description: "Crée l'exécution d'un plan (statut initial 'planned').",
  inputSchema: { planId: z.string() },
}, async ({ planId }) => {
  try {
    const pe = await createPlanExecution(planId);
    return text(JSON.stringify({ ok: true, planExecution: pe }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === plan_commit_add ===
server.registerTool("plan_commit_add", {
  description:
    "Enregistre un commit dans la trace append-only d'un plan (sous-tâche). Tous les commits sont conservés (y compris ceux des reworks : une sous-tâche peut produire plusieurs commits). Chaque commit décrit les fichiers touchés (path, status added|modified|deleted|renamed, additions, deletions, diff).",
  inputSchema: {
    planId: z.string().describe("Identifiant du plan (sous-tâche)."),
    sha: z.string().describe("SHA du commit (complet ou court)."),
    branch: z.string().optional().describe("Branche sur laquelle le commit a été créé."),
    message: z.string().optional().describe("Message du commit."),
    author: z.string().optional(),
    committedAt: z.string().optional().describe("Date ISO 8601 du commit."),
    files: z.array(z.object({
      path: z.string().describe("Chemin du fichier touché."),
      status: z.string().describe("added | modified | deleted | renamed"),
      additions: z.number().int().optional(),
      deletions: z.number().int().optional(),
      diff: z.string().optional().describe("Diff unifié du fichier (patch)."),
    })).optional(),
    taskId: z.string().optional(),
    executionId: z.string().optional(),
  },
}, async ({ planId, sha, branch, message, author, committedAt, files, taskId, executionId }) => {
  try {
    if (!planId) return err("planId requis");
    if (!sha) return err("sha requis");
    const commits = await addPlanCommit({ planId, executionId, branch, sha, message, author, committedAt, files });
    return text(JSON.stringify({ ok: true, planId, count: commits.length, commits }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === plan_commits_list ===
server.registerTool("plan_commits_list", {
  description:
    "Liste les commits rattachés à un plan (sous-tâche), dans l'ordre d'ajout. Tous les commits sont conservés (y compris ceux des reworks).",
  inputSchema: { planId: z.string() },
}, async ({ planId }) => {
  try {
    const commits = await listPlanCommits(planId);
    return text(JSON.stringify({ count: commits.length, commits }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === decision_expired ===
server.registerTool("decision_expired", {
  description: "Liste les décisions humaines en attente dont l'échéance est dépassée.",
  inputSchema: { taskId: z.string().optional() },
}, async ({ taskId }) => {
  try {
    const list = await listExpiredDecisions(taskId);
    return text(JSON.stringify({ count: list.length, expired: list }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === artifact_add ===
server.registerTool("artifact_add", {
  description:
    "Rattache un document/livrable (plan, audit, rapport...) à une tâche. Le chemin `path` doit être un chemin absolu hôte lisible (pour le téléchargement depuis le panneau).",
  inputSchema: {
    taskId: z.string(),
    kind: z.string().describe("Type de document : plan | audit | report | autre."),
    title: z.string().optional().describe("Titre lisible (ex: Plan-echo-cancellation)."),
    path: z.string().describe("Chemin absolu (hôte) du fichier."),
  },
}, async ({ taskId, kind, title, path }) => {
  try {
    const task = await getTask(taskId);
    if (!task) return err(`tâche inconnue : ${taskId}`);
    if (kind === "audit" && task.type !== "audit") {
      return err(`artefact d'audit refusé : la tâche ${taskId} est de type "${task.type}" (un audit n'est rattaché qu'à une tâche type="audit").`);
    }
    const a = await addArtifact({ taskId, kind, title, path });
    return text(JSON.stringify({ ok: true, artifact: a }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === artifact_list ===
server.registerTool("artifact_list", {
  description: "Liste les documents/livrables rattachés à une tâche (ou tous).",
  inputSchema: { taskId: z.string().optional() },
}, async ({ taskId }) => {
  try {
    const artifacts = await listArtifacts(taskId);
    return text(JSON.stringify({ count: artifacts.length, artifacts }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === participant_add ===
server.registerTool("participant_add", {
  description:
    "Enregistre un agent comme participant d'une tâche (idempotent). Rôle : planner | executor | auditor | orchestrator.",
  inputSchema: {
    taskId: z.string(),
    agent: z.string().describe("Nom de l'agent (ex: atomic-plan, build-notify, hexagonal-architecture-auditor)."),
    role: z.string().optional().describe("Rôle : planner | executor | auditor | orchestrator."),
  },
}, async ({ taskId, agent, role }) => {
  try {
    if (!await getTask(taskId)) return err(`tâche inconnue : ${taskId}`);
    const participants = await registerParticipant({ taskId, agent, role });
    return text(JSON.stringify({ ok: true, taskId, participants }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === task_delete ===
server.registerTool("task_delete", {
  description: "Supprime définitivement une tâche et tout son rattaché (events, executions, worktrees, deployments, decisions, artifacts, plans).",
  inputSchema: { taskId: z.string() },
}, async ({ taskId }) => {
  try {
    const r = await deleteTask(taskId);
    if (!r) return err(`tâche inconnue : ${taskId}`);
    return text(JSON.stringify({ ok: true, ...r }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === main ===
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error("Erreur fatale du MCP server task-orchestrator:", e);
  process.exit(1);
});
