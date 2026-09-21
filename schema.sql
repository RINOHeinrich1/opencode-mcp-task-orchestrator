-- Task Registry — schéma PostgreSQL (idempotent)
-- Source de vérité LOGIQUE de l'orchestration (l'état PHYSIQUE reste Git).
-- Types : TEXT (chaînes/ISO 8601/JSON sérialisé), INTEGER, et IDENTITY pour les
-- séquences (remplace rowid/AUTOINCREMENT de SQLite).

-- Marqueur de VERSION du schéma : `ensureSchema()` (db.mjs) lit la ligne
-- `schema_version` et SAUTE le rejeu de ce fichier + `migrate()` si la version
-- correspond. `SCHEMA_VERSION` est une constante de code, À INCRÉMENTER à
-- chaque évolution de `schema.sql`/`migrate()` : toute version différente
-- déclenche un apply complet (idempotent, sous verrou advisory).
CREATE TABLE IF NOT EXISTS schema_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

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
  emergent       INTEGER NOT NULL DEFAULT 0,      -- 1 = émergente (hors sprint / après clôture)
  emergent_origin TEXT,                           -- hors_sprint | apres_cloture
  version        INTEGER NOT NULL DEFAULT 0        -- optimistic lock
);

-- Émergence d'une TÂCHE (apparue hors sprint / après clôture) : tracée, non
-- bloquante. Les colonnes sont d'abord ajoutées idempotemment aux bases
-- EXISTANTES (CREATE TABLE IF NOT EXISTS ne modifie pas une table déjà créée) —
-- miroir de migrate() dans db.mjs.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS emergent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS emergent_origin TEXT;
CREATE INDEX IF NOT EXISTS idx_tasks_emergent ON tasks(project) WHERE emergent = 1;

-- Organisations : tenant de premier niveau (multi-organisation). Toutes les
-- entités de 1er niveau (projets, repos, tâches, recettes, tests, docs,
-- artefacts) portent `organization_id`. Un utilisateur appartient à une org.
CREATE TABLE IF NOT EXISTS organizations (
  id          TEXT PRIMARY KEY,                 -- slug (ex. onirtech)
  name        TEXT NOT NULL,                    -- nom lisible (ex. ONIRTECH)
  description TEXT,
  created_at  TEXT NOT NULL,
  created_by  TEXT
);

-- Tokens git MULTIPLES par organisation (v0.10) : une organisation peut avoir
-- plusieurs PAT (ex. un par compte/hôte git). Le choix du token utilisé par un
-- repo associé à un projet se fait au niveau de la liaison (project_repos.
-- git_token_id). `organizations.git_token_enc` reste le token PAR DÉFAUT
-- (rétrocompat + fallback). Chaque token est chiffré ; jamais renvoyé en clair.
CREATE TABLE IF NOT EXISTS org_git_tokens (
  id          TEXT PRIMARY KEY,      -- gt_<org>_<slug court>
  org         TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,          -- libellé lisible (ex. 'PAT GitHub Rino', 'compte dev')
  token_enc   TEXT NOT NULL,          -- chiffré (encryptSecret)
  created_at  TEXT NOT NULL,
  created_by  TEXT
);
CREATE INDEX IF NOT EXISTS idx_org_git_tokens_org ON org_git_tokens(org);

-- Projets : entité de première classe (enregistrement explicite).
CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  workspace     TEXT,
  git_path      TEXT,
  main_branch   TEXT,                              -- branche principale (garde déploiement)
  e2e_repo_dir  TEXT,                              -- checkout hôte où s'exécutent les runs E2E
  e2e_base_url  TEXT,                              -- URL de test par défaut (E2E)
  organization_id TEXT,                            -- organisation (tenant)
  created_at    TEXT NOT NULL,
  created_by    TEXT
);

