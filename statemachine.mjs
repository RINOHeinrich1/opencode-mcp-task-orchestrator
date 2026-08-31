// statemachine.mjs — Machines à états (tâche + plan).
//
// - La TÂCHE porte des phases grossières (planning / awaiting_validation / planned /
//   in_progress / done) : `task_transition`.
// - Le PLAN (sous-tâche) porte le cycle complet (review / merge / déploiement) :
//   `plan_transition`. C'est lui la source de vérité de l'exécution fine.

export const VALID_STATES = [
  "queued",
  "started",
  "planning",
  "awaiting_validation",
  "planned",
  "in_progress",
  "validating",
  "review",
  "approved",
  "rejected",
  "rework",
  "merge_pending",
  "merged",
  "deploy_pending",
  "deploying",
  "deployed",
  "deploy_failed",
  "post_deploy_verified",
  "blocked",
  "failed",
  "aborted",
  "crashed",
  "done",
];

// Machine de la TÂCHE (phases grossières). Le détail fin vit dans le plan.
export const TASK_TRANSITIONS = {
  queued: ["started", "blocked", "aborted"],
  started: ["planning", "blocked", "failed", "aborted", "crashed"],
  planning: ["awaiting_validation", "blocked", "failed", "aborted", "crashed"],
  awaiting_validation: ["planned", "blocked", "aborted"],
  planned: ["in_progress", "blocked", "aborted", "failed"],
  in_progress: ["done", "blocked", "failed", "aborted", "crashed"],
  done: ["rework"],
  blocked: ["queued", "planning", "in_progress", "failed", "aborted"],
  failed: ["queued", "in_progress"],
  aborted: ["queued"],
  crashed: ["in_progress", "blocked", "failed", "aborted"],
  // Reprise après rejet humain/recette : la tâche rouverte en `rework` peut
  // reprendre son cycle (→ in_progress/planned) puis se clôturer (→ done).
  rework: ["planned", "in_progress", "blocked", "failed", "aborted", "done"],
};

// Machine du PLAN (cycle complet review / merge / déploiement).
export const PLAN_TRANSITIONS = {
  planned: ["in_progress", "blocked", "aborted", "failed"],
  in_progress: ["validating", "blocked", "failed", "aborted", "crashed"],
  validating: ["review", "rework", "failed", "crashed"],
  review: ["approved", "rejected", "blocked"],
  approved: ["merge_pending"],
  rejected: ["rework", "failed"],
  rework: ["in_progress", "blocked", "aborted"],
  merge_pending: ["merged", "failed", "blocked"],
  merged: ["deploy_pending", "blocked"],
  deploy_pending: ["deploying", "aborted", "blocked"],
  deploying: ["deployed", "deploy_failed", "blocked"],
  deployed: ["post_deploy_verified", "deploy_failed"],
  post_deploy_verified: ["done"],
  deploy_failed: ["deploy_pending", "failed", "blocked"],
  done: ["rework"],
  blocked: ["in_progress", "rework", "failed", "aborted"],
  failed: ["in_progress", "rework"],
  aborted: [],
  crashed: ["in_progress", "blocked", "failed", "aborted"],
};

// États terminaux (aucune transition sortante). `done` reste ré-ouvrable via `rework`.
export const TERMINAL_STATES = ["aborted"];

export function isValidState(s) {
  return VALID_STATES.includes(s);
}

export function canTaskTransition(from, to) {
  return Array.isArray(TASK_TRANSITIONS[from]) && TASK_TRANSITIONS[from].includes(to);
}

export function canPlanTransition(from, to) {
  return Array.isArray(PLAN_TRANSITIONS[from]) && PLAN_TRANSITIONS[from].includes(to);
}

// Alias rétro-compatible : `canTransition` = machine du plan.
export function canTransition(from, to) {
  return canPlanTransition(from, to);
}

export function isTerminal(s) {
  return TERMINAL_STATES.includes(s);
}

// Liste lisible des transitions autorisées depuis `from` (messages d'erreur).
export function allowedFrom(from) {
  return TASK_TRANSITIONS[from] || [];
}
