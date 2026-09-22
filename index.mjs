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
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, unlinkSync, readdirSync, statSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, extname, relative, resolve } from "node:path";
import { canTaskTransition, isValidState, allowedFrom, VALID_STATES } from "./statemachine.mjs";
import {
  createTask,
  getTask,
  getTaskWithRepos,
  setTaskRepos,
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
  listTaskEmergentFrom,
  startRecette,
  unlinkRecetteTask,
  upsertE2ETest,
  reactivateE2ETest,
  markE2ETestObsolete,
  draftE2ETest,
  setE2ETestSession,
  updateE2ETestMeta,
  setE2ETestParams,
  getE2ETest,
  listE2ETests,
  e2eStableId,
  linkTaskE2E,
  unlinkTaskE2E,
  listTaskE2E,
  recordE2EExecution,
  updateE2EExecution,
  deleteRecetteItem,
  listE2EExecutions,
  setE2EVar,
  listE2EVars,
  getE2EVarValue,
  deleteE2EVar,
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
  registerRepo,
  getRepo,
  listRepos,
  deleteRepo,
  linkRepoToProject,
  unlinkRepoFromProject,
  listProjectRepos,
  listProjectsWithRepos,
  deleteTask,
  registerDoc,
  updateDoc,
  deleteDoc,
  getDoc,
  listDocs,
  docsForProjectContext,
  addDocAttachment,
  removeDocAttachment,
  listDocAttachments,
  listAdrs,
  getAdr,
  searchAdrs,
  buildAdrContext,
  buildFeatureContext,
  buildRuleContext,
  registerAdr,
  setAdrStatus,
  attachAdr,
  // CONVERSION D'ADR (ADR-001 §6) — A003/A004.
  linkAdrConversion,
  listAdrConversions,
  convertAdr,
  reportAdrConflict,
  listAdrConflicts,
  reportAdrMissing,
  listAdrVigilances,
  resolveAdrVigilance,
  ADR_TRANSITIONS,
  DOC_KINDS,
  ADR_STATUS,
  ADR_VIGILANCE_TYPES,
  ADR_VIGILANCE_STATUS,
  DOC_ATTACHMENT_SOURCES,
  DOC_TYPES,
  PIECE_NATURES,
  addPiece,
  listPieces,
  requalifyDocsAsPieces,
  removePiece,
  buildSprintReport,
  createSprint,
  getSprintDetail,
  deleteSprint,
  attachPiecesToSprint,
  getSprint,
  listProjectSprints,
  closeSprint,
  autoCloseExpiredSprints,
  reopenSprint,
  setSprintSession,
  classifyEmergence,
  // SESSION DE MIGRATION DES ANCIENS SPRINTS (ADR-001 §6) — A005/A006/A007.
  MIGRATION_STATUS,
  startMigration,
  getMigration,
  listMigrations,
  setMigrationSession,
  finishMigration,
  migrateProjectElementsToDefaultSprint,
  // CARDINALITÉS HEURISTIQUES + GOUVERNANCE DE L'ÉMERGENCE (T6, ADR-001 §5).
  EMERGENT_ORIGINS,
  CARDINALITY_RULES,
  CARDINALITY_VIEWS,
  checkCardinality,
  recordCardinalitySignal,
  listCardinalitySignals,
  resolveCardinalitySignal,
  cardinalityView,
  cardinalityReport,
  ensureDefaultSprintLink,
  // FONCTIONNALITÉS / RÈGLES / LIAISONS (T5) — CRUD + liens N:N + workflow ADR.
  registerFeature,
  updateFeature,
  markFeatureImplemented,
  getFeature,
  listFeatures,
  deleteFeature,
  registerRule,
  updateRule,
  markRuleImplemented,
  getRule,
  listRules,
  deleteRule,
  linkFeatureRule,
  unlinkFeatureRule,
  linkFeatureGherkin,
  unlinkFeatureGherkin,
  linkFeatureAdr,
  unlinkFeatureAdr,
  linkFeatureSprint,
  unlinkFeatureSprint,
  linkRuleSprint,
  unlinkRuleSprint,
  linkTaskSprint,
  unlinkTaskSprint,
  linkTaskFeature,
  unlinkTaskFeature,
  proposeTaskAdr,
  validateTaskAdr,
  unlinkTaskAdr,
  listTaskAdrs,
  linkRecetteSprint,
  unlinkRecetteSprint,
  linkRecetteFeature,
  unlinkRecetteFeature,
  linkRecetteRule,
  unlinkRecetteRule,
  linkRecetteAdr,
  unlinkRecetteAdr,
  ARTIFACT_SOURCES,
  ARTIFACT_KINDS,
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
  createBatch,
  getBatch,
  listBatches,
  addBatchTask,
  removeBatchTask,
  setBatchSession,
  setBatchStatus,
  setBatchLaunchMode,
  batchReadiness,
  batchConflictMatrix,
  registerOrganization,
  listOrganizations,
  getOrganization,
  deleteOrganization,
  setDefaultOrganization,
  addOrgGitToken,
  listOrgGitTokens,
  deleteOrgGitToken,
  // Famille évaluation (Recette de l'ÉVALUATEUR PRODUIT) — T-20260922-100650-sbc1.
  startEvaluation,
  listProjectEvaluations,
  getEvaluationById,
  addEvaluationItem,
  updateEvaluationItem,
  deleteEvaluationItem,
  setEvaluationItemDecision,
  listTreatableEvaluationItems,
  linkCadrageEvaluationItem,
  unlinkCadrageEvaluationItem,
  listCadrageEvaluationItems,
  linkEvaluationFeature,
  unlinkEvaluationFeature,
  linkEvaluationRule,
  unlinkEvaluationRule,
  setEvaluationVerdict,
  addEvaluationDocument,
  listEvaluationDocuments,
  removeEvaluationDocument,
  confirmEvaluation,
  EVALUATION_ITEM_CATEGORIES,
  EVALUATION_ITEM_SEVERITIES,
  EVALUATION_ITEM_STATUSES,
  EVALUATION_ITEM_DECISIONS,
  EVALUATION_VERDICTS,
  getArtifact,
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
    repoIds: z.array(z.string()).optional().describe("Repos ciblés de la tâche (parmi ceux du projet, ADR 09). Défaut : TOUS les repos du projet."),
    featureIds: z.array(z.string()).optional().describe("Fonctionnalités liées à la tâche (optionnel, T6) — leur absence marque la tâche émergente `sans_fonctionnalite`."),
    sprintId: z.string().optional().describe("Sprint explicite (optionnel, T6) ; sinon rattachement au sprint par défaut SI le projet n'a aucun sprint."),
    adrIds: z.array(z.string()).optional().describe("ADR PROPOSÉES pour la tâche (optionnel, T6) — lien `propose`, effectif après validation humaine en recette."),
    originTaskId: z.string().optional().describe("Si cette tâche est ÉMERGENTE (créée hors scope pendant une tâche source) : taskId de la tâche SOURCE. La nouvelle tâche sera liée à sa source (relation_type='emergent')."),
    originReason: z.string().optional().describe("Raison de l'émergence (demande hors scope reçue pendant la tâche source)."),
    createdBy: z.string().optional().describe("Utilisateur (username) qui crée la tâche (attribution)."),
    organizationId: z.string().optional().describe("Organisation (tenant). Défaut : celle du projet."),
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
    // CARDINALITÉ (T6, lecture seule, NON bloquante) : manques éventuels
    // (sprint / fonctionnalité / ADR effectif) signalés sans bloquer.
    const cardinalite = await checkCardinality({ entityType: "task", entityId: taskId }).catch(() => null);
    return text(JSON.stringify({ ok: true, taskId, executionId, task, cardinalite }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === project_register ===
server.registerTool("project_register", {
  description: "Enregistre (ou met à jour) un projet dans le registre. Toute tâche doit référencer un projet existant. La branche principale (mainBranch) est OBLIGATOIRE pour autoriser le déploiement d'une tâche. e2eRepoDir = checkout hôte où s'exécutent les runs E2E ; e2eBaseUrl = URL de test par défaut.",
  inputSchema: {
    id: z.string().describe("Identifiant du projet (ex: oniria)."),
    name: z.string().describe("Nom lisible du projet."),
    workspace: z.string().optional().describe("Workspace Coder associé."),
    gitPath: z.string().optional().describe("Chemin du dépôt git (hôte ou /home/coder)."),
    mainBranch: z.string().optional().describe("Branche principale du projet (ex: main, oniria-preprod) — requise pour déployer."),
    e2eRepoDir: z.string().optional().describe("Checkout hôte des runs E2E (ex: /root/oniria-preprod)."),
    e2eBaseUrl: z.string().optional().describe("URL de test par défaut (ex: https://preprod.madatalk.fr)."),
    organizationId: z.string().optional().describe("Organisation (tenant) du projet. Défaut : organisation courante."),
    createdBy: z.string().optional(),
  },
}, async ({ id, name, workspace, gitPath, mainBranch, e2eRepoDir, e2eBaseUrl, organizationId, createdBy }) => {
  try {
    const project = await registerProject({ id, name, workspace, gitPath, mainBranch, e2eRepoDir, e2eBaseUrl, organizationId, createdBy });
    return text(JSON.stringify({ ok: true, project }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === project_list ===
server.registerTool("project_list", {
  description: "Liste les projets (produits) enregistrés, avec leurs repos associés (N:N — ADR 09).",
  inputSchema: {},
}, async () => {
  try {
    const projects = await listProjectsWithRepos();
    return text(JSON.stringify({ count: projects.length, projects }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === project_delete ===
server.registerTool("project_delete", {
  description: "Supprime un projet (produit) du registre.",
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

// === Repos (ADR 09) — dépôts de code physiques, rattachables à 1..N produits ===
server.registerTool("repo_register", {
  description: "Enregistre (ou met à jour) un REPO (dépôt de code physique : workspace, git_path, branches, checkout E2E). Indépendant des produits : il est rattaché à un ou plusieurs projets via project_repo_link.",
  inputSchema: {
    id: z.string().describe("Identifiant du repo (ex: mada-talk, oniria)."),
    name: z.string().optional().describe("Nom lisible."),
    description: z.string().optional().describe("À quoi sert ce repo pour le projet."),
    deploy: z.string().optional().describe("Mécanisme de déploiement CI/CD de CE repo (texte libre, ex: workflows GitHub Actions, branches de déclenchement, cibles) — fourni en contexte à l'orchestrateur."),
    workspace: z.string().optional().describe("Workspace Coder où vit le checkout."),
    repoDir: z.string().optional().describe("Répertoire du dépôt (chemin du checkout dans/du workspace)."),
    gitPath: z.string().optional().describe("[alias] = repoDir (rétrocompat)."),
    gitUrl: z.string().optional(),
    branches: z.array(z.string()).optional().describe("Branches cible(s) de déploiement (ex: ['main'], ['oniria-preprod'])."),
    mainBranch: z.string().optional().describe("Branche de déploiement par défaut (requise pour déployer)."),
    e2eRepoDir: z.string().optional().describe("Checkout hôte des runs E2E."),
    e2eBaseUrl: z.string().optional().describe("URL de test par défaut."),
    organizationId: z.string().optional().describe("Organisation (tenant). Défaut : organisation courante."),
    createdBy: z.string().optional(),
  },
}, async (args) => {
  try {
    const { id, name, description, deploy, workspace, repoDir, gitPath, gitUrl, branches, mainBranch, e2eRepoDir, e2eBaseUrl, organizationId, createdBy } = args;
    const repo = await registerRepo({ id, name, description, deploy, workspace, repoDir, gitPath, gitUrl, branches, mainBranch, e2eRepoDir, e2eBaseUrl, organizationId, createdBy });
    return text(JSON.stringify({ ok: true, repo }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("repo_list", {
  description: "Liste tous les repos enregistrés (ADR 09). Si projectId est fourni : les repos de CE projet (associés) en premier, et chaque repo expose role + gitTokenId (token git choisi pour la liaison).",
  inputSchema: { projectId: z.string().optional().describe("Si fourni : repos associés à ce projet (+ détails de liaison role/gitTokenId).") },
}, async ({ projectId }) => {
  try {
    const repos = projectId ? await listRepos(projectId) : await listRepos();
    return text(JSON.stringify({ count: repos.length, repos }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("repo_get", {
  description: "Détail d'un repo (ADR 09).",
  inputSchema: { id: z.string() },
}, async ({ id }) => {
  try {
    const repo = await getRepo(id);
    if (!repo) return err(`repo inconnu : ${id}`);
    return text(JSON.stringify({ ok: true, repo }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("repo_delete", {
  description: "Supprime un repo (et ses associations projet). Ne supprime aucun projet.",
  inputSchema: { id: z.string() },
}, async ({ id }) => {
  try {
    const r = await deleteRepo(id);
    if (!r) return err(`repo inconnu : ${id}`);
    return text(JSON.stringify({ ok: true, ...r }, null, 2));
  } catch (e) { return err(e.message); }
});

// === Documents de référence (ADR-12) : contexte architecture & comportement ===
// Registre générique N:N docs ⇄ projets et/ou repos. Un doc n'a PAS de contenu
// en base : `path` pointe le fichier (workspace/checkout) que les agents LISENT.
// kind : adr-tech (architecture technique : stack, archi cible, composants,
// patterns, structure de dossiers) | specs-fonctionnelles (User stories + règles
// métier) | scenarios-gherkin (scénarios Gherkin).
server.registerTool("doc_register", {
  description: "Enregistre un DOCUMENT de référence (ADR-12) — registre générique N:N rattaché à un projet et/ou 1..N repos. kind : adr-tech (architecture technique) | specs-fonctionnelles (User stories/règles métier) | scenarios-gherkin. ADR structurée : status (Proposé | Accepté | Déprécié | Remplacé), context, decision, consequences, replacedBy. Rattachement repos : repoId (1) ou repoIds (1..N) ; global=true rattache TOUS les repos du projet (ADR globale). path = chemin du fichier que les agents liront en contexte — jamais de contenu en base. Rebassé sur la table polymorphe `artifacts` (doc_type = adr | specs | gherkin ; content_id = docId).",
  inputSchema: {
    kind: z.enum(["adr-tech", "specs-fonctionnelles", "scenarios-gherkin"]),
    title: z.string().optional().describe("Titre lisible (ex. 'ADR — Architecture madatalk')."),
    path: z.string().describe("Chemin du fichier (ex. /home/coder/mada-talk/docs/adr-technique.md ou tests/docs/specs.md)."),
    description: z.string().optional(),
    status: z.enum(ADR_STATUS).optional().describe("Statut ADR : Proposé | Accepté | Déprécié | Remplacé."),
    context: z.string().optional().describe("ADR : contexte."),
    decision: z.string().optional().describe("ADR : décision."),
    consequences: z.string().optional().describe("ADR : conséquences."),
    replacedBy: z.string().optional().describe("ADR : docId de l'ADR qui remplace celle-ci (statut Remplacé)."),
    projectId: z.string().optional().describe("Projet (produit) rattaché."),
    repoId: z.string().optional().describe("Repo (dépôt de code) rattaché (rétrocompat — 1 repo)."),
    repoIds: z.array(z.string()).optional().describe("Repos (dépôt de code) rattachés — 1..N."),
    global: z.boolean().optional().describe("ADR globale : rattachée à TOUS les repos du projet (exige projectId)."),
    organizationId: z.string().optional().describe("Organisation (tenant). Défaut : celle du projet."),
    createdBy: z.string().optional(),
  },
}, async ({ kind, title, path, description, status, context, decision, consequences, replacedBy, projectId, repoId, repoIds, global: isGlobal, organizationId, createdBy }) => {
  try {
    const doc = await registerDoc({ kind, title, path, description, status, context, decision, consequences, replacedBy, projectId, repoId, repoIds, global: isGlobal, organizationId, createdBy });
    return text(JSON.stringify({ ok: true, doc }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("doc_update", {
  description: "Met à jour un document de référence (ADR-12) — titre/kind/path/description + champs ADR (status, context, decision, consequences, replacedBy) + rattachements (addProjectId/addRepoId/addRepoIds, setGlobal pour rattacher tous les repos du projet). Rebassé sur `artifacts` (doc_type adr/specs/gherkin/project_doc).",
  inputSchema: {
    docId: z.string(),
    kind: z.enum(["adr-tech", "specs-fonctionnelles", "scenarios-gherkin"]).optional(),
    title: z.string().optional(),
    path: z.string().optional(),
    description: z.string().optional(),
    status: z.enum(ADR_STATUS).optional().describe("Statut ADR : Proposé | Accepté | Déprécié | Remplacé."),
    context: z.string().optional().describe("ADR : contexte."),
    decision: z.string().optional().describe("ADR : décision."),
    consequences: z.string().optional().describe("ADR : conséquences."),
    replacedBy: z.string().optional().describe("ADR : docId de l'ADR qui remplace celle-ci."),
    addProjectId: z.string().optional(),
    addRepoId: z.string().optional(),
    addRepoIds: z.array(z.string()).optional().describe("Repos à rattacher (1..N)."),
    setGlobal: z.boolean().optional().describe("true : rattacher TOUS les repos des projets du doc + is_global=1 ; false : is_global=0."),
  },
}, async ({ docId, kind, title, path, description, status, context, decision, consequences, replacedBy, addProjectId, addRepoId, addRepoIds, setGlobal }) => {
  try {
    const doc = await updateDoc({ docId, kind, title, path, description, status, context, decision, consequences, replacedBy, addProjectId, addRepoId, addRepoIds, setGlobal });
    if (!doc) return err(`doc inconnu : ${docId}`);
    return text(JSON.stringify({ ok: true, doc }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("doc_delete", {
  description: "Supprime un document de référence (ADR-12). Ne supprime aucun projet/repo.",
  inputSchema: { docId: z.string() },
}, async ({ docId }) => {
  try {
    const r = await deleteDoc(docId);
    if (!r) return err(`doc inconnu : ${docId}`);
    return text(JSON.stringify({ ok: true, ...r }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("doc_get", {
  description: "Détail d'un document de référence (ADR-12). Rebassé sur `artifacts` (doc_type adr/specs/gherkin/project_doc).",
  inputSchema: { docId: z.string() },
}, async ({ docId }) => {
  try {
    const doc = await getDoc(docId);
    if (!doc) return err(`doc inconnu : ${docId}`);
    return text(JSON.stringify({ ok: true, doc }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("doc_list", {
  description: "Liste les documents de référence (ADR-12). Filtres : kind, statut ADR (status), projet (projectId), repo (repoId), includeRepoDocs (docs des repos du projet inclus — contexte projet, rétrocompat). Chaque doc expose projects[] et repos[] (cibles) + champs ADR (status/context/decision/consequences/replacedBy/isGlobal/meta/updatedAt). Rebassé sur `artifacts` (doc_type adr/specs/gherkin/project_doc).",
  inputSchema: {
    kind: z.enum(["adr-tech", "specs-fonctionnelles", "scenarios-gherkin"]).optional(),
    status: z.enum(ADR_STATUS).optional().describe("Filtre ADR par statut : Proposé | Accepté | Déprécié | Remplacé."),
    projectId: z.string().optional().describe("Si fourni : docs rattachés au projet."),
    repoId: z.string().optional().describe("Si fourni : docs rattachés au repo."),
    includeRepoDocs: z.boolean().optional().describe("Avec projectId : inclure les docs des repos du projet (contexte projet complet)."),
    limit: z.number().int().optional(),
  },
}, async ({ kind, status, projectId, repoId, includeRepoDocs, limit }) => {
  try {
    const docs = await listDocs({ kind, status, projectId, repoId, includeRepoDocs, limit });
    return text(JSON.stringify({ count: docs.length, docs }, null, 2));
  } catch (e) { return err(e.message); }
});

// Pièces jointes d'ADR (item 122) : une ADR (docs.kind='adr-tech') peut être
// rattachée à 0..N documents/fichiers. source='registry' (targetDocId),
// source='import' (fichier importé, path) ou source='ref' (fichier référencé
// par chemin, path). Retourne le doc porteur enrichi (champ attachments).
server.registerTool("doc_attachment_add", {
  description: "Rattache une pièce jointe à un document de référence (ADR-12). 3 sources : 'registry' (document du registre via targetDocId), 'import' (fichier importé via path, stocké sous storage/ref-docs) ou 'ref' (fichier référencé par chemin via path, workspace/checkout). kind/nature/title libres. Retourne le doc porteur avec ses pièces jointes (0..N). Rebassé sur `artifacts` (doc_type = adr_file ; content_id = docId).",
  inputSchema: {
    docId: z.string().describe("docId de l'ADR (document porteur) à laquelle rattacher la pièce jointe."),
    targetDocId: z.string().optional().describe("source='registry' : docId du document du registre à rattacher."),
    path: z.string().optional().describe("source='import'|'ref' : chemin du fichier."),
    title: z.string().optional().describe("Libellé lisible de la pièce jointe."),
    kind: z.string().optional().describe("Libellé libre (annexe, spec, capture…)."),
    nature: z.string().optional().describe("Nature : document | fichier | lien (défaut selon la source)."),
    source: z.enum(DOC_ATTACHMENT_SOURCES).optional().describe("Source : registry | import | ref (défaut registry)."),
    meta: z.record(z.string(), z.any()).optional().describe("Métadonnées libres (JSON)."),
  },
}, async ({ docId, targetDocId, path, title, kind, nature, source, meta }) => {
  try {
    const doc = await addDocAttachment({ docId, targetDocId, path, title, kind, nature, source, meta });
    return text(JSON.stringify({ ok: true, doc }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("doc_attachment_remove", {
  description: "Retire une pièce jointe d'une ADR (ADR-12) par son attachmentId stable. docId optionnel (vérifie l'appartenance). Ne touche ni au fichier ni aux rattachements projet/repo. Rebassé sur `artifacts` (doc_type = adr_file).",
  inputSchema: {
    attachmentId: z.string().describe("attachmentId de la pièce jointe à retirer."),
    docId: z.string().optional().describe("docId de l'ADR porteuse (vérification d'appartenance)."),
  },
}, async ({ attachmentId, docId }) => {
  try {
    const r = await removeDocAttachment({ attachmentId, docId });
    if (!r) return err(`pièce jointe inconnue : ${attachmentId}`);
    return text(JSON.stringify({ ok: true, ...r }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("doc_attachment_list", {
  description: "Liste les pièces jointes d'un document de référence (ADR-12). Retourne { count, attachments }. Rebassé sur `artifacts` (doc_type = adr_file).",
  inputSchema: {
    docId: z.string().describe("docId de l'ADR porteuse."),
  },
}, async ({ docId }) => {
  try {
    const attachments = await listDocAttachments({ docId });
    return text(JSON.stringify({ count: attachments.length, attachments }, null, 2));
  } catch (e) { return err(e.message); }
});

// ===========================================================================
// Famille « PIÈCE CLIENT » (ADR-001, item 4) — matière première des sprints.
// Une pièce est un artefact `doc_type='piece'`, `content_id = projectId`
// (traçage par le gestionnaire central d'artefacts). Natures admises :
// markdown | pdf | docx | lien externe (Drive public). PHOTO et VIDÉO REFUSÉES.
// ===========================================================================

server.registerTool("piece_add", {
  description: "Ajoute une PIÈCE CLIENT à un projet (matière première des sprints). Natures admises : markdown | pdf | docx | lien (lien externe type Drive public, mis en PUBLIC par l'utilisateur — l'agent lit le contenu via l'URL). PHOTO et VIDÉO sont REFUSÉES (garde à l'import ET pour les liens externes). Traçage : artefact `doc_type='piece'`, `content_id=projectId`, lien `artifact_projects`. Une pièce reçue APRÈS l'initialisation d'un sprint est marquée ÉMERGENTE (`emergent`, origine `apres_init_sprint`/`apres_cloture`) — non bloquant.",
  inputSchema: {
    projectId: z.string().describe("Projet (produit) porteur de la pièce."),
    nature: z.enum(PIECE_NATURES).optional().describe("Nature : markdown | pdf | docx | lien (déduite de l'extension si absente ; 'lien' si url)."),
    title: z.string().optional().describe("Titre lisible de la pièce."),
    path: z.string().optional().describe("Chemin du fichier (markdown/pdf/docx) — import ou référence."),
    url: z.string().optional().describe("URL PUBLIQUE d'un lien externe (ex. Drive public) — nature 'lien'."),
    filename: z.string().optional().describe("Nom du fichier d'origine (contrôle d'extension)."),
    description: z.string().optional(),
    createdBy: z.string().optional(),
  },
}, async ({ projectId, nature, title, path, url, filename, description, createdBy }) => {
  try {
    const piece = await addPiece({ projectId, nature, title, path, url, filename, description, createdBy });
    return text(JSON.stringify({ ok: true, piece }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("piece_list", {
  description: "Liste les PIÈCES CLIENT d'un projet : pièces nouvelles (`doc_type='piece'`) + documents ADR-12 REQUALIFIÉS (`requalified=true`). Chaque pièce expose nature, url (Drive), emergent (+ origine), sprintId, securityNote. Filtres : nature, emergent, includeRequalified (défaut true).",
  inputSchema: {
    projectId: z.string().describe("Projet dont on liste les pièces."),
    nature: z.enum(PIECE_NATURES).optional().describe("Filtre par nature."),
    emergent: z.boolean().optional().describe("Filtre les pièces émergentes (reçues après l'init d'un sprint)."),
    includeRequalified: z.boolean().optional().describe("Inclure les docs ADR-12 requalifiés (défaut true)."),
  },
}, async ({ projectId, nature, emergent, includeRequalified }) => {
  try {
    const pieces = await listPieces({ projectId, nature, emergent, includeRequalified });
    return text(JSON.stringify({ count: pieces.length, pieces }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("piece_requalify", {
  description: "Requalifie SANS PERTE les documents ADR-12 (adr/specs/gherkin/project_doc) en PIÈCES CLIENT du projet : n'écrit QUE le marqueur `meta` (`piece_client`, `piece_nature`, `requalified_at`, `requalified_from_doc_type`) — jamais `doc_type`/`content_id`/`path`/liens. Idempotent, relançable. Sans projectId : tous les docs ADR-12 du registre.",
  inputSchema: {
    projectId: z.string().optional().describe("Projet à requalifier (défaut : tous les docs ADR-12)."),
  },
}, async ({ projectId }) => {
  try {
    const r = await requalifyDocsAsPieces({ projectId });
    return text(JSON.stringify({ ok: true, ...r }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("piece_delete", {
  description: "Retire une PIÈCE CLIENT (famille `doc_type='piece'` uniquement) par son pieceId. Les liens projet (`artifact_projects`) et sprint (`sprint_pieces`) suivent en CASCADE. Nécessaire à la route panneau DELETE /api/pieces/:id.",
  inputSchema: {
    pieceId: z.string().describe("pieceId (= artifact_id de la pièce)."),
  },
}, async ({ pieceId }) => {
  try {
    const r = await removePiece({ pieceId });
    if (!r) return err(`pièce inconnue : ${pieceId}`);
    return text(JSON.stringify({ ok: true, ...r }, null, 2));
  } catch (e) { return err(e.message); }
});

// ===========================================================================
// Famille « SPRINT » — CRUD complet `sprint_*` (ADR-001). T3 a livré le cycle
// de vie produit (`closeSprint`/`autoCloseExpiredSprints`/`reopenSprint`/
// `getSprint`/`listProjectSprints`/`buildSprintReport`) + le tool `sprint_report`
// (lecture seule, conservé ici SANS doublon) ; T4 expose la couche CRUD
// `sprint_start` / `sprint_list` / `sprint_get` / `sprint_close` /
// `sprint_reopen` / `sprint_attach_pieces` AU-DESSUS de ces primitives
// (aucune réimplémentation). La clôture DÉCLENCHE la règle d'émergence ; la
// reprise la SUSPEND (état renvoyé par `classifyEmergence`).
// ===========================================================================

server.registerTool("sprint_report", {
  description: "RAPPORT DE SPRINT (lecture seule, téléchargeable) — agrégation du registre : fonctionnalités implémentées (`implemented=1` **ou** ≥1 tâche liée `done`), **ventilées** écosystème / hors écosystème, et émergentes ; tâches effectuées et émergentes ; **règles métier implémentées** (section dédiée, `implemented=1` **ou** signal écosystème dérivé) et émergentes ; pièces client (émergentes), recettes. `format='markdown'` (défaut) renvoie le rapport rédigé ; `format='json'` renvoie `{ sprint, stats, sections, markdown }` (stats ventilées `implementeesEcosystem`/`implementeesHorsEcosystem`).",
  inputSchema: {
    sprintId: z.string().describe("Identifiant du sprint (SPRINT-<ts>-<rand>)."),
    format: z.enum(["markdown", "json"]).optional().describe("Format de sortie : markdown (défaut) | json."),
  },
}, async ({ sprintId, format }) => {
  try {
    const report = await buildSprintReport(sprintId, { format: format || "markdown" });
    if ((format || "markdown") === "json") return text(JSON.stringify(report, null, 2));
    return text(report.markdown);
  } catch (e) { return err(e.message); }
});

server.registerTool("sprint_start", {
  description: "CRÉE un sprint NOMINAL à DURÉE PARAMÉTRABLE (ADR-001). `projectId` + `title` requis ; `startDate`/`endDate` ISO 8601 (`endDate >= startDate`) ; `autoClose` (défaut true) = clôture AUTOMATIQUE à l'échéance ; `pieces` (0..N pieceId) rattachées à la création (NON émergentes). Statut initial `open`, ou `close`/`auto_echeance` si l'échéance est déjà passée. Retourne le détail du sprint créé (`{ sprint, pieces, fonctionnalites, regles, tasks, recettes, counts }`).",
  inputSchema: {
    projectId: z.string().describe("Projet du sprint."),
    title: z.string().describe("Titre du sprint."),
    startDate: z.string().optional().describe("Début ISO 8601."),
    endDate: z.string().optional().describe("Échéance ISO 8601 (clôture auto si autoClose)."),
    autoClose: z.boolean().optional().describe("Clôture automatique à l'échéance (défaut true)."),
    sessionId: z.string().optional().describe("Session IA dédiée au sprint."),
    createdBy: z.string().optional().describe("Acteur créateur."),
    pieces: z.array(z.string()).optional().describe("pieceId des pièces client rattachées à la création (NON émergentes)."),
  },
}, async ({ projectId, title, startDate, endDate, autoClose, sessionId, createdBy, pieces }) => {
  try {
    const detail = await createSprint({ projectId, title, startDate, endDate, autoClose: autoClose !== false, sessionId, createdBy, pieces });
    return text(JSON.stringify({ ok: true, ...detail }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("sprint_list", {
  description: "LISTE les sprints d'un projet (du plus récent au plus ancien) avec statut + dates. La clôture AUTOMATIQUE à l'échéance est appliquée AVANT lecture (`autoCloseExpiredSprints`) : un sprint échu apparaît `close`/`auto_echeance`. Filtre `status`. Retourne `{ count, sprints, autoClosed }`.",
  inputSchema: {
    projectId: z.string().describe("Projet dont on liste les sprints."),
    status: z.enum(["open", "close"]).optional().describe("Filtre par statut."),
  },
}, async ({ projectId, status }) => {
  try {
    const auto = await autoCloseExpiredSprints({ projectId });
    const sprints = await listProjectSprints(projectId, { status });
    return text(JSON.stringify({ count: sprints.length, sprints, autoClosed: auto.closed }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("sprint_get", {
  description: "DÉTAIL COMPLET d'un sprint : statut, dates, cycle de vie + pièces client, fonctionnalités, règles métier, tâches et recettes rattachées + compteurs. `err` si le sprint est inconnu.",
  inputSchema: {
    sprintId: z.string().describe("Identifiant du sprint (SPRINT-<ts>-<rand>)."),
  },
}, async ({ sprintId }) => {
  try {
    const detail = await getSprintDetail(sprintId);
    if (!detail) return err(`sprint inconnu : ${sprintId}`);
    return text(JSON.stringify({ ok: true, ...detail }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("sprint_close", {
  description: "CLÔTURE d'un sprint (DISTINCTE de la clôture d'exécution des tâches — n'écrit jamais sur tasks/executions). MANUELLE via `sprintId` (`closeSprint`, reason `manuel`), ou AUTOMATIQUE à l'échéance via `projectId` (ou sans argument = balayage global) (`autoCloseExpiredSprints`). La clôture DÉCLENCHE la règle d'émergence (les éléments suivants sont émergents) — l'état est renvoyé par `classifyEmergence`. Retourne `{ ok, sprints, emergence }`.",
  inputSchema: {
    sprintId: z.string().optional().describe("Sprint à clôturer MANUELLEMENT."),
    projectId: z.string().optional().describe("Projet à balayer pour la clôture AUTO à l'échéance."),
    reason: z.string().optional().describe("Raison de la clôture manuelle (défaut : manuel)."),
  },
}, async ({ sprintId, projectId, reason }) => {
  try {
    if (sprintId) {
      const sprint = await closeSprint(sprintId, { reason: reason || "manuel" });
      const emergence = await classifyEmergence(sprint.project, { kind: "element" });
      return text(JSON.stringify({ ok: true, sprints: [sprint], emergence }, null, 2));
    }
    const auto = await autoCloseExpiredSprints({ projectId });
    const sprints = [];
    for (const id of auto.closed) { const s = await getSprint(id); if (s) sprints.push(s); }
    let emergence = null;
    if (projectId) {
      emergence = await classifyEmergence(projectId, { kind: "element" });
    } else {
      const projects = [...new Set(sprints.map((s) => s.project))];
      emergence = projects.length === 1
        ? await classifyEmergence(projects[0], { kind: "element" })
        : await Promise.all(projects.map((p) => classifyEmergence(p, { kind: "element" })));
    }
    return text(JSON.stringify({ ok: true, sprints, emergence }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("sprint_reopen", {
  description: "REPRISE / RÉOUVERTURE d'un sprint clôturé (le cycle n'est PAS définitif) : repasse `open`, efface `closed_at`/`close_reason`, pose `reopened_at`. `endDate` prolonge l'échéance ; si l'échéance résultante est passée sans `autoClose` explicite, `auto_close=0` (anti re-clôture immédiate). La reprise SUSPEND la règle d'émergence (sprint `open` → éléments non émergents) — état renvoyé par `classifyEmergence`. Retourne `{ ok, sprint, emergence }`.",
  inputSchema: {
    sprintId: z.string().describe("Sprint clôturé à rouvrir."),
    endDate: z.string().optional().describe("Nouvelle échéance ISO 8601 (prolongation)."),
    autoClose: z.boolean().optional().describe("Force la clôture auto (sinon règle anti re-clôture)."),
    by: z.string().optional().describe("Acteur de la reprise."),
  },
}, async ({ sprintId, endDate, autoClose, by }) => {
  try {
    const sprint = await reopenSprint(sprintId, { endDate, autoClose, by });
    const emergence = await classifyEmergence(sprint.project, { kind: "element" });
    return text(JSON.stringify({ ok: true, sprint, emergence }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("sprint_attach_pieces", {
  description: "RATTACHE des pièces client à un sprint (garde NATURE : pièce `piece` ou doc ADR-12 requalifié ; photos/vidéos refusées). ÉMERGENCE (ADR-001 §5) : `atInit=true` → pièces du sprint à sa création (NON émergentes) ; sinon pièce reçue APRÈS l'init → émergente `apres_init_sprint` (sprint open) ou `apres_cloture` (sprint close). Idempotent. Retourne `{ ok, sprintId, attached, pieces }`.",
  inputSchema: {
    sprintId: z.string().describe("Sprint cible."),
    pieceIds: z.array(z.string()).describe("pieceId des pièces à rattacher."),
    atInit: z.boolean().optional().describe("true = rattachement à la création (NON émergent)."),
    by: z.string().optional().describe("Acteur du rattachement."),
  },
}, async ({ sprintId, pieceIds, atInit, by }) => {
  try {
    const r = await attachPiecesToSprint(sprintId, { pieceIds, atInit: atInit === true, by });
    return text(JSON.stringify({ ok: true, ...r }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("sprint_delete", {
  description: "SUPPRIME un SPRINT (`SPRINT-*`) et détache ses liens (`sprint_fonctionnalites`/`sprint_regles`/`sprint_pieces` — les entités restent au projet), `migrations.sprint_id` → NULL, et nettoie ses signaux de cardinalité `open`. REFUS DUR (pas de `force`) : sprint PAR DÉFAUT (`is_default=1`, message préfixé `[SPRINT_DEFAULT]`) ; sprint portant des TÂCHES ou RECETTES (`task_sprints`/`recette_sprints`, message préfixé `[SPRINT_LINKED]` — détacher d'abord via `task_sprint_unlink`/`recette_sprint_unlink`). Retourne `{ ok, sprintId, deleted, detached }`.",
  inputSchema: {
    sprintId: z.string().describe("Identifiant du sprint (SPRINT-<ts>-<rand>)."),
  },
}, async ({ sprintId }) => {
  try {
    const r = await deleteSprint(sprintId);
    if (!r) return err(`sprint inconnu : ${sprintId}`);
    return text(JSON.stringify({ ok: true, ...r }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("sprint_session_set", {
  description: "ASSOCIE la session IA dédiée (agent-sprint) à un sprint EXISTANT (`sprints.session_id`). Miroir de `recette_session_set` MAIS NE TOUCHE PAS au statut du sprint : `open`/`close` (et donc la garde d'émergence) restent pilotés par `sprint_close`/`sprint_reopen`. `sessionId` null détache la session. Retourne `{ ok, sprint }`.",
  inputSchema: {
    sprintId: z.string().describe("Sprint cible (SPRINT-<ts>-<rand>)."),
    sessionId: z.string().nullable().describe("Session opencode (ses_…) à rattacher, ou null pour détacher."),
  },
}, async ({ sprintId, sessionId }) => {
  try {
    const sprint = await setSprintSession({ sprintId, sessionId });
    return text(JSON.stringify({ ok: true, sprint }, null, 2));
  } catch (e) { return err(e.message); }
});

// ===========================================================================
// Famille « SESSION DE MIGRATION DES ANCIENS SPRINTS » (ADR-001 §6) — T9.
// Entité `migrations` d'un PROJET (type dédié), ANCRÉE sur le sprint par défaut
// (= l'ancien sprint). Les éléments migrés (pièces/fonctionnalités/règles) et
// les anciennes tâches sont rattachés à l'ancien sprint par INSERT DIRECTS —
// AUCUN FAUX ÉMERGENT (jamais `attachPiecesToSprint`, jamais `emergent`).
// ===========================================================================

server.registerTool("migration_start", {
  description: "DÉMARRE (ou résout) la SESSION DE MIGRATION des anciens sprints d'un projet (ADR-001 §6). IDEMPOTENT : une seule migration par projet. Le sprint cible est le SPRINT PAR DÉFAUT du projet (= l'ANCIEN sprint, ex. myxmax 14/09, madatalk 07/09), créé au besoin (`ensureDefaultSprint`). Retourne `{ ok, migration, sprint }`. `migration.session_id` porte la session IA dédiée (agent-migration).",
  inputSchema: {
    projectId: z.string().describe("Projet (produit) dont on migre les anciens sprints."),
    title: z.string().optional().describe("Titre de la session de migration (défaut dérivé du projet)."),
    startDate: z.string().optional().describe("Début du sprint par défaut (ISO 8601)."),
    endDate: z.string().optional().describe("Échéance du sprint par défaut (ISO 8601)."),
    createdBy: z.string().optional().describe("Acteur créateur."),
  },
}, async ({ projectId, title, startDate, endDate, createdBy }) => {
  try {
    const r = await startMigration({ projectId, title, startDate, endDate, createdBy });
    return text(JSON.stringify({ ok: true, ...r }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("migration_get", {
  description: "DÉTAIL d'une session de migration (statut, session IA, sprint cible résolu). `err` si la migration est inconnue.",
  inputSchema: {
    migrationId: z.string().describe("Identifiant de la migration (MIG-<ts>-<rand>)."),
  },
}, async ({ migrationId }) => {
  try {
    const migration = await getMigration(migrationId);
    if (!migration) return err(`migration inconnue : ${migrationId}`);
    return text(JSON.stringify({ ok: true, migration }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("migration_list", {
  description: "LISTE les sessions de migration (toutes, ou celles d'un projet), plus récentes d'abord. Retourne `{ count, migrations }`.",
  inputSchema: {
    project: z.string().optional().describe("Filtre par projet."),
    limit: z.number().int().optional().describe("Max (défaut 500)."),
  },
}, async ({ project, limit }) => {
  try {
    const migrations = await listMigrations({ project, limit });
    return text(JSON.stringify({ count: migrations.length, migrations }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("migration_session_set", {
  description: "RATTACHE (ou REPREND) la SESSION IA dédiée (agent-migration) à une migration existante. Miroir de `sprint_session_set` : NE TOUCHE PAS au statut du sprint (open/close et garde d'émergence inchangés). Une migration `open` passe `in_progress` ; `sessionId` null détache. Retourne `{ ok, migration }`.",
  inputSchema: {
    migrationId: z.string().describe("Migration cible (MIG-<ts>-<rand>)."),
    sessionId: z.string().nullable().describe("Session opencode (ses_…) à rattacher, ou null pour détacher."),
  },
}, async ({ migrationId, sessionId }) => {
  try {
    const migration = await setMigrationSession({ migrationId, sessionId });
    return text(JSON.stringify({ ok: true, migration }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("migration_finish", {
  description: "CLÔTURE une session de migration : `done` (migrée) ou `aborted` (abandonnée). Pose `finished_at`. Idempotent. Retourne `{ ok, migration }`.",
  inputSchema: {
    migrationId: z.string().describe("Migration à clôturer."),
    status: z.enum(["done", "aborted"]).optional().describe("done (défaut) | aborted."),
    by: z.string().optional().describe("Acteur de la clôture."),
  },
}, async ({ migrationId, status, by }) => {
  try {
    const migration = await finishMigration({ migrationId, status, by });
    return text(JSON.stringify({ ok: true, migration }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("sprint_migrate_elements", {
  description: "RATTACHE à l'ANCIEN SPRINT (sprint par défaut du projet) tous les éléments EXISTANTS sans lien sprint : fonctionnalités, règles métier, pièces client, anciennes tâches et recettes. INSERT DIRECTS et IDEMPOTENTS — AUCUN FAUX ÉMERGENT : n'appelle JAMAIS `attachPiecesToSprint` et n'écrit AUCUN marqueur `emergent`/`emergent_origin` (l'émergence n'est pas rétroactive, ADR-001 §5). Retourne `{ ok, sprintId, sprint, fonctionnalites, regles, pieces, tasks, recettes }` (compteurs des liens créés).",
  inputSchema: {
    projectId: z.string().describe("Projet (produit) à migrer."),
    title: z.string().optional().describe("Titre du sprint par défaut (si création)."),
    startDate: z.string().optional().describe("Début du sprint par défaut (ISO 8601)."),
    endDate: z.string().optional().describe("Échéance du sprint par défaut (ISO 8601)."),
    createdBy: z.string().optional().describe("Acteur du rattachement."),
  },
}, async ({ projectId, title, startDate, endDate, createdBy }) => {
  try {
    const r = await migrateProjectElementsToDefaultSprint({ projectId, title, startDate, endDate, createdBy });
    return text(JSON.stringify({ ok: true, ...r }, null, 2));
  } catch (e) { return err(e.message); }
});

// ===========================================================================
// Famille « FONCTIONNALITÉS / RÈGLES / LIAISONS » (ADR-001, T5). CRUD MCP
// `feature_*` / `rule_*` au-dessus des tables T1 (`fonctionnalites`,
// `regles_metier`) + outils de LIAISON sur les tables N:N T1. Règles :
//   - PIÈCE SOURCE gardée (garde nature T2) + appartenance au projet ;
//   - ÉMERGENCE réutilisant `classifyEmergence` (hors_sprint / apres_cloture),
//     rattachable à un sprint ULTÉRIEUR (tools `*_sprint_link`) ;
//   - LIEN ADR d'une tâche PROPOSÉ par l'agent (`task_adr_propose`) → EFFECTIF
//     seulement après validation HUMAINE (`task_adr_validate`) ;
//   - aucune création systématique d'ADR (liaison vers une ADR EXISTANTE).
// La famille `sprint_*` (ci-dessus) et `adr_*` (ci-dessous) restent intactes.
// ===========================================================================

server.registerTool("feature_register", {
  description: "CRÉE une FONCTIONNALITÉ (`US-xxx`, ADR-001 §3) : `projectId` + `ref` + `userStory` requis ; `role` libre ; `sourcedPieceId` = pièce client SOURCE (optionnelle) GARDÉE (garde nature T2 + appartenance au projet). ÉMERGENCE : hors sprint → `hors_sprint` ; dernier sprint clôturé → `apres_cloture` ; sprint OUVERT → non émergente et rattachée au sprint courant. `ref` dupliquée pour le projet → erreur. Retourne le détail (liens inclus).",
  inputSchema: {
    projectId: z.string().describe("Projet de la fonctionnalité."),
    ref: z.string().describe("Référence de la fonctionnalité (ex. US-xxx)."),
    role: z.string().optional().describe("Rôle / acteur de la fonctionnalité."),
    userStory: z.string().describe("User story (formulation du besoin)."),
    sourcedPieceId: z.string().optional().describe("pieceId de la pièce client SOURCE (optionnel, gardé)."),
    recetteId: z.string().optional().describe("Recette d'origine (optionnel, T6) — marque l'élément émergent d'origine `recette`."),
    createdBy: z.string().optional().describe("Acteur créateur."),
  },
}, async ({ projectId, ref, role, userStory, sourcedPieceId, recetteId, createdBy }) => {
  try {
    const feature = await registerFeature({ projectId, ref, role, userStory, sourcedPieceId, recetteId, createdBy });
    return text(JSON.stringify({ ok: true, feature }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("feature_update", {
  description: "MODIFIE partiellement une FONCTIONNALITÉ (champs fournis uniquement) : `ref`, `role`, `userStory`, `sourcedPieceId` (re-gardée), et l'ÉTAT D'IMPLÉMENTATION `implemented`/`implementedOrigin`/`implementedNote`. `implementedOrigin` fourni ⇒ `implemented` forcé à 1 (origine ∈ ecosystem | hors_ecosystem) ; `implemented=false` ⇒ reset de la traçabilité. `updated_at` posé. L'émergence reste un axe distinct (inchangée). Retourne le détail.",
  inputSchema: {
    featureId: z.string().describe("Identifiant de la fonctionnalité (FEAT-<ts>-<rand>)."),
    ref: z.string().optional().describe("Nouvelle référence (US-xxx)."),
    role: z.string().optional().describe("Nouveau rôle."),
    userStory: z.string().optional().describe("Nouvelle user story."),
    sourcedPieceId: z.string().optional().describe("Nouvelle pièce source (gardée) ; vide pour détacher."),
    implemented: z.boolean().optional().describe("État d'implémentation explicite (true/false) ; false ⇒ reset de l'origine et de la traçabilité."),
    implementedOrigin: z.enum(["ecosystem", "hors_ecosystem"]).optional().describe("Origine de l'implémentation — ecosystem (par une tâche de l'écosystème) | hors_ecosystem. Fournie ⇒ implémentée."),
    implementedNote: z.string().optional().describe("Motif/note libre de la qualification."),
    by: z.string().optional().describe("Acteur de la modification."),
  },
}, async ({ featureId, ref, role, userStory, sourcedPieceId, implemented, implementedOrigin, implementedNote, by }) => {
  try {
    const feature = await updateFeature({ featureId, ref, role, userStory, sourcedPieceId, implemented, implementedOrigin, implementedNote, by });
    return text(JSON.stringify({ ok: true, feature }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("feature_mark_implemented", {
  description: "MARQUE une FONCTIONNALITÉ comme IMPLÉMENTÉE avec son ORIGINE (intention explicite pour agents/panneau) : `origin` REQUIS (`ecosystem` = implémentée par une/des tâche(s) de l'écosystème | `hors_ecosystem` = implémentée EN DEHORS de l'écosystème, sans tâche liée). Idempotent (re-qualifier écrase proprement). N'écrit JAMAIS l'émergence. Retourne le détail.",
  inputSchema: {
    featureId: z.string().describe("Identifiant de la fonctionnalité (FEAT-<ts>-<rand>)."),
    origin: z.enum(["ecosystem", "hors_ecosystem"]).describe("Origine de l'implémentation (requise)."),
    note: z.string().optional().describe("Motif/note libre."),
    by: z.string().optional().describe("Acteur de la qualification."),
  },
}, async ({ featureId, origin, note, by }) => {
  try {
    const feature = await markFeatureImplemented({ featureId, origin, note, by });
    return text(JSON.stringify({ ok: true, feature }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("feature_get", {
  description: "DÉTAIL d'une FONCTIONNALITÉ + liens : règles métier, scénarios Gherkin (`e2e_tests`), ADR, sprints, tâches, recettes. Expose l'état d'implémentation `implemented`/`implementedOrigin`/`implementedAt`/`implementedBy`/`implementedNote` (et l'émergence, axe distinct). `err` si inconnue.",
  inputSchema: { featureId: z.string().describe("Identifiant de la fonctionnalité.") },
}, async ({ featureId }) => {
  try {
    const feature = await getFeature(featureId);
    if (!feature) return err(`fonctionnalité inconnue : ${featureId}`);
    return text(JSON.stringify({ ok: true, feature }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("feature_list", {
  description: "LISTE les fonctionnalités d'un projet (tri `ref`). Filtres : `emergent` (booléen), `search` (ref/user_story), `limit` (défaut 500). Chaque élément expose `implemented`/`implementedOrigin`/`implementedAt`/`implementedBy`/`implementedNote`, le champ additif `links` (compteurs de liens `{rules,gherkin,adrs,sprints,tasks,recettes}`, calculés en UNE requête bulk — plus de N+1 côté panneau) ET le champ additif `sprintIds` (ids des sprints liés via `sprint_fonctionnalites` ; `[]` = « Sans sprint »), issu de la MÊME requête bulk. Retourne `{ count, features }`.",
  inputSchema: {
    projectId: z.string().describe("Projet dont on liste les fonctionnalités."),
    emergent: z.boolean().optional().describe("Filtre émergence."),
    search: z.string().optional().describe("Recherche texte (ref/user_story)."),
    limit: z.number().optional().describe("Nombre max (défaut 500)."),
  },
}, async ({ projectId, emergent, search, limit }) => {
  try {
    const features = await listFeatures({ projectId, emergent, search, limit });
    return text(JSON.stringify({ count: features.length, features }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("feature_delete", {
  description: "SUPPRIME une FONCTIONNALITÉ (`FEAT-*`) et ses liens (`fonctionnalite_regles`, `fonctionnalite_gherkin`, `fonctionnalite_adr`, `sprint_fonctionnalites`, `task_fonctionnalites`, `recette_fonctionnalites`) en CASCADE. GARDE D'INTÉGRITÉ « ADR ≥ 1 fonctionnalité » : si la suppression ferait perdre à une ADR sa DERNIÈRE fonctionnalité, l'appel est REFUSÉ (message préfixé `[ADR_LAST_FEATURE]`) SAUF si `cascadeAdrs=true` — auquel cas l'ADR orpheline est supprimée dans la MÊME transaction (avant les liens, pour satisfaire le trigger différé). Retourne `{ ok, featureId, deleted, cascadedAdrs }`.",
  inputSchema: {
    featureId: z.string().describe("Identifiant de la fonctionnalité (FEAT-<ts>-<rand>)."),
    cascadeAdrs: z.boolean().optional().describe("true : supprimer aussi les ADR qui perdraient leur dernière fonctionnalité (défaut false → refus explicite)."),
    by: z.string().optional().describe("Acteur de la suppression."),
  },
}, async ({ featureId, cascadeAdrs, by }) => {
  try {
    const r = await deleteFeature(featureId, { cascadeAdrs: cascadeAdrs === true, by });
    if (!r) return err(`fonctionnalité inconnue : ${featureId}`);
    return text(JSON.stringify({ ok: true, ...r }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("rule_register", {
  description: "CRÉE une RÈGLE MÉTIER (`RM-xxxx`, ADR-001 §3) : `projectId` + `ref` + `content` requis ; `sourcedPieceId` optionnelle GARDÉE. Association EXPLICITE de rôles OBLIGATOIRE : `roles` (1..N) OU `roleGlobal=true` (s'applique à TOUS les rôles) — sinon l'appel est REFUSÉ. Mêmes règles d'ÉMERGENCE que `feature_register` (sprint ouvert → rattachement `sprint_regles`). `ref` dupliquée → erreur. Retourne le détail (liens inclus).",
  inputSchema: {
    projectId: z.string().describe("Projet de la règle."),
    ref: z.string().describe("Référence de la règle (ex. RM-xxxx)."),
    content: z.string().describe("Contenu de la règle métier."),
    sourcedPieceId: z.string().optional().describe("pieceId de la pièce client SOURCE (optionnel, gardé)."),
    recetteId: z.string().optional().describe("Recette d'origine (optionnel, T6) — marque la règle émergente d'origine `recette`."),
    roles: z.array(z.string()).optional().describe("Rôles EXPLICITES associés (1..N). Requis si `roleGlobal` n'est pas vrai."),
    roleGlobal: z.boolean().optional().describe("true = la règle s'applique à TOUS les rôles (dispense de `roles`)."),
    createdBy: z.string().optional().describe("Acteur créateur."),
  },
}, async ({ projectId, ref, content, sourcedPieceId, recetteId, roles, roleGlobal, createdBy }) => {
  try {
    const rule = await registerRule({ projectId, ref, content, sourcedPieceId, recetteId, roles, roleGlobal, createdBy });
    return text(JSON.stringify({ ok: true, rule }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("rule_update", {
  description: "MODIFIE partiellement une RÈGLE MÉTIER (champs fournis uniquement) : `ref`, `content`, `sourcedPieceId` (re-gardée), l'ASSOCIATION DE RÔLES `roles` (1..N) / `roleGlobal` (tous les rôles), et l'ÉTAT D'IMPLÉMENTATION `implemented`/`implementedOrigin`/`implementedNote`. Pour l'association, l'état EFFECTIF est évalué (champ non fourni ⇒ valeur courante) puis la garde « ≥1 rôle OU global » s'applique. `implementedOrigin` fourni ⇒ `implemented` forcé à 1 (origine ∈ ecosystem | hors_ecosystem) ; `implemented=false` ⇒ reset de la traçabilité. `updated_at` posé. L'émergence reste un axe distinct. Retourne le détail.",
  inputSchema: {
    ruleId: z.string().describe("Identifiant de la règle (RMET-<ts>-<rand>)."),
    ref: z.string().optional().describe("Nouvelle référence (RM-xxxx)."),
    content: z.string().optional().describe("Nouveau contenu."),
    sourcedPieceId: z.string().optional().describe("Nouvelle pièce source (gardée) ; vide pour détacher."),
    roles: z.array(z.string()).optional().describe("Rôles EXPLICITES (1..N). Remplace l'association ; `[]` autorisé si `roleGlobal` effectif est vrai."),
    roleGlobal: z.boolean().optional().describe("true = s'applique à TOUS les rôles (dispense de `roles`)."),
    implemented: z.boolean().optional().describe("État d'implémentation explicite (true/false) ; false ⇒ reset de l'origine et de la traçabilité."),
    implementedOrigin: z.enum(["ecosystem", "hors_ecosystem"]).optional().describe("Origine de l'implémentation — ecosystem | hors_ecosystem. Fournie ⇒ implémentée."),
    implementedNote: z.string().optional().describe("Motif/note libre de la qualification."),
    by: z.string().optional().describe("Acteur de la modification."),
  },
}, async ({ ruleId, ref, content, sourcedPieceId, roles, roleGlobal, implemented, implementedOrigin, implementedNote, by }) => {
  try {
    const rule = await updateRule({ ruleId, ref, content, sourcedPieceId, roles, roleGlobal, implemented, implementedOrigin, implementedNote, by });
    return text(JSON.stringify({ ok: true, rule }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("rule_mark_implemented", {
  description: "MARQUE une RÈGLE MÉTIER comme IMPLÉMENTÉE avec son ORIGINE (intention explicite) : `origin` REQUIS (`ecosystem` | `hors_ecosystem`). Idempotent. N'écrit JAMAIS l'émergence. Retourne le détail.",
  inputSchema: {
    ruleId: z.string().describe("Identifiant de la règle (RMET-<ts>-<rand>)."),
    origin: z.enum(["ecosystem", "hors_ecosystem"]).describe("Origine de l'implémentation (requise)."),
    note: z.string().optional().describe("Motif/note libre."),
    by: z.string().optional().describe("Acteur de la qualification."),
  },
}, async ({ ruleId, origin, note, by }) => {
  try {
    const rule = await markRuleImplemented({ ruleId, origin, note, by });
    return text(JSON.stringify({ ok: true, rule }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("rule_get", {
  description: "DÉTAIL d'une RÈGLE MÉTIER + liens : fonctionnalités (inverse), sprints. Expose l'ASSOCIATION EXPLICITE de rôles `roles` (1..N) / `roleGlobal` (true = tous les rôles) — plus de dérivation depuis les fonctionnalités liées — et l'état d'implémentation `implemented`/`implementedOrigin`/`implementedAt`/`implementedBy`/`implementedNote`. `err` si inconnue.",
  inputSchema: { ruleId: z.string().describe("Identifiant de la règle.") },
}, async ({ ruleId }) => {
  try {
    const rule = await getRule(ruleId);
    if (!rule) return err(`règle inconnue : ${ruleId}`);
    return text(JSON.stringify({ ok: true, rule }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("rule_list", {
  description: "LISTE les règles métier d'un projet (tri `ref`). Filtres : `emergent`, `search` (ref/content), `limit` (défaut 500). Chaque élément expose `implemented`/`implementedOrigin`/`implementedAt`/`implementedBy`/`implementedNote`, le champ additif `links` (compteurs de liens `{features,sprints}`, calculés en UNE requête bulk — plus de N+1 côté panneau), le champ additif `sprintIds` (ids des sprints liés via `sprint_regles` ; `[]` = « Sans sprint ») ET l'ASSOCIATION EXPLICITE de rôles `roles` (1..N) / `roleGlobal` (true = tous les rôles), lue sur la règle (plus de dérivation depuis les fonctionnalités liées). `links`/`sprintIds` proviennent de la MÊME requête bulk (0 N+1). Retourne `{ count, rules }`.",
  inputSchema: {
    projectId: z.string().describe("Projet dont on liste les règles."),
    emergent: z.boolean().optional().describe("Filtre émergence."),
    search: z.string().optional().describe("Recherche texte (ref/content)."),
    limit: z.number().optional().describe("Nombre max (défaut 500)."),
  },
}, async ({ projectId, emergent, search, limit }) => {
  try {
    const rules = await listRules({ projectId, emergent, search, limit });
    return text(JSON.stringify({ count: rules.length, rules }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("rule_delete", {
  description: "SUPPRIME une RÈGLE MÉTIER (`RMET-*`) et ses liens (`fonctionnalite_regles`, `sprint_regles`) en CASCADE. Aucun invariant métier. Retourne `{ ok, ruleId, deleted }`.",
  inputSchema: {
    ruleId: z.string().describe("Identifiant de la règle (RMET-<ts>-<rand>)."),
  },
}, async ({ ruleId }) => {
  try {
    const r = await deleteRule(ruleId);
    if (!r) return err(`règle inconnue : ${ruleId}`);
    return text(JSON.stringify({ ok: true, ...r }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("feature_rule_link", {
  description: "LIE une FONCTIONNALITÉ à une RÈGLE MÉTIER (N:N `fonctionnalite_regles`, idempotent). Valide les 2 extrémités.",
  inputSchema: {
    featureId: z.string().describe("Fonctionnalité."),
    regleId: z.string().describe("Règle métier."),
  },
}, async ({ featureId, regleId }) => {
  try { return text(JSON.stringify(await linkFeatureRule({ featureId, regleId }), null, 2)); }
  catch (e) { return err(e.message); }
});

server.registerTool("feature_rule_unlink", {
  description: "DÉLIE une FONCTIONNALITÉ d'une RÈGLE MÉTIER (`fonctionnalite_regles`).",
  inputSchema: {
    featureId: z.string().describe("Fonctionnalité."),
    regleId: z.string().describe("Règle métier."),
  },
}, async ({ featureId, regleId }) => {
  try { return text(JSON.stringify(await unlinkFeatureRule({ featureId, regleId }), null, 2)); }
  catch (e) { return err(e.message); }
});

server.registerTool("feature_gherkin_link", {
  description: "LIE une FONCTIONNALITÉ à un SCÉNARIO GHERKIN EXISTANT (`fonctionnalite_gherkin` → `e2e_tests`, N:N, idempotent). AUCUNE création de test : le test E2E doit EXISTER (`e2eTestId`).",
  inputSchema: {
    featureId: z.string().describe("Fonctionnalité."),
    e2eTestId: z.string().describe("Test E2E existant (scénario Gherkin)."),
  },
}, async ({ featureId, e2eTestId }) => {
  try { return text(JSON.stringify(await linkFeatureGherkin({ featureId, e2eTestId }), null, 2)); }
  catch (e) { return err(e.message); }
});

server.registerTool("feature_gherkin_unlink", {
  description: "DÉLIE une FONCTIONNALITÉ d'un SCÉNARIO GHERKIN (`fonctionnalite_gherkin`).",
  inputSchema: {
    featureId: z.string().describe("Fonctionnalité."),
    e2eTestId: z.string().describe("Test E2E."),
  },
}, async ({ featureId, e2eTestId }) => {
  try { return text(JSON.stringify(await unlinkFeatureGherkin({ featureId, e2eTestId }), null, 2)); }
  catch (e) { return err(e.message); }
});

server.registerTool("feature_adr_link", {
  description: "LIE une FONCTIONNALITÉ à une ADR EXISTANTE (N:N `fonctionnalite_adr`, idempotent). L'ADR doit exister (`kind='adr-tech'`).",
  inputSchema: {
    featureId: z.string().describe("Fonctionnalité."),
    adrId: z.string().describe("docId de l'ADR (kind='adr-tech')."),
  },
}, async ({ featureId, adrId }) => {
  try { return text(JSON.stringify(await linkFeatureAdr({ featureId, adrId }), null, 2)); }
  catch (e) { return err(e.message); }
});

server.registerTool("feature_adr_unlink", {
  description: "DÉLIE une FONCTIONNALITÉ d'une ADR (`fonctionnalite_adr`). Une ADR garde ≥1 fonctionnalité : si c'est la DERNIÈRE, l'erreur du trigger T1 est remontée telle quelle (aucun contournement).",
  inputSchema: {
    featureId: z.string().describe("Fonctionnalité."),
    adrId: z.string().describe("docId de l'ADR."),
  },
}, async ({ featureId, adrId }) => {
  try { return text(JSON.stringify(await unlinkFeatureAdr({ featureId, adrId }), null, 2)); }
  catch (e) { return err(e.message); }
});

server.registerTool("feature_sprint_link", {
  description: "RATTACHE une FONCTIONNALITÉ (souvent émergente) à un SPRINT ULTÉRIEUR (`sprint_fonctionnalites`, idempotent). N'EFFACE PAS le flag `emergent` (traçabilité conservée).",
  inputSchema: {
    featureId: z.string().describe("Fonctionnalité."),
    sprintId: z.string().describe("Sprint cible."),
  },
}, async ({ featureId, sprintId }) => {
  try { return text(JSON.stringify(await linkFeatureSprint({ featureId, sprintId }), null, 2)); }
  catch (e) { return err(e.message); }
});

server.registerTool("feature_sprint_unlink", {
  description: "DÉTACHE une FONCTIONNALITÉ d'un SPRINT (`sprint_fonctionnalites`).",
  inputSchema: {
    featureId: z.string().describe("Fonctionnalité."),
    sprintId: z.string().describe("Sprint."),
  },
}, async ({ featureId, sprintId }) => {
  try { return text(JSON.stringify(await unlinkFeatureSprint({ featureId, sprintId }), null, 2)); }
  catch (e) { return err(e.message); }
});

server.registerTool("rule_sprint_link", {
  description: "RATTACHE une RÈGLE MÉTIER (souvent émergente) à un SPRINT ULTÉRIEUR (`sprint_regles`, idempotent). N'EFFACE PAS le flag `emergent`.",
  inputSchema: {
    regleId: z.string().describe("Règle métier."),
    sprintId: z.string().describe("Sprint cible."),
  },
}, async ({ regleId, sprintId }) => {
  try { return text(JSON.stringify(await linkRuleSprint({ regleId, sprintId }), null, 2)); }
  catch (e) { return err(e.message); }
});

server.registerTool("rule_sprint_unlink", {
  description: "DÉTACHE une RÈGLE MÉTIER d'un SPRINT (`sprint_regles`).",
  inputSchema: {
    regleId: z.string().describe("Règle métier."),
    sprintId: z.string().describe("Sprint."),
  },
}, async ({ regleId, sprintId }) => {
  try { return text(JSON.stringify(await unlinkRuleSprint({ regleId, sprintId }), null, 2)); }
  catch (e) { return err(e.message); }
});

server.registerTool("task_sprint_link", {
  description: "LIE une TÂCHE à un SPRINT (`task_sprints`, idempotent). Valide la tâche et le sprint.",
  inputSchema: {
    taskId: z.string().describe("Tâche."),
    sprintId: z.string().describe("Sprint."),
  },
}, async ({ taskId, sprintId }) => {
  try { return text(JSON.stringify(await linkTaskSprint({ taskId, sprintId }), null, 2)); }
  catch (e) { return err(e.message); }
});

server.registerTool("task_sprint_unlink", {
  description: "DÉLIE une TÂCHE d'un SPRINT (`task_sprints`).",
  inputSchema: {
    taskId: z.string().describe("Tâche."),
    sprintId: z.string().describe("Sprint."),
  },
}, async ({ taskId, sprintId }) => {
  try { return text(JSON.stringify(await unlinkTaskSprint({ taskId, sprintId }), null, 2)); }
  catch (e) { return err(e.message); }
});

server.registerTool("task_feature_link", {
  description: "LIE une TÂCHE à une FONCTIONNALITÉ (`task_fonctionnalites`, idempotent) — alimente `sprint_report` (fonctionnalités implémentées).",
  inputSchema: {
    taskId: z.string().describe("Tâche."),
    featureId: z.string().describe("Fonctionnalité."),
  },
}, async ({ taskId, featureId }) => {
  try { return text(JSON.stringify(await linkTaskFeature({ taskId, featureId }), null, 2)); }
  catch (e) { return err(e.message); }
});

server.registerTool("task_feature_unlink", {
  description: "DÉLIE une TÂCHE d'une FONCTIONNALITÉ (`task_fonctionnalites`).",
  inputSchema: {
    taskId: z.string().describe("Tâche."),
    featureId: z.string().describe("Fonctionnalité."),
  },
}, async ({ taskId, featureId }) => {
  try { return text(JSON.stringify(await unlinkTaskFeature({ taskId, featureId }), null, 2)); }
  catch (e) { return err(e.message); }
});

server.registerTool("task_adr_propose", {
  description: "PROPOSE (action AGENT) un LIEN ADR sur une TÂCHE vers une ADR EXISTANTE (`kind='adr-tech'`) : `task_adr.status='propose'` (NON effectif). Idempotent ; ne rétrograde JAMAIS un lien déjà `valide`. AUCUNE création d'ADR : si aucune ADR pertinente n'existe, utiliser `adr_register` + `adr_report_missing`. Le lien devient EFFECTIF seulement après `task_adr_validate` (action HUMAINE).",
  inputSchema: {
    taskId: z.string().describe("Tâche concernée."),
    adrId: z.string().describe("docId de l'ADR EXISTANTE (kind='adr-tech')."),
    reason: z.string().optional().describe("Raison de la proposition (pertinence de l'ADR)."),
    by: z.string().optional().describe("Agent proposant (ex. build-notify, agent-recette)."),
  },
}, async ({ taskId, adrId, reason, by }) => {
  try { return text(JSON.stringify(await proposeTaskAdr({ taskId, adrId, reason, by }), null, 2)); }
  catch (e) { return err(e.message); }
});

server.registerTool("task_adr_validate", {
  description: "VALIDE (action HUMAINE, en recette) un lien ADR PROPOSÉ sur une tâche : `task_adr.status='valide'` + `validated_by`/`validated_at` ⇒ lien EFFECTIF. Erreur si AUCUNE proposition n'existe (utiliser `task_adr_propose` d'abord).",
  inputSchema: {
    taskId: z.string().describe("Tâche concernée."),
    adrId: z.string().describe("docId de l'ADR proposée."),
    by: z.string().optional().describe("Acteur humain validant (défaut : human)."),
  },
}, async ({ taskId, adrId, by }) => {
  try { return text(JSON.stringify(await validateTaskAdr({ taskId, adrId, by: by || "human" }), null, 2)); }
  catch (e) { return err(e.message); }
});

server.registerTool("task_adr_unlink", {
  description: "DÉLIE un lien ADR d'une TÂCHE (`task_adr`) — proposé ou validé.",
  inputSchema: {
    taskId: z.string().describe("Tâche."),
    adrId: z.string().describe("docId de l'ADR."),
  },
}, async ({ taskId, adrId }) => {
  try { return text(JSON.stringify(await unlinkTaskAdr({ taskId, adrId }), null, 2)); }
  catch (e) { return err(e.message); }
});

server.registerTool("task_adr_list", {
  description: "LISTE les liens ADR d'une TÂCHE avec leur état tracé : `status` (`propose` = proposé par l'agent, NON effectif ; `valide` = validé par l'humain, EFFECTIF), `effective`, `reason`, `proposed_by/at`, `validated_by/at`. Filtre `status`.",
  inputSchema: {
    taskId: z.string().describe("Tâche dont on liste les liens ADR."),
    status: z.enum(["propose", "valide"]).optional().describe("Filtre par état du lien."),
  },
}, async ({ taskId, status }) => {
  try {
    const adrs = await listTaskAdrs({ taskId, status });
    return text(JSON.stringify({ count: adrs.length, adrs }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("recette_sprint_link", {
  description: "Alias legacy de `cadrage_sprint_link`. LIE une RECETTE à un SPRINT (`recette_sprints`, idempotent). Valide la recette et le sprint.",
  inputSchema: {
    recetteId: z.string().describe("Recette."),
    sprintId: z.string().describe("Sprint."),
  },
}, async ({ recetteId, sprintId }) => {
  try { return text(JSON.stringify(await linkRecetteSprint({ recetteId, sprintId }), null, 2)); }
  catch (e) { return err(e.message); }
});

server.registerTool("recette_sprint_unlink", {
  description: "Alias legacy de `cadrage_sprint_unlink`. DÉLIE une RECETTE d'un SPRINT (`recette_sprints`).",
  inputSchema: {
    recetteId: z.string().describe("Recette."),
    sprintId: z.string().describe("Sprint."),
  },
}, async ({ recetteId, sprintId }) => {
  try { return text(JSON.stringify(await unlinkRecetteSprint({ recetteId, sprintId }), null, 2)); }
  catch (e) { return err(e.message); }
});

server.registerTool("recette_feature_link", {
  description: "Alias legacy de `cadrage_feature_link`. LIE une RECETTE à une FONCTIONNALITÉ (`recette_fonctionnalites`, idempotent).",
  inputSchema: {
    recetteId: z.string().describe("Recette."),
    featureId: z.string().describe("Fonctionnalité."),
  },
}, async ({ recetteId, featureId }) => {
  try { return text(JSON.stringify(await linkRecetteFeature({ recetteId, featureId }), null, 2)); }
  catch (e) { return err(e.message); }
});

server.registerTool("recette_feature_unlink", {
  description: "Alias legacy de `cadrage_feature_unlink`. DÉLIE une RECETTE d'une FONCTIONNALITÉ (`recette_fonctionnalites`).",
  inputSchema: {
    recetteId: z.string().describe("Recette."),
    featureId: z.string().describe("Fonctionnalité."),
  },
}, async ({ recetteId, featureId }) => {
  try { return text(JSON.stringify(await unlinkRecetteFeature({ recetteId, featureId }), null, 2)); }
  catch (e) { return err(e.message); }
});

server.registerTool("recette_adr_link", {
  description: "Alias legacy de `cadrage_adr_link`. LIE une RECETTE à une ADR EXISTANTE (`recette_adr`, idempotent).",
  inputSchema: {
    recetteId: z.string().describe("Recette."),
    adrId: z.string().describe("docId de l'ADR (kind='adr-tech')."),
  },
}, async ({ recetteId, adrId }) => {
  try { return text(JSON.stringify(await linkRecetteAdr({ recetteId, adrId }), null, 2)); }
  catch (e) { return err(e.message); }
});

server.registerTool("recette_adr_unlink", {
  description: "Alias legacy de `cadrage_adr_unlink`. DÉLIE une RECETTE d'une ADR (`recette_adr`).",
  inputSchema: {
    recetteId: z.string().describe("Recette."),
    adrId: z.string().describe("docId de l'ADR."),
  },
}, async ({ recetteId, adrId }) => {
  try { return text(JSON.stringify(await unlinkRecetteAdr({ recetteId, adrId }), null, 2)); }
  catch (e) { return err(e.message); }
});

server.registerTool("recette_rule_link", {
  description: "Alias legacy de `cadrage_rule_link`. LIE une RECETTE à une RÈGLE MÉTIER EXISTANTE (`recette_regles`, idempotent).",
  inputSchema: {
    recetteId: z.string().describe("Recette."),
    ruleId: z.string().describe("Règle métier."),
  },
}, async ({ recetteId, ruleId }) => {
  try { return text(JSON.stringify(await linkRecetteRule({ recetteId, ruleId }), null, 2)); }
  catch (e) { return err(e.message); }
});

server.registerTool("recette_rule_unlink", {
  description: "Alias legacy de `cadrage_rule_unlink`. DÉLIE une RECETTE d'une RÈGLE MÉTIER (`recette_regles`).",
  inputSchema: {
    recetteId: z.string().describe("Recette."),
    ruleId: z.string().describe("Règle métier."),
  },
}, async ({ recetteId, ruleId }) => {
  try { return text(JSON.stringify(await unlinkRecetteRule({ recetteId, ruleId }), null, 2)); }
  catch (e) { return err(e.message); }
});

// ===========================================================================
// Famille ADR `adr_*` (item 125) — sur-ensemble STRUCTURÉ du module `doc_*`.
// Lecture/contexte (productivité), cycle de vie (écriture tracée), signalement.
// Les tools `doc_*` restent inchangés (rétrocompat) ; une ADR reste un doc
// `kind='adr-tech'`.
// ===========================================================================

server.registerTool("adr_list", {
  description: "Vue CONDENSÉE des ADR (adr-tech) d'un projet — point d'entrée de tout agent. Filtres : projectId, repoIds (intersection des repos rattachés ; une ADR globale correspond toujours), status (Proposé|Accepté|Déprécié|Remplacé), search (titre/contexte/décision/conséquences/chemin, insensible casse/accents), includeRepoDocs. Le statut est filtré côté registre (ne dépend pas du SQL includeRepoDocs). Retourne { count, adrs }. Rebassé sur `artifacts` (doc_type = 'adr').",
  inputSchema: {
    projectId: z.string().optional().describe("Projet dont on liste les ADR."),
    repoIds: z.array(z.string()).optional().describe("Repos à considérer (une ADR globale correspond toujours)."),
    status: z.enum(ADR_STATUS).optional().describe("Filtre par statut ADR."),
    search: z.string().optional().describe("Recherche texte (titre/contexte/décision/conséquences/chemin)."),
    includeRepoDocs: z.boolean().optional().describe("Avec projectId : inclure les ADR portées par les repos du projet (défaut true)."),
  },
}, async ({ projectId, repoIds, status, search, includeRepoDocs }) => {
  try {
    const adrs = await listAdrs({ projectId, repoIds, status, search, includeRepoDocs: includeRepoDocs !== false });
    return text(JSON.stringify({ count: adrs.length, adrs }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("adr_get", {
  description: "Contenu COMPLET structuré d'une ADR : titre, statut, contexte, décision, conséquences, replacedBy, repos, pièces jointes, chemin, + conflits ouverts. `err` si inconnue ou si le doc n'est pas une ADR. Rebassé sur `artifacts` (doc_type = 'adr').",
  inputSchema: { adrId: z.string().describe("docId de l'ADR (kind='adr-tech').") },
}, async ({ adrId }) => {
  try {
    const adr = await getAdr(adrId);
    if (!adr) return err(`ADR inconnue (kind='adr-tech' attendu) : ${adrId}`);
    return text(JSON.stringify({ ok: true, adr }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("adr_search", {
  description: "Recherche texte dans les ADR (titre/contexte/décision/conséquences/chemin) — retrouver la règle pertinente. Retourne { count, results } avec un extrait. Rebassé sur `artifacts` (doc_type = 'adr').",
  inputSchema: {
    query: z.string().describe("Texte recherché (insensible casse/accents)."),
    projectId: z.string().optional().describe("Restreindre à un projet."),
  },
}, async ({ query, projectId }) => {
  try {
    const results = await searchAdrs({ query, projectId });
    return text(JSON.stringify({ count: results.length, results }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("adr_context", {
  description: "Construit le bloc de contexte ADR prêt à injecter dans un prompt agent ('## ADR de référence' : titre, statut, repos, décision, conséquence, chemin). ADR = `adrIds` (sélection explicite) sinon les ADR ACTIVES (Proposé/Accepté) du projet ; filtrage par `scope` (ADR globale ou segment de chemin). `taskId` résout projectId/scope. Retourne { projectId, count, adrs, context }. Rebassé sur `artifacts` (doc_type = 'adr').",
  inputSchema: {
    projectId: z.string().optional(),
    scope: z.array(z.string()).optional().describe("Périmètres (chemins) — une ADR globale correspond toujours."),
    adrIds: z.array(z.string()).optional().describe("ADR sélectionnées (prioritaire sur la liste automatique)."),
    taskId: z.string().optional().describe("Résout projectId/scope depuis la tâche."),
  },
}, async ({ projectId, scope, adrIds, taskId }) => {
  try {
    const r = await buildAdrContext({ projectId, scope, adrIds, taskId });
    return text(JSON.stringify(r, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("feature_context", {
  description: "Construit le bloc de contexte FONCTIONNALITÉS prêt à injecter dans un prompt agent ('## Fonctionnalités de référence' : ref, rôle, user story). Sélection EXPLICITE via `featureIds` (lecture BULK, 1 requête, 0 N+1) ; `context` = \"\" si aucune sélection ⇒ aucun bloc (facultatif). Retourne { projectId, count, features, context }.",
  inputSchema: {
    projectId: z.string().optional().describe("Projet de référence (affiché dans le bloc)."),
    featureIds: z.array(z.string()).optional().describe("Fonctionnalités sélectionnées."),
  },
}, async ({ projectId, featureIds }) => {
  try {
    const r = await buildFeatureContext({ projectId, featureIds });
    return text(JSON.stringify(r, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("rule_context", {
  description: "Construit le bloc de contexte RÈGLES MÉTIER prêt à injecter dans un prompt agent ('## Règles métier de référence' : ref, contenu, rôles/global). Sélection EXPLICITE via `ruleIds` (lecture BULK, 1 requête, 0 N+1) ; `context` = \"\" si aucune sélection ⇒ aucun bloc (facultatif). Retourne { projectId, count, rules, context }.",
  inputSchema: {
    projectId: z.string().optional().describe("Projet de référence (affiché dans le bloc)."),
    ruleIds: z.array(z.string()).optional().describe("Règles métier sélectionnées."),
  },
}, async ({ projectId, ruleIds }) => {
  try {
    const r = await buildRuleContext({ projectId, ruleIds });
    return text(JSON.stringify(r, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("adr_register", {
  description: "Crée une ADR structurée (kind='adr-tech') — statut initial 'Proposé' par défaut (l'acceptation est une DÉCISION HUMAINE, pas une écriture d'agent). repoIds (1..N), global=true pour tous les repos du projet, attachments[] optionnels ({repoId?, docId?, path?, title?, kind?, nature?}). `path` requis (l'ADR pointe un fichier que l'agent lit). Rebassé sur `artifacts` (doc_type = 'adr').",
  inputSchema: {
    projectId: z.string(),
    repoIds: z.array(z.string()).optional().describe("Repos rattachés (1..N)."),
    title: z.string(),
    path: z.string().describe("Chemin du fichier de l'ADR."),
    description: z.string().optional(),
    status: z.enum(ADR_STATUS).optional().describe("Statut initial (défaut Proposé)."),
    context: z.string().optional().describe("ADR : contexte."),
    decision: z.string().optional().describe("ADR : décision."),
    consequences: z.string().optional().describe("ADR : conséquences."),
    global: z.boolean().optional().describe("true : ADR globale (tous les repos du projet)."),
    attachments: z.array(z.object({
      repoId: z.string().optional(),
      docId: z.string().optional().describe("Pièce jointe = document du registre."),
      path: z.string().optional().describe("Pièce jointe = fichier (import/ref)."),
      title: z.string().optional(),
      kind: z.string().optional(),
      nature: z.string().optional(),
    })).optional().describe("Rattachements optionnels (repos et/ou pièces jointes)."),
  },
}, async (input) => {
  try {
    const adr = await registerAdr(input);
    return text(JSON.stringify({ ok: true, adr }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("adr_set_status", {
  description: "Fait transiter une ADR : Proposé→{Accepté,Déprécié}, Accepté→{Déprécié,Remplacé}, Déprécié→{Remplacé}, Remplacé terminal. 'Remplacé' exige `replacedBy` (docId de l'ADR qui remplace). Toute transition non permise est refusée. Rebassé sur `artifacts` (doc_type = 'adr').",
  inputSchema: {
    adrId: z.string(),
    status: z.enum(ADR_STATUS),
    replacedBy: z.string().optional().describe("docId de l'ADR qui remplace (requis si status='Remplacé')."),
  },
}, async ({ adrId, status, replacedBy }) => {
  try {
    const adr = await setAdrStatus({ adrId, status, replacedBy });
    return text(JSON.stringify({ ok: true, adr }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("adr_update", {
  description: "Met à jour les champs STRUCTURÉS d'une ADR (title/path/description/context/decision/consequences/replacedBy) et ses rattachements repos (addRepoIds) / global (setGlobal). `err` si l'ADR est inconnue. Rebassé sur `artifacts` (doc_type = 'adr').",
  inputSchema: {
    adrId: z.string(),
    title: z.string().optional(),
    path: z.string().optional(),
    description: z.string().optional(),
    context: z.string().optional(),
    decision: z.string().optional(),
    consequences: z.string().optional(),
    replacedBy: z.string().optional(),
    addRepoIds: z.array(z.string()).optional().describe("Repos à rattacher (1..N)."),
    setGlobal: z.boolean().optional().describe("true : rattacher tous les repos du projet ; false : is_global=0."),
  },
}, async ({ adrId, title, path, description, context, decision, consequences, replacedBy, addRepoIds, setGlobal }) => {
  try {
    if (!(await getAdr(adrId))) return err(`ADR inconnue (kind='adr-tech' attendu) : ${adrId}`);
    await updateDoc({ docId: adrId, title, path, description, context, decision, consequences, replacedBy, addRepoIds, setGlobal });
    return text(JSON.stringify({ ok: true, adr: await getAdr(adrId) }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("adr_attach", {
  description: "Rattache à une ADR : un repo (repoId, cumulable 1..N) et/ou une pièce jointe (docId = document du registre, ou path = fichier import/ref). Au moins un des trois (repoId/docId/path) requis. Retourne l'ADR à jour. Rebassé sur `artifacts` (doc_type = 'adr' / 'adr_file').",
  inputSchema: {
    adrId: z.string(),
    repoId: z.string().optional().describe("Repo à rattacher."),
    docId: z.string().optional().describe("Pièce jointe = document du registre (source registry)."),
    path: z.string().optional().describe("Pièce jointe = fichier (source import/ref)."),
    title: z.string().optional(),
    kind: z.string().optional().describe("Libellé libre (annexe, spec, capture…)."),
    nature: z.string().optional().describe("document | fichier | lien."),
    source: z.enum(DOC_ATTACHMENT_SOURCES).optional().describe("registry | import | ref (défaut selon docId/path)."),
    meta: z.record(z.string(), z.any()).optional().describe("Métadonnées libres (JSON)."),
  },
}, async ({ adrId, repoId, docId, path, title, kind, nature, source, meta }) => {
  try {
    const adr = await attachAdr({ adrId, repoId, docId, path, title, kind, nature, source, meta });
    return text(JSON.stringify({ ok: true, adr }, null, 2));
  } catch (e) { return err(e.message); }
});

// CONVERSION D'ADR MONOLITHIQUE → ADR ATOMIQUE (ADR-001 §6) — A009.
// L'ADR d'origine reste INTACTE ; la convertie porte les colonnes structurées
// (titre/statut/contexte/décision/conséquences) et les grands détails passent en
// PIÈCES JOINTES (`adr_file`). Le lien historique est écrit dans `adr_conversions`.
server.registerTool("adr_convert", {
  description: "CONVERTIT une ADR MONOLITHIQUE en UNE ADR ATOMIQUE (ADR-001 §6) : crée une NOUVELLE ADR structurée (titre/statut/contexte/décision/conséquences), rattache les grands détails en PIÈCES JOINTES (`attachments[]` → `adr_file`), et écrit le LIEN HISTORIQUE dans `adr_conversions` (+ `meta.converted_from_adr_id`). L'ADR D'ORIGINE RESTE INTACTE (aucune réécriture doc_type/content_id/path/meta). Le projet est résolu depuis l'origine (erreur explicite si aucun projet rattaché). Retourne `{ ok, adr, conversion, original }`. Chaque ADR convertie doit ensuite être associée à 1..N fonctionnalités (`feature_adr_link`).",
  inputSchema: {
    originalAdrId: z.string().describe("ADR monolithique d'origine (kind='adr-tech')."),
    title: z.string().describe("Titre de l'ADR atomique."),
    status: z.enum(ADR_STATUS).optional().describe("Statut (défaut : hérité de l'origine, sinon 'Proposé')."),
    context: z.string().optional().describe("Contexte (colonne structurée)."),
    decision: z.string().optional().describe("Décision (colonne structurée)."),
    consequences: z.string().optional().describe("Conséquences (colonne structurée)."),
    description: z.string().optional().describe("Description libre de l'ADR atomique."),
    path: z.string().optional().describe("Chemin du fichier de l'ADR atomique (défaut : celui de l'origine)."),
    repoIds: z.array(z.string()).optional().describe("Repos rattachés (défaut : ceux de l'origine)."),
    global: z.boolean().optional().describe("true : ADR globale (tous les repos du projet)."),
    attachments: z.array(z.object({
      docId: z.string().optional().describe("Pièce jointe = document du registre (source registry)."),
      path: z.string().optional().describe("Pièce jointe = fichier (source import/ref)."),
      title: z.string().optional(),
      kind: z.string().optional().describe("Libellé libre (annexe, spec, détail…)."),
      nature: z.string().optional().describe("document | fichier | lien."),
      source: z.enum(DOC_ATTACHMENT_SOURCES).optional().describe("registry | import | ref (défaut selon docId/path)."),
      repoId: z.string().optional().describe("Repo à rattacher."),
      meta: z.record(z.string(), z.any()).optional(),
    })).optional().describe("Pièces jointes portant les grands détails (adr_file)."),
    createdBy: z.string().optional().describe("Acteur de la conversion."),
  },
}, async ({ originalAdrId, title, status, context, decision, consequences, description, path, repoIds, global, attachments, createdBy }) => {
  try {
    const r = await convertAdr({
      originalAdrId, title, status, context, decision, consequences, description,
      path, repoIds, global, attachments, createdBy, by: "agent",
    });
    return text(JSON.stringify({ ok: true, ...r }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("adr_conversion_link", {
  description: "ÉCRIT le LIEN HISTORIQUE ADR monolithique d'origine ↔ ADR atomique convertie (`adr_conversions`). GARDES : les deux ADR doivent exister et différer. IDEMPOTENT (un couple = une ligne). Retourne `{ ok, conversion }`. Utile pour rattacher une ADR créée hors `adr_convert`.",
  inputSchema: {
    originalAdrId: z.string().describe("ADR d'origine (kind='adr-tech')."),
    convertedAdrId: z.string().describe("ADR convertie (kind='adr-tech')."),
    createdBy: z.string().optional().describe("Acteur."),
  },
}, async ({ originalAdrId, convertedAdrId, createdBy }) => {
  try {
    const conversion = await linkAdrConversion({ originalAdrId, convertedAdrId, createdBy });
    return text(JSON.stringify({ ok: true, conversion }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("adr_conversion_list", {
  description: "LISTE les liens de conversion ADR (par ADR d'origine et/ou par ADR convertie) — historique de la conversion sans perte. Retourne `{ count, conversions }`.",
  inputSchema: {
    originalAdrId: z.string().optional().describe("Filtre par ADR d'origine."),
    convertedAdrId: z.string().optional().describe("Filtre par ADR convertie."),
    limit: z.number().int().optional().describe("Max (défaut 500)."),
  },
}, async ({ originalAdrId, convertedAdrId, limit }) => {
  try {
    const conversions = await listAdrConversions({ originalAdrId, convertedAdrId, limit });
    return text(JSON.stringify({ count: conversions.length, conversions }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("adr_report_conflict", {
  description: "Signale qu'une implémentation CONTREDIT une ADR → conflit persisté (adr_conflicts, status='open') MÊME SANS taskId ; si `taskId` fourni, une décision HUMAINE trackée (kind='conflict') est créée et référencée — sa résolution clôt le conflit. Aucune violation silencieuse. `recetteId` OPTIONNEL : signaler un conflit PENDANT une recette crée EN PLUS un POINT DE VIGILANCE GLOBAL de la recette (type='conflict'), qui BLOQUE sa terminaison jusqu'à levée. Retourne { ok, conflict, decision, vigilance }. Rebassé sur `artifacts` (adr_conflicts.adr_id → artifacts.artifact_id).",
  inputSchema: {
    adrId: z.string().describe("ADR contredite."),
    taskId: z.string().optional().describe("Tâche concernée (→ décision humaine trackée)."),
    recetteId: z.string().optional().describe("Recette en cours → point de vigilance global (bloquant)."),
    description: z.string().describe("Description de la contradiction code ↔ ADR."),
    entity: z.string().optional().describe("Entité discutée (contexte du conflit)."),
    relatedAdrId: z.string().optional().describe("Nouvelle ADR en conflit avec `adrId` (chaînage)."),
  },
}, async ({ adrId, taskId, recetteId, description, entity, relatedAdrId }) => {
  try {
    const r = await reportAdrConflict({ adrId, taskId, recetteId, description, entity, relatedAdrId, by: "agent" });
    return text(JSON.stringify({ ok: true, ...r }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("adr_report_missing", {
  description: "Signale une ADR MANQUANTE pour une entité réellement discutée en session de RECETTE ou de TEST (aucune ADR ne la couvre : adr_list/adr_search négatifs). Exige `entity` ET `description` (évite les fausses alertes). Contexte requis : `recetteId` (recette) OU `taskId` (test) OU `projectId` — le projet est résolu (recettes.project / tasks.project). Si `recetteId`, le point devient un POINT DE VIGILANCE GLOBAL de la recette qui BLOQUE sa terminaison. `proposedAdrId` référence l'ADR Proposé créée depuis la session (adr_register). Retourne { ok, vigilance }.",
  inputSchema: {
    recetteId: z.string().optional().describe("Recette en cours (→ point de vigilance global bloquant)."),
    taskId: z.string().optional().describe("Tâche/test concerné (résout le projet)."),
    projectId: z.string().optional().describe("Projet (si ni recetteId ni taskId)."),
    entity: z.string().describe("Entité/constat réellement discuté, sans ADR couvrante."),
    description: z.string().describe("Description du constat et de l'ADR manquante."),
    proposedAdrId: z.string().optional().describe("ADR Proposé créée depuis la session (adr_register)."),
    sessionId: z.string().optional().describe("Session recette/test d'origine (traçage)."),
  },
}, async ({ recetteId, taskId, projectId, entity, description, proposedAdrId, sessionId }) => {
  try {
    const vigilance = await reportAdrMissing({ recetteId, taskId, projectId, entity, description, proposedAdrId, sessionId, by: "agent" });
    return text(JSON.stringify({ ok: true, vigilance }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("adr_vigilance_list", {
  description: "HISTORIQUE FILTRABLE (append-only, lecture seule) des points de vigilance ADR remontés par les recettes/tests : ADR manquante (type='missing') ou conflit d'ADR (type='conflict'). Filtres : projectId, recetteId, type, status (open|resolved), from/to (dates), limit. Chaque point porte sa `reason` explicite (« ADR manquant pour [entité] » / « Conflit d'ADR : [ancienne] vs [nouvelle] »). Retourne { count, vigilancess }.",
  inputSchema: {
    projectId: z.string().optional().describe("Filtre projet."),
    recetteId: z.string().optional().describe("Filtre recette liée."),
    type: z.enum(ADR_VIGILANCE_TYPES).optional().describe("missing (ADR manquante) | conflict (conflit)."),
    status: z.enum(ADR_VIGILANCE_STATUS).optional().describe("open | resolved."),
    from: z.string().optional().describe("Date de détection ≥ (ISO/texte)."),
    to: z.string().optional().describe("Date de détection ≤ (ISO/texte)."),
    limit: z.number().int().optional().describe("Max (défaut 500)."),
  },
}, async ({ projectId, recetteId, type, status, from, to, limit }) => {
  try {
    const vigilancess = await listAdrVigilances({ projectId, recetteId, type, status, from, to, limit });
    return text(JSON.stringify({ count: vigilancess.length, vigilancess }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("adr_vigilance_resolve", {
  description: "LÈVE un point de vigilance ADR (ADR créée / dépréciation actée / décision explicite / levée manuelle). `resolution` (raison TRACÉE) est OBLIGATOIRE : le blocage de terminaison n'est jamais infini mais jamais silencieux. resolutionKind : adr_created | adr_deprecated | manual | decision (défaut manual). `adrId` (optionnel) = ADR liée à la levée. Retourne { ok, vigilance }.",
  inputSchema: {
    vigilanceId: z.string(),
    resolution: z.string().describe("Raison tracée de la levée (obligatoire)."),
    resolutionKind: z.enum(["adr_created", "adr_deprecated", "manual", "decision"]).optional().describe("Nature de la levée (défaut manual)."),
    adrId: z.string().optional().describe("ADR liée à la levée (créée/dépréciée)."),
    resolvedBy: z.string().optional().describe("Acteur (défaut human)."),
  },
}, async ({ vigilanceId, resolution, resolutionKind, adrId, resolvedBy }) => {
  try {
    const vigilance = await resolveAdrVigilance({ vigilanceId, resolution, resolutionKind, adrId, resolvedBy });
    return text(JSON.stringify({ ok: true, vigilance }, null, 2));
  } catch (e) { return err(e.message); }
});

// ===========================================================================
// CARDINALITÉS HEURISTIQUES + GOUVERNANCE DE L'ÉMERGENCE (T6, ADR-001 §5).
// SIGNALEMENT + TRAÇAGE, JAMAIS BLOQUANT. Ces tools sont en LECTURE SEULE
// (sauf `cardinality_signal_resolve`, clôture tracée) et alimentent le panneau
// (T7). L'émergence n'est jamais rétroactive (aucun backfill).
// ===========================================================================

server.registerTool("cardinality_report", {
  description: "AGRÉGAT de traçage des cardinalités heuristiques d'un projet (T6) : compteurs + vues complètes (tâche sans ADR/fonctionnalité/sprint, recette sans ADR/fonctionnalité/sprint, ADR sans fonctionnalité, sprint sans fonctionnalité/règle, émergents) + synthèse des signaux (total/open/resolved/stale). `view` (optionnel) restreint à une seule vue. Lecture seule, NON bloquant.",
  inputSchema: {
    projectId: z.string().describe("Projet (produit) dont on veut les cardinalités."),
    view: z.string().optional().describe(`Vue unique (sinon rapport complet) : ${CARDINALITY_VIEWS.join(" | ")}.`),
  },
}, async ({ projectId, view }) => {
  try {
    if (view) {
      const v = await cardinalityView({ projectId, view });
      return text(JSON.stringify({ ok: true, ...v }, null, 2));
    }
    const report = await cardinalityReport({ projectId });
    return text(JSON.stringify({ ok: true, ...report }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("cardinality_signals_list", {
  description: "HISTORIQUE filtrable des signaux de cardinalité (T6, append-only) : `projectId`, `entityType` (recette|task|adr|sprint), `entityId`, `status` (open|resolved). Chaque signal est enrichi de `currentGaps` (manques live) et `stale` (signal OPEN désormais comblé). Lecture seule.",
  inputSchema: {
    projectId: z.string().optional().describe("Filtre projet."),
    entityType: z.string().optional().describe("recette | task | adr | sprint."),
    entityId: z.string().optional().describe("Identifiant de l'entité porteuse."),
    status: z.string().optional().describe("open | resolved."),
    limit: z.number().optional().describe("Nombre max (défaut 500)."),
  },
}, async ({ projectId, entityType, entityId, status, limit }) => {
  try {
    const signals = await listCardinalitySignals({ projectId, entityType, entityId, status, limit });
    return text(JSON.stringify({ count: signals.length, signals }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("cardinality_signal_resolve", {
  description: "CLÔT un signal de cardinalité (open → resolved). `resolution` (raison TRACÉE) est OBLIGATOIRE : jamais de clôture silencieuse. Le flag `emergent` de l'entité n'est PAS effacé (trace historique).",
  inputSchema: {
    signalId: z.string().describe("Identifiant du signal (card-<ts>-<rand>)."),
    resolution: z.string().describe("Raison tracée de la clôture (obligatoire)."),
    resolvedBy: z.string().optional().describe("Acteur (défaut human)."),
  },
}, async ({ signalId, resolution, resolvedBy }) => {
  try {
    const signal = await resolveCardinalitySignal({ signalId, resolution, resolvedBy });
    return text(JSON.stringify({ ok: true, signal }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("project_repo_link", {
  description: "Rattache un repo à un projet (produit) — N:N (ADR 09). Un repo peut servir plusieurs produits (ex. le repo oniria est lié à mada-talk ET oniria). gitTokenId : token git de l'ORGANISATION du projet à utiliser pour ce repo (clone/pull/push) — choisi parmi les gitTokens de l'organisation (org_git_token_add). Absent = inchangé (fallback token par défaut de l'org).",
  inputSchema: {
    projectId: z.string(),
    repoId: z.string(),
    role: z.string().optional().describe("Rôle : frontend | backend | console | outillage…"),
    gitTokenId: z.string().optional().describe("Token git de l'organisation du projet à utiliser pour ce repo (choisi dans org_git_tokens)."),
  },
}, async ({ projectId, repoId, role, gitTokenId }) => {
  try {
    return text(JSON.stringify({ ok: true, ...(await linkRepoToProject({ projectId, repoId, role, gitTokenId: gitTokenId || undefined })) }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("project_repo_unlink", {
  description: "Retire un repo d'un projet (ADR 09).",
  inputSchema: { projectId: z.string(), repoId: z.string() },
}, async ({ projectId, repoId }) => {
  try {
    return text(JSON.stringify({ ok: true, ...(await unlinkRepoFromProject({ projectId, repoId })) }, null, 2));
  } catch (e) { return err(e.message); }
});



// === task_get ===
server.registerTool("task_get", {
  description: "Renvoie le détail d'une tâche (contexte + exécutions + participants + exécutions des plans). Expose aussi `adrs` (liens ADR proposés/validés) et `cardinalite` (manques heuristiques : sprint / fonctionnalité / ADR effectif) — T6, non bloquant.",
  inputSchema: { taskId: z.string() },
}, async ({ taskId }) => {
  try {
    const task = await getTaskWithRepos(taskId);
    if (!task) return err(`tâche inconnue : ${taskId}`);
    const executions = await getExecutions(taskId);
    const participants = await listParticipants(taskId);
    const planExecutions = await listPlanExecutions(taskId);
    const planCommits = await listTaskPlanCommits(taskId);
    const sessions = await listTaskSessions(taskId);
    const linkedTasks = await listTaskLinks(taskId);
    const emergentFrom = await listTaskEmergentFrom(taskId);
    const recette = await getRecette(taskId).catch(() => null);
    // CARDINALITÉ (T6, lecture seule, NON bloquante) + liens ADR de la tâche.
    const adrs = await listTaskAdrs({ taskId }).catch(() => []);
    const cardinalite = await checkCardinality({ entityType: "task", entityId: taskId }).catch(() => null);
    return text(JSON.stringify({ task, executions, participants, planExecutions, planCommits, sessions, linkedTasks, emergentFrom, recette, adrs, cardinalite }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === task_link_add ===
server.registerTool("task_link_add", {
  description: "Rattache une tâche associée (source) à une tâche, avec la nature de la liaison. Les tâches liées sont exploitables par atomic-plan (commits, plans, docs). relationType : 'linked' (défaut) | 'emergent' (tâche émergente reliée à sa source).",
  inputSchema: {
    taskId: z.string().describe("Tâche cible (celle qui exploitera la tâche liée)."),
    linkedTaskId: z.string().describe("taskId de la tâche associée (source)."),
    description: z.string().optional().describe("Nature de la liaison (libre)."),
    relationType: z.enum(["linked", "emergent"]).optional().describe("linked (défaut) | emergent."),
  },
}, async ({ taskId, linkedTaskId, description, relationType }) => {
  try {
    if (!(await getTask(taskId))) return err(`tâche inconnue : ${taskId}`);
    const links = await addTaskLink({ taskId, linkedTaskId, description, relationType });
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

// ===========================================================================
// Famille `cadrage_*` (CANONIQUE) — « Cadrage technique » (ADR-001,
// doc-muchlzn8-acon). L'entité actuelle « recette » devient le « Cadrage
// technique » de l'exécuteur : mêmes capacités (contexte de mission, lecture du
// code, analyse, production de tâches techniques) et mêmes fonctions `db.mjs`
// (tables `recettes`/`recette_*` et historique CONSERVÉS — aucun renommage de
// schéma). Les éléments convertibles en tâches sont les « ÉLÉMENTS DE CADRAGE ».
// Les tools `recette_*` restent des ALIAS LEGACY (voir la section suivante) pour
// la rétrocompatibilité (`pilot.mjs` hors périmètre + historique).
// ===========================================================================

// === cadrage_start ===
server.registerTool("cadrage_start", {
  description: "Crée une opération de CADRAGE TECHNIQUE de PROJET : 1 cadrage = 1 PROJET unique (produit). Les REPOS TRANSVERSES du projet (project_repos, ex: mada-talk traverse le repo oniria) couvrent la portée — pas d'ajout de projets supplémentaires. + titre + 0..N tâches couvertes (du projet) + session dédiée.",
  inputSchema: {
    project: z.string().describe("Projet (produit) unique du cadrage — ses repos transverses sont la portée."),
    title: z.string().optional().describe("Titre court compréhensible (ex: 'Cadrage du module chatbot'). Dérivé si absent."),
    description: z.string().optional().describe("Description longue (détail du périmètre analysé)."),
    taskIds: z.array(z.string()).optional().describe("Tâches couvertes par le cadrage (0..N — doivent appartenir au projet du cadrage)."),
    sprintId: z.string().optional().describe("Sprint du cadrage (optionnel, T6) ; sinon sprint par défaut SI le projet n'a aucun sprint."),
    featureIds: z.array(z.string()).optional().describe("Fonctionnalités du cadrage (optionnel, T6)."),
    ruleIds: z.array(z.string()).optional().describe("Règles métier du cadrage (optionnel, T6 — NON bloquant)."),
    adrIds: z.array(z.string()).optional().describe("ADR du cadrage (optionnel, T6)."),
    status: z.enum(["pending", "in_progress"]).optional().describe("pending (défaut) ou in_progress (session lancée)."),
    sessionId: z.string().optional().describe("Session dédiée de l'agent de cadrage (si lancée)."),
    createdBy: z.string().optional().describe("Utilisateur (username) qui crée le cadrage."),
    organizationId: z.string().optional().describe("Organisation (tenant). Défaut : celle du projet."),
  },
}, async ({ project, title, description, taskIds, sprintId, featureIds, ruleIds, adrIds, status, sessionId, createdBy, organizationId }) => {
  try {
    const recette = await startRecette({ project, title, description, taskIds, sprintId, featureIds, ruleIds, adrIds, status: status || "pending", sessionId: sessionId || null, createdBy, organizationId });
    // CARDINALITÉ (T6, lecture seule, NON bloquante) : cadrage → ≥1 ADR +
    // ≥1 fonctionnalité + 1 sprint.
    const cardinalite = await checkCardinality({ entityType: "recette", entityId: recette.recetteId }).catch(() => null);
    return text(JSON.stringify({ ok: true, cadrage: recette, cardinalite }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === cadrage_list ===
server.registerTool("cadrage_list", {
  description: "Liste les cadrages techniques (tous ou filtrés par projet) avec nb de tâches couvertes et nb d'éléments de cadrage.",
  inputSchema: { project: z.string().optional() },
}, async ({ project }) => {
  try {
    const cadrages = await listProjectRecettes(project);
    return text(JSON.stringify({ count: cadrages.length, cadrages }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === cadrage_get ===
server.registerTool("cadrage_get", {
  description: "Détail d'un cadrage technique (titre, projet UNIQUE + repos transverses du projet, statut, tâches couvertes, éléments de cadrage). Expose les liens N:N `sprints`, `fonctionnalites`, `regles` (règles métier) et `adrs`, ainsi que `evaluationItems` (éléments de recette évaluateur REPRIS par ce cadrage, « repris par le cadrage X »). Expose aussi `adrVigilances` (historique des points de vigilance ADR : ADR manquante / conflit), `adrVigilancesOpen` (ceux qui BLOQUENT la terminaison) et `cardinalite` (manques heuristiques : ≥1 ADR / ≥1 fonctionnalité / 1 sprint — T6, non bloquant).",
  inputSchema: { cadrageId: z.string() },
}, async ({ cadrageId }) => {
  try {
    const cadrage = await getRecetteById(cadrageId);
    if (!cadrage) return err(`cadrage inconnu : ${cadrageId}`);
    // CARDINALITÉ (T6, lecture seule, NON bloquante) — à côté de `adrVigilances`.
    cadrage.cardinalite = await checkCardinality({ entityType: "recette", entityId: cadrageId }).catch(() => null);
    return text(JSON.stringify({ cadrage }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === cadrage_session_set ===
server.registerTool("cadrage_session_set", {
  description: "Associe la session dédiée lancée à un cadrage technique et le passe en cours (in_progress).",
  inputSchema: { cadrageId: z.string(), sessionId: z.string() },
}, async ({ cadrageId, sessionId }) => {
  try {
    const cadrage = await setRecetteSession({ recetteId: cadrageId, sessionId });
    return text(JSON.stringify({ ok: true, cadrage }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === cadrage_doc_add ===
server.registerTool("cadrage_doc_add", {
  description: "Rattache un document à un cadrage technique (importé ou artefact existant) avec la nature de la liaison (à quoi sert / comment l'exploiter).",
  inputSchema: {
    cadrageId: z.string(),
    title: z.string().optional(),
    nature: z.string().optional().describe("Nature de la liaison : à quoi sert le document et comment l'exploiter."),
    source: z.enum(["import", "artifact"]).default("import"),
    path: z.string().optional().describe("Chemin du fichier (mode import)."),
    artifactId: z.string().optional().describe("Artefact existant à lier (mode artifact)."),
  },
}, async ({ cadrageId, title, nature, source, path, artifactId }) => {
  try {
    let finalPath = path;
    if (source === "artifact") {
      if (!artifactId) return err("artifactId requis en mode artifact");
      const a = await getArtifact(artifactId);
      if (!a) return err(`artefact inconnu : ${artifactId}`);
      finalPath = a.path;
    }
    const docs = await addRecetteDocument({ recetteId: cadrageId, title, nature, source, path: finalPath, artifactId: source === "artifact" ? artifactId : null });
    return text(JSON.stringify({ ok: true, documents: docs }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === cadrage_doc_remove ===
server.registerTool("cadrage_doc_remove", {
  description: "Retire un document d'un cadrage technique.",
  inputSchema: { documentId: z.number().int() },
}, async ({ documentId }) => {
  try {
    const cadrageId = await removeRecetteDocument(documentId);
    if (!cadrageId) return err(`document inconnu : ${documentId}`);
    return text(JSON.stringify({ ok: true, cadrageId, documents: await listRecetteDocuments(cadrageId) }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === cadrage_link_task ===
server.registerTool("cadrage_link_task", {
  description: "Rattache une tâche à un cadrage technique (tâche couverte). Garde : la tâche doit appartenir au PROJET du cadrage (1 cadrage = 1 projet ; les repos transverses du projet sont la portée).",
  inputSchema: { cadrageId: z.string(), taskId: z.string() },
}, async ({ cadrageId, taskId }) => {
  try {
    if (!(await getTask(taskId))) return err(`tâche inconnue : ${taskId}`);
    await linkRecetteTask(cadrageId, taskId);
    return text(JSON.stringify({ ok: true, cadrage: await getRecetteById(cadrageId) }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === cadrage_unlink_task ===
server.registerTool("cadrage_unlink_task", {
  description: "Détache une tâche d'un cadrage technique (la tâche reste historiquement intacte, juste plus couverte).",
  inputSchema: { cadrageId: z.string(), taskId: z.string() },
}, async ({ cadrageId, taskId }) => {
  try {
    const cadrage = await unlinkRecetteTask(cadrageId, taskId);
    if (!cadrage) return err(`cadrage inconnu : ${cadrageId}`);
    return text(JSON.stringify({ ok: true, cadrage }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === cadrage_item_add ===
server.registerTool("cadrage_item_add", {
  description: "Enregistre un ÉLÉMENT DE CADRAGE détecté pendant le cadrage technique (remarque, demande, constat, problème) avec sa classification (rework|bug|improvement|feature), son projet cible (= projet unique du cadrage — les repos transverses sont des repos, pas des projets), le périmètre (scope) suggéré et, si le constat implique de faire évoluer des TESTS et/ou des DOCUMENTS de référence du projet, une intention structurée (testIntent / docIntent).",
  inputSchema: {
    cadrageId: z.string(),
    content: z.string().describe("La remarque / demande / constat."),
    classification: z.enum(["rework", "bug", "improvement", "feature"]).optional().describe("Nature de l'élément de cadrage (défaut rework)."),
    project: z.string().optional().describe("Projet cible de l'élément (= projet unique du cadrage ; fourni par défaut, ignoré sinon). Les repos transverses du projet ne sont pas des projets."),
    discussion: z.string().optional().describe("Échanges associés."),
    scope: z.array(z.string()).optional().describe("Périmètre suggéré (chemins) — transmis à la tâche créée à la confirmation."),
    title: z.string().optional().describe("Titre court de la tâche qui sera créée à la confirmation."),
    acceptance: z.string().optional().describe("Critère d'acceptation / livrable attendu de la tâche qui sera créée."),
    execOrder: z.number().int().optional().describe("Ordre d'exécution recommandé (même numéro = exécutable en parallèle)."),
    vigilance: z.string().optional().describe("Point de vigilance / écart sémantique détecté pour cet élément."),
    testIntent: z.object({
      action: z.enum(["create", "update", "obsolete"]).describe("Action sur le(s) test(s) : create (nouveau test pour le comportement voulu/bug) | update (adapter un test existant) | obsolete (test devenu obsolète)."),
      testType: z.enum(["unit", "e2e"]).optional().describe("Type de test concerné : unit (unitaire, dans le repo) | e2e (entité E2E Playwright). Défaut unit."),
      target: z.string().optional().describe("Cible : e2eTestId, specFile (E2E) ou chemin du test unitaire (ex. tests/mon-test.spec.ts)."),
      scenario: z.string().optional().describe("Scénario / comportement à couvrir ou à vérifier."),
      reason: z.string().optional().describe("Pourquoi ce besoin test (bug non couvert, comportement changé, test obsolète…)."),
    }).optional().describe("Intention test structurée — à renseigner quand le constat requiert d'ajouter/modifier/obsoléter un test du projet pour couvrir le comportement voulu ou le bug détecté."),
    docIntent: z.object({
      action: z.enum(["create", "update", "obsolete"]).describe("Action sur le(s) document(s) de référence : update (mettre à jour) | create (documenter une règle nouvelle) | obsolete (document devenu obsolète)."),
      docType: z.enum(["adr-tech", "specs-fonctionnelles", "scenarios-gherkin"]).optional().describe("Type de document concerné (ADR-12) : adr-tech (architecture technique) | specs-fonctionnelles (User stories/règles métier) | scenarios-gherkin (scénarios BDD)."),
      target: z.string().optional().describe("Cible : docId ou chemin du document à faire évoluer."),
      summary: z.string().optional().describe("Ce que le document doit refléter après le cadrage."),
      reason: z.string().optional().describe("Pourquoi ce besoin doc (le cadrage rend un document inexact/obsolète, ou une règle doit être documentée)."),
    }).optional().describe("Intention document structurée — à renseigner quand une décision de cadrage impose de mettre à jour/créer/obsoléter un document de référence du projet (ADR technique, specs fonctionnelles, scénarios Gherkin)."),
  },
}, async ({ cadrageId, project, content, classification, discussion, scope, title, acceptance, execOrder, vigilance, testIntent, docIntent }) => {
  try {
    const item = await addRecetteItem({ recetteId: cadrageId, project, content, classification, discussion, scope, title, acceptance, execOrder, vigilance, testIntent, docIntent });
    return text(JSON.stringify({ ok: true, item }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === cadrage_item_update ===
server.registerTool("cadrage_item_update", {
  description: "Met à jour un élément de cadrage (contenu, classification, discussion, scope, projet cible, titre, critère d'acceptation, ordre, vigilance, intentions test/document, statut, tâche créée).",
  inputSchema: {
    itemId: z.number().int(),
    content: z.string().optional().describe("Contenu de l'élément (remarque/demande/constat) — non vide si fourni."),
    classification: z.enum(["rework", "bug", "improvement", "feature"]).optional(),
    discussion: z.string().optional(),
    scope: z.array(z.string()).optional().describe("Périmètre suggéré (chemins)."),
    project: z.string().optional().describe("Projet cible de l'élément."),
    title: z.string().optional(),
    acceptance: z.string().optional(),
    execOrder: z.number().int().optional().describe("Ordre d'exécution recommandé (même numéro = parallèle)."),
    vigilance: z.string().optional().describe("Point de vigilance / écart sémantique."),
    testIntent: z.object({
      action: z.enum(["create", "update", "obsolete"]),
      testType: z.enum(["unit", "e2e"]).optional(),
      target: z.string().optional(),
      scenario: z.string().optional(),
      reason: z.string().optional(),
    }).optional().describe("Intention test structurée (remplace l'existante ; null/absent ne la change pas)."),
    docIntent: z.object({
      action: z.enum(["create", "update", "obsolete"]),
      docType: z.enum(["adr-tech", "specs-fonctionnelles", "scenarios-gherkin"]).optional(),
      target: z.string().optional(),
      summary: z.string().optional(),
      reason: z.string().optional(),
    }).optional().describe("Intention document structurée (remplace l'existante ; null/absent ne la change pas)."),
    status: z.enum(["open", "task_created"]).optional(),
    createdTaskId: z.string().optional(),
  },
}, async ({ itemId, content, classification, discussion, scope, project, title, acceptance, execOrder, vigilance, testIntent, docIntent, status, createdTaskId }) => {
  try {
    const item = await updateRecetteItem({ itemId, content, classification, discussion, scope, project, title, acceptance, execOrder, vigilance, testIntent, docIntent, status, createdTaskId });
    return text(JSON.stringify({ ok: true, item }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === cadrage_item_delete ===
server.registerTool("cadrage_item_delete", {
  description: "Supprime un élément de cadrage (remarque/demande/constat). Refus si une tâche a déjà été créée depuis cet élément (task_created).",
  inputSchema: { itemId: z.number().int() },
}, async ({ itemId }) => {
  try {
    const r = await deleteRecetteItem({ itemId });
    return text(JSON.stringify({ ok: true, ...r }, null, 2));
  } catch (e) { return err(e.message); }
});

// === cadrage_confirm ===
server.registerTool("cadrage_confirm", {
  description: "Clôt le CADRAGE TECHNIQUE (statut 'done' = fait) après confirmation de la liste consolidée des éléments de cadrage. La tâche initiale reste done et close ; les travaux issus sont de nouvelles tâches. GARDE ADR : REFUSÉ avec raison explicite (« ADR manquant pour [entité] » / « Conflit d'ADR : [ancienne] vs [nouvelle] ») tant qu'un point de vigilance ADR (ADR manquante / conflit) est OUVERT sur le cadrage — levez-le via `adr_vigilance_resolve` (raison tracée).",
  inputSchema: {
    cadrageId: z.string(),
    confirmedBy: z.string().optional(),
  },
}, async ({ cadrageId, confirmedBy }) => {
  try {
    const cadrage = await confirmRecette({ recetteId: cadrageId, confirmedBy });
    return text(JSON.stringify({ ok: true, cadrage }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// --- Liens de contexte du cadrage (sprint / fonctionnalité / ADR / règle) ---

// === cadrage_sprint_link ===
server.registerTool("cadrage_sprint_link", {
  description: "LIE un CADRAGE TECHNIQUE à un SPRINT (`recette_sprints`, idempotent). Valide le cadrage et le sprint.",
  inputSchema: {
    cadrageId: z.string().describe("Cadrage technique."),
    sprintId: z.string().describe("Sprint."),
  },
}, async ({ cadrageId, sprintId }) => {
  try { return text(JSON.stringify(await linkRecetteSprint({ recetteId: cadrageId, sprintId }), null, 2)); }
  catch (e) { return err(e.message); }
});

// === cadrage_sprint_unlink ===
server.registerTool("cadrage_sprint_unlink", {
  description: "DÉLIE un CADRAGE TECHNIQUE d'un SPRINT (`recette_sprints`).",
  inputSchema: {
    cadrageId: z.string().describe("Cadrage technique."),
    sprintId: z.string().describe("Sprint."),
  },
}, async ({ cadrageId, sprintId }) => {
  try { return text(JSON.stringify(await unlinkRecetteSprint({ recetteId: cadrageId, sprintId }), null, 2)); }
  catch (e) { return err(e.message); }
});

// === cadrage_feature_link ===
server.registerTool("cadrage_feature_link", {
  description: "LIE un CADRAGE TECHNIQUE à une FONCTIONNALITÉ (`recette_fonctionnalites`, idempotent).",
  inputSchema: {
    cadrageId: z.string().describe("Cadrage technique."),
    featureId: z.string().describe("Fonctionnalité."),
  },
}, async ({ cadrageId, featureId }) => {
  try { return text(JSON.stringify(await linkRecetteFeature({ recetteId: cadrageId, featureId }), null, 2)); }
  catch (e) { return err(e.message); }
});

// === cadrage_feature_unlink ===
server.registerTool("cadrage_feature_unlink", {
  description: "DÉLIE un CADRAGE TECHNIQUE d'une FONCTIONNALITÉ (`recette_fonctionnalites`).",
  inputSchema: {
    cadrageId: z.string().describe("Cadrage technique."),
    featureId: z.string().describe("Fonctionnalité."),
  },
}, async ({ cadrageId, featureId }) => {
  try { return text(JSON.stringify(await unlinkRecetteFeature({ recetteId: cadrageId, featureId }), null, 2)); }
  catch (e) { return err(e.message); }
});

// === cadrage_adr_link ===
server.registerTool("cadrage_adr_link", {
  description: "LIE un CADRAGE TECHNIQUE à une ADR EXISTANTE (`recette_adr`, idempotent).",
  inputSchema: {
    cadrageId: z.string().describe("Cadrage technique."),
    adrId: z.string().describe("docId de l'ADR (kind='adr-tech')."),
  },
}, async ({ cadrageId, adrId }) => {
  try { return text(JSON.stringify(await linkRecetteAdr({ recetteId: cadrageId, adrId }), null, 2)); }
  catch (e) { return err(e.message); }
});

// === cadrage_adr_unlink ===
server.registerTool("cadrage_adr_unlink", {
  description: "DÉLIE un CADRAGE TECHNIQUE d'une ADR (`recette_adr`).",
  inputSchema: {
    cadrageId: z.string().describe("Cadrage technique."),
    adrId: z.string().describe("docId de l'ADR."),
  },
}, async ({ cadrageId, adrId }) => {
  try { return text(JSON.stringify(await unlinkRecetteAdr({ recetteId: cadrageId, adrId }), null, 2)); }
  catch (e) { return err(e.message); }
});

// === cadrage_rule_link ===
server.registerTool("cadrage_rule_link", {
  description: "LIE un CADRAGE TECHNIQUE à une RÈGLE MÉTIER EXISTANTE (`recette_regles`, idempotent).",
  inputSchema: {
    cadrageId: z.string().describe("Cadrage technique."),
    ruleId: z.string().describe("Règle métier."),
  },
}, async ({ cadrageId, ruleId }) => {
  try { return text(JSON.stringify(await linkRecetteRule({ recetteId: cadrageId, ruleId }), null, 2)); }
  catch (e) { return err(e.message); }
});

// === cadrage_rule_unlink ===
server.registerTool("cadrage_rule_unlink", {
  description: "DÉLIE un CADRAGE TECHNIQUE d'une RÈGLE MÉTIER (`recette_regles`).",
  inputSchema: {
    cadrageId: z.string().describe("Cadrage technique."),
    ruleId: z.string().describe("Règle métier."),
  },
}, async ({ cadrageId, ruleId }) => {
  try { return text(JSON.stringify(await unlinkRecetteRule({ recetteId: cadrageId, ruleId }), null, 2)); }
  catch (e) { return err(e.message); }
});

// === recette_start (alias legacy de cadrage_start) ===
  server.registerTool("recette_start", {
   description: "Alias legacy de `cadrage_start`. Crée une opération de recette de PROJET : 1 recette = 1 PROJET unique (produit). Les REPOS TRANSVERSES du projet (project_repos, ex: mada-talk traverse le repo oniria) couvrent la portée — pas d'ajout de projets supplémentaires. + titre + 0..N tâches couvertes (du projet) + session dédiée.",
   inputSchema: {
     project: z.string().describe("Projet (produit) unique de la recette — ses repos transverses sont la portée."),
     title: z.string().optional().describe("Titre court compréhensible (ex: 'Recette du module chatbot'). Dérivé si absent."),
     description: z.string().optional().describe("Description longue (détail du périmètre vérifié)."),
     taskIds: z.array(z.string()).optional().describe("Tâches couvertes par la recette (0..N — doivent appartenir au projet de la recette)."),
     sprintId: z.string().optional().describe("Sprint de la recette (optionnel, T6) ; sinon sprint par défaut SI le projet n'a aucun sprint."),
     featureIds: z.array(z.string()).optional().describe("Fonctionnalités de la recette (optionnel, T6)."),
     ruleIds: z.array(z.string()).optional().describe("Règles métier de la recette (optionnel, T6 — NON bloquant)."),
     adrIds: z.array(z.string()).optional().describe("ADR de la recette (optionnel, T6)."),
     status: z.enum(["pending", "in_progress"]).optional().describe("pending (défaut) ou in_progress (session lancée)."),
     sessionId: z.string().optional().describe("Session dédiée de l'agent-recette (si lancée)."),
     createdBy: z.string().optional().describe("Utilisateur (username) qui crée la recette."),
     organizationId: z.string().optional().describe("Organisation (tenant). Défaut : celle du projet."),
   },
 }, async ({ project, title, description, taskIds, sprintId, featureIds, ruleIds, adrIds, status, sessionId, createdBy, organizationId }) => {
   try {
     const recette = await startRecette({ project, title, description, taskIds, sprintId, featureIds, ruleIds, adrIds, status: status || "pending", sessionId: sessionId || null, createdBy, organizationId });
    // CARDINALITÉ (T6, lecture seule, NON bloquante) : recette → ≥1 ADR +
    // ≥1 fonctionnalité + 1 sprint.
    const cardinalite = await checkCardinality({ entityType: "recette", entityId: recette.recetteId }).catch(() => null);
    return text(JSON.stringify({ ok: true, recette, cardinalite }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === recette_list (alias legacy de cadrage_list) ===
server.registerTool("recette_list", {
  description: "Alias legacy de `cadrage_list`. Liste les recettes (toutes ou filtrées par projet) avec nb de tâches couvertes et nb d'éléments.",
  inputSchema: { project: z.string().optional() },
}, async ({ project }) => {
  try {
    const recettes = await listProjectRecettes(project);
    return text(JSON.stringify({ count: recettes.length, recettes }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === recette_get (alias legacy de cadrage_get) ===
server.registerTool("recette_get", {
  description: "Alias legacy de `cadrage_get`. Détail d'une recette (titre, projet UNIQUE + repos transverses du projet, statut, tâches couvertes, éléments). Expose les liens N:N `sprints`, `fonctionnalites`, `regles` (règles métier) et `adrs`. Expose aussi `adrVigilances` (historique des points de vigilance ADR : ADR manquante / conflit), `adrVigilancesOpen` (ceux qui BLOQUENT la terminaison) et `cardinalite` (manques heuristiques : ≥1 ADR / ≥1 fonctionnalité / 1 sprint — T6, non bloquant).",
  inputSchema: { recetteId: z.string() },
}, async ({ recetteId }) => {
  try {
    const recette = await getRecetteById(recetteId);
    if (!recette) return err(`recette inconnue : ${recetteId}`);
    // CARDINALITÉ (T6, lecture seule, NON bloquante) — à côté de `adrVigilances`.
    recette.cardinalite = await checkCardinality({ entityType: "recette", entityId: recetteId }).catch(() => null);
    return text(JSON.stringify({ recette }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === recette_session_set (alias legacy de cadrage_session_set) ===
server.registerTool("recette_session_set", {
  description: "Alias legacy de `cadrage_session_set`. Associe la session dédiée lancée à une recette et la passe en cours (in_progress).",
  inputSchema: { recetteId: z.string(), sessionId: z.string() },
}, async ({ recetteId, sessionId }) => {
  try {
    const recette = await setRecetteSession({ recetteId, sessionId });
    return text(JSON.stringify({ ok: true, recette }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === recette_doc_add (alias legacy de cadrage_doc_add) ===
server.registerTool("recette_doc_add", {
  description: "Alias legacy de `cadrage_doc_add`. Rattache un document à une recette (importé ou artefact existant) avec la nature de la liaison (à quoi sert / comment l'exploiter).",
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

// === recette_doc_remove (alias legacy de cadrage_doc_remove) ===
server.registerTool("recette_doc_remove", {
  description: "Alias legacy de `cadrage_doc_remove`. Retire un document d'une recette.",
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

// === recette_link_task (alias legacy de cadrage_link_task) ===
server.registerTool("recette_link_task", {
  description: "Alias legacy de `cadrage_link_task`. Rattache une tâche à une recette (tâche couverte). Garde : la tâche doit appartenir au PROJET de la recette (1 recette = 1 projet ; les repos transverses du projet sont la portée).",
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

// === recette_unlink_task (alias legacy de cadrage_unlink_task) ===
server.registerTool("recette_unlink_task", {
  description: "Alias legacy de `cadrage_unlink_task`. Détache une tâche d'une recette (la tâche reste historiquement intacte, juste plus couverte).",
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

// === recette_item_add (alias legacy de cadrage_item_add) ===
server.registerTool("recette_item_add", {
  description: "Alias legacy de `cadrage_item_add`. Enregistre un élément détecté pendant la recette (remarque, demande, constat, problème) avec sa classification (rework|bug|improvement|feature), son projet cible (= projet unique de la recette — les repos transverses sont des repos, pas des projets), le périmètre (scope) suggéré et, si le constat implique de faire évoluer des TESTS et/ou des DOCUMENTS de référence du projet, une intention structurée (testIntent / docIntent).",
  inputSchema: {
    recetteId: z.string(),
    content: z.string().describe("La remarque / demande / constat."),
    classification: z.enum(["rework", "bug", "improvement", "feature"]).optional().describe("Nature de l'élément (défaut rework)."),
    project: z.string().optional().describe("Projet cible de l'élément (= projet unique de la recette ; fourni par défaut, ignoré sinon). Les repos transverses du projet ne sont pas des projets."),
    discussion: z.string().optional().describe("Échanges associés."),
    scope: z.array(z.string()).optional().describe("Périmètre suggéré (chemins) — transmis à la tâche créée à la confirmation."),
    title: z.string().optional().describe("Titre court de la tâche qui sera créée à la confirmation."),
    acceptance: z.string().optional().describe("Critère d'acceptation / livrable attendu de la tâche qui sera créée."),
    execOrder: z.number().int().optional().describe("Ordre d'exécution recommandé (même numéro = exécutable en parallèle)."),
    vigilance: z.string().optional().describe("Point de vigilance / écart sémantique détecté pour cet élément."),
    testIntent: z.object({
      action: z.enum(["create", "update", "obsolete"]).describe("Action sur le(s) test(s) : create (nouveau test pour le comportement voulu/bug) | update (adapter un test existant) | obsolete (test devenu obsolète)."),
      testType: z.enum(["unit", "e2e"]).optional().describe("Type de test concerné : unit (unitaire, dans le repo) | e2e (entité E2E Playwright). Défaut unit."),
      target: z.string().optional().describe("Cible : e2eTestId, specFile (E2E) ou chemin du test unitaire (ex. tests/mon-test.spec.ts)."),
      scenario: z.string().optional().describe("Scénario / comportement à couvrir ou à vérifier."),
      reason: z.string().optional().describe("Pourquoi ce besoin test (bug non couvert, comportement changé, test obsolète…)."),
    }).optional().describe("Intention test structurée — à renseigner quand le constat requiert d'ajouter/modifier/obsoléter un test du projet pour couvrir le comportement voulu ou le bug détecté."),
    docIntent: z.object({
      action: z.enum(["create", "update", "obsolete"]).describe("Action sur le(s) document(s) de référence : update (mettre à jour) | create (documenter une règle nouvelle) | obsolete (document devenu obsolète)."),
      docType: z.enum(["adr-tech", "specs-fonctionnelles", "scenarios-gherkin"]).optional().describe("Type de document concerné (ADR-12) : adr-tech (architecture technique) | specs-fonctionnelles (User stories/règles métier) | scenarios-gherkin (scénarios BDD)."),
      target: z.string().optional().describe("Cible : docId ou chemin du document à faire évoluer."),
      summary: z.string().optional().describe("Ce que le document doit refléter après la recette."),
      reason: z.string().optional().describe("Pourquoi ce besoin doc (la recette rend un document inexact/obsolète, ou une règle doit être documentée)."),
    }).optional().describe("Intention document structurée — à renseigner quand une décision de recette impose de mettre à jour/créer/obsoléter un document de référence du projet (ADR technique, specs fonctionnelles, scénarios Gherkin)."),
  },
}, async ({ recetteId, project, content, classification, discussion, scope, title, acceptance, execOrder, vigilance, testIntent, docIntent }) => {
  try {
    const item = await addRecetteItem({ recetteId, project, content, classification, discussion, scope, title, acceptance, execOrder, vigilance, testIntent, docIntent });
    return text(JSON.stringify({ ok: true, item }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === recette_item_update (alias legacy de cadrage_item_update) ===
server.registerTool("recette_item_update", {
  description: "Alias legacy de `cadrage_item_update`. Met à jour un élément de recette (contenu, classification, discussion, scope, projet cible, titre, critère d'acceptation, ordre, vigilance, intentions test/document, statut, tâche créée).",
  inputSchema: {
    itemId: z.number().int(),
    content: z.string().optional().describe("Contenu de l'élément (remarque/demande/constat) — non vide si fourni."),
    classification: z.enum(["rework", "bug", "improvement", "feature"]).optional(),
    discussion: z.string().optional(),
    scope: z.array(z.string()).optional().describe("Périmètre suggéré (chemins)."),
    project: z.string().optional().describe("Projet cible de l'élément."),
    title: z.string().optional(),
    acceptance: z.string().optional(),
    execOrder: z.number().int().optional().describe("Ordre d'exécution recommandé (même numéro = parallèle)."),
    vigilance: z.string().optional().describe("Point de vigilance / écart sémantique."),
    testIntent: z.object({
      action: z.enum(["create", "update", "obsolete"]),
      testType: z.enum(["unit", "e2e"]).optional(),
      target: z.string().optional(),
      scenario: z.string().optional(),
      reason: z.string().optional(),
    }).optional().describe("Intention test structurée (remplace l'existante ; null/absent ne la change pas)."),
    docIntent: z.object({
      action: z.enum(["create", "update", "obsolete"]),
      docType: z.enum(["adr-tech", "specs-fonctionnelles", "scenarios-gherkin"]).optional(),
      target: z.string().optional(),
      summary: z.string().optional(),
      reason: z.string().optional(),
    }).optional().describe("Intention document structurée (remplace l'existante ; null/absent ne la change pas)."),
    status: z.enum(["open", "task_created"]).optional(),
    createdTaskId: z.string().optional(),
  },
}, async ({ itemId, content, classification, discussion, scope, project, title, acceptance, execOrder, vigilance, testIntent, docIntent, status, createdTaskId }) => {
  try {
    const item = await updateRecetteItem({ itemId, content, classification, discussion, scope, project, title, acceptance, execOrder, vigilance, testIntent, docIntent, status, createdTaskId });
    return text(JSON.stringify({ ok: true, item }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});


// === recette_item_delete (alias legacy de cadrage_item_delete) ===
server.registerTool("recette_item_delete", {
  description: "Alias legacy de `cadrage_item_delete`. Supprime un élément de recette (remarque/demande/constat). Refus si une tâche a déjà été créée depuis cet élément (task_created).",
  inputSchema: { itemId: z.number().int() },
}, async ({ itemId }) => {
  try {
    const r = await deleteRecetteItem({ itemId });
    return text(JSON.stringify({ ok: true, ...r }, null, 2));
  } catch (e) { return err(e.message); }
});

// === recette_confirm (alias legacy de cadrage_confirm) ===
server.registerTool("recette_confirm", {
  description: "Alias legacy de `cadrage_confirm`. Clôt la recette (statut 'done' = faite) après confirmation de la liste consolidée. La tâche initiale reste done et close ; les travaux issus sont de nouvelles tâches. GARDE ADR : REFUSÉ avec raison explicite (« ADR manquant pour [entité] » / « Conflit d'ADR : [ancienne] vs [nouvelle] ») tant qu'un point de vigilance ADR (ADR manquante / conflit) est OUVERT sur la recette — levez-le via `adr_vigilance_resolve` (raison tracée).",
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

// ===========================================================================
// Famille ÉVALUATION (T-20260922-100650-sbc1) — « Recette » de l'ÉVALUATEUR
// PRODUIT. Objet de 1er niveau DISTINCT de `recettes`/`cadrage_*` (Cadrage
// technique exécuteur). L'évaluateur décrit le PARCOURS ÉVALUÉ, rattache 1..N
// fonctionnalités (verdict porté par le lien) + 1..N règles métier, enregistre
// des ÉLÉMENTS (recommandation | problème) et joint des PIÈCES. Cycle de vie :
// pending → in_progress → done. AUCUNE conversion en tâches.
// ===========================================================================

server.registerTool("evaluation_start", {
  description: "Crée une ÉVALUATION (« Recette » de l'évaluateur produit) : 1 évaluation = 1 PROJET unique + titre + description du PARCOURS ÉVALUÉ + 1..N fonctionnalités + 1..N règles métier (liens posés à la création, NON bloquants). `createdBy` est indispensable au filtre propriétaire (l'évaluateur ne voit que SES recettes). Statut initial 'pending'. AUCUNE conversion en tâches.",
  inputSchema: {
    project: z.string().describe("Projet (produit) de l'évaluation."),
    title: z.string().optional().describe("Titre court (dérivé si absent)."),
    description: z.string().optional().describe("Description du PARCOURS ÉVALUÉ."),
    featureIds: z.array(z.string()).optional().describe("Fonctionnalités évaluées (1..N)."),
    ruleIds: z.array(z.string()).optional().describe("Règles métier évaluées (1..N)."),
    createdBy: z.string().optional().describe("Utilisateur (username) évaluateur propriétaire."),
    organizationId: z.string().optional().describe("Organisation (tenant). Défaut : celle du projet."),
  },
}, async ({ project, title, description, featureIds, ruleIds, createdBy, organizationId }) => {
  try {
    const evaluation = await startEvaluation({ project, title, description, featureIds, ruleIds, createdBy, organizationId });
    return text(JSON.stringify({ ok: true, evaluation }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("evaluation_list", {
  description: "Liste les évaluations (« Recettes » évaluateur) d'un projet (ou toutes) avec nb d'éléments / fonctionnalités / règles.",
  inputSchema: { project: z.string().optional().describe("Projet (produit) — sinon toutes.") },
}, async ({ project }) => {
  try {
    const evaluations = await listProjectEvaluations(project);
    return text(JSON.stringify({ count: evaluations.length, evaluations }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("evaluation_get", {
  description: "Détail d'une évaluation : parcours évalué, statut, éléments (recommandation/problème) avec leur DÉCISION ADMIN (pending|a_traiter|non_retenu), leur statut de suivi, leurs PIÈCES (`documents[]`) et leur traçage `reprisPar[]` (« repris par le cadrage X »), fonctionnalités avec VERDICT, règles métier, pièces jointes.",
  inputSchema: { evaluationId: z.string().describe("Identifiant EVAL-<ts>-<rand>.") },
}, async ({ evaluationId }) => {
  try {
    const evaluation = await getEvaluationById(evaluationId);
    if (!evaluation) return err(`évaluation inconnue : ${evaluationId}`);
    return text(JSON.stringify({ evaluation }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("evaluation_item_add", {
  description: "Enregistre un ÉLÉMENT d'évaluation : une RECOMMANDATION ou un PROBLÈME (catégorie), avec sa SÉVÉRITÉ et une discussion libre. Statut de suivi initial 'open'.",
  inputSchema: {
    evaluationId: z.string(),
    content: z.string().describe("La recommandation / le problème."),
    category: z.enum(EVALUATION_ITEM_CATEGORIES).optional().describe("Nature (défaut recommandation)."),
    severity: z.enum(EVALUATION_ITEM_SEVERITIES).optional().describe("Sévérité (défaut medium)."),
    discussion: z.string().optional().describe("Échanges associés."),
  },
}, async ({ evaluationId, content, category, severity, discussion }) => {
  try {
    const item = await addEvaluationItem({ evaluationId, content, category, severity, discussion });
    return text(JSON.stringify({ ok: true, item }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("evaluation_item_update", {
  description: "Met à jour un élément d'évaluation (contenu, catégorie, sévérité, discussion, statut de suivi open|treated|dismissed). La DÉCISION ADMIN « à traiter » (pending|a_traiter|non_retenu) n'est PAS modifiable ici : utiliser `evaluation_item_decision`.",
  inputSchema: {
    itemId: z.number().int(),
    content: z.string().optional(),
    category: z.enum(EVALUATION_ITEM_CATEGORIES).optional(),
    severity: z.enum(EVALUATION_ITEM_SEVERITIES).optional(),
    discussion: z.string().optional(),
    status: z.enum(EVALUATION_ITEM_STATUSES).optional(),
  },
}, async ({ itemId, content, category, severity, discussion, status }) => {
  try {
    const item = await updateEvaluationItem({ itemId, content, category, severity, discussion, status });
    return text(JSON.stringify({ ok: true, item }, null, 2));
  } catch (e) { return err(e.message); }
});

// === evaluation_item_decision (décision ADMIN « à traiter ») ===
server.registerTool("evaluation_item_decision", {
  description: "DÉCISION ADMIN d'un élément de recette évaluateur : `pending` (non décidé) | `a_traiter` | `non_retenu`. DISTINCTE du statut de suivi. Seuls les éléments `a_traiter` sont accessibles à l'exécuteur (contexte de cadrage).",
  inputSchema: {
    itemId: z.number().int(),
    decision: z.enum(EVALUATION_ITEM_DECISIONS).describe("pending | a_traiter | non_retenu."),
    by: z.string().optional().describe("Auteur de la décision (admin)."),
  },
}, async ({ itemId, decision, by }) => {
  try {
    const item = await setEvaluationItemDecision({ itemId, decision, by });
    return text(JSON.stringify({ ok: true, item }, null, 2));
  } catch (e) { return err(e.message); }
});

// === evaluation_items_treatable (contexte de sélection de l'exécuteur) ===
server.registerTool("evaluation_items_treatable", {
  description: "Liste les ÉLÉMENTS DE RECETTE ÉVALUATEUR « à traiter » (décision admin = `a_traiter`), seuls accessibles à l'exécuteur comme entrée de contexte d'un cadrage technique. Inclut le traçage `reprisPar` (cadrage(s) ayant repris l'élément).",
  inputSchema: { project: z.string().optional().describe("Projet (produit) — sinon tous.") },
}, async ({ project }) => {
  try {
    const items = await listTreatableEvaluationItems({ project });
    return text(JSON.stringify({ count: items.length, items }, null, 2));
  } catch (e) { return err(e.message); }
});

// === cadrage_evaluation_item_* (reprise d'un élément par un cadrage) ===
server.registerTool("cadrage_evaluation_item_link", {
  description: "Reprend un ÉLÉMENT DE RECETTE ÉVALUATEUR dans un CADRAGE technique (lien additif, traçage « repris par le cadrage X »). GARDE : refuse un élément dont la décision admin n'est pas `a_traiter`.",
  inputSchema: { cadrageId: z.string().describe("Cadrage technique (recette)."), itemId: z.number().int().describe("Élément d'évaluation.") },
}, async ({ cadrageId, itemId }) => {
  try {
    const r = await linkCadrageEvaluationItem({ recetteId: cadrageId, itemId });
    return text(JSON.stringify({ ok: true, ...r }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("cadrage_evaluation_item_unlink", {
  description: "Détache un ÉLÉMENT DE RECETTE ÉVALUATEUR d'un CADRAGE technique (fin de la reprise « repris par le cadrage X »).",
  inputSchema: { cadrageId: z.string(), itemId: z.number().int() },
}, async ({ cadrageId, itemId }) => {
  try {
    const r = await unlinkCadrageEvaluationItem({ recetteId: cadrageId, itemId });
    return text(JSON.stringify({ ok: true, ...r }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("cadrage_evaluation_item_list", {
  description: "Liste les ÉLÉMENTS DE RECETTE ÉVALUATEUR repris par un CADRAGE technique (traçage « repris par le cadrage X »).",
  inputSchema: { cadrageId: z.string() },
}, async ({ cadrageId }) => {
  try {
    const items = await listCadrageEvaluationItems({ recetteId: cadrageId });
    return text(JSON.stringify({ count: items.length, items }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("evaluation_item_delete", {
  description: "Supprime un élément d'évaluation (recommandation/problème).",
  inputSchema: { itemId: z.number().int() },
}, async ({ itemId }) => {
  try {
    const r = await deleteEvaluationItem({ itemId });
    return text(JSON.stringify({ ok: true, ...r }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("evaluation_feature_link", {
  description: "Rattache une FONCTIONNALITÉ à une évaluation (idempotent). Le VERDICT est porté par le lien (`verdict` optionnel).",
  inputSchema: {
    evaluationId: z.string(),
    featureId: z.string().describe("Fonctionnalité."),
    verdict: z.enum(EVALUATION_VERDICTS).optional().describe("Verdict (conforme|non_conforme|a_ameliorer)."),
    verdictComment: z.string().optional().describe("Commentaire du verdict."),
  },
}, async ({ evaluationId, featureId, verdict, verdictComment }) => {
  try {
    const r = await linkEvaluationFeature({ evaluationId, featureId, verdict, verdictComment });
    return text(JSON.stringify({ ok: true, ...r }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("evaluation_feature_unlink", {
  description: "Détache une FONCTIONNALITÉ d'une évaluation.",
  inputSchema: { evaluationId: z.string(), featureId: z.string() },
}, async ({ evaluationId, featureId }) => {
  try {
    const r = await unlinkEvaluationFeature({ evaluationId, featureId });
    return text(JSON.stringify({ ok: true, ...r }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("evaluation_rule_link", {
  description: "Rattache une RÈGLE MÉTIER à une évaluation (idempotent).",
  inputSchema: { evaluationId: z.string(), ruleId: z.string().describe("Règle métier.") },
}, async ({ evaluationId, ruleId }) => {
  try {
    const r = await linkEvaluationRule({ evaluationId, ruleId });
    return text(JSON.stringify({ ok: true, ...r }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("evaluation_rule_unlink", {
  description: "Détache une RÈGLE MÉTIER d'une évaluation.",
  inputSchema: { evaluationId: z.string(), ruleId: z.string() },
}, async ({ evaluationId, ruleId }) => {
  try {
    const r = await unlinkEvaluationRule({ evaluationId, ruleId });
    return text(JSON.stringify({ ok: true, ...r }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("evaluation_verdict_set", {
  description: "Positionne le VERDICT d'une fonctionnalité DÉJÀ rattachée à l'évaluation (conforme|non_conforme|a_ameliorer).",
  inputSchema: {
    evaluationId: z.string(),
    fonctionnaliteId: z.string().describe("Fonctionnalité rattachée."),
    verdict: z.enum(EVALUATION_VERDICTS).optional().describe("Verdict (null pour effacer)."),
    verdictComment: z.string().optional(),
  },
}, async ({ evaluationId, fonctionnaliteId, verdict, verdictComment }) => {
  try {
    const r = await setEvaluationVerdict({ evaluationId, fonctionnaliteId, verdict, verdictComment });
    return text(JSON.stringify({ ok: true, ...r }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("evaluation_doc_add", {
  description: "Rattache une PIÈCE à une évaluation (lien / document / photo / vidéo) : `nature` libre + `source` (import d'un chemin, ou artifact existant) + `path`/`artifactId`. `itemId` optionnel rattache la pièce à un ÉLÉMENT précis (sinon pièce au niveau de l'évaluation). Famille isolée (`doc_type='evaluation_doc'`).",
  inputSchema: {
    evaluationId: z.string(),
    title: z.string().optional(),
    nature: z.string().optional().describe("Nature : lien | document | photo | video."),
    source: z.enum(["import", "artifact"]).default("import"),
    path: z.string().optional().describe("Chemin / URL de la pièce (mode import)."),
    artifactId: z.string().optional().describe("Artefact existant à lier (mode artifact)."),
    itemId: z.number().int().optional().describe("Élément d'évaluation porteur de la pièce (optionnel)."),
  },
}, async ({ evaluationId, title, nature, source, path, artifactId, itemId }) => {
  try {
    let finalPath = path;
    if (source === "artifact") {
      if (!artifactId) return err("artifactId requis en mode artifact");
      const a = await getArtifact(artifactId);
      if (!a) return err(`artefact inconnu : ${artifactId}`);
      finalPath = a.path;
    }
    const documents = await addEvaluationDocument({ evaluationId, title, nature, source, path: finalPath, artifactId: source === "artifact" ? artifactId : null, itemId });
    return text(JSON.stringify({ ok: true, documents }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("evaluation_doc_remove", {
  description: "Retire une PIÈCE d'une évaluation.",
  inputSchema: { documentId: z.number().int() },
}, async ({ documentId }) => {
  try {
    const evaluationId = await removeEvaluationDocument(documentId);
    if (!evaluationId) return err(`document inconnu : ${documentId}`);
    return text(JSON.stringify({ ok: true, evaluationId, documents: await listEvaluationDocuments(evaluationId) }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("evaluation_confirm", {
  description: "Clôt une évaluation (statut 'done') SANS convertir en tâches. Les éléments restent attachés à l'évaluation.",
  inputSchema: { evaluationId: z.string(), confirmedBy: z.string().optional() },
}, async ({ evaluationId, confirmedBy }) => {
  try {
    const evaluation = await confirmEvaluation({ evaluationId, confirmedBy });
    return text(JSON.stringify({ ok: true, evaluation }, null, 2));
  } catch (e) { return err(e.message); }
});

// === batch (v0.9.0) : orchestration multi-tâches — une session, N tâches ===
// Phase 1 : lecture + enregistrement (aucun auto-avancement). Readiness et
// matrice de conflit fichiers sont CALCULÉES à la volée.
server.registerTool("batch_register", {
  description: "Enregistre un batch d'orchestration : groupe de tâches pilotées par une session d'orchestration unique. Source naturelle = recette (recetteId) ou ad-hoc. maxParallel = plafond d'écrivains simultanés (défaut 2). launchMode : batch (le worker batch-pilot lance les tâches automatiquement) | session (une session orchestrateur unique pilote le batch) | manual (aucun auto-lancement — l'utilisateur lance chaque tâche).",
  inputSchema: {
    project: z.string().describe("Projet (produit) cible du batch."),
    title: z.string().describe("Titre court du batch."),
    recetteId: z.string().optional().describe("Recette source (si le batch regroupe les tâches d'une recette)."),
    taskIds: z.array(z.string()).optional().describe("Tâches du batch (0..N)."),
    maxParallel: z.number().int().min(1).max(8).optional().describe("Plafond d'écrivains simultanés (défaut 2)."),
    launchMode: z.enum(["batch", "session", "manual"]).optional().describe("Mode de lancement (défaut batch)."),
    sessionId: z.string().optional().describe("Session d'orchestration unique (rattachée après lancement)."),
    createdBy: z.string().optional(),
  },
}, async ({ project, title, recetteId, taskIds, maxParallel, launchMode, sessionId, createdBy }) => {
  try {
    const batch = await createBatch({ project, title, recetteId, taskIds, maxParallel: maxParallel || 2, launchMode: launchMode || "batch", sessionId: sessionId || null, createdBy });
    return text(JSON.stringify({ ok: true, batch }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

server.registerTool("batch_set_launch_mode", {
  description: "Change le mode de lancement d'un batch : batch (worker auto) | session (session unique) | manual (aucun auto).",
  inputSchema: { batchId: z.string(), launchMode: z.enum(["batch", "session", "manual"]) },
}, async ({ batchId, launchMode }) => {
  try {
    const batch = await setBatchLaunchMode(batchId, launchMode);
    return text(JSON.stringify({ ok: true, batch }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

server.registerTool("batch_get", {
  description: "Détail d'un batch : tâches, readiness (qui est prêt/bloqué/en cours) et matrice de conflit fichiers (tâches qui se chevauchent).",
  inputSchema: { batchId: z.string() },
}, async ({ batchId }) => {
  try {
    const batch = await getBatch(batchId);
    if (!batch) return err(`batch inconnu : ${batchId}`);
    return text(JSON.stringify({ batch }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

server.registerTool("batch_list", {
  description: "Liste les batches (tous ou filtrés par projet).",
  inputSchema: { project: z.string().optional() },
}, async ({ project }) => {
  try {
    const batches = await listBatches(project);
    return text(JSON.stringify({ count: batches.length, batches }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

server.registerTool("batch_add_task", {
  description: "Ajoute une tâche à un batch.",
  inputSchema: { batchId: z.string(), taskId: z.string() },
}, async ({ batchId, taskId }) => {
  try {
    const batch = await addBatchTask(batchId, taskId);
    return text(JSON.stringify({ ok: true, batch }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

server.registerTool("batch_remove_task", {
  description: "Retire une tâche d'un batch.",
  inputSchema: { batchId: z.string(), taskId: z.string() },
}, async ({ batchId, taskId }) => {
  try {
    const batch = await removeBatchTask(batchId, taskId);
    return text(JSON.stringify({ ok: true, batch }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

server.registerTool("batch_set_session", {
  description: "Rattache (ou retire) la session d'orchestration unique d'un batch.",
  inputSchema: { batchId: z.string(), sessionId: z.string().optional() },
}, async ({ batchId, sessionId }) => {
  try {
    const batch = await setBatchSession(batchId, sessionId || null);
    return text(JSON.stringify({ ok: true, batch }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

server.registerTool("batch_set_status", {
  description: "Change le statut d'un batch : active | completed | aborted.",
  inputSchema: { batchId: z.string(), status: z.enum(["active", "completed", "aborted"]) },
}, async ({ batchId, status }) => {
  try {
    const batch = await setBatchStatus(batchId, status);
    return text(JSON.stringify({ ok: true, batch }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

server.registerTool("batch_readiness", {
  description: "Readiness d'un batch (Phase 3 — granularité ÉTAPE) : pour chaque tâche — active/done, dépendances non satisfaites, étapes todo bloquées par une étape d'une autre tâche (blockedSteps), tâches interleavables, et « ready » (prêt à lancer : deps satisfaites + aucune étape bloquée).",
  inputSchema: { batchId: z.string() },
}, async ({ batchId }) => {
  try {
    const readiness = await batchReadiness(batchId);
    return text(JSON.stringify({ batchId, readiness }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

server.registerTool("batch_conflict_matrix", {
  description: "Matrice de conflit fichiers d'un batch (Phase 3 — granularité ÉTAPE) : paires de tâches dont des ÉTAPES de plan se chevauchent sur des fichiers (déclarés par étape + réels via commits). Une paire sans conflit d'étape est interleavable.",
  inputSchema: { batchId: z.string() },
}, async ({ batchId }) => {
  try {
    const matrix = await batchConflictMatrix(batchId);
    return text(JSON.stringify({ batchId, conflictMatrix: matrix }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === organisations (v0.9.47) — tenant de premier niveau ======================
server.registerTool("org_register", {
  description: "Enregistre (ou met à jour) une ORGANISATION (tenant) : id (slug), nom, description. Les entités de 1er niveau (projets, repos, tâches, recettes, tests, docs, artefacts) portent organization_id.",
  inputSchema: {
    id: z.string().describe("Identifiant/slug de l'organisation (ex. onirtech)."),
    name: z.string().describe("Nom lisible (ex. ONIRTECH)."),
    description: z.string().optional().describe("Description de l'organisation."),
    isDefault: z.boolean().optional().describe("Définir cette organisation comme organisation par défaut (seule à configurer l'écosystème)."),
    coderUrl: z.string().optional().describe("URL du serveur Coder de l'organisation (ex. https://ide.madatalk.fr)."),
    coderToken: z.string().optional().describe("Token d'accès Coder (stocké CHIFFRÉ, jamais renvoyé). Absent = inchangé."),
    coderTemplate: z.string().optional().describe("Nom du template Coder utilisé pour créer les workspaces."),
    gitToken: z.string().optional().describe("Token git (PAT) pour clone/pull/push (stocké CHIFFRÉ, jamais renvoyé). Absent = inchangé."),
    createdBy: z.string().optional(),
  },
}, async ({ id, name, description, isDefault, coderUrl, coderToken, coderTemplate, gitToken, createdBy }) => {
  try {
    const organization = await registerOrganization({ id, name, description, isDefault, coderUrl, coderToken, coderTemplate, gitToken, createdBy });
    return text(JSON.stringify({ ok: true, organization }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

server.registerTool("org_set_default", {
  description: "Définit l'organisation PAR DÉFAUT (une seule) : seule autorisée à configurer l'écosystème.",
  inputSchema: { id: z.string() },
}, async ({ id }) => {
  try {
    const organization = await setDefaultOrganization(id);
    return text(JSON.stringify({ ok: true, organization }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

server.registerTool("org_list", {
  description: "Liste les organisations enregistrées.",
  inputSchema: {},
}, async () => {
  try {
    const organizations = await listOrganizations();
    return text(JSON.stringify({ count: organizations.length, organizations }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

server.registerTool("org_get", {
  description: "Détail d'une organisation (id, nom, description).",
  inputSchema: { id: z.string() },
}, async ({ id }) => {
  try {
    const organization = await getOrganization(id);
    if (!organization) return err(`organisation inconnue : ${id}`);
    return text(JSON.stringify({ organization }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

server.registerTool("org_delete", {
  description: "Supprime une organisation (refusé si des projets y sont rattachés).",
  inputSchema: { id: z.string() },
}, async ({ id }) => {
  try {
    const r = await deleteOrganization(id);
    return text(JSON.stringify({ ok: true, ...r }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === tokens git multiples par organisation (v0.10) ============================
server.registerTool("org_git_token_add", {
  description: "Ajoute un token git (PAT) à une organisation — plusieurs tokens possibles par organisation. Le token à utiliser pour un repo associé à un projet est choisi lors de project_repo_link (gitTokenId). Stocké CHIFFRÉ, jamais renvoyé en clair.",
  inputSchema: {
    org: z.string().describe("Identifiant de l'organisation (tenant)."),
    name: z.string().describe("Libellé lisible (ex: 'PAT GitHub Rino', 'compte dev onirtech')."),
    token: z.string().describe("Token git (PAT) — stocké chiffré, jamais renvoyé."),
    createdBy: z.string().optional(),
  },
}, async ({ org, name, token, createdBy }) => {
  try {
    const t = await addOrgGitToken({ org, name, token, createdBy });
    return text(JSON.stringify({ ok: true, ...t }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

server.registerTool("org_git_token_list", {
  description: "Liste les tokens git d'une organisation (id + libellé uniquement — la valeur N'EST JAMAIS renvoyée).",
  inputSchema: { org: z.string().describe("Identifiant de l'organisation (tenant).") },
}, async ({ org }) => {
  try {
    const tokens = await listOrgGitTokens(org);
    return text(JSON.stringify({ org, count: tokens.length, tokens }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

server.registerTool("org_git_token_delete", {
  description: "Supprime un token git d'une organisation. Les liaisons repo↔projet qui le référençaient repassent au token par défaut de l'organisation.",
  inputSchema: {
    id: z.string().describe("Identifiant du token (gt_…)."),
    org: z.string().describe("Identifiant de l'organisation (tenant)."),
  },
}, async ({ id, org }) => {
  try {
    return text(JSON.stringify({ ok: true, ...(await deleteOrgGitToken({ id, org })) }, null, 2));
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
    repoIds: z.array(z.string()).optional().describe("Repos ciblés (défaut si absent : inchangé)."),
  },
}, async ({ taskId, request, title, acceptanceCriteria, scope, priority, directExecution, linkedTasks, repoIds }) => {
  try {
    const task = await updateTask({ taskId, request, title, acceptanceCriteria, scope, priority, directExecution, linkedTasks, repoIds });
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
// Gestionnaire central polymorphe (T-20260920-162801-jxtr) : `docType` + `contentId`
// identifient l'entité porteuse (tâche/recette/projet/doc) ; `kind` = NATURE.
// Rétrocompat : `artifact_add(taskId, kind, path)` reste fonctionnel (docType
// dérivé de kind, contentId = taskId). Cf. `public/docs/nomenclature-doc-type.md`.
server.registerTool("artifact_add", {
  description:
    "Rattache un artefact (document/livrable) à une ENTITÉ porteuse via le couple (docType, contentId) — gestionnaire central polymorphe. docType : taxonomie (adr|specs|gherkin|project_doc|adr_file|plan|task_synthese|task_report|audit_report|recette_report|recette_doc|e2e_report|e2e_video|autre). kind = NATURE (plan|audit|report|autre). Rétrocompat : taskId seul + kind suffit (docType dérivé de kind, contentId = taskId). `path` = chemin absolu hôte lisible (téléchargement/visionneuse).",
  inputSchema: {
    taskId: z.string().optional().describe("Entité porteuse (rétrocompat famille task) — requis si docType ∈ famille task."),
    docType: z.enum(DOC_TYPES).optional().describe("Type d'artefact (défaut dérivé de kind : plan|audit_report|task_report|autre)."),
    contentId: z.string().optional().describe("Identifiant de l'entité porteuse (défaut = taskId)."),
    kind: z.enum(ARTIFACT_KINDS).describe("NATURE : plan | audit | report | autre."),
    title: z.string().optional().describe("Titre lisible (ex: Plan-echo-cancellation)."),
    path: z.string().describe("Chemin absolu (hôte) du fichier."),
    nature: z.string().optional().describe("Liaison libre (à quoi sert le document)."),
    source: z.enum(ARTIFACT_SOURCES).optional().describe("Origine : import | artifact | registry | ref (défaut import)."),
    meta: z.record(z.string(), z.any()).optional().describe("Métadonnées propres à la famille (JSON)."),
  },
}, async ({ taskId, docType, contentId, kind, title, path, nature, source, meta }) => {
  try {
    // Rétrocompat : garde audit (une tâche non-audit ne porte pas d'audit).
    if (taskId && kind === "audit") {
      const task = await getTask(taskId);
      if (!task) return err(`tâche inconnue : ${taskId}`);
      if (task.type !== "audit") {
        return err(`artefact d'audit refusé : la tâche ${taskId} est de type "${task.type}" (un audit n'est rattaché qu'à une tâche type="audit").`);
      }
    }
    const a = await addArtifact({ taskId, docType, contentId, kind, title, path, nature, source, meta });
    return text(JSON.stringify({ ok: true, artifact: a }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === artifact_list ===
server.registerTool("artifact_list", {
  description:
    "Liste les artefacts. Rétrocompat : `artifact_list(taskId)` renvoie les artefacts de la famille task (content_id = taskId). Filtres centraux : docType, contentId, kind, q (recherche titre/path).",
  inputSchema: {
    taskId: z.string().optional().describe("Rétrocompat : artefacts rattachés à cette tâche (famille task)."),
    docType: z.enum(DOC_TYPES).optional().describe("Filtre par type d'artefact."),
    contentId: z.string().optional().describe("Filtre par entité porteuse."),
    kind: z.enum(ARTIFACT_KINDS).optional().describe("Filtre par NATURE."),
    q: z.string().optional().describe("Recherche texte (titre/path)."),
    limit: z.number().int().optional().describe("Max (défaut 500)."),
  },
}, async ({ taskId, docType, contentId, kind, q, limit }) => {
  try {
    const artifacts = await listArtifacts({ taskId, docType, contentId, kind, q, limit });
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
server.registerTool("e2e_test_register", {
  description: "Enregistre (ou réactive) un test E2E comme entité de 1er niveau — 1 enregistrement par test() Playwright. project = PROJET (produit) dont le comportement est vérifié (ADR 11) ; repoIds = REPOS DE CODE associés au test (repos traversés par le comportement, le spec vit dans l'un d'eux — ex. ['mada-talk','oniria']) ; coveredProjects = rétrocompat (obsolète, préférer repoIds). gherkin = formalisation Gherkin du comportement (test-agent). Indépendant de toute tâche (l'association tâche se fait via e2e_test_link).",
  inputSchema: {
    project: z.string().describe("PROJET (produit) dont le comportement est vérifié (ex. mada-talk)."),
    specFile: z.string().describe("Chemin du spec file (ex: tests/e2e/auth/login.spec.ts)."),
    scenario: z.string().describe("Titre du test() Playwright."),
    title: z.string().optional().describe("Titre court / comportement couvert."),
    description: z.string().optional().describe("Description du comportement vérifié (demande libre, multi-repos éventuel)."),
    gherkin: z.string().optional().describe("Formalisation Gherkin (Given/When/Then) du comportement — produite par test-agent."),
    coveredProjects: z.array(z.string()).optional().describe("Rétrocompat (obsolète) : projets couverts — préférer repoIds."),
    repoIds: z.array(z.string()).optional().describe("REPOS DE CODE associés au test (repos traversés par le comportement, ex. ['mada-talk','oniria']). Le repo contenant le spec est inclus par défaut. Défaut si absent : repos du projet."),
    organizationId: z.string().optional().describe("Organisation (tenant). Défaut : celle du projet."),
    createdBy: z.string().optional().describe("Utilisateur (username) qui crée le test."),
  },
}, async ({ project, specFile, scenario, title, description, gherkin, coveredProjects, repoIds, organizationId, createdBy }) => {
  try {
    const t = await upsertE2ETest({ project, specFile, scenario, title, description, gherkin, coveredProjects, repoIds, organizationId, createdBy });
    return text(JSON.stringify({ ok: true, test: await getE2ETest(t.id) }, null, 2));
  } catch (e) { return err(e.message); }
});

// === e2e_test_update / get / obsolete ===
server.registerTool("e2e_test_update", {
  description: "Met à jour le titre/description/gherkin d'un test E2E et/ou ses REPOS DE CODE associés (repoIds — repos traversés par le comportement, ADR 11).",
  inputSchema: {
    e2eTestId: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    gherkin: z.string().optional(),
    coveredProjects: z.array(z.string()).optional().describe("Rétrocompat (obsolète) — préférer repoIds."),
    repoIds: z.array(z.string()).optional().describe("Remplace les REPOS DE CODE associés au test (repos traversés, ex. ['mada-talk','oniria'])."),
  },
}, async ({ e2eTestId, title, description, gherkin, coveredProjects, repoIds }) => {
  try {
    const t = await updateE2ETestMeta({ e2eTestId, title, description, gherkin, coveredProjects, repoIds });
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

server.registerTool("e2e_test_draft", {
  description: "Passe un test E2E en DRAFT (entité créée, spec en cours de rédaction via une session test-agent).",
  inputSchema: { e2eTestId: z.string() },
}, async ({ e2eTestId }) => {
  try {
    const t = await draftE2ETest(e2eTestId);
    return text(JSON.stringify({ ok: true, test: t }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("e2e_test_session_set", {
  description: "Rattache (ou retire, sessionId null) la session de création/mise à jour d'un test E2E (session test-agent). Le test affiche alors un bouton de reprise.",
  inputSchema: {
    e2eTestId: z.string(),
    sessionId: z.string().nullable().optional().describe("sessionId opencode (ses_…) à rattacher, ou null pour retirer."),
  },
}, async ({ e2eTestId, sessionId }) => {
  try {
    const t = await setE2ETestSession({ e2eTestId, sessionId: sessionId || null });
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
  description: "Associe un test E2E à une tâche (N:N pure association). relation_type : CREATED|UPDATED|REGRESSION|EXISTING|REQUIRED (+ reason). REQUIRED = la tâche doit être done pour que le test soit considéré PASS (contrat TDD/BDD, « bloqué par »). Le test reste indépendant.",
  inputSchema: {
    taskId: z.string(),
    e2eTestId: z.string(),
    relationType: z.enum(["CREATED", "UPDATED", "REGRESSION", "EXISTING", "REQUIRED"]).optional(),
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
    skipReason: z.string().optional().describe("Raison d'un SKIPPED (précondition de données manquante…)."),
    verdictBy: z.string().optional().describe("build-notify | human | agent-recette."),
    origin: z.enum(["task", "recette", "ci", "manual", "session"]).optional(),
    executedAt: z.string().optional(),
  },
}, async ({ executionId, status, durationMs, reportArtifactId, logsUrl, videoUrl, summary, skipReason, verdictBy, origin, executedAt }) => {
  try {
    const ex = await updateE2EExecution({ executionId, status, durationMs, reportArtifactId, logsUrl, videoUrl, summary, skipReason, verdictBy, origin, executedAt });
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
      // RAPPORT TEXTE RICHE (transcript horodaté) — copié depuis le .txt du runner.
      let logsUrl = null;
      let reportText = null;
      if (res.reportFile && existsSync(join(runDir, res.reportFile))) {
        const srcTxt = readFileSync(join(runDir, res.reportFile), "utf8");
        const destTxt = join(outDir, `report-${rec.id}.txt`);
        writeFileSync(destTxt, srcTxt);
        logsUrl = destTxt;
        reportText = srcTxt;
      }
      writeFileSync(reportPath, JSON.stringify({ runId, executionId: rec.id, e2eTestId, specFile: res.specFile, scenario: res.scenario, status: res.status, durationMs: res.durationMs, error: res.error || null, skipReason: res.skipReason || null, reportText: reportText ? reportText.slice(0, 60000) : null, attempts }, null, 2));
      if (!logsUrl) logsUrl = reportPath;
      let videoUrl = null;
      if (res.videoFile && existsSync(join(runDir, res.videoFile))) {
        const dest = join(outDir, `video-${rec.id}${extname(res.videoFile) || ".webm"}`);
        copyFileSync(join(runDir, res.videoFile), dest);
        videoUrl = dest;
      }
      let summary;
      if (reportText) {
        const keep = reportText.split("\n").filter((l) => l && !l.startsWith("[REPORT-TEXTE]") && !l.startsWith("[SCENARIO]") && !l.startsWith("[SPEC]"));
        summary = keep.slice(-14).join("\n");
        if (res.skipReason && !reportText.includes("[SKIPPED]")) summary += `\n[SKIPPED] ${res.skipReason}`;
      } else {
        summary = res.skipReason ? `SKIPPED : ${res.skipReason}` : (res.summary || (res.error ? `Échec : ${String(res.error).slice(0, 400)}` : `PASS ${res.scenario}`));
      }
      await updateE2EExecution({ executionId: rec.id, status: res.status || "ERROR", durationMs: res.durationMs || null, logsUrl, videoUrl, skipReason: res.skipReason || null, summary: summary.slice(0, 2000), verdictBy: "build-notify", executedAt: manifest.executedAt || new Date().toISOString() });
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

// --- Pré-vol E2E : spec absent du checkout → recherche git (solution long terme).
// Le run s'exécute dans un checkout hôte (souvent sur main) alors que le spec
// peut vivre sur une branche de travail non mergée. Au lieu d'un run vide
// muet, on LOCALISE le spec dans l'historique git (fetch + toutes branches) et
// on propose un worktree temporaire au commit choisi.

function gitExec(repoDir, args, opts = {}) {
  try {
    return execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8", ...opts }).trim();
  } catch { return null; }
}

// Liste les commits où le fichier EXISTE dans l'historique (création +
// modifications ultérieures, avant une éventuelle suppression), avec la branche
// la plus proche qui le contient. Cherche dans TOUT l'historique local
// (git log --all) : utile quand le spec a été purgé de main mais vit encore
// dans l'historique ou sur une branche non mergée fetchée.
// Renvoie [] si rien de récupérable, null si git indispo.
function locateSpecInGit(repoDir, specFile) {
  if (!existsSync(join(repoDir, ".git"))) return null;
  // Fetch best-effort (peut échouer sans credentials — on continue sinon).
  try { gitExec(repoDir, ["fetch", "origin", "--prune"], { timeout: 60 * 1000 }); } catch {}
  const log = (gitExec(repoDir, ["log", "--all", "--format=%H|%ad|%s", "--date=iso", "--", specFile]) || "");
  const lines = log.split("\n").filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const line of lines) {
    const [sha, date, ...rest] = line.split("|");
    const subject = rest.join("|");
    if (!sha || seen.has(sha)) continue;
    // Le fichier doit exister À CE COMMIT (cat-file -e sha:path).
    if (gitExec(repoDir, ["cat-file", "-e", `${sha}:${specFile}`]) === null) continue;
    seen.add(sha);
    // Branche(s) contenant ce commit — première distante sinon locale.
    const branches = (gitExec(repoDir, ["branch", "-a", "--contains", sha, "--format=%(refname:short)"]) || "")
      .split("\n").map((b) => b.trim()).filter((b) => b && b !== "HEAD");
    const branch = branches[0] || "historique";
    out.push({
      sha,
      short: sha.slice(0, 10),
      branch,
      branches: branches.slice(0, 3),
      date,
      subject: subject || "",
    });
    if (out.length >= 10) break;
  }
  return out;
}

// Crée un worktree temporaire détaché au commit donné (spec + helpers + config
// complets), partage node_modules du checkout d'origine quand les dépendances
// n'ont pas changé. Retourne le chemin du worktree.
function createRunWorktree(repoDir, sha, project) {
  const wtBase = "/root/test-E2E";
  try { mkdirSync(wtBase, { recursive: true }); } catch {}
  const wtDir = join(wtBase, `${project}-${Date.now().toString(36)}-${sha.slice(0, 7)}`);
  const add = gitExec(repoDir, ["worktree", "add", "--detach", wtDir, sha], { timeout: 60 * 1000 });
  if (add === null || !existsSync(wtDir)) {
    try { rmSync(wtDir, { recursive: true, force: true }); } catch {}
    throw new Error(`impossible de créer le worktree au commit ${sha.slice(0, 10)} — la branche est-elle fetchée ?`);
  }
  // Partage node_modules si le manifest des dépendances n'a pas changé au commit.
  const nmBase = join(repoDir, "node_modules");
  if (existsSync(nmBase) && !existsSync(join(wtDir, "node_modules"))) {
    const pkgChanged = gitExec(repoDir, ["diff", "--quiet", "HEAD", sha, "--", "package.json", "package-lock.json"]);
    try {
      if (pkgChanged === null) {
        // Commit == HEAD (pkg identique) : symlink sûr.
        try { symlinkSync(nmBase, join(wtDir, "node_modules")); } catch {}
      } else {
        try { symlinkSync(nmBase, join(wtDir, "node_modules")); } catch {}
      }
    } catch {}
  }
  return wtDir;
}

function removeRunWorktree(repoDir, wtDir) {
  if (!wtDir) return;
  try { gitExec(repoDir, ["worktree", "remove", "--force", wtDir]); } catch {}
  try { rmSync(wtDir, { recursive: true, force: true }); } catch {}
}

server.registerTool("e2e_run", {
  description: "Déclenche un run E2E Playwright sur un repo applicatif (cible externe déployée, ex. préprod) puis IMPORTE le résultat dans le registre. Le test est une entité de 1er niveau : passer e2eTestId (ou laisser specPattern pour un run libre). origin : task|recette|manual (défaut manual, task si taskId fourni). Le verdict lu par l'IA est le RAPPORT TEXTE ; la vidéo est une preuve humaine.",
  inputSchema: {
    project: z.string(),
    repoDir: z.string().optional().describe("Répertoire (hôte) du dépôt applicatif avec Playwright (ex: /root/mada-talk-preprod). Optionnel si e2eTestId fourni : e2e_run résout le repo d'exécution depuis les repos traversés du test (celui qui contient le spec)."),
    baseUrl: z.string().optional().describe("URL de la cible déployée (défaut : e2e.env E2E_BASE_URL)."),
    e2eTestId: z.string().optional().describe("Test (entité 1er niveau) à exécuter — résout specPattern + repos traversés + projets depuis le registre."),
    origin: z.enum(["task", "recette", "manual", "ci", "session"]).optional().describe("Origine du déclenchement."),
    taskId: z.string().optional().describe("Tâche origine à associer (et lier si non déjà liée)."),
    specPattern: z.string().optional().describe("Regex Playwright de filtre de spec à exécuter (positionnelle, transmise après '--' ; défaut : run complet de la config). Ex: madatalk-requests-(chatbot-cycle|support-interactions-kpi|pause-resiliation)\\\\.spec\\\\.ts"),
    playwrightConfig: z.string().optional(),
    pwArgs: z.array(z.string()).optional().describe("Arguments Playwright supplémentaires transmis après '--' (ex: ['--project=authenticated']). Sans collision avec 'project' (projet du REGISTRE oniria/mada-talk), ni avec 'playwrightConfig'."),
    paramValues: z.record(z.string(), z.string()).optional().describe("Surcharge des paramètres du test au run (ex. {'baseUrl':'…'} ; les défauts du test sont appliqués sinon)."),
    secretNames: z.array(z.string()).optional().describe("Noms des secrets E2E du projet à injecter au run (défaut : TOUS les secrets du projet). Les valeurs sont déchiffrées en interne et posées dans process.env du run — jamais persistées ni retournées."),
    runFromRef: z.string().optional().describe("Si le spec du test est ABSENT du repoDir (branche non mergée / checkout périmé) : ref git (branche distante 'origin/...' ou commit sha) depuis laquelle créer un WORKTREE temporaire et y exécuter le run. Le spec + helpers + config sont pris au commit. Sinon, sans cette option, e2e_run renvoie une erreur pré-vol listant les origines git du spec."),
  },
}, async ({ project, repoDir, baseUrl, taskId, origin, e2eTestId, specPattern, playwrightConfig, pwArgs, paramValues, secretNames, runFromRef }) => {
  try {
    const env = loadE2EEnv();
    if (!env.E2E_USER_EMAIL || !env.E2E_USER_PASSWORD) return err("identifiants E2E absents : renseigner " + E2E_ENV_FILE);
    // Si un test 1er niveau est donné, on résout specPattern + repos traversés.
    let resolvedProject = project;
    let pattern = specPattern;
    let paramOverrides = paramValues || {};
    let targetTest = null;
    if (e2eTestId) {
      targetTest = await getE2ETest(e2eTestId);
      if (!targetTest) return err(`test inconnu : ${e2eTestId}`);
      resolvedProject = targetTest.project;
      pattern = pattern || targetTest.specFile;
      for (const p of targetTest.params || []) {
        if (p.defaultValue && paramOverrides[p.name] === undefined) paramOverrides[p.name] = p.defaultValue;
      }
      // ADR 11 : repo d'exécution résolu depuis les repos traversés si repoDir absent.
      if (!repoDir) {
        const testRepos = (targetTest.repos || []).filter((r) => r && r.e2eRepoDir);
        const specRepo = testRepos.find((r) => {
          try { return existsSync(join(String(r.e2eRepoDir).trim(), String(targetTest.specFile).replace(/^\.\//, ""))); } catch { return false; }
        }) || testRepos[0];
        if (specRepo) repoDir = specRepo.e2eRepoDir;
      }
    }
    if (!repoDir || !existsSync(join(repoDir, "package.json"))) return err(`repoDir invalide ou sans package.json : ${repoDir || "(non résolu)"}`);
    // --- PRÉ-VOL (solution long terme « spec absent du checkout ») -----------
    // Le spec cible doit exister dans le repoDir où Playwright va s'exécuter.
    // S'il est absent (branche non mergée, checkout périmé) :
    //   - si runFromRef est fourni → worktree temporaire au commit et run là-bas ;
    //   - sinon → recherche git et erreur structurée listant les origines.
    let effectiveRepoDir = repoDir;
    let worktreeToClean = null;
    if (targetTest && targetTest.specFile) {
      const specAbsent = !existsSync(join(repoDir, targetTest.specFile));
      if (specAbsent) {
        if (runFromRef && String(runFromRef).trim()) {
          const ref = String(runFromRef).trim();
          const sha = gitExec(repoDir, ["rev-parse", "--verify", `${ref}^{commit}`]);
          if (!sha) return err(`ref introuvable pour le worktree : ${ref} (branche fetchée ?)`);
          try {
            effectiveRepoDir = createRunWorktree(repoDir, sha, resolvedProject);
            worktreeToClean = effectiveRepoDir;
            pattern = pattern || targetTest.specFile;
          } catch (e) { return err(`worktree impossible : ${e.message}`); }
        } else {
          // Recherche git des origines du spec (sans créer de worktree).
          const candidates = locateSpecInGit(repoDir, targetTest.specFile);
          if (candidates && candidates.length) {
            return err(JSON.stringify({
              code: "SPEC_NOT_IN_CHECKOUT",
              message: `Le spec « ${targetTest.specFile} » est absent du checkout ${repoDir} (HEAD=${(gitExec(repoDir, ["rev-parse", "--short", "HEAD"]) || "?")}). Il existe dans l'historique git — relancer avec runFromRef=<sha> pour créer un worktree temporaire et l'y exécuter.`,
              specFile: targetTest.specFile,
              repoDir,
              candidates,
            }));
          }
          if (candidates === null) {
            return err(`spec absent du checkout ${repoDir} et dépôt non git : ${targetTest.specFile}`);
          }
          return err(`spec absent du checkout ${repoDir} et introuvable dans l'historique git : ${targetTest.specFile}`);
        }
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
    // Injection des vars E2E du projet (module vars/secrets unifié) :
    //  - kind='variable'  : injectées AUTOMATIQUEMENT (défauts projet, en clair) ;
    //  - kind='secret'    : injectées si sélectionnées (secretNames ; défaut =
    //    toutes), valeurs déchiffrées en interne — jamais persistées.
    // L'ordre final : variables projet < surcharges paramValues < secrets.
    const projVars = await listE2EVars(resolvedProject);
    const secretNamesSet = projVars.filter((v) => v.kind === "secret").map((v) => v.name);
    const wantedSecrets = Array.isArray(secretNames) && secretNames.length
      ? secretNames.map((n) => String(n).trim()).filter(Boolean)
      : secretNamesSet;
    const injectedVars = [];
    const injectedSecrets = [];
    for (const v of projVars) {
      if (v.kind !== "variable") continue;
      if (runEnv[v.name] !== undefined) continue; // process.env prioritaire
      try {
        const val = await getE2EVarValue(v.project, v.name);
        if (val !== null) { runEnv[v.name] = val; injectedVars.push(v.name); }
      } catch {}
    }
    // Surcharges paramValues (UI) : s'appliquent par-dessus les variables projet,
    // mais JAMAIS sur une clé déclarée secret.
    for (const [k, v] of Object.entries(paramOverrides)) {
      if (k !== "baseUrl" && wantedSecrets.includes(k)) continue; // secret non surchargeable en clair
      runEnv[k] = String(v);
    }
    for (const v of projVars) {
      if (v.kind !== "secret") continue;
      if (!wantedSecrets.includes(v.name)) continue;
      try {
        const val = await getE2EVarValue(v.project, v.name);
        if (val !== null) { runEnv[v.name] = val; injectedSecrets.push(v.name); }
      } catch {}
    }
    execFileSync("node", args, { cwd: effectiveRepoDir, env: runEnv, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60 * 1000 });
    // Import automatique du run dans le registre.
    const runDir = join("/root/orchestrator-panel/storage/e2e/inbox", runId);
    const manifestPath = join(runDir, "manifest.json");
    if (!existsSync(manifestPath)) {
      try { if (worktreeToClean) removeRunWorktree(repoDir, worktreeToClean); } catch {}
      return err(`run exécuté mais manifest absent : ${manifestPath}`);
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    // Anti-fantôme : un placeholder « (aucun test exécuté) » (spec "—") n'est
    // PAS une entrée de test — on le saute toujours (défense vs vieux manifs).
    const realResults = (manifest.results || []).filter(
      (res) => res && res.specFile && res.scenario && res.specFile !== "—" && res.scenario !== "(aucun test exécuté)",
    );
    if (!realResults.length) {
      try { rmSync(runDir, { recursive: true, force: true }); } catch {}
      try { if (worktreeToClean) removeRunWorktree(repoDir, worktreeToClean); } catch {}
      const why = manifest.failedLaunch
        ? (manifest.launchError || "échec de lancement playwright")
        : (manifest.emptyFilter ? "aucun spec ne matche le filtre (filtre vide ou spec introuvable dans le checkout)" : "aucun résultat");
      // Run CIBLÉ (e2eTestId) : on enregistre une exécution ERROR sur le test
      // (le run a bien eu lieu mais n'a rien exécuté) — pas de nouvelle entité.
      if (e2eTestId) {
        const rec = await recordE2EExecution({ e2eTestId, origin: runOrigin, taskId, env: "external", commitSha: manifest.commitSha || null, branch: manifest.branch || null, attempts: manifest.attempts || 1 });
        await updateE2EExecution({ executionId: rec.id, status: "ERROR", summary: `Aucun test exécuté : ${why}`.slice(0, 2000), verdictBy: "build-notify", executedAt: manifest.executedAt || new Date().toISOString() });
        return err(`Aucun test exécuté (${why}). Exécution ERROR ${rec.id} tracée sur ${e2eTestId}.`);
      }
      return err(`Aucun test exécuté : ${why}`);
    }
    const imported = [];
    for (const res of realResults) {
      if (!res.specFile || !res.scenario) continue;
      // Run CIBLÉ (e2eTestId) : l'entité existe déjà (grain spec+scenario du
      // registre) — on y rattache l'exécution SANS créer de doublon (le spec_file
      // du runner peut être relatif ≠ chemin canonique du registre).
      let reg;
      if (e2eTestId && targetTest && res.scenario === targetTest.scenario) {
        reg = { id: targetTest.e2eTestId };
      } else if (e2eTestId && targetTest) {
        reg = await upsertE2ETest({ project: resolvedProject, specFile: targetTest.specFile, scenario: res.scenario, title: res.title, coveredProjects: null });
      } else {
        reg = await upsertE2ETest({ project: resolvedProject, specFile: res.specFile, scenario: res.scenario, title: res.title, coveredProjects: [resolvedProject] });
      }
      if (taskId) await linkTaskE2E({ taskId, e2eTestId: reg.id, relationType: res.relation || "REGRESSION", reason: res.reason || "Run déclenché par la recette/vérification" });
      const rec = await recordE2EExecution({ e2eTestId: reg.id, origin: runOrigin, taskId, env: "external", commitSha: manifest.commitSha || null, branch: manifest.branch || null, attempts: manifest.attempts || 1, paramValues: Object.keys(paramOverrides).length ? { ...paramOverrides, varsInjected: injectedVars.length ? injectedVars : undefined, secretsInjected: injectedSecrets.length ? injectedSecrets : undefined } : ((injectedVars.length || injectedSecrets.length) ? { varsInjected: injectedVars.length ? injectedVars : undefined, secretsInjected: injectedSecrets.length ? injectedSecrets : undefined } : null) });
      const outDir = join("/root/orchestrator-panel/storage/e2e/runs", runId);
      mkdirSync(outDir, { recursive: true });
      // RAPPORT TEXTE RICHE (transcript des étapes, horodaté) : le runner a écrit
      // un .txt par résultat (res.reportFile) quand le spec a posé l'attachment
      // « rapport-e2e-texte ». On le copie comme artefact de l'exécution. Le JSON
      // squelettique reste écrit en méta (rétrocompat), mais logsUrl → le .txt.
      let logsUrl = null;
      let reportText = null;
      if (res.reportFile && existsSync(join(runDir, res.reportFile))) {
        const srcTxt = readFileSync(join(runDir, res.reportFile), "utf8");
        const destTxt = join(outDir, `report-${rec.id}.txt`);
        writeFileSync(destTxt, srcTxt);
        logsUrl = destTxt;
        reportText = srcTxt;
      }
      const reportPath = join(outDir, `report-${rec.id}.json`);
      writeFileSync(reportPath, JSON.stringify({ runId, executionId: rec.id, e2eTestId: reg.id, specFile: res.specFile, scenario: res.scenario, status: res.status, durationMs: res.durationMs, error: res.error || null, skipReason: res.skipReason || null, reportText: reportText ? reportText.slice(0, 60000) : null, attempts: manifest.attempts || 1 }, null, 2));
      if (!logsUrl) logsUrl = reportPath;
      let videoUrl = null;
      if (res.videoFile && existsSync(join(runDir, res.videoFile))) {
        const dest = join(outDir, `video-${rec.id}${extname(res.videoFile) || ".webm"}`);
        copyFileSync(join(runDir, res.videoFile), dest);
        videoUrl = dest;
      }
      // Résumé riche : transcript réel quand dispo, sinon verdict dérivé.
      let summary;
      if (reportText) {
        const keep = reportText.split("\n").filter((l) => l && !l.startsWith("[REPORT-TEXTE]") && !l.startsWith("[SCENARIO]") && !l.startsWith("[SPEC]"));
        summary = keep.slice(-14).join("\n");
        if (res.skipReason && !reportText.includes("[SKIPPED]")) summary += `\n[SKIPPED] ${res.skipReason}`;
      } else {
        summary = res.skipReason ? `SKIPPED : ${res.skipReason}` : (res.summary || `Résultat ${res.status}`);
      }
      await updateE2EExecution({ executionId: rec.id, status: res.status || "ERROR", durationMs: res.durationMs || null, logsUrl, videoUrl, skipReason: res.skipReason || null, summary: summary.slice(0, 2000), verdictBy: "build-notify", executedAt: manifest.executedAt || new Date().toISOString() });
      imported.push({ e2eTestId: reg.id, executionId: rec.id, status: res.status || "ERROR", scenario: res.scenario, summary: (res.skipReason ? `SKIPPED : ${res.skipReason}` : res.summary || "").slice(0, 300) });
    }
    try { rmSync(runDir, { recursive: true, force: true }); } catch {}
    try { if (worktreeToClean) removeRunWorktree(repoDir, worktreeToClean); } catch {}
    return text(JSON.stringify({ ok: true, runId, origin: runOrigin, count: imported.length, varsInjected: injectedVars, secretsInjected: injectedSecrets, worktreeUsed: worktreeToClean ? true : false, results: imported }, null, 2));
  } catch (e) {
    try { if (worktreeToClean) removeRunWorktree(repoDir, worktreeToClean); } catch {}
    return err(e.message);
  }
});

// === e2e_sync_repo (T10 : synchronisation automatique registre ↔ repo) ===
// Reflet du repo dans le registre : scan des spec files Playwright, création/
// réactivation des tests présents, passage OBSOLETE des tests disparus.
// Le registre reste la source pour l'historique (jamais de suppression).
function walkSpecFiles(dir, out, relBase) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".git" || e.name === "test-results" || e.name === "playwright-report" || e.name === ".playwright") continue;
      walkSpecFiles(p, out, relBase);
    } else if (e.isFile() && /\.spec\.(ts|tsx|js|mjs|cjs)$/.test(e.name)) {
      out.push(relative(relBase, p).replace(/\\/g, "/"));
    }
  }
}

// Extraction légère des titres de test() Playwright (scenarios) d'un spec file.
// Gère `test("titre", async ...)`, `test('titre', ...)` avec apostrophes dans le
// titre, et les variantes ternaires `test(cond ? "a" : "b", ...)`. Le registre
// est au grain test() (les test.describe ne sont pas des entrées).
function extractTestTitles(src) {
  const out = [];
  const startRe = /\btest\s*\(\s*(?:[\w.\s]+\?\s*)?(['"`])/g;
  let sm;
  while ((sm = startRe.exec(src))) {
    const q = sm[1];
    const i = startRe.lastIndex;
    // Lecture du contenu jusqu'à la quote de fermeture non échappée.
    let j = i; let closed = -1;
    while (j < src.length) {
      if (src[j] === "\\") { j += 2; continue; }
      if (src[j] === q) { closed = j; break; }
      j++;
    }
    if (closed < 0) continue;
    const title = src.slice(i, closed).trim();
    // Ignore test.skip/fixme/fail/slow(...).
    const head = src.slice(0, sm.index);
    const lastKw = head.slice(head.lastIndexOf("test")).trim();
    if (/^(skip|fixme|fail|slow)\s*\(/.test(lastKw)) { startRe.lastIndex = closed + 1; continue; }
    if (title && title.length && title.length <= 200 && !out.includes(title)) out.push(title);
    startRe.lastIndex = closed + 1;
  }
  return out;
}

server.registerTool("e2e_sync_repo", {
  description: "Synchronise le registre e2e_tests avec un repo applicatif (T10) : scan récursif des spec files Playwright (repoDir), enregistre/réactive les tests présents (ACTIVE, repo source = project, projets couverts par défaut = project) et marque OBSOLETE ceux du projet qui ont disparu du repo. L'historique d'exécution n'est jamais supprimé. Idempotent.",
  inputSchema: {
    project: z.string().describe("Projet du registre (= repo source, ex. oniria / mada-talk)."),
    repoDir: z.string().describe("Répertoire (hôte) du dépôt applicatif à scanner."),
    testDir: z.string().optional().describe("Sous-dossier racine des specs (défaut : scan récursif de tout le repo, hors node_modules/.git/test-results/playwright-report/.playwright)."),
    dryRun: z.boolean().optional().describe("true = rapport seul sans écriture (défaut false)."),
  },
}, async ({ project, repoDir, testDir, dryRun }) => {
  try {
    if (!project || !repoDir || !existsSync(repoDir)) return err(`project et repoDir valide requis (reçu project=${project}, repoDir=${repoDir})`);
    const base = resolve(repoDir);
    const scanRoot = testDir ? resolve(base, testDir) : base;
    if (!existsSync(scanRoot)) return err(`testDir introuvable : ${scanRoot}`);
    const specFiles = [];
    walkSpecFiles(scanRoot, specFiles, base);

    // Cartographie des tests présents dans le repo : (specFile -> scenarios).
    const present = new Map(); // key `${specFile}::${scenario}` -> specFile
    for (const specFile of specFiles) {
      let src = "";
      try { src = readFileSync(join(base, specFile), "utf8"); } catch { continue; }
      const titles = extractTestTitles(src);
      if (!titles.length) continue;
      for (const scenario of titles) present.set(`${specFile}::${scenario}`, specFile);
    }

    const dry = dryRun === true;
    const created = [];
    const reactivated = [];
    const obsolete = [];
    const updatedSpecs = new Set();

    // 1) Upsert de chaque test présent dans le repo.
    for (const [key, specFile] of present) {
      const scenario = key.slice(key.indexOf("::") + 2);
      const id = e2eStableId(project, specFile, scenario);
      const existing = await getE2ETest(id);
      if (!dry) await upsertE2ETest({ project, specFile, scenario, coveredProjects: [project] });
      if (existing && existing.status === "OBSOLETE") reactivated.push(id);
      else if (!existing) created.push(id);
      else updatedSpecs.add(specFile);
    }

    // 2) Marque OBSOLETE les tests ACTIVE du projet dont le spec/scenario a disparu.
    const known = await listE2ETests({ project, status: "ACTIVE", limit: 10000 });
    const presentKeys = new Set(present.keys());
    for (const t of known) {
      const k = `${t.specFile}::${t.scenario}`;
      if (!presentKeys.has(k)) {
        if (!dry) await markE2ETestObsolete(t.e2eTestId);
        obsolete.push(t.e2eTestId);
      }
    }

    return text(JSON.stringify({
      ok: true, project, repoDir: base, testDir: testDir || null,
      dryRun: dry, specFiles: specFiles.length,
      present: present.size, created: created.length, reactivated: reactivated.length,
      obsolete: obsolete.length, unchanged: updatedSpecs.size,
      detail: dry ? { created, reactivated, obsolete } : undefined,
    }, null, 2));
  } catch (e) { return err(e.message); }
});

// === Vars E2E (module vars/secrets unifié) — variables d'env par projet ===
// kind = 'variable' (non sensible, clair, éditable) | 'secret' (chiffré, jamais
// de clair en lecture). name = clé d'env injectée au run.
server.registerTool("e2e_var_set", {
  description: "Crée/remplace une var E2E d'un PROJET (variable d'env injectée au run, ex. E2E_ADMIN_EMAIL). kind='variable' (défaut, non sensible, stockée en clair) ou 'secret' (chiffrée AES-256-GCM, JAMAIS retournée en clair). name = clé d'env lue par les specs via process.env.",
  inputSchema: {
    project: z.string().describe("Projet (repo source / contexte d'application)."),
    name: z.string().describe("Nom de la variable d'env (ex. E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD)."),
    value: z.string().describe("Valeur (stockée en clair si variable, chiffrée si secret)."),
    kind: z.enum(["variable", "secret"]).optional().describe("variable (défaut) | secret."),
    purpose: z.string().optional().describe("Description libre."),
  },
}, async ({ project, name, value, kind, purpose }) => {
  try {
    const r = await setE2EVar({ project, name, value, kind, purpose });
    return text(JSON.stringify({ ok: true, ...r }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("e2e_var_list", {
  description: "Liste les vars E2E d'un projet (métadonnées : name, kind, purpose, dates). La valeur d'un secret n'est JAMAIS retournée ; celle d'une variable (non sensible) est renvoyée. kind optionnel pour filtrer (variable|secret).",
  inputSchema: {
    project: z.string().describe("Projet (repo source)."),
    kind: z.enum(["variable", "secret"]).optional().describe("Filtre par type."),
  },
}, async ({ project, kind }) => {
  try {
    const vars = await listE2EVars(project, kind);
    return text(JSON.stringify({ ok: true, project, count: vars.length, vars }, null, 2));
  } catch (e) { return err(e.message); }
});

server.registerTool("e2e_var_delete", {
  description: "Supprime une var E2E d'un projet (définitif).",
  inputSchema: {
    project: z.string(),
    name: z.string().describe("Nom de la variable d'env à supprimer."),
  },
}, async ({ project, name }) => {
  try {
    const r = await deleteE2EVar({ project, name });
    return text(JSON.stringify({ ok: true, ...r }, null, 2));
  } catch (e) { return err(e.message); }
});

// Alias rétrocompat (module secrets v0.8.6) — mêmes fonctions, kind=secret forcé.
server.registerTool("e2e_secret_set", {
  description: "[alias] Crée/remplace un secret E2E d'un projet (kind='secret', chiffré AES-256-GCM). Préférer e2e_var_set.",
  inputSchema: { project: z.string(), name: z.string(), value: z.string(), purpose: z.string().optional() },
}, async ({ project, name, value, purpose }) => {
  try { return text(JSON.stringify({ ok: true, ...(await setE2EVar({ project, name, value, kind: "secret", purpose })) }, null, 2)); }
  catch (e) { return err(e.message); }
});
server.registerTool("e2e_secret_list", {
  description: "[alias] Liste les secrets E2E d'un projet (kind='secret', jamais la valeur). Préférer e2e_var_list.",
  inputSchema: { project: z.string() },
}, async ({ project }) => {
  try {
    const vars = await listE2EVars(project, "secret");
    return text(JSON.stringify({ ok: true, project, count: vars.length, secrets: vars }, null, 2));
  } catch (e) { return err(e.message); }
});
server.registerTool("e2e_secret_delete", {
  description: "[alias] Supprime un secret E2E d'un projet. Préférer e2e_var_delete.",
  inputSchema: { project: z.string(), name: z.string() },
}, async ({ project, name }) => {
  try { return text(JSON.stringify({ ok: true, ...(await deleteE2EVar({ project, name })) }, null, 2)); }
  catch (e) { return err(e.message); }
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
