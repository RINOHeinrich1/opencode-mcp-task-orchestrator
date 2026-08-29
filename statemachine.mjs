// statemachine.mjs — Machine à états du Task Registry (norme v4, socle P0/P1).
//
// Seule voie de changement de statut : canTransition(from, to) doit être vrai.
// L'orchestrateur (agent) est le seul à appliquer les transitions ; les agents
// de fond publient des événements, jamais des états.

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

// Transitions autorisées : from -> [to].
export const TRANSITIONS = {
  queued: ["started", "blocked", "aborted"],
  // `started` = session lancée (panneau « Lancer ») ; la planification commence
  // quand l'orchestrateur délègue à atomic-plan (`started` → `planning`).
  started: ["planning", "blocked", "failed", "aborted", "crashed"],
  planning: ["awaiting_validation", "blocked", "failed", "aborted", "crashed"],
  awaiting_validation: ["approved", "rejected", "aborted", "blocked"],
  planned: ["in_progress", "blocked", "aborted", "failed"],
  in_progress: ["validating", "blocked", "failed", "aborted", "crashed"],
  validating: ["review", "rework", "failed", "crashed"],
  review: ["approved", "rejected", "blocked"],
  approved: ["planned", "merge_pending"],
  rejected: ["planning", "rework", "failed"],
  rework: ["in_progress", "blocked", "aborted"],
  merge_pending: ["merged", "failed", "blocked"],
  merged: ["deploy_pending", "blocked"],
  deploy_pending: ["deploying", "aborted", "blocked"],
  deploying: ["deployed", "deploy_failed", "blocked"],
  deployed: ["post_deploy_verified", "deploy_failed"],
  post_deploy_verified: ["done"],
  deploy_failed: ["deploy_pending", "failed", "blocked"],
  blocked: ["queued", "planning", "in_progress", "rework", "failed", "aborted", "deploy_pending"],
  failed: ["queued", "in_progress", "rework"],
  aborted: ["queued"],
  crashed: ["in_progress", "blocked", "failed", "aborted"],
  // `done` = orchestrateur terminé, en attente de recette humaine. Un rejet de
  // recette rouvre l'exécution via `rework` (reprise nouvelle session / continuer).
  done: ["rework"],
};

// États terminaux (aucune transition sortante).
// `done` n'est pas listé : il reste ré-ouvrable via `rework` (rejet de recette).
export const TERMINAL_STATES = ["aborted"];

export function isValidState(s) {
  return VALID_STATES.includes(s);
}

export function canTransition(from, to) {
  return Array.isArray(TRANSITIONS[from]) && TRANSITIONS[from].includes(to);
}

export function isTerminal(s) {
  return TERMINAL_STATES.includes(s);
}

// Liste lisible des transitions autorisées depuis `from` (pour messages d'erreur).
export function allowedFrom(from) {
  return TRANSITIONS[from] || [];
}
