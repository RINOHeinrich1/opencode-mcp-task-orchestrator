-- Task Registry — schéma PostgreSQL (idempotent)
-- Source de vérité LOGIQUE de l'orchestration (l'état PHYSIQUE reste Git).
-- Types : TEXT (chaînes/ISO 8601/JSON sérialisé), INTEGER, et IDENTITY pour les
-- séquences (remplace rowid/AUTOINCREMENT de SQLite).

-- Contexte immuable d'une tâche (le "quoi").
CREATE TABLE IF NOT EXISTS tasks (
  id             TEXT PRIMARY KEY,                 -- ex: T-20260827-001
  request        TEXT NOT NULL,                    -- demande d'origine
  project        TEXT NOT NULL,                    -- projet cible (scope)
  workspace      TEXT,                             -- workspace Coder associé
  type           TEXT NOT NULL DEFAULT 'feature',  -- feature | debug | audit
  audit_target   TEXT,                             -- cible d'un audit : backend | frontend | both
  priority       TEXT NOT NULL DEFAULT 'normal',   -- low | normal | high | critical
  deadline       TEXT,                             -- ISO 8601
  budget_maxsteps INTEGER,                         -- itérations agentiques max
  budget_maxcost TEXT,                             -- coût max (libre)
  scope          TEXT,                             -- JSON array de périmètres
  acceptance_criteria TEXT,                        -- JSON array
  constraints    TEXT,                             -- JSON array
  dependencies   TEXT,                             -- JSON array de taskId
  created_at     TEXT NOT NULL,
  created_by     TEXT,
  session_id     TEXT,                             -- session opencode qui a créé la tâche
  recette_status TEXT NOT NULL DEFAULT 'pending',  -- recette humaine : pending | approved | rejected
  version        INTEGER NOT NULL DEFAULT 0        -- optimistic lock
);

-- Projets : entité de première classe (enregistrement explicite).
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  workspace   TEXT,
  git_path    TEXT,
  created_at  TEXT NOT NULL,
  created_by  TEXT
);

