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
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, extname } from "node:path";
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
  recordScopeConflicts,
  countScopeConflicts,
  findPlanTask,
  requestDecision,
  resolveDecision,
  listExpiredDecisions,
  addArtifact,
  listArtifacts,
  addTaskLink,
  removeTaskLink,
  listTaskLinks,
  startRecette,
  addRecetteProject,
  removeRecetteProject,
  unlinkRecetteTask,
  upsertE2ETest,
  reactivateE2ETest,
  markE2ETestObsolete,
  updateE2ETestMeta,
  setE2ETestParams,
  getE2ETest,
  listE2ETests,
  linkTaskE2E,
  unlinkTaskE2E,
  listTaskE2E,
  recordE2EExecution,
  updateE2EExecution,
  deleteRecetteItem,
  listE2EExecutions,
  getRecette,
  getRecetteById,
  listProjectRecettes,
  linkRecetteTask,
  setRecetteSession,
  addRecetteDocument,
  listRecetteDocuments,
  removeRecetteDocument,
  addRecetteItem,
  updateRecetteItem,
  confirmRecette,
  registerParticipant,
  listParticipants,
  updateTaskSession,
  updateTask,
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

// Trace une erreur de transition (machine à états refusée) — KPI d'orchestration.
async function logTransitionError({ taskId, from, to, reason, by }) {
  if (!taskId) return;
  try {
    await appendEvent({
      eventId: `${taskId}-ERR-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      taskId,
      type: "TRANSITION_ERROR",
      by: by || "system",
      detail: { from: from ?? null, to, reason },
    });
  } catch {}
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function newTaskId() {
  // Unicité garantie : timestamp + suffixe aléatoire (deux enregistrements
  // dans la même seconde ne peuvent pas entrer en collision).
  return `T-${stamp()}-${Math.random().toString(36).slice(2, 6)}`;
}

function newExecutionId(taskId) {
  return `E-${taskId}-${Math.random().toString(36).slice(2, 8)}`;
}

const server = new McpServer({ name: "task-orchestrator", version: "0.6.7" });

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
    linkedTasks: z.array(z.object({
      taskId: z.string().describe("taskId de la tâche associée (source)."),
      description: z.string().optional().describe("Nature de la liaison (ex: 'c'est là que le package a été créé')."),
    })).optional().describe("Tâches liées : tâches associées à exploiter (commits, plans, docs) pour traiter la nouvelle tâche."),
    recetteClass: z.enum(["rework", "bug", "improvement", "feature"]).optional().describe("Si la tâche est issue d'une recette : sa classification."),
    recetteId: z.string().optional().describe("Recette SOURCE si la tâche a été générée par une recette."),
    title: z.string().optional().describe("Titre court de la tâche (dérivé de la demande si absent)."),
    directExecution: z.boolean().optional().describe("Exécution directe via build-notify (pas d'atomic-plan) pour les tâches simples."),
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
  description: "Enregistre (ou met à jour) un projet dans le registre. Toute tâche doit référencer un projet existant. La branche principale (mainBranch) est OBLIGATOIRE pour autoriser le déploiement d'une tâche.",
  inputSchema: {
    id: z.string().describe("Identifiant du projet (ex: oniria)."),
    name: z.string().describe("Nom lisible du projet."),
    workspace: z.string().optional().describe("Workspace Coder associé."),
    gitPath: z.string().optional().describe("Chemin du dépôt git (hôte ou /home/coder)."),
    mainBranch: z.string().optional().describe("Branche principale du projet (ex: main, oniria-preprod) — requise pour déployer."),
    createdBy: z.string().optional(),
  },
}, async ({ id, name, workspace, gitPath, mainBranch, createdBy }) => {
  try {
    const project = await registerProject({ id, name, workspace, gitPath, mainBranch, createdBy });
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
    const linkedTasks = await listTaskLinks(taskId);
    const recette = await getRecette(taskId).catch(() => null);
    return text(JSON.stringify({ task, executions, participants, planExecutions, planCommits, sessions, linkedTasks, recette }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === task_link_add ===
server.registerTool("task_link_add", {
  description: "Rattache une tâche associée (source) à une tâche, avec la nature de la liaison. Les tâches liées sont exploitables par atomic-plan (commits, plans, docs).",
  inputSchema: {
    taskId: z.string().describe("Tâche cible (celle qui exploitera la tâche liée)."),
    linkedTaskId: z.string().describe("taskId de la tâche associée (source)."),
    description: z.string().optional().describe("Nature de la liaison (libre)."),
  },
}, async ({ taskId, linkedTaskId, description }) => {
  try {
    if (!(await getTask(taskId))) return err(`tâche inconnue : ${taskId}`);
    const links = await addTaskLink({ taskId, linkedTaskId, description });
    return text(JSON.stringify({ ok: true, taskId, links }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === task_link_remove ===
server.registerTool("task_link_remove", {
  description: "Retire une tâche associée d'une tâche.",
  inputSchema: { taskId: z.string(), linkedTaskId: z.string() },
}, async ({ taskId, linkedTaskId }) => {
  try {
    const links = await removeTaskLink({ taskId, linkedTaskId });
    return text(JSON.stringify({ ok: true, taskId, links }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === recette_start ===
 server.registerTool("recette_start", {
  description: "Crée une opération de recette de PROJET (v0.9.0) : 1..N projets rattachés + titre + 0..N tâches couvertes + session dédiée. La recette est un objet de premier niveau rattaché à UN OU PLUSIEURS projets.",
  inputSchema: {
    project: z.string().optional().describe("Projet principal/historique (1er projet). Rétrocompat : requis si `projects` absent."),
    projects: z.array(z.string()).optional().describe("Projets rattachés (1..N — recommandé). Au moins un projet est requis au total."),
    title: z.string().optional().describe("Titre court compréhensible (ex: 'Recette du module chatbot'). Dérivé si absent."),
    description: z.string().optional().describe("Description longue (détail du périmètre vérifié)."),
    taskIds: z.array(z.string()).optional().describe("Tâches couvertes par la recette (0..N)."),
    status: z.enum(["pending", "in_progress"]).optional().describe("pending (défaut) ou in_progress (session lancée)."),
    sessionId: z.string().optional().describe("Session dédiée de l'agent-recette (si lancée)."),
  },
}, async ({ project, projects, title, description, taskIds, status, sessionId }) => {
  try {
    const recette = await startRecette({ project, projects, title, description, taskIds, status: status || "pending", sessionId: sessionId || null });
    return text(JSON.stringify({ ok: true, recette }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === recette_list ===
server.registerTool("recette_list", {
  description: "Liste les recettes (toutes ou filtrées par projet) avec nb de tâches couvertes et nb d'éléments.",
  inputSchema: { project: z.string().optional() },
}, async ({ project }) => {
  try {
    const recettes = await listProjectRecettes(project);
    return text(JSON.stringify({ count: recettes.length, recettes }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === recette_get ===
server.registerTool("recette_get", {
  description: "Détail d'une recette (titre, projet, statut, tâches couvertes, éléments).",
  inputSchema: { recetteId: z.string() },
}, async ({ recetteId }) => {
  try {
    const recette = await getRecetteById(recetteId);
    if (!recette) return err(`recette inconnue : ${recetteId}`);
    return text(JSON.stringify({ recette }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === recette_session_set ===
server.registerTool("recette_session_set", {
  description: "Associe la session dédiée lancée à une recette et la passe en cours (in_progress).",
  inputSchema: { recetteId: z.string(), sessionId: z.string() },
}, async ({ recetteId, sessionId }) => {
  try {
    const recette = await setRecetteSession({ recetteId, sessionId });
    return text(JSON.stringify({ ok: true, recette }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === recette_doc_add ===
server.registerTool("recette_doc_add", {
  description: "Rattache un document à une recette (importé ou artefact existant) avec la nature de la liaison (à quoi sert / comment l'exploiter).",
  inputSchema: {
    recetteId: z.string(),
    title: z.string().optional(),
    nature: z.string().optional().describe("Nature de la liaison : à quoi sert le document et comment l'exploiter."),
    source: z.enum(["import", "artifact"]).default("import"),
    path: z.string().optional().describe("Chemin du fichier (mode import)."),
    artifactId: z.string().optional().describe("Artefact existant à lier (mode artifact)."),
  },
}, async ({ recetteId, title, nature, source, path, artifactId }) => {
  try {
    let finalPath = path;
    if (source === "artifact") {
      if (!artifactId) return err("artifactId requis en mode artifact");
      const a = await getArtifact(artifactId);
      if (!a) return err(`artefact inconnu : ${artifactId}`);
      finalPath = a.path;
    }
    const docs = await addRecetteDocument({ recetteId, title, nature, source, path: finalPath, artifactId: source === "artifact" ? artifactId : null });
    return text(JSON.stringify({ ok: true, documents: docs }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === recette_doc_remove ===
server.registerTool("recette_doc_remove", {
  description: "Retire un document d'une recette.",
  inputSchema: { documentId: z.number().int() },
}, async ({ documentId }) => {
  try {
    const recetteId = await removeRecetteDocument(documentId);
    if (!recetteId) return err(`document inconnu : ${documentId}`);
    return text(JSON.stringify({ ok: true, recetteId, documents: await listRecetteDocuments(recetteId) }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === recette_link_task ===
server.registerTool("recette_link_task", {
  description: "Rattache une tâche à une recette (tâche couverte). Garde : la tâche doit appartenir à l'un des projets rattachés à la recette.",
  inputSchema: { recetteId: z.string(), taskId: z.string() },
}, async ({ recetteId, taskId }) => {
  try {
    if (!(await getTask(taskId))) return err(`tâche inconnue : ${taskId}`);
    await linkRecetteTask(recetteId, taskId);
    return text(JSON.stringify({ ok: true, recette: await getRecetteById(recetteId) }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === recette_unlink_task ===
server.registerTool("recette_unlink_task", {
  description: "Détache une tâche d'une recette (la tâche reste historiquement intacte, juste plus couverte).",
  inputSchema: { recetteId: z.string(), taskId: z.string() },
}, async ({ recetteId, taskId }) => {
  try {
    const recette = await unlinkRecetteTask(recetteId, taskId);
    if (!recette) return err(`recette inconnue : ${recetteId}`);
    return text(JSON.stringify({ ok: true, recette }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === recette_project_add ===
server.registerTool("recette_project_add", {
  description: "Ajoute un projet à une recette existante (recette multi-projets : 1 recette = 1..N projets, pas de projet principal).",
  inputSchema: { recetteId: z.string(), project: z.string().describe("Projet à rattacher à la recette.") },
}, async ({ recetteId, project }) => {
  try {
    const recette = await addRecetteProject({ recetteId, project });
    return text(JSON.stringify({ ok: true, recette }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === recette_project_remove ===
server.registerTool("recette_project_remove", {
  description: "Retire un projet d'une recette existante. Refus si c'est le dernier projet, ou si la recette couvre encore des tâches de ce projet.",
  inputSchema: { recetteId: z.string(), project: z.string().describe("Projet à retirer de la recette.") },
}, async ({ recetteId, project }) => {
  try {
    const recette = await removeRecetteProject({ recetteId, project });
    return text(JSON.stringify({ ok: true, recette }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === recette_item_add ===
server.registerTool("recette_item_add", {
  description: "Enregistre un élément détecté pendant la recette (remarque, demande, constat, problème) avec sa classification (rework|bug|improvement|feature), son PROJET CIBLE (1 item = 1 projet) et le périmètre (scope) suggéré.",
  inputSchema: {
    recetteId: z.string(),
    content: z.string().describe("La remarque / demande / constat."),
    classification: z.enum(["rework", "bug", "improvement", "feature"]).optional().describe("Nature de l'élément (défaut rework)."),
    project: z.string().optional().describe("Projet CIBLE de l'élément (doit être l'un des projets de la recette). Défaut : premier projet de la recette."),
    discussion: z.string().optional().describe("Échanges associés."),
    scope: z.array(z.string()).optional().describe("Périmètre suggéré (chemins) — transmis à la tâche créée à la confirmation."),
    title: z.string().optional().describe("Titre court de la tâche qui sera créée à la confirmation."),
    acceptance: z.string().optional().describe("Critère d'acceptation / livrable attendu de la tâche qui sera créée."),
    execOrder: z.number().int().optional().describe("Ordre d'exécution recommandé (même numéro = exécutable en parallèle)."),
    vigilance: z.string().optional().describe("Point de vigilance / écart sémantique détecté pour cet élément."),
  },
}, async ({ recetteId, project, content, classification, discussion, scope, title, acceptance, execOrder, vigilance }) => {
  try {
    const item = await addRecetteItem({ recetteId, project, content, classification, discussion, scope, title, acceptance, execOrder, vigilance });
    return text(JSON.stringify({ ok: true, item }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === recette_item_update ===
server.registerTool("recette_item_update", {
  description: "Met à jour un élément de recette (classification, discussion, scope, projet cible, statut, tâche créée).",
  inputSchema: {
    itemId: z.number().int(),
    classification: z.enum(["rework", "bug", "improvement", "feature"]).optional(),
    discussion: z.string().optional(),
    scope: z.array(z.string()).optional().describe("Périmètre suggéré (chemins)."),
    project: z.string().optional().describe("Projet cible de l'élément."),
    title: z.string().optional(),
    acceptance: z.string().optional(),
    execOrder: z.number().int().optional().describe("Ordre d'exécution recommandé (même numéro = parallèle)."),
    vigilance: z.string().optional().describe("Point de vigilance / écart sémantique."),
    status: z.enum(["open", "task_created"]).optional(),
    createdTaskId: z.string().optional(),
  },
}, async ({ itemId, classification, discussion, scope, project, title, acceptance, execOrder, vigilance, status, createdTaskId }) => {
  try {
    const item = await updateRecetteItem({ itemId, classification, discussion, scope, project, title, acceptance, execOrder, vigilance, status, createdTaskId });
    return text(JSON.stringify({ ok: true, item }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});


// === recette_item_delete ===
server.registerTool("recette_item_delete", {
  description: "Supprime un élément de recette (remarque/demande/constat). Refus si une tâche a déjà été créée depuis cet élément (task_created).",
  inputSchema: { itemId: z.number().int() },
}, async ({ itemId }) => {
  try {
    const r = await deleteRecetteItem({ itemId });
    return text(JSON.stringify({ ok: true, ...r }, null, 2));
  } catch (e) { return err(e.message); }
});

// === recette_confirm ===
server.registerTool("recette_confirm", {
  description: "Clôt la recette (statut 'done' = faite) après confirmation de la liste consolidée. La tâche initiale reste done et close ; les travaux issus sont de nouvelles tâches.",
  inputSchema: {
    recetteId: z.string(),
    confirmedBy: z.string().optional(),
  },
}, async ({ recetteId, confirmedBy }) => {
  try {
    const recette = await confirmRecette({ recetteId, confirmedBy });
    return text(JSON.stringify({ ok: true, recette }, null, 2));
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
    kind: z.enum(["launch", "rework", "relaunch", "recette"]).optional().describe("Type de lien : launch | rework | relaunch | recette (défaut launch)."),
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

// === task_update ===
server.registerTool("task_update", {
  description: "Modifie une tâche en statut 'queued' (non lancée) : request, titre court, critères d'acceptation, scope, priorité. Refusée si la tâche n'est plus queued.",
  inputSchema: {
    taskId: z.string(),
    request: z.string().optional(),
    title: z.string().optional().describe("Titre court."),
    acceptanceCriteria: z.array(z.string()).optional(),
    scope: z.array(z.string()).optional(),
    priority: z.enum(["low", "normal", "high", "critical"]).optional(),
    directExecution: z.boolean().optional().describe("Exécution directe via build-notify (sans atomic-plan)."),
    linkedTasks: z.array(z.object({ taskId: z.string(), description: z.string().optional() })).optional().describe("Remplace les tâches liées (combo)."),
  },
}, async ({ taskId, request, title, acceptanceCriteria, scope, priority, directExecution, linkedTasks }) => {
  try {
    const task = await updateTask({ taskId, request, title, acceptanceCriteria, scope, priority, directExecution, linkedTasks });
    return text(JSON.stringify({ ok: true, task }, null, 2));
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
    // Garde (v0.5.2) : une recette en cours ou terminée clôture la tâche (aucune transition) — aucune transition.
    const task = await getTask(taskId);
    if (task && ["in_progress","approved","done"].includes(task.recetteStatus)) {
      return err(`recette en cours ou terminée : la tâche ${taskId} est clôturée, aucune transition (${to}) n'est autorisée`);
    }
    if (!canTaskTransition(exec.status, to)) {
      await logTransitionError({ taskId, from: exec.status, to, by: by || "orchestrator", reason: `non autorisé depuis ${exec.status}` });
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
    // Persistance des conflits détectés (KPI d'orchestration) — non bloquant.
    await recordScopeConflicts({ project, scope, conflicts: r.conflicts, reservedWorktrees: r.reservedWorktrees });
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
    const task = await getTask(taskId);
    if (!task) return err(`tâche inconnue : ${taskId}`);
    // Garde (v0.5.2) : recette en cours ou terminée → aucune nouvelle décision.
    if (["in_progress","approved","done"].includes(task.recetteStatus)) {
      return err(`recette en cours ou terminée : la tâche ${taskId} est clôturée, aucune nouvelle décision (${kind}) n'est autorisée`);
    }
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
    // Garde (v0.5.2) : si la tâche liée au plan a une recette déjà validée → refus.
    const planTaskId = await findPlanTask(planId).catch(() => null);
    if (planTaskId) {
      const task = await getTask(planTaskId);
      if (task && ["in_progress","approved","done"].includes(task.recetteStatus)) {
        await logTransitionError({ taskId: planTaskId, to, by: by || "orchestrator", reason: "recette en cours ou terminée — tâche clôturée" });
        return err(`recette en cours ou terminée : la tâche ${planTaskId} (plan ${planId}) est clôturée, aucune transition de plan (${to}) n'est autorisée`);
      }
    }
    const r = await applyPlanTransition({ planId, to, by: by || "orchestrator", note });
    return text(JSON.stringify(r, null, 2));
  } catch (e) {
    // Trace une erreur de transition de plan (KPI d'orchestration).
    const taskId = await findPlanTask(planId).catch(() => null);
    await logTransitionError({ taskId, to, by: by || "orchestrator", reason: String((e && e.message) || e) });
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


// ===========================================================================
// Tests E2E Playwright (cadrage 07) — registre, liens, exécutions
// ===========================================================================

// === e2e_test_register ===
// === e2e_test_register (entité 1er niveau) ===
server.registerTool("e2e_test_register", {
  description: "Enregistre (ou réactive) un test E2E comme entité de 1er niveau — 1 enregistrement par test() Playwright. project = REPO SOURCE (où vit le spec) ; coveredProjects = projets dont le comportement est vérifié (le repo source est toujours inclus). Indépendant de toute tâche (l'association tâche se fait via e2e_test_link).",
  inputSchema: {
    project: z.string().describe("Repo source (projet du dépôt où vit le spec)."),
    specFile: z.string().describe("Chemin du spec file (ex: tests/e2e/auth/login.spec.ts)."),
    scenario: z.string().describe("Titre du test() Playwright."),
    title: z.string().optional().describe("Titre court / comportement couvert."),
    description: z.string().optional().describe("Description du comportement vérifié (multi-projets éventuel)."),
    coveredProjects: z.array(z.string()).optional().describe("Projets couverts par le comportement (ex. ['mada-talk','oniria'])."),
  },
}, async ({ project, specFile, scenario, title, description, coveredProjects }) => {
  try {
    const t = await upsertE2ETest({ project, specFile, scenario, title, description, coveredProjects });
    return text(JSON.stringify({ ok: true, test: await getE2ETest(t.id) }, null, 2));
  } catch (e) { return err(e.message); }
});

// === e2e_test_update / get / obsolete ===
server.registerTool("e2e_test_update", {
  description: "Met à jour le titre/description/projets couverts d'un test E2E (entité 1er niveau).",
  inputSchema: {
    e2eTestId: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    coveredProjects: z.array(z.string()).optional().describe("Remplace les projets couverts."),
  },
}, async ({ e2eTestId, title, description, coveredProjects }) => {
  try {
    const t = await updateE2ETestMeta({ e2eTestId, title, description, coveredProjects });
    return text(JSON.stringify({ ok: true, test: t }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("e2e_test_get", {
  description: "Détail d'un test E2E (1er niveau) : infos, projets couverts, paramètres, tâches liées, dernière exécution.",
  inputSchema: { e2eTestId: z.string() },
}, async ({ e2eTestId }) => {
  try {
    const t = await getE2ETest(e2eTestId);
    if (!t) return err(`test inconnu : ${e2eTestId}`);
    return text(JSON.stringify({ ok: true, test: t }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("e2e_test_obsolete", {
  description: "Marque un test E2E OBSOLETE (spec disparu du repo — sync auto T10). Jamais de suppression d'historique.",
  inputSchema: { e2eTestId: z.string() },
}, async ({ e2eTestId }) => {
  try {
    const t = await markE2ETestObsolete(e2eTestId);
    return text(JSON.stringify({ ok: true, test: t }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("e2e_test_param_set", {
  description: "Déclare/remplace les paramètres variables d'un test (URL, compte, token…). Valeur par défaut NON sensible ; secret : fournir secretRef (référence e2e.env/secrets), JAMAIS la valeur.",
  inputSchema: {
    e2eTestId: z.string(),
    params: z.array(z.object({
      name: z.string(),
      kind: z.enum(["url", "string", "secret", "int", "bool"]).optional().describe("Type du paramètre (défaut string)."),
      defaultValue: z.string().optional().describe("Valeur par défaut non sensible."),
      secretRef: z.string().optional().describe("Si secret : référence (ex. ONIRIA_E2E_USER_EMAIL) — la valeur ne doit jamais être persistée."),
      required: z.boolean().optional(),
    })).describe("Paramètres du test (remplace l'existant)."),
  },
}, async ({ e2eTestId, params }) => {
  try {
    await setE2ETestParams(e2eTestId, params);
    return text(JSON.stringify({ ok: true, e2eTestId, params: params || [] }, null, 2));
  } catch (e) { return err(e.message); }
});

// === e2e_list (global, entités 1er niveau) ===
server.registerTool("e2e_list", {
  description: "Liste les tests E2E (entités 1er niveau). Filtres : projet couvert, tâche associée (taskId → tests liés à la tâche), statut, recherche texte.",
  inputSchema: {
    taskId: z.string().optional().describe("Si fourni : tests associés à cette tâche (relation + dernière exécution sur la tâche)."),
    project: z.string().optional().describe("Filtre : projet couvert par le comportement."),
    status: z.string().optional().describe("Filtre statut : ACTIVE | OBSOLETE | QUARANTINE | DRAFT."),
    search: z.string().optional().describe("Recherche texte (titre / scénario / spec file)."),
    limit: z.number().int().optional(),
  },
}, async ({ taskId, project, status, search, limit }) => {
  try {
    if (taskId) {
      const tests = await listTaskE2E(taskId);
      return text(JSON.stringify({ taskId, count: tests.length, tests }, null, 2));
    }
    const tests = await listE2ETests({ project, status, search, limit });
    return text(JSON.stringify({ count: tests.length, tests }, null, 2));
  } catch (e) { return err(e.message); }
});

// === e2e_test_link / unlink (association tâche ↔ test) ===
server.registerTool("e2e_test_link", {
  description: "Associe un test E2E à une tâche (N:N pure association). relation_type : CREATED|UPDATED|REGRESSION|EXISTING (+ reason obligatoire). Le test reste indépendant.",
  inputSchema: {
    taskId: z.string(),
    e2eTestId: z.string(),
    relationType: z.enum(["CREATED", "UPDATED", "REGRESSION", "EXISTING"]).optional(),
    reason: z.string().optional().describe("Justification (tracée)."),
  },
}, async ({ taskId, e2eTestId, relationType, reason }) => {
  try {
    const r = await linkTaskE2E({ taskId, e2eTestId, relationType, reason });
    return text(JSON.stringify({ ok: true, ...r }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("e2e_test_unlink", {
  description: "Détache un test E2E d'une tâche (le test reste enregistré).",
  inputSchema: { taskId: z.string(), e2eTestId: z.string() },
}, async ({ taskId, e2eTestId }) => {
  try {
    return text(JSON.stringify({ ok: true, ...(await unlinkTaskE2E({ taskId, e2eTestId })) }, null, 2));
  } catch (e) { return err(e.message); }
});

// === e2e_execution_record / update / list ===
server.registerTool("e2e_execution_record", {
  description: "Enregistre le début d'une exécution E2E (PENDING/RUNNING). L'exécution appartient au TEST ; origin = task|recette|ci|manual|session (défaut manual). taskId optionnel = origine tracée.",
  inputSchema: {
    e2eTestId: z.string(),
    origin: z.enum(["task", "recette", "ci", "manual", "session"]).optional().describe("Origine du déclenchement (défaut manual)."),
    taskId: z.string().optional().describe("Tâche origine (optionnelle)."),
    deploymentId: z.string().optional(),
    planId: z.string().optional(),
    env: z.string().optional().describe("Description de la cible exécutée."),
    commitSha: z.string().optional(),
    branch: z.string().optional(),
    pipelineRef: z.string().optional(),
    attempts: z.number().int().optional().describe("Itération de correction (1..3)."),
    paramValues: z.record(z.string(), z.any()).optional().describe("Valeurs effectives utilisées au run (noms ; secrets référencés, jamais en clair)."),
  },
}, async (args) => {
  try {
    const r = await recordE2EExecution(args);
    return text(JSON.stringify({ ok: true, execution: r }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("e2e_execution_update", {
  description: "Met à jour une exécution E2E (verdict, durée, preuves : rapport texte partagé, vidéo humaine, logs, synthèse).",
  inputSchema: {
    executionId: z.string(),
    status: z.enum(["PENDING", "RUNNING", "PASSED", "FAILED", "ERROR", "SKIPPED", "FLAKY"]).optional(),
    durationMs: z.number().int().optional(),
    reportArtifactId: z.string().optional().describe("Artefact rapport TEXTE (IA + humain)."),
    logsUrl: z.string().optional(),
    videoUrl: z.string().optional().describe("Preuve HUMAINE (vidéo) — jamais analysée par l'IA."),
    summary: z.string().optional().describe("Verdict / synthèse textuelle."),
    verdictBy: z.string().optional().describe("build-notify | human | agent-recette."),
    origin: z.enum(["task", "recette", "ci", "manual", "session"]).optional(),
    executedAt: z.string().optional(),
  },
}, async ({ executionId, status, durationMs, reportArtifactId, logsUrl, videoUrl, summary, verdictBy, origin, executedAt }) => {
  try {
    const ex = await updateE2EExecution({ executionId, status, durationMs, reportArtifactId, logsUrl, videoUrl, summary, verdictBy, origin, executedAt });
    return text(JSON.stringify({ ok: true, execution: ex }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("e2e_execution_list", {
  description: "Liste les exécutions E2E (historique d'un test et/ou d'une tâche, filtrable par origine).",
  inputSchema: {
    e2eTestId: z.string().optional().describe("Historique du test."),
    taskId: z.string().optional().describe("Exécutions dont l'origine est cette tâche."),
    origin: z.enum(["task", "recette", "ci", "manual", "session"]).optional(),
    limit: z.number().int().optional(),
  },
}, async ({ e2eTestId, taskId, origin, limit }) => {
  try {
    const executions = await listE2EExecutions({ e2eTestId, taskId, origin, limit });
    return text(JSON.stringify({ count: executions.length, executions }, null, 2));
  } catch (e) { return err(e.message); }
});


// === e2e_collect ===
const E2E_INBOX = "/root/orchestrator-panel/storage/e2e/inbox";
const E2E_RUNS = "/root/orchestrator-panel/storage/e2e/runs";
server.registerTool("e2e_collect", {
  description: "Importe un run E2E CI (manifest + résultats Playwright) depuis storage/e2e/inbox/<runId> dans le registre (e2e_tests/task_e2e/e2e_executions) et conserve rapports texte + vidéos. Verdict posé sur le RAPPORT TEXTE uniquement (la vidéo est une preuve humaine).",
  inputSchema: { runId: z.string() },
}, async ({ runId }) => {
  try {
    const runDir = join(E2E_INBOX, runId);
    const manifestPath = join(runDir, "manifest.json");
    if (!existsSync(manifestPath)) return err(`manifest introuvable : ${manifestPath}`);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const { taskId, project, env, commitSha, branch, pipelineRef, attempts = 1 } = manifest;
    const results = Array.isArray(manifest.results) ? manifest.results : [];
    if (!results.length) return err("aucun résultat dans le manifest");
    const outDir = join(E2E_RUNS, runId);
    mkdirSync(outDir, { recursive: true });
    const imported = [];
    for (const res of results) {
      if (!res.specFile || !res.scenario) continue;
      const reg = await upsertE2ETest({ project, specFile: res.specFile, scenario: res.scenario, title: res.title });
      const e2eTestId = reg.id;
      if (taskId) await linkTaskE2E({ taskId, e2eTestId, relationType: res.relation || "REGRESSION", reason: res.reason || "Associé à l'exécution CI" });
      const rec = await recordE2EExecution({ e2eTestId, origin: "ci", taskId, env, commitSha, branch, pipelineRef, attempts });
      const reportPath = join(outDir, `report-${rec.id}.json`);
      writeFileSync(reportPath, JSON.stringify({ runId, executionId: rec.id, e2eTestId, specFile: res.specFile, scenario: res.scenario, status: res.status, durationMs: res.durationMs, error: res.error || null, attempts }, null, 2));
      let videoUrl = null;
      if (res.videoFile && existsSync(join(runDir, res.videoFile))) {
        const dest = join(outDir, `video-${rec.id}${extname(res.videoFile) || ".webm"}`);
        copyFileSync(join(runDir, res.videoFile), dest);
        videoUrl = dest;
      }
      await updateE2EExecution({ executionId: rec.id, status: res.status || "ERROR", durationMs: res.durationMs || null, logsUrl: reportPath, videoUrl, summary: (res.summary || (res.error ? `Échec : ${String(res.error).slice(0, 400)}` : `PASS ${res.scenario}`)).slice(0, 2000), verdictBy: "build-notify", executedAt: manifest.executedAt || new Date().toISOString() });
      imported.push({ e2eTestId, executionId: rec.id, status: res.status || "ERROR" });
    }
    writeFileSync(join(outDir, "imported.json"), JSON.stringify({ runId, importedAt: new Date().toISOString(), count: imported.length }, null, 2));
    try { rmSync(runDir, { recursive: true, force: true }); } catch {}
    return text(JSON.stringify({ ok: true, runId, imported, count: imported.length, failures: imported.filter((i) => i.status === "FAILED").length }, null, 2));
  } catch (e) { return err(e.message); }
});


// === e2e_run ===
const E2E_ENV_FILE = "/root/.config/opencode/e2e.env";   // creds compte de test (root-only)
const E2E_RUNNER = "/root/.config/opencode/scripts/e2e-runner.mjs";
function loadE2EEnv() {
  const out = {};
  try {
    const raw = readFileSync(E2E_ENV_FILE, "utf8");
    for (const line of raw.split("\n")) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) out[m[1]] = m[2];
    }
  } catch {}
  return out;
}
server.registerTool("e2e_run", {
  description: "Déclenche un run E2E Playwright sur un repo applicatif (cible externe déployée, ex. préprod) puis IMPORTE le résultat dans le registre. Le test est une entité de 1er niveau : passer e2eTestId (ou laisser specPattern pour un run libre). origin : task|recette|manual (défaut manual, task si taskId fourni). Le verdict lu par l'IA est le RAPPORT TEXTE ; la vidéo est une preuve humaine.",
  inputSchema: {
    project: z.string(),
    repoDir: z.string().describe("Répertoire (hôte) du dépôt applicatif avec Playwright (ex: /root/mada-talk-preprod)."),
    baseUrl: z.string().optional().describe("URL de la cible déployée (défaut : e2e.env E2E_BASE_URL)."),
    e2eTestId: z.string().optional().describe("Test (entité 1er niveau) à exécuter — résout specPattern + projets couverts depuis le registre."),
    origin: z.enum(["task", "recette", "manual", "ci", "session"]).optional().describe("Origine du déclenchement."),
    taskId: z.string().optional().describe("Tâche origine à associer (et lier si non déjà liée)."),
    specPattern: z.string().optional().describe("Regex Playwright de filtre de spec à exécuter (positionnelle, transmise après '--' ; défaut : run complet de la config). Ex: madatalk-requests-(chatbot-cycle|support-interactions-kpi|pause-resiliation)\\\\.spec\\\\.ts"),
    playwrightConfig: z.string().optional().describe("Config Playwright dédiée (ex: playwright.madatalk-requests.recette.config.ts) — passée à Playwright via --config (placée AVANT les filtres de spec)."),
    pwArgs: z.array(z.string()).optional().describe("Arguments Playwright supplémentaires transmis après '--' (ex: ['--project=authenticated']). Sans collision avec 'project' (projet du REGISTRE oniria/mada-talk), ni avec 'playwrightConfig'."),
    paramValues: z.record(z.string(), z.string()).optional().describe("Surcharge des paramètres du test au run (ex. {'baseUrl':'…'} ; les défauts du test sont appliqués sinon)."),
  },
}, async ({ project, repoDir, baseUrl, taskId, origin, e2eTestId, specPattern, playwrightConfig, pwArgs, paramValues }) => {
  try {
    if (!repoDir || !existsSync(join(repoDir, "package.json"))) return err(`repoDir invalide ou sans package.json : ${repoDir}`);
    const env = loadE2EEnv();
    if (!env.E2E_USER_EMAIL || !env.E2E_USER_PASSWORD) return err("identifiants E2E absents : renseigner " + E2E_ENV_FILE);
    // Si un test 1er niveau est donné, on résout specPattern + défauts de params.
    let resolvedProject = project;
    let pattern = specPattern;
    let paramOverrides = paramValues || {};
    if (e2eTestId) {
      const t = await getE2ETest(e2eTestId);
      if (!t) return err(`test inconnu : ${e2eTestId}`);
      resolvedProject = t.project;
      pattern = pattern || t.specFile;
      for (const p of t.params || []) {
        if (p.defaultValue && paramOverrides[p.name] === undefined) paramOverrides[p.name] = p.defaultValue;
      }
    }
    const runOrigin = origin || (taskId ? "task" : "manual");
    const target = baseUrl || env.E2E_BASE_URL || "";
    if (!target) return err("baseUrl requis (cible déployée)");
    const runId = `run-${Date.now()}`;
    const args = [E2E_RUNNER, "--runId", runId, "--project", resolvedProject, "--out", "/root/orchestrator-panel/storage/e2e/inbox"];
    if (taskId) args.push("--taskId", taskId);
    // Arguments Playwright après le séparateur "--" (le runner les transmet à
    // `npx playwright test`). Ordre : --config AVANT les filtres de spec, puis
    // args Playwright supplémentaires (ex. --project=authenticated), puis la
    // regex de spec (positionnelle, en dernier).
    const pw = [];
    if (playwrightConfig) pw.push(`--config=${playwrightConfig}`);
    if (Array.isArray(pwArgs) && pwArgs.length) pw.push(...pwArgs);
    if (pattern) pw.push(pattern);
    if (pw.length) args.push("--", ...pw);
    // Environnement du run :
    //  - E2E_BASE_URL reste posé (rétrocompat mada-talk : le SPA lit cette var) ;
    //  - ONIRIA_E2E_BASE_URL posé avec la même cible (les configs Playwright du
    //    dépôt ONIRIA lisent cette var — défaut localhost:3000 sinon) ;
    //  - propagation des éventuels secrets ONIRIA_E2E_* présents dans e2e.env,
    //    sans écraser ceux déjà posés par process.env ;
    //  - identifiants de compte de test E2E_USER_* (root-only e2e.env).
    const runEnv = { ...process.env, E2E_EXTERNAL: "1", E2E_BASE_URL: target, ONIRIA_E2E_BASE_URL: target, E2E_USER_EMAIL: env.E2E_USER_EMAIL, E2E_USER_PASSWORD: env.E2E_USER_PASSWORD };
    for (const [k, v] of Object.entries(env)) {
      if (/^ONIRIA_E2E_/.test(k) && !(k in process.env)) runEnv[k] = v;
    }
    // Surcharges paramValues exposées comme variables d'environnement (les
    // specs lisent process.env). baseUrl prioritaire sur paramValues.
    for (const [k, v] of Object.entries(paramOverrides)) {
      if (runEnv[k] === undefined && k !== "baseUrl") runEnv[k] = String(v);
    }
    execFileSync("node", args, { cwd: repoDir, env: runEnv, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60 * 1000 });
    // Import automatique du run dans le registre.
    const runDir = join("/root/orchestrator-panel/storage/e2e/inbox", runId);
    const manifestPath = join(runDir, "manifest.json");
    if (!existsSync(manifestPath)) return err(`run exécuté mais manifest absent : ${manifestPath}`);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const imported = [];
    for (const res of manifest.results || []) {
      if (!res.specFile || !res.scenario) continue;
      const reg = await upsertE2ETest({ project: resolvedProject, specFile: res.specFile, scenario: res.scenario, title: res.title, coveredProjects: (e2eTestId ? null : [resolvedProject]) });
      if (taskId) await linkTaskE2E({ taskId, e2eTestId: reg.id, relationType: res.relation || "REGRESSION", reason: res.reason || "Run déclenché par la recette/vérification" });
      const rec = await recordE2EExecution({ e2eTestId: reg.id, origin: runOrigin, taskId, env: "external", commitSha: manifest.commitSha || null, branch: manifest.branch || null, attempts: manifest.attempts || 1, paramValues: Object.keys(paramOverrides).length ? paramOverrides : null });
      const outDir = join("/root/orchestrator-panel/storage/e2e/runs", runId);
      mkdirSync(outDir, { recursive: true });
      const reportPath = join(outDir, `report-${rec.id}.json`);
      writeFileSync(reportPath, JSON.stringify({ runId, executionId: rec.id, e2eTestId: reg.id, specFile: res.specFile, scenario: res.scenario, status: res.status, durationMs: res.durationMs, error: res.error || null, attempts: manifest.attempts || 1 }, null, 2));
      let videoUrl = null;
      if (res.videoFile && existsSync(join(runDir, res.videoFile))) {
        const dest = join(outDir, `video-${rec.id}${extname(res.videoFile) || ".webm"}`);
        copyFileSync(join(runDir, res.videoFile), dest);
        videoUrl = dest;
      }
      await updateE2EExecution({ executionId: rec.id, status: res.status || "ERROR", durationMs: res.durationMs || null, logsUrl: reportPath, videoUrl, summary: (res.summary || `Résultat ${res.status}`).slice(0, 2000), verdictBy: "build-notify", executedAt: manifest.executedAt || new Date().toISOString() });
      imported.push({ e2eTestId: reg.id, executionId: rec.id, status: res.status || "ERROR", scenario: res.scenario, summary: (res.summary || "").slice(0, 300) });
    }
    try { rmSync(runDir, { recursive: true, force: true }); } catch {}
    return text(JSON.stringify({ ok: true, runId, origin: runOrigin, count: imported.length, results: imported }, null, 2));
  } catch (e) { return err(e.message); }
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