-- Repos : dépôts de code physiques (ADR 09). Un repo peut être rattaché à
-- plusieurs projets (N:N via project_repos). Une ADR se rattache à un projet
-- et à 1..N de ses repos (doc_repos).
CREATE TABLE IF NOT EXISTS repos (
  id            TEXT PRIMARY KEY,                  -- ex. mada-talk | oniria
  name          TEXT,
  description   TEXT,                              -- à quoi sert ce repo pour le projet
  deploy        TEXT,                              -- mécanisme de déploiement CI/CD (texte libre)
  git_path      TEXT,                              -- chemin/url du dépôt git
  git_url       TEXT,
  workspace     TEXT,                              -- workspace Coder où vit le checkout
  branches      TEXT,                              -- JSON array : branches cible(s) de déploiement
  main_branch   TEXT,                              -- branche principale (alias rapide)
  e2e_repo_dir  TEXT,                              -- checkout hôte E2E
  e2e_base_url  TEXT,
  organization_id TEXT,                            -- organisation (tenant)
  created_at    TEXT NOT NULL,
  updated_at    TEXT,
  created_by    TEXT,
  meta          JSONB
);
CREATE INDEX IF NOT EXISTS idx_repos_workspace ON repos(workspace);

-- Projets ⇄ Repos (N:N).
CREATE TABLE IF NOT EXISTS project_repos (
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  repo_id     TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  role        TEXT,                                -- ex. frontend | backend | console | outillage
  git_token_id TEXT,                               -- token git de l'organisation (choisi par liaison)
  PRIMARY KEY (project_id, repo_id)
);
CREATE INDEX IF NOT EXISTS idx_project_repos_repo ON project_repos(repo_id);

-- Tâches ⇄ Repos (ADR 09) : une tâche travaille sur 1..N repos du projet
-- (défaut = tous les repos du projet au moment de la création).
CREATE TABLE IF NOT EXISTS task_repos (
  task_id  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  repo_id  TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, repo_id)
);
CREATE INDEX IF NOT EXISTS idx_task_repos_repo ON task_repos(repo_id);

-- ===========================================================================
-- ARTEFACTS — table polymorphe UNIQUE (fusion physique `artifacts` + `docs` +
-- `recette_documents` + `doc_attachments` ; tâche T-20260920-162801-jxtr).
-- Identifiée par le couple (doc_type, content_id) :
--   doc_type   : type d'artefact (taxonomie énumérée — cf. nomenclature-doc-type.md)
--   content_id : identifiant de l'entité porteuse (taskId/recetteId/projectId/docId)
--   kind       : NATURE de l'artefact (plan | audit | report | autre)
-- `content_type` est un nom RÉSERVÉ (futur « type d'artefact ») : JAMAIS créé.
-- Champs ADR structurés conservés : status/context/decision/consequences/
-- replaced_by/is_global. Rattachement N:N via artifact_projects/artifact_repos.
-- NB : définie AVANT `adr_conflicts` (FK adr_id → artifacts.artifact_id).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS artifacts (
  id              INTEGER GENERATED ALWAYS AS IDENTITY,  -- ordre d'insertion (ex-rowid)
  artifact_id     TEXT PRIMARY KEY,                      -- PK stable (ART-… / doc-… / att-…)
  doc_type        TEXT NOT NULL DEFAULT 'autre',         -- taxonomie (cf. nomenclature)
  content_id      TEXT NOT NULL,                         -- entité porteuse (polymorphe, sans FK)
  kind            TEXT NOT NULL DEFAULT 'autre',         -- NATURE : plan | audit | report | autre
  title           TEXT,
  path            TEXT,
  nature          TEXT,                                  -- liaison libre (recette : à quoi sert)
  source          TEXT NOT NULL DEFAULT 'import',        -- import | artifact | registry | ref
  meta            JSONB,                                 -- champs propres à une famille
  description     TEXT,
  status          TEXT,                                  -- ADR : Proposé | Accepté | Déprécié | Remplacé
  context         TEXT,                                  -- ADR : contexte
  decision        TEXT,                                  -- ADR : décision
  consequences    TEXT,                                  -- ADR : conséquences
  replaced_by     TEXT,                                  -- ADR : artifact_id qui remplace
  is_global       INTEGER NOT NULL DEFAULT 0,            -- ADR globale : tous les repos du projet
  organization_id TEXT,                                  -- organisation (tenant)
  created_at      TEXT NOT NULL,
  updated_at      TEXT,                                  -- dernière mise à jour
  created_by      TEXT
);
CREATE INDEX IF NOT EXISTS idx_artifacts_doc_type ON artifacts(doc_type);
CREATE INDEX IF NOT EXISTS idx_artifacts_content ON artifacts(content_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_kind ON artifacts(kind);

-- Artefacts ⇄ Projets (N:N) et Artefacts ⇄ Repos (N:N) — remplacent
-- doc_projects/doc_repos (rattachement projet/repo des ADR-12 ; ADR globale).
CREATE TABLE IF NOT EXISTS artifact_projects (
  artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id) ON DELETE CASCADE,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (artifact_id, project_id)
);
CREATE INDEX IF NOT EXISTS idx_artifact_projects_project ON artifact_projects(project_id);

CREATE TABLE IF NOT EXISTS artifact_repos (
  artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id) ON DELETE CASCADE,
  repo_id     TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  PRIMARY KEY (artifact_id, repo_id)
);
CREATE INDEX IF NOT EXISTS idx_artifact_repos_repo ON artifact_repos(repo_id);