-- État opérationnel d'une exécution (le "comment", mutable par l'orchestrateur seul).
CREATE TABLE IF NOT EXISTS executions (
  execution_id  TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attempt       INTEGER NOT NULL DEFAULT 1,
  rework_count  INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'queued',
  checkpoint    TEXT,
  started_at    TEXT,
  updated_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_executions_task ON executions(task_id);

-- Sessions opencode liées à une tâche (une par lancement / reprise) — trace
-- append-only. Sert au traçage de consommation par session (y compris reworks).
CREATE TABLE IF NOT EXISTS task_sessions (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  session_id   TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'launch',  -- launch | rework | relaunch
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_sessions_task ON task_sessions(task_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_sessions_uniq ON task_sessions(task_id, session_id);

-- Worktrees : cycle de vie + lease.
CREATE TABLE IF NOT EXISTS worktrees (
  worktree_id    TEXT PRIMARY KEY,
  project        TEXT NOT NULL,
  path           TEXT NOT NULL,
  branch         TEXT,
  status         TEXT NOT NULL DEFAULT 'AVAILABLE', -- AVAILABLE | RESERVED | IN_USE | RELEASED
  agent          TEXT,
  task_id        TEXT,
  reserved_at    TEXT,
  lease_until    TEXT,
  last_heartbeat TEXT,
  lock           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_worktrees_project ON worktrees(project);

-- Journal d'événements append-only (dédupliqué par event_id).
CREATE TABLE IF NOT EXISTS events (
  seq       INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id  TEXT NOT NULL UNIQUE,
  task_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  ts        TEXT NOT NULL,
  type      TEXT NOT NULL,
  by        TEXT,
  detail    TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id);

-- Déploiements (suivi CI/CD d'une tâche).
CREATE TABLE IF NOT EXISTS deployments (
  id             INTEGER GENERATED ALWAYS AS IDENTITY, -- ordre d'insertion (ex-rowid)
  deployment_id  TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'deploy_pending',
  triggered_at   TEXT,
  pipeline_url   TEXT,
  verified_at    TEXT,
  attempt        INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_deployments_task ON deployments(task_id);

-- Décisions humaines (validation de plan, review/merge, recette) avec échéance & escalade.
CREATE TABLE IF NOT EXISTS decisions (
  id             INTEGER GENERATED ALWAYS AS IDENTITY, -- ordre d'insertion (ex-rowid)
  decision_id    TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL DEFAULT 'validation',  -- validation | review | permission | recette
  status         TEXT NOT NULL DEFAULT 'awaiting',    -- awaiting | approved | rejected | expired
  requested_at   TEXT NOT NULL,
  requested_by   TEXT,
  session_id     TEXT,
  expires_at     TEXT,
  escalations    INTEGER NOT NULL DEFAULT 0,
  resolved_at    TEXT,
  resolution     TEXT,
  detail         TEXT,
  permission_id  TEXT,
  plan_id        TEXT
);
CREATE INDEX IF NOT EXISTS idx_decisions_task ON decisions(task_id);

-- Participants d'une tâche (agents enregistrés comme participants).
CREATE TABLE IF NOT EXISTS participants (
  task_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent     TEXT NOT NULL,
  role      TEXT,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (task_id, agent)
);
CREATE INDEX IF NOT EXISTS idx_participants_task ON participants(task_id);

-- Artifacts (documents/livrables liés à une tâche : plan, audit, rapport...).
CREATE TABLE IF NOT EXISTS artifacts (
  id          INTEGER GENERATED ALWAYS AS IDENTITY, -- ordre d'insertion (ex-rowid)
  artifact_id TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,              -- plan | audit | report | autre
  title       TEXT,
  path        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(task_id);

-- ===========================================================================
-- Plans d'action (granularité atomique) — persistance des plans gérés par
-- l'agent `atomic-plan` et le MCP `plan-manager`.
-- Miroir: mcp/plan-manager/db.mjs (CREATE IF NOT EXISTS identiques).
-- ===========================================================================

CREATE TABLE IF NOT EXISTS plans (
  id            TEXT PRIMARY KEY,                 -- planId (ex: Plan-<objectif>-<date>)
  task_id       TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  objective     TEXT NOT NULL,
  file          TEXT,
  absolute_path TEXT,
  deliverables  TEXT,                             -- JSON array de livrables
  status        TEXT NOT NULL DEFAULT 'active',   -- active | completed
  branch        TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plans_task ON plans(task_id);

-- Exécution d'un plan (sous-tâche) : cycle de vie INDÉPENDANT par plan (miroir de
-- `executions`, mais au niveau plan). Le statut de la tâche devient un agrégat
-- (phases grossières) ; les états fins (review/merge/déploiement) vivent ici.
CREATE TABLE IF NOT EXISTS plan_executions (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plan_id       TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  attempt       INTEGER NOT NULL DEFAULT 1,
  status        TEXT NOT NULL DEFAULT 'planned',
  checkpoint    TEXT,
  started_at    TEXT,
  updated_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_plan_executions_plan ON plan_executions(plan_id);

-- Commits rattachés à un plan (sous-tâche) — trace APPEND-ONLY.
-- Tous les commits sont conservés, y compris ceux d'un rework (une sous-tâche
-- peut produire plusieurs commits). Chaque commit décrit les fichiers touchés
-- (`files` = JSON array de {path, status, additions, deletions, diff}).
CREATE TABLE IF NOT EXISTS plan_commits (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plan_id       TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  execution_id  TEXT,
  branch        TEXT,
  sha           TEXT NOT NULL,
  message       TEXT,
  author        TEXT,
  committed_at  TEXT,
  files         TEXT NOT NULL DEFAULT '[]',
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plan_commits_plan ON plan_commits(plan_id, id);

CREATE TABLE IF NOT EXISTS plan_steps (
  plan_id    TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  step_id    TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'todo',        -- todo | in_progress | done | blocked | skipped
  note       TEXT,
  updated_at TEXT,
  PRIMARY KEY (plan_id, step_id)
);
CREATE INDEX IF NOT EXISTS idx_plan_steps_plan ON plan_steps(plan_id);

CREATE TABLE IF NOT EXISTS plan_incidents (
  seq         INTEGER GENERATED ALWAYS AS IDENTITY, -- ordre d'insertion (ex-rowid)
  id          TEXT PRIMARY KEY,                   -- INC-###
  plan_id     TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  step_id     TEXT,
  severity    TEXT NOT NULL DEFAULT 'medium',
  title       TEXT NOT NULL,
  description TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',
  created_at  TEXT NOT NULL,
  resolved_at TEXT,
  resolution  TEXT
);
CREATE INDEX IF NOT EXISTS idx_plan_incidents_plan ON plan_incidents(plan_id);

CREATE TABLE IF NOT EXISTS plan_inconsistencies (
  seq             INTEGER GENERATED ALWAYS AS IDENTITY, -- ordre d'insertion (ex-rowid)
  id              TEXT PRIMARY KEY,               -- INCO-###
  plan_id         TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  step_id         TEXT,
  related_plan_id TEXT,
  description     TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open',
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plan_inconsistencies_plan ON plan_inconsistencies(plan_id);

CREATE TABLE IF NOT EXISTS plan_counters (
  name  TEXT PRIMARY KEY,                         -- incident | inconsistency
  value INTEGER NOT NULL DEFAULT 0
);

-- Conflits de scope détectés (persistance pour KPI d'orchestration) —
-- remplie par le tool `scope_conflict` (v0.2.1).
CREATE TABLE IF NOT EXISTS scope_conflicts (
  id                   INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project              TEXT NOT NULL,
  scope                TEXT NOT NULL,             -- JSON array des périmètres candidats
  conflicting_task_id  TEXT,                      -- tâche active en conflit
  worktree_id          TEXT,                      -- worktree réservé en conflit
  created_at           TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'open'  -- open | resolved
);
CREATE INDEX IF NOT EXISTS idx_scope_conflicts_project ON scope_conflicts(project);
CREATE INDEX IF NOT EXISTS idx_scope_conflicts_id ON scope_conflicts(id);
