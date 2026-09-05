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
  recette_status TEXT NOT NULL DEFAULT 'pending',  -- recette : pending (pas faite) | in_progress (en cours) | done (faite)
  recette_class  TEXT,                             -- si tâche issue d'une recette : rework | bug | improvement | feature
  recette_id     TEXT,                             -- recette SOURCE si la tâche a été générée par une recette
  title          TEXT,                             -- titre court de la tâche (obligatoire)
  direct_execution INTEGER NOT NULL DEFAULT 0,     -- 1 = exécution directe via build-notify (pas d'atomic-plan)
  version        INTEGER NOT NULL DEFAULT 0        -- optimistic lock
);

-- Projets : entité de première classe (enregistrement explicite).
CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  workspace     TEXT,
  git_path      TEXT,
  main_branch   TEXT,                              -- branche principale (garde déploiement)
  e2e_repo_dir  TEXT,                              -- checkout hôte où s'exécutent les runs E2E
  e2e_base_url  TEXT,                              -- URL de test par défaut (E2E)
  created_at    TEXT NOT NULL,
  created_by    TEXT
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

-- Tâches liées (tâches associées à une tâche, avec nature de la liaison).
-- Permet à atomic-plan d'exploiter les tâches sources (commits, plans, docs).
CREATE TABLE IF NOT EXISTS task_links (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  linked_task_id  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  description     TEXT,                     -- nature de la liaison (libre)
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_links_task ON task_links(task_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_links_uniq ON task_links(task_id, linked_task_id);

-- ===========================================================================
-- Recette (opération de vérification) — v0.8.0
-- Objet de premier niveau rattaché à un PROJET, avec titre, session propre,
-- couvrant 0..N tâches (recette_tasks). Les éléments identifiés pendant la
-- recette deviennent de NOUVELLES tâches.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS recettes (
  recette_id   TEXT PRIMARY KEY,            -- RECT-<ts>-<rand>
  project      TEXT NOT NULL,               -- projet rattaché (contexte obligatoire)
  title        TEXT NOT NULL,               -- titre court compréhensible (ex: "Recette du module chatbot")
  description  TEXT,                        -- description longue (détail du périmètre vérifié)
  task_id      TEXT,                        -- legacy (une seule tâche) — associations via recette_tasks
  session_id   TEXT,                        -- session dédiée agent-recette
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending (pas faite) | in_progress (en cours) | done (faite)
  created_at   TEXT NOT NULL,
  confirmed_at TEXT,
  confirmed_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_recettes_project ON recettes(project);

-- Tâches couvertes par une recette (0..N).
CREATE TABLE IF NOT EXISTS recette_tasks (
  recette_id TEXT NOT NULL REFERENCES recettes(recette_id) ON DELETE CASCADE,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (recette_id, task_id)
);
CREATE INDEX IF NOT EXISTS idx_recette_tasks_task ON recette_tasks(task_id);

-- Projets rattachés à une recette (1..N — une recette peut couvrir plusieurs projets).
-- `recettes.project` (colonne legacy) reste le PREMIER projet (jamais NULL) ; la
-- source de vérité multi-projets est cette table.
CREATE TABLE IF NOT EXISTS recette_projects (
  recette_id TEXT NOT NULL REFERENCES recettes(recette_id) ON DELETE CASCADE,
  project    TEXT NOT NULL,
  PRIMARY KEY (recette_id, project)
);
CREATE INDEX IF NOT EXISTS idx_recette_projects_project ON recette_projects(project);

-- Éléments détectés pendant la recette (remarques, demandes, constats…).
CREATE TABLE IF NOT EXISTS recette_items (
  id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recette_id       TEXT NOT NULL REFERENCES recettes(recette_id) ON DELETE CASCADE,
  project          TEXT,                    -- projet cible de l'élément (1 item = 1 projet) ; NULL legacy
  content          TEXT NOT NULL,           -- la remarque / demande / constat
  classification   TEXT NOT NULL DEFAULT 'rework',  -- rework | bug | improvement | feature
  discussion       TEXT,                    -- échanges liés
  scope            TEXT,                    -- JSON array de chemins (périmètre suggéré, rempli par l'agent-recette)
  status           TEXT NOT NULL DEFAULT 'open',    -- open | task_created
  created_task_id  TEXT,                    -- tâche créée après confirmation
  exec_order       INTEGER,                 -- ordre d'exécution recommandé (même n = parallèle)
  vigilance        TEXT,                    -- point de vigilance / écart sémantique
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recette_items_recette ON recette_items(recette_id);

-- Documents rattachés à une recette (importés ou liés à un artefact existant),
-- avec la NATURE de la liaison (à quoi sert le document / comment l'exploiter).
CREATE TABLE IF NOT EXISTS recette_documents (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recette_id  TEXT NOT NULL REFERENCES recettes(recette_id) ON DELETE CASCADE,
  title       TEXT,                          -- titre affiché (défaut : nom du fichier)
  nature      TEXT,                          -- à quoi sert le doc / comment l'exploiter
  source      TEXT NOT NULL DEFAULT 'import',-- import | artifact
  path        TEXT,                          -- chemin du fichier
  artifact_id TEXT,                          -- si lié à un artefact existant
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recette_documents_recette ON recette_documents(recette_id);

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

-- ===========================================================================
-- Tests E2E Playwright (cadrage 08) : entités de 1er niveau (indépendantes des
-- tâches), projets couverts (N:N), paramètres, exécutions propriété du test.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS e2e_tests (
  id             TEXT PRIMARY KEY,             -- E2E-<PROJ>-<hash>
  project        TEXT NOT NULL,                -- REPO SOURCE (où vit le spec)
  spec_file      TEXT NOT NULL,                -- chemin du spec Playwright
  scenario       TEXT NOT NULL,                -- titre du test()
  title          TEXT,
  description    TEXT,
  status         TEXT NOT NULL DEFAULT 'ACTIVE',  -- ACTIVE | OBSOLETE | QUARANTINE | DRAFT
  version        INTEGER NOT NULL DEFAULT 1,
  meta           JSONB,
  first_seen_at  TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  CONSTRAINT uq_e2e_tests_scenario UNIQUE (project, spec_file, scenario)
);
CREATE INDEX IF NOT EXISTS idx_e2e_tests_project ON e2e_tests(project);

-- Projets couverts par le comportement (N:N) — inclut le repo source.
CREATE TABLE IF NOT EXISTS e2e_test_projects (
  e2e_test_id   TEXT NOT NULL REFERENCES e2e_tests(id) ON DELETE CASCADE,
  project       TEXT NOT NULL,
  PRIMARY KEY (e2e_test_id, project)
);
CREATE INDEX IF NOT EXISTS idx_e2e_test_projects_project ON e2e_test_projects(project);

-- Paramètres variables d'un test (défaut non sensible ; refs secrets hors registre).
CREATE TABLE IF NOT EXISTS e2e_test_params (
  e2e_test_id   TEXT NOT NULL REFERENCES e2e_tests(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'string',   -- url | string | secret | int | bool
  default_value TEXT,
  secret_ref    TEXT,
  required      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (e2e_test_id, name)
);

-- Relation N:N tâche ↔ test (pure association : le test existe sans tâche).
CREATE TABLE IF NOT EXISTS task_e2e (
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  e2e_test_id   TEXT NOT NULL REFERENCES e2e_tests(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL DEFAULT 'REGRESSION',  -- CREATED|UPDATED|REGRESSION|EXISTING
  reason        TEXT,
  PRIMARY KEY (task_id, e2e_test_id)
);
CREATE INDEX IF NOT EXISTS idx_task_e2e_test ON task_e2e(e2e_test_id);

-- Une exécution = une preuve ; appartient au TEST (origin : task|recette|ci|manual|session).
CREATE TABLE IF NOT EXISTS e2e_executions (
  id                 TEXT PRIMARY KEY,          -- EXE-<ts>-<rand>
  e2e_test_id        TEXT NOT NULL REFERENCES e2e_tests(id) ON DELETE CASCADE,
  origin             TEXT,
  task_id            TEXT,
  deployment_id      TEXT,
  plan_id            TEXT,
  env                TEXT,
  commit_sha         TEXT,
  branch             TEXT,
  pipeline_ref       TEXT,
  status             TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING|RUNNING|PASSED|FAILED|ERROR|SKIPPED|FLAKY
  duration_ms        INTEGER,
  attempts           INTEGER NOT NULL DEFAULT 1,       -- itération de correction (1..3)
  executed_at        TEXT,
  report_artifact_id TEXT,       -- artefact TEXTE (IA + humain)
  logs_url           TEXT,
  video_url          TEXT,       -- preuve HUMAINE
  summary            TEXT,       -- verdict/synthèse textuelle
  verdict_by         TEXT,       -- build-notify | human | agent-recette
  created_at         TEXT NOT NULL,
  param_values       JSONB       -- valeurs effectives utilisées au run
);
CREATE INDEX IF NOT EXISTS idx_e2e_executions_task ON e2e_executions(task_id);
CREATE INDEX IF NOT EXISTS idx_e2e_executions_test ON e2e_executions(e2e_test_id);
CREATE INDEX IF NOT EXISTS idx_e2e_executions_created ON e2e_executions(created_at);
-- NOTE : idx_e2e_executions_origin est créé par migrate() APRÈS l'ALTER ADD COLUMN
-- origin (rétrocompat base existante) — ne pas le déclarer ici avant l'ALTER.