-- ===========================================================================
-- LEGACY (neutralisées par T-20260920-162801-jxtr — cf. `nomenclature-doc-type.md`)
-- Tables `docs`, `doc_projects`, `doc_repos`, `doc_attachments` et
-- `recette_documents` : une base NEUVE ne les crée plus (source logique unique =
-- `artifacts`). Les bases existantes sont migrées par
-- `scripts/artifacts-fusion-migration.mjs` puis NEUTRALISÉES (renommées
-- `legacy_*`) — JAMAIS supprimées.
-- ===========================================================================

-- Conflits code ↔ ADR (item 125) : un agent signale qu'une implémentation
-- contredit une ADR. Le conflit est PERSISTÉ même sans `task_id` (« pas de
-- violation silencieuse ») ; si `task_id` est fourni, une décision humaine
-- (`decisions.kind='conflict'`) est créée et référencée par `decision_id` —
-- sa résolution clôt le conflit (`status='resolved'`, cf. db.mjs).
--   status : open | resolved
CREATE TABLE IF NOT EXISTS adr_conflicts (
  conflict_id TEXT PRIMARY KEY,                             -- adr-conf-<ts>-<rand>
  adr_id      TEXT NOT NULL REFERENCES artifacts(artifact_id) ON DELETE CASCADE,
  task_id     TEXT REFERENCES tasks(id) ON DELETE SET NULL,  -- nullable (hors tâche)
  description TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',                 -- open | resolved
  decision_id TEXT,                                         -- décision humaine (kind='conflict')
  created_at  TEXT NOT NULL,
  created_by  TEXT
);
CREATE INDEX IF NOT EXISTS idx_adr_conflicts_adr ON adr_conflicts(adr_id);
CREATE INDEX IF NOT EXISTS idx_adr_conflicts_status ON adr_conflicts(status);

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

-- LEGACY : l'ancien bloc `artifacts (task_id NOT NULL)` a été remplacé par la
-- table polymorphe définie plus haut (T-20260920-162801-jxtr). La colonne
-- `task_id` est neutralisée (renommée `legacy_task_id`) sur les bases
-- existantes par `scripts/artifacts-fusion-migration.mjs neutralize`.

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

-- Projets rattachés à une recette — LÉGACY multi-projets (1..N), PLUS UTILISÉE.
-- Depuis v0.9.34 : 1 recette = 1 PROJET unique (`recettes.project`) ; la portée
-- réelle est couverte par les REPOS TRANSVERSES du projet (`project_repos`,
-- ADR 11 — ex: mada-talk traverse les repos mada-talk et oniria). La table est
-- conservée pour l'historique des anciennes recettes multi-projets (aucune
-- écriture/lecture par la logique actuelle).
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
  test_intent      TEXT,                    -- JSON : besoin TEST capturé en recette
  doc_intent       TEXT,                    -- JSON : besoin DOCUMENT (ADR/specs/Gherkin) capturé
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recette_items_recette ON recette_items(recette_id);

-- LEGACY : `recette_documents` (documents de recette) est fusionnée dans
-- `artifacts` (`doc_type` ∈ {recette_doc, recette_report}, `content_id` =
-- recetteId) — T-20260920-162801-jxtr. Table neutralisée (renommée
-- `legacy_recette_documents`) par le script de migration ; JAMAIS supprimée.

-- Points de vigilance ADR remontés par les sessions de RECETTE / TEST (item 126) :
-- une ADR MANQUANTE pour une entité réellement discutée, ou un CONFLIT d'ADR
-- signalé pendant la recette. HISTORIQUE APPEND-ONLY : aucune suppression ; seul
-- `status` transite `open → resolved` (resolved_at/resolution/resolved_by sont
-- AJOUTÉS, jamais effacés). Un point OUVERT rattaché à une recette BLOQUE sa
-- terminaison (`confirmRecette`) avec une raison explicite.
--   type            : missing (ADR manquante) | conflict (conflit d'ADR)
--   status          : open | resolved
--   resolution_kind : adr_created | adr_deprecated | manual | decision
-- NB : placée APRÈS `recettes` (FK) — ordre requis par PostgreSQL.
CREATE TABLE IF NOT EXISTS adr_vigilances (
  vigilance_id    TEXT PRIMARY KEY,                 -- adr-vig-<ts>-<rand>
  project         TEXT NOT NULL,                    -- projet de la recette (filtre historique)
  recette_id      TEXT REFERENCES recettes(recette_id) ON DELETE CASCADE,
  task_id         TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  session_id      TEXT,                             -- session recette/test d'origine (traçage)
  type            TEXT NOT NULL,                    -- missing | conflict
  status          TEXT NOT NULL DEFAULT 'open',     -- open | resolved
  entity          TEXT,                             -- entité/constat (type='missing')
  description     TEXT NOT NULL,
  adr_id          TEXT,                             -- ADR concernée (conflit) / ADR proposée (manquant)
  related_adr_id  TEXT,                             -- ADR liée (nouvelle ADR en conflit / ADR levée)
  conflict_id     TEXT,                             -- adr_conflicts.conflict_id (type='conflict')
  resolution      TEXT,                             -- raison TRACÉE de la levée (obligatoire pour résoudre)
  resolution_kind TEXT,                             -- adr_created | adr_deprecated | manual | decision
  created_at      TEXT NOT NULL,
  created_by      TEXT,
  resolved_at     TEXT,
  resolved_by     TEXT
);
CREATE INDEX IF NOT EXISTS idx_adr_vigilances_project ON adr_vigilances(project);
CREATE INDEX IF NOT EXISTS idx_adr_vigilances_recette ON adr_vigilances(recette_id);
CREATE INDEX IF NOT EXISTS idx_adr_vigilances_status ON adr_vigilances(status);
CREATE INDEX IF NOT EXISTS idx_adr_vigilances_type ON adr_vigilances(type);

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
  files      TEXT,                                -- JSON array des fichiers touchés par l'étape (Phase 3)
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
  gherkin        TEXT,                         -- formalisation Gherkin du comportement (test-agent)
  status         TEXT NOT NULL DEFAULT 'ACTIVE',  -- ACTIVE | OBSOLETE | QUARANTINE | DRAFT
  session_id     TEXT,                         -- session de création/mise à jour du test
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

-- Repos traversés par le comportement (N:N, ADR 11) : le spec vit dans l'un
-- d'eux ; l'exécution/sync le déduisent en cherchant spec_file. `repo_id` est un
-- TEXT NOT NULL SANS FK (DDL identique à migrate() — ne pas ajouter REFERENCES).
CREATE TABLE IF NOT EXISTS e2e_test_repos (
  e2e_test_id TEXT NOT NULL REFERENCES e2e_tests(id) ON DELETE CASCADE,
  repo_id     TEXT NOT NULL,
  PRIMARY KEY (e2e_test_id, repo_id)
);
CREATE INDEX IF NOT EXISTS idx_e2e_test_repos_repo ON e2e_test_repos(repo_id);

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

-- Vars E2E (module vars/secrets unifié) : variables d'env par PROJET.
-- kind = 'variable' (non sensible, valeur EN CLAIR dans value) | 'secret'
-- (chiffré AES-256-GCM dans value_enc, clé root-only hors registre).
-- name = clé d'env injectée au run (ex. E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD).
-- NOTE : l'ancienne table e2e_secrets (v0.8.6) est migrée par migrate() dans e2e_vars.
CREATE TABLE IF NOT EXISTS e2e_vars (
  project      TEXT NOT NULL,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'variable',   -- variable | secret
  value        TEXT,                               -- en clair (kind=variable)
  value_enc    TEXT,                               -- chiffré (kind=secret)
  purpose      TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (project, name)
);
CREATE INDEX IF NOT EXISTS idx_e2e_vars_project ON e2e_vars(project);

-- ===========================================================================
-- Batch d'orchestration (v0.9.0) : groupe de tâches pilotées par UNE session
-- d'orchestration. Source naturelle = recette (recette_id), ou ad-hoc.
-- La READINESS et la MATRICE DE CONFLIT sont CALCULÉES (pas stockées) depuis :
--   - dépendances (tasks.dependencies) → précédence ;
--   - fichiers déclarés (plans.file / absolute_path) + réels (plan_commits.files)
--     → détection fine de conflit entre tâches.
-- `max_parallel` = plafond d'écrivains simultanés (défaut 2). Phase 1 : LECTURE +
-- enregistrement (aucun auto-avancement) — l'orchestrateur voit le DAG et la
-- matrice, mais reste conduit semi-manuellement.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS batches (
  id            TEXT PRIMARY KEY,                 -- BATCH-<ts>-<rand>
  project       TEXT NOT NULL,                    -- projet cible
  title         TEXT NOT NULL,
  recette_id    TEXT,                             -- source naturelle (nullable si ad-hoc)
  session_id    TEXT,                             -- session d'orchestration unique
  max_parallel  INTEGER NOT NULL DEFAULT 2,       -- plafond d'écrivains simultanés
  launch_mode   TEXT NOT NULL DEFAULT 'batch',    -- batch (worker auto) | session (session unique) | manual (aucun auto)
  status        TEXT NOT NULL DEFAULT 'active',   -- active | completed | aborted
  created_at    TEXT NOT NULL,
  created_by    TEXT
);
CREATE INDEX IF NOT EXISTS idx_batches_project ON batches(project);
CREATE INDEX IF NOT EXISTS idx_batches_recette ON batches(recette_id);

CREATE TABLE IF NOT EXISTS batch_tasks (
  batch_id  TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  task_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  position  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (batch_id, task_id)
);
CREATE INDEX IF NOT EXISTS idx_batch_tasks_task ON batch_tasks(task_id);

-- ===========================================================================
-- MODÈLE STRUCTURÉ — Fonctionnalités (US-xxx), Règles métier (RM-xxxx), Sprints
-- (ADR-001, item 128). Les documents ADR-12 (specs/gherkin) deviennent des
-- PIÈCES CLIENT ; les valeurs de référence vivent ici. Idempotent.
-- NE TOUCHE PAS la famille ADR (artifacts doc_type='adr', adr_*).
-- ===========================================================================

CREATE TABLE IF NOT EXISTS fonctionnalites (
  id               TEXT PRIMARY KEY,               -- FEAT-<ts>-<rand>
  project          TEXT NOT NULL,
  ref              TEXT NOT NULL,                  -- US-001, US-002…
  role             TEXT,                           -- rôle (« En tant que <rôle> »)
  user_story       TEXT NOT NULL,                  -- « En tant que <rôle>, je peux … »
  sourced_piece_id TEXT,                           -- pièce client source (artifacts.artifact_id)
  emergent         INTEGER NOT NULL DEFAULT 0,     -- 1 = émergente (hors sprint / après clôture)
  emergent_origin  TEXT,                           -- hors_sprint | apres_cloture | sans_piece | recette
  implemented      INTEGER NOT NULL DEFAULT 0,     -- 1 = implémentée (état explicite, T-20260921-133134-yz2i)
  implemented_origin TEXT,                         -- ecosystem | hors_ecosystem (origine de l'implémentation)
  implemented_at   TEXT,                           -- horodatage de la qualification
  implemented_by   TEXT,                           -- acteur de la qualification
  implemented_note TEXT,                           -- motif/note libre
  organization_id  TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT,
  created_by       TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fonctionnalites_project_ref ON fonctionnalites(project, ref);
CREATE INDEX IF NOT EXISTS idx_fonctionnalites_project ON fonctionnalites(project);
-- État d'implémentation + origine sur une base EXISTANTE (CREATE TABLE IF NOT
-- EXISTS ne modifie pas une table déjà créée) — miroir idempotent de migrate().
-- Champs absents ⇒ implemented=0 ⇒ comportement historique inchangé.
ALTER TABLE fonctionnalites ADD COLUMN IF NOT EXISTS implemented INTEGER NOT NULL DEFAULT 0;
ALTER TABLE fonctionnalites ADD COLUMN IF NOT EXISTS implemented_origin TEXT;
ALTER TABLE fonctionnalites ADD COLUMN IF NOT EXISTS implemented_at TEXT;
ALTER TABLE fonctionnalites ADD COLUMN IF NOT EXISTS implemented_by TEXT;
ALTER TABLE fonctionnalites ADD COLUMN IF NOT EXISTS implemented_note TEXT;

CREATE TABLE IF NOT EXISTS regles_metier (
  id               TEXT PRIMARY KEY,               -- RMET-<ts>-<rand>
  project          TEXT NOT NULL,
  ref              TEXT NOT NULL,                  -- RM-0001…
  content          TEXT NOT NULL,                  -- contenu de la règle
  sourced_piece_id TEXT,                           -- pièce client source (artifacts.artifact_id)
  emergent         INTEGER NOT NULL DEFAULT 0,
  emergent_origin  TEXT,
  implemented      INTEGER NOT NULL DEFAULT 0,     -- 1 = implémentée (état explicite, T-20260921-133134-yz2i)
  implemented_origin TEXT,                         -- ecosystem | hors_ecosystem
  implemented_at   TEXT,
  implemented_by   TEXT,
  implemented_note TEXT,
  organization_id  TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT,
  created_by       TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_regles_metier_project_ref ON regles_metier(project, ref);
CREATE INDEX IF NOT EXISTS idx_regles_metier_project ON regles_metier(project);
-- État d'implémentation + origine sur une base EXISTANTE — miroir idempotent de migrate().
ALTER TABLE regles_metier ADD COLUMN IF NOT EXISTS implemented INTEGER NOT NULL DEFAULT 0;
ALTER TABLE regles_metier ADD COLUMN IF NOT EXISTS implemented_origin TEXT;
ALTER TABLE regles_metier ADD COLUMN IF NOT EXISTS implemented_at TEXT;
ALTER TABLE regles_metier ADD COLUMN IF NOT EXISTS implemented_by TEXT;
ALTER TABLE regles_metier ADD COLUMN IF NOT EXISTS implemented_note TEXT;

CREATE TABLE IF NOT EXISTS sprints (
  id              TEXT PRIMARY KEY,                -- SPRINT-<ts>-<rand>
  project         TEXT NOT NULL,
  title           TEXT NOT NULL,
  start_date      TEXT,                            -- début (ISO 8601)
  end_date        TEXT,                            -- fin (ISO 8601) — échéance de clôture AUTO
  status          TEXT NOT NULL DEFAULT 'open',    -- open | close (reprise : close -> open)
  is_default      INTEGER NOT NULL DEFAULT 0,      -- 1 = sprint par défaut du projet (« anciens sprints »)
  auto_close      INTEGER NOT NULL DEFAULT 1,      -- 1 = clôture automatique à end_date
  closed_at       TEXT,                            -- date de clôture (auto ou manuelle)
  close_reason    TEXT,                            -- auto_echeance | manuel
  reopened_at     TEXT,                            -- dernière réouverture
  session_id      TEXT,                            -- session IA dédiée
  organization_id TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT,
  created_by      TEXT
);
CREATE INDEX IF NOT EXISTS idx_sprints_project ON sprints(project);
CREATE INDEX IF NOT EXISTS idx_sprints_status ON sprints(status);
CREATE INDEX IF NOT EXISTS idx_sprints_project_status ON sprints(project, status);
-- Colonnes du cycle de vie produit sur une base EXISTANTE (CREATE TABLE IF NOT
-- EXISTS ne modifie pas une table déjà créée) — miroir idempotent de migrate().
ALTER TABLE sprints ADD COLUMN IF NOT EXISTS is_default INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sprints ADD COLUMN IF NOT EXISTS auto_close INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sprints ADD COLUMN IF NOT EXISTS closed_at TEXT;
ALTER TABLE sprints ADD COLUMN IF NOT EXISTS close_reason TEXT;
ALTER TABLE sprints ADD COLUMN IF NOT EXISTS reopened_at TEXT;
-- Au plus UN sprint par défaut par projet.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sprints_default ON sprints(project) WHERE is_default = 1;

CREATE TABLE IF NOT EXISTS fonctionnalite_regles (
  fonctionnalite_id TEXT NOT NULL REFERENCES fonctionnalites(id) ON DELETE CASCADE,
  regle_id          TEXT NOT NULL REFERENCES regles_metier(id) ON DELETE CASCADE,
  PRIMARY KEY (fonctionnalite_id, regle_id)
);
CREATE INDEX IF NOT EXISTS idx_fonctionnalite_regles_regle ON fonctionnalite_regles(regle_id);

CREATE TABLE IF NOT EXISTS fonctionnalite_gherkin (
  fonctionnalite_id TEXT NOT NULL REFERENCES fonctionnalites(id) ON DELETE CASCADE,
  e2e_test_id       TEXT NOT NULL REFERENCES e2e_tests(id) ON DELETE CASCADE,
  PRIMARY KEY (fonctionnalite_id, e2e_test_id)
);
CREATE INDEX IF NOT EXISTS idx_fonctionnalite_gherkin_test ON fonctionnalite_gherkin(e2e_test_id);

CREATE TABLE IF NOT EXISTS fonctionnalite_adr (
  fonctionnalite_id TEXT NOT NULL REFERENCES fonctionnalites(id) ON DELETE CASCADE,
  adr_id            TEXT NOT NULL REFERENCES artifacts(artifact_id) ON DELETE CASCADE,
  PRIMARY KEY (fonctionnalite_id, adr_id)
);
CREATE INDEX IF NOT EXISTS idx_fonctionnalite_adr_adr ON fonctionnalite_adr(adr_id);

-- Contrainte : une ADR (existante) ne peut perdre sa dernière fonctionnalité.
CREATE OR REPLACE FUNCTION fn_fonctionnalite_adr_min() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM artifacts WHERE artifact_id = OLD.adr_id)
       AND NOT EXISTS (SELECT 1 FROM fonctionnalite_adr WHERE adr_id = OLD.adr_id) THEN
      RAISE EXCEPTION 'ADR % doit être rattachée à au moins 1 fonctionnalité', OLD.adr_id;
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.adr_id IS DISTINCT FROM NEW.adr_id
     AND EXISTS (SELECT 1 FROM artifacts WHERE artifact_id = OLD.adr_id)
     AND NOT EXISTS (SELECT 1 FROM fonctionnalite_adr WHERE adr_id = OLD.adr_id) THEN
    RAISE EXCEPTION 'ADR % doit être rattachée à au moins 1 fonctionnalité', OLD.adr_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_fonctionnalite_adr_min ON fonctionnalite_adr;
CREATE CONSTRAINT TRIGGER trg_fonctionnalite_adr_min
  AFTER INSERT OR UPDATE OR DELETE ON fonctionnalite_adr
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fn_fonctionnalite_adr_min();

CREATE TABLE IF NOT EXISTS sprint_fonctionnalites (
  sprint_id         TEXT NOT NULL REFERENCES sprints(id) ON DELETE CASCADE,
  fonctionnalite_id TEXT NOT NULL REFERENCES fonctionnalites(id) ON DELETE CASCADE,
  PRIMARY KEY (sprint_id, fonctionnalite_id)
);
CREATE INDEX IF NOT EXISTS idx_sprint_fonctionnalites_feat ON sprint_fonctionnalites(fonctionnalite_id);

CREATE TABLE IF NOT EXISTS sprint_regles (
  sprint_id TEXT NOT NULL REFERENCES sprints(id) ON DELETE CASCADE,
  regle_id  TEXT NOT NULL REFERENCES regles_metier(id) ON DELETE CASCADE,
  PRIMARY KEY (sprint_id, regle_id)
);
CREATE INDEX IF NOT EXISTS idx_sprint_regles_regle ON sprint_regles(regle_id);

CREATE TABLE IF NOT EXISTS sprint_pieces (
  sprint_id TEXT NOT NULL REFERENCES sprints(id) ON DELETE CASCADE,
  piece_id  TEXT NOT NULL REFERENCES artifacts(artifact_id) ON DELETE CASCADE,
  PRIMARY KEY (sprint_id, piece_id)
);
CREATE INDEX IF NOT EXISTS idx_sprint_pieces_piece ON sprint_pieces(piece_id);

CREATE TABLE IF NOT EXISTS task_sprints (
  task_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  sprint_id TEXT NOT NULL REFERENCES sprints(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, sprint_id)
);
CREATE INDEX IF NOT EXISTS idx_task_sprints_sprint ON task_sprints(sprint_id);

CREATE TABLE IF NOT EXISTS task_fonctionnalites (
  task_id           TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  fonctionnalite_id TEXT NOT NULL REFERENCES fonctionnalites(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, fonctionnalite_id)
);
CREATE INDEX IF NOT EXISTS idx_task_fonctionnalites_feat ON task_fonctionnalites(fonctionnalite_id);

CREATE TABLE IF NOT EXISTS task_adr (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  adr_id  TEXT NOT NULL REFERENCES artifacts(artifact_id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, adr_id)
);
CREATE INDEX IF NOT EXISTS idx_task_adr_adr ON task_adr(adr_id);

CREATE TABLE IF NOT EXISTS recette_sprints (
  recette_id TEXT NOT NULL REFERENCES recettes(recette_id) ON DELETE CASCADE,
  sprint_id  TEXT NOT NULL REFERENCES sprints(id) ON DELETE CASCADE,
  PRIMARY KEY (recette_id, sprint_id)
);
CREATE INDEX IF NOT EXISTS idx_recette_sprints_sprint ON recette_sprints(sprint_id);

CREATE TABLE IF NOT EXISTS recette_fonctionnalites (
  recette_id        TEXT NOT NULL REFERENCES recettes(recette_id) ON DELETE CASCADE,
  fonctionnalite_id TEXT NOT NULL REFERENCES fonctionnalites(id) ON DELETE CASCADE,
  PRIMARY KEY (recette_id, fonctionnalite_id)
);
CREATE INDEX IF NOT EXISTS idx_recette_fonctionnalites_feat ON recette_fonctionnalites(fonctionnalite_id);

CREATE TABLE IF NOT EXISTS recette_adr (
  recette_id TEXT NOT NULL REFERENCES recettes(recette_id) ON DELETE CASCADE,
  adr_id     TEXT NOT NULL REFERENCES artifacts(artifact_id) ON DELETE CASCADE,
  PRIMARY KEY (recette_id, adr_id)
);
CREATE INDEX IF NOT EXISTS idx_recette_adr_adr ON recette_adr(adr_id);

-- ===========================================================================
-- SESSION DE MIGRATION DES ANCIENS SPRINTS (ADR-001 §6) — DDL ADDITIVE.
-- Miroir EXACT de la DDL posée dans `migrate()` (db.mjs). Aucune colonne
-- existante n'est modifiée ; l'ADR d'origine n'est jamais altérée.
-- ===========================================================================

-- A001 — LIEN HISTORIQUE ADR monolithique d'origine ↔ ADR atomiques converties
-- (N converties pour 1 origine). Idempotence par couple (origine, convertie).
CREATE TABLE IF NOT EXISTS adr_conversions (
  conversion_id     TEXT PRIMARY KEY,
  original_adr_id   TEXT NOT NULL REFERENCES artifacts(artifact_id) ON DELETE CASCADE,
  converted_adr_id  TEXT NOT NULL REFERENCES artifacts(artifact_id) ON DELETE CASCADE,
  created_at        TEXT NOT NULL,
  created_by        TEXT
);
CREATE INDEX IF NOT EXISTS idx_adr_conversions_original ON adr_conversions(original_adr_id);
CREATE INDEX IF NOT EXISTS idx_adr_conversions_converted ON adr_conversions(converted_adr_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_adr_conversions_pair ON adr_conversions(original_adr_id, converted_adr_id);

-- A002 — SESSION DE MIGRATION d'un PROJET (type dédié, reprise), ancrée sur le
-- SPRINT PAR DÉFAUT (= l'ancien sprint). Une migration par projet (idempotent).
CREATE TABLE IF NOT EXISTS migrations (
  migration_id    TEXT PRIMARY KEY,
  project         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sprint_id       TEXT REFERENCES sprints(id) ON DELETE SET NULL,
  session_id      TEXT,
  status          TEXT NOT NULL DEFAULT 'open',
  title           TEXT,
  organization_id TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT,
  finished_at     TEXT,
  created_by      TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_migrations_project ON migrations(project);
CREATE INDEX IF NOT EXISTS idx_migrations_status ON migrations(status);
CREATE INDEX IF NOT EXISTS idx_migrations_sprint ON migrations(sprint_id);
