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
  // Phase 3 — interleaving fin : fichiers par étape de plan (déclarés).
  await pool().query("ALTER TABLE plan_steps ADD COLUMN IF NOT EXISTS files TEXT");
  // Recette — capture structurée du besoin TEST (créer/modifier/obsoléter un test).
  await pool().query("ALTER TABLE recette_items ADD COLUMN IF NOT EXISTS test_intent TEXT");
  // Recette — capture structurée du besoin DOCUMENT (ADR/specs/Gherkin à faire évoluer).
  await pool().query("ALTER TABLE recette_items ADD COLUMN IF NOT EXISTS doc_intent TEXT");
  // Batch — mode de lancement : batch (worker auto) | session (session unique) | manual.
  await pool().query("ALTER TABLE batches ADD COLUMN IF NOT EXISTS launch_mode TEXT NOT NULL DEFAULT 'batch'");
  // E2E (cadrage 08) : checkout hôte où s'exécutent les runs + URL de test par défaut.
  await pool().query("ALTER TABLE projects ADD COLUMN IF NOT EXISTS e2e_repo_dir TEXT");
  await pool().query("ALTER TABLE projects ADD COLUMN IF NOT EXISTS e2e_base_url TEXT");
  await pool().query("ALTER TABLE recettes ADD COLUMN IF NOT EXISTS project TEXT");
  await pool().query("ALTER TABLE recettes ADD COLUMN IF NOT EXISTS title TEXT");
  await pool().query("ALTER TABLE recettes ADD COLUMN IF NOT EXISTS description TEXT");
  await pool().query("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS title TEXT");
  await pool().query("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS recette_id TEXT");
  await pool().query("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS direct_execution INTEGER NOT NULL DEFAULT 0");
  // E2E : raison d'un SKIP / échec (précondition de données manquante, bug…).
  await pool().query("ALTER TABLE e2e_executions ADD COLUMN IF NOT EXISTS skip_reason TEXT");
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
  // Recette : 1 recette = 1 PROJET unique (`recettes.project`). Les REPOS
  // transverses du projet (project_repos) sont la portée réelle de la recette :
  // le projet mada-talk traverse par ex. le repo oniria. `recette_items.project`
  // (projet cible d'un item) = toujours le projet de la recette (rétrocompat).
  await pool().query("ALTER TABLE recette_items ADD COLUMN IF NOT EXISTS project TEXT");
  // Items legacy sans projet cible → projet de leur recette.
  await pool().query(
    `UPDATE recette_items i SET project = COALESCE(i.project, r.project)
     FROM recettes r WHERE r.recette_id = i.recette_id AND i.project IS NULL`,
  );
  // Tests E2E (cadrage 08) : entités de 1er niveau (indépendantes des tâches).
  // `project` = REPO SOURCE (où vit le spec) ; projets couverts en N:N via
  // e2e_test_projects (le comportement peut traverser plusieurs projets).
  await pool().query(`CREATE TABLE IF NOT EXISTS e2e_tests (
    id TEXT PRIMARY KEY, project TEXT NOT NULL, spec_file TEXT NOT NULL,
    scenario TEXT NOT NULL, title TEXT,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'ACTIVE', version INTEGER NOT NULL DEFAULT 1,
    meta JSONB, first_seen_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    CONSTRAINT uq_e2e_tests_scenario UNIQUE (project, spec_file, scenario)
  )`);
  await pool().query("ALTER TABLE e2e_tests ADD COLUMN IF NOT EXISTS description TEXT");
  await pool().query("ALTER TABLE e2e_tests ADD COLUMN IF NOT EXISTS gherkin TEXT");
  await pool().query("ALTER TABLE e2e_tests ADD COLUMN IF NOT EXISTS session_id TEXT");
  await pool().query("CREATE INDEX IF NOT EXISTS idx_e2e_tests_project ON e2e_tests(project)");
  // Projets couverts par le comportement (N:N) — inclut le repo source.
  await pool().query(`CREATE TABLE IF NOT EXISTS e2e_test_projects (
    e2e_test_id TEXT NOT NULL REFERENCES e2e_tests(id) ON DELETE CASCADE,
    project     TEXT NOT NULL,
    PRIMARY KEY (e2e_test_id, project)
  )`);
  await pool().query("CREATE INDEX IF NOT EXISTS idx_e2e_test_projects_project ON e2e_test_projects(project)");
  // Paramètres variables d'un test (valeur par défaut non sensible ; refs secrets).
  await pool().query(`CREATE TABLE IF NOT EXISTS e2e_test_params (
    e2e_test_id   TEXT NOT NULL REFERENCES e2e_tests(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    kind          TEXT NOT NULL DEFAULT 'string',
    default_value TEXT,
    secret_ref    TEXT,
    required      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (e2e_test_id, name)
  )`);
  await pool().query(`CREATE TABLE IF NOT EXISTS task_e2e (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    e2e_test_id TEXT NOT NULL REFERENCES e2e_tests(id) ON DELETE CASCADE,
    relation_type TEXT NOT NULL DEFAULT 'REGRESSION', reason TEXT,
    PRIMARY KEY (task_id, e2e_test_id)
  )`);
  await pool().query("CREATE INDEX IF NOT EXISTS idx_task_e2e_test ON task_e2e(e2e_test_id)");
  // Exécutions = propriété du TEST ; tâche/recette/CI/manuel = origine tracée.
  await pool().query(`CREATE TABLE IF NOT EXISTS e2e_executions (
    id TEXT PRIMARY KEY, e2e_test_id TEXT NOT NULL REFERENCES e2e_tests(id) ON DELETE CASCADE,
    origin TEXT, task_id TEXT, deployment_id TEXT, plan_id TEXT, env TEXT, commit_sha TEXT, branch TEXT,
    pipeline_ref TEXT, status TEXT NOT NULL DEFAULT 'PENDING', duration_ms INTEGER,
    attempts INTEGER NOT NULL DEFAULT 1, executed_at TEXT, report_artifact_id TEXT,
    logs_url TEXT, video_url TEXT, summary TEXT, verdict_by TEXT, created_at TEXT NOT NULL,
    param_values JSONB
  )`);
  await pool().query("ALTER TABLE e2e_executions ADD COLUMN IF NOT EXISTS origin TEXT");
  await pool().query("ALTER TABLE e2e_executions ADD COLUMN IF NOT EXISTS param_values JSONB");
  await pool().query("CREATE INDEX IF NOT EXISTS idx_e2e_executions_task ON e2e_executions(task_id)");
  await pool().query("CREATE INDEX IF NOT EXISTS idx_e2e_executions_test ON e2e_executions(e2e_test_id)");
  await pool().query("CREATE INDEX IF NOT EXISTS idx_e2e_executions_origin ON e2e_executions(origin)");
  await pool().query("CREATE INDEX IF NOT EXISTS idx_e2e_executions_created ON e2e_executions(created_at)");
  // Vars E2E (module vars/secrets unifié, cadrage 08 v3) : variables d'env par
  // PROJET. kind = 'variable' (non sensible, valeur en clair dans `value`) |
  // 'secret' (chiffré AES-256-GCM dans `value_enc`, clé root-only hors registre).
  // name = clé d'env injectée au run (ex. E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD).
  await pool().query(`CREATE TABLE IF NOT EXISTS e2e_vars (
    project      TEXT NOT NULL,
    name         TEXT NOT NULL,
    kind         TEXT NOT NULL DEFAULT 'variable',   -- variable | secret
    value        TEXT,                               -- en clair (kind=variable)
    value_enc    TEXT,                               -- chiffré (kind=secret)
    purpose      TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    PRIMARY KEY (project, name)
  )`);
  await pool().query("CREATE INDEX IF NOT EXISTS idx_e2e_vars_project ON e2e_vars(project)");
  // Migration rétrocompat : la table e2e_secrets (v0.8.6) devient e2e_vars.
  const hasSecrets = (await pool().query("SELECT to_regclass('public.e2e_secrets') AS t")).rows[0].t !== null;
  if (hasSecrets) {
    await pool().query(
      `INSERT INTO e2e_vars (project, name, kind, value_enc, purpose, created_at, updated_at)
       SELECT project, name, 'secret', value_enc, purpose, created_at, updated_at FROM e2e_secrets
       ON CONFLICT (project, name) DO UPDATE SET kind = 'secret', value_enc = EXCLUDED.value_enc, purpose = COALESCE(EXCLUDED.purpose, e2e_vars.purpose)`,
    );
    await pool().query("DROP TABLE IF EXISTS e2e_secrets");
  }
  await pool().query(`CREATE TABLE IF NOT EXISTS recette_documents (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    recette_id TEXT NOT NULL REFERENCES recettes(recette_id) ON DELETE CASCADE,
    title TEXT, nature TEXT, source TEXT NOT NULL DEFAULT 'import',
    path TEXT, artifact_id TEXT, created_at TEXT NOT NULL
  )`);
  await pool().query("CREATE INDEX IF NOT EXISTS idx_recette_documents_recette ON recette_documents(recette_id)");
  // =========================================================================
  // ADR 09 — Projets ⇄ Repos (N:N). `projects` = PRODUITS (métier). `repos` =
  // dépôts de code physiques (workspace, git_path, branches, e2e). Un repo peut
  // être rattaché à plusieurs produits ; un produit référence plusieurs repos.
  // =========================================================================
  await pool().query(`CREATE TABLE IF NOT EXISTS repos (
    id            TEXT PRIMARY KEY,          -- ex. mada-talk | oniria (repo PBN)
    name          TEXT,
    description   TEXT,                      -- à quoi sert ce repo pour le projet
    deploy        TEXT,                      -- mécanisme de déploiement CI/CD de CE repo (texte libre)
    git_path      TEXT,                      -- chemin/url du dépôt git
    git_url       TEXT,
    workspace     TEXT,                      -- workspace Coder où vit le checkout
    branches      TEXT,                      -- JSON array : branches cible(s) de déploiement
    main_branch   TEXT,                      -- branche principale (alias rapide)
    e2e_repo_dir  TEXT,                      -- checkout hôte E2E
    e2e_base_url  TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT,
    created_by    TEXT,
    meta          JSONB
  )`);
  await pool().query("ALTER TABLE repos ADD COLUMN IF NOT EXISTS updated_at TEXT");
  await pool().query("ALTER TABLE repos ADD COLUMN IF NOT EXISTS description TEXT");
  await pool().query("ALTER TABLE repos ADD COLUMN IF NOT EXISTS deploy TEXT");
  await pool().query("CREATE INDEX IF NOT EXISTS idx_repos_workspace ON repos(workspace)");
  await pool().query(`CREATE TABLE IF NOT EXISTS project_repos (
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    repo_id     TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    role        TEXT,                        -- ex. 'frontend' | 'backend' | 'console' | 'outillage'
    PRIMARY KEY (project_id, repo_id)
  )`);
  await pool().query("CREATE INDEX IF NOT EXISTS idx_project_repos_repo ON project_repos(repo_id)");
  // =========================================================================
  // ADR-12 — Documents de référence (contexte architecture & comportement).
  // Registre générique N:N : un DOCUMENT (kind = adr-tech | specs-fonctionnelles
  // | scenarios-gherkin, chemin + titre) est rattaché à des projets ET/OU des
  // repos (N:N). Il n'y a PAS de contenu en base : le `path` pointe le fichier
  // (workspace Coder / checkout) que les agents LISENT en contexte (test-agent à
  // la création d'un test, agent-recette en début de recette).
  // =========================================================================
  await pool().query(`CREATE TABLE IF NOT EXISTS docs (
    id          TEXT PRIMARY KEY,          -- doc-<ts>-<rand>
    kind        TEXT NOT NULL,             -- adr-tech | specs-fonctionnelles | scenarios-gherkin
    title       TEXT,
    path        TEXT NOT NULL,             -- chemin du fichier (lu par l'agent)
    description TEXT,
    created_at  TEXT NOT NULL,
    created_by  TEXT
  )`);
  await pool().query("CREATE INDEX IF NOT EXISTS idx_docs_kind ON docs(kind)");
  await pool().query(`CREATE TABLE IF NOT EXISTS doc_projects (
    doc_id     TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    PRIMARY KEY (doc_id, project_id)
  )`);
  await pool().query("CREATE INDEX IF NOT EXISTS idx_doc_projects_project ON doc_projects(project_id)");
  await pool().query(`CREATE TABLE IF NOT EXISTS doc_repos (
    doc_id  TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
    repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    PRIMARY KEY (doc_id, repo_id)
  )`);
  await pool().query("CREATE INDEX IF NOT EXISTS idx_doc_repos_repo ON doc_repos(repo_id)");
  // --- Backfill idempotent depuis projects (ne supprime rien) ---------------
  // Chaque projet existant avec des données repo physiques (workspace ou
  // git_path non nul) génère un repo homonyme + l'association au produit.
  await pool().query(
    `INSERT INTO repos (id, name, git_path, workspace, main_branch, e2e_repo_dir, e2e_base_url, created_at, created_by)
     SELECT p.id, p.name, p.git_path, p.workspace, p.main_branch, p.e2e_repo_dir, p.e2e_base_url, p.created_at, p.created_by
     FROM projects p
     WHERE (p.workspace IS NOT NULL OR p.git_path IS NOT NULL OR p.e2e_repo_dir IS NOT NULL)
       AND p.id NOT IN (SELECT id FROM repos)
     ON CONFLICT (id) DO NOTHING`,
  );
  await pool().query(
    `INSERT INTO project_repos (project_id, repo_id, role)
     SELECT p.id, p.id, NULL FROM projects p
     WHERE (p.workspace IS NOT NULL OR p.git_path IS NOT NULL OR p.e2e_repo_dir IS NOT NULL)
       AND p.id NOT IN (SELECT project_id FROM project_repos WHERE project_id = p.id AND repo_id = p.id)
     ON CONFLICT DO NOTHING`,
  );
  // Tâches ⇄ Repos (ADR 09) : une tâche travaille sur 1..N repos du projet
  // (défaut = tous les repos du projet au moment de la création).
  await pool().query(`CREATE TABLE IF NOT EXISTS task_repos (
    task_id  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    repo_id  TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, repo_id)
  )`);
  await pool().query("CREATE INDEX IF NOT EXISTS idx_task_repos_repo ON task_repos(repo_id)");
  // Backfill : les tâches existantes SANS repos explicites reçoivent les repos
  // de leur projet. Ne touche PAS aux tâches qui ont déjà une sélection (une
  // tâche restreinte à certains repos ne doit jamais être élargie par rejeu).
  await pool().query(
    `INSERT INTO task_repos (task_id, repo_id)
     SELECT t.id, pr.repo_id FROM tasks t
     JOIN project_repos pr ON pr.project_id = t.project
     WHERE t.id NOT IN (SELECT task_id FROM task_repos)
     ON CONFLICT DO NOTHING`,
  );
  // Tâches émergentes : task_links porte une relation_type ('emergent' = créée
  // hors scope pendant la tâche source, liée à sa source).
  await pool().query("ALTER TABLE task_links ADD COLUMN IF NOT EXISTS relation_type TEXT DEFAULT 'linked'");
  // ADR 11 — Tests E2E rattachés à UN PROJET (produit) + repos traversés (N:N).
  // `e2e_tests.project` = le PROJET (produit) dont le comportement est vérifié.
  // `e2e_test_repos` = les REPOS traversés par le comportement (le spec vit dans
  // l'un d'eux ; l'exécution/sync le déduisent en cherchant spec_file).
  await pool().query(`CREATE TABLE IF NOT EXISTS e2e_test_repos (
    e2e_test_id TEXT NOT NULL REFERENCES e2e_tests(id) ON DELETE CASCADE,
    repo_id     TEXT NOT NULL,
    PRIMARY KEY (e2e_test_id, repo_id)
  )`);
  await pool().query("CREATE INDEX IF NOT EXISTS idx_e2e_test_repos_repo ON e2e_test_repos(repo_id)");
  // Backfill rétrocompat : les anciens « projets couverts » (e2e_test_projects)
  // deviennent des repos traversés quand un REPO porte ce nom (sinon on déduit
  // le repo du projet de e2e_tests via project_repos). Ne touche pas aux tests
  // déjà pourvus.
  await pool().query(
    `INSERT INTO e2e_test_repos (e2e_test_id, repo_id)
     SELECT DISTINCT ep.e2e_test_id, r.id
     FROM e2e_test_projects ep
     JOIN repos r ON r.id = ep.project
     WHERE ep.e2e_test_id NOT IN (SELECT e2e_test_id FROM e2e_test_repos)
     ON CONFLICT DO NOTHING`,
  );
  await pool().query(
    `INSERT INTO e2e_test_repos (e2e_test_id, repo_id)
     SELECT DISTINCT e.id, pr.repo_id
     FROM e2e_tests e
     JOIN project_repos pr ON pr.project_id = e.project
     WHERE e.id NOT IN (SELECT e2e_test_id FROM e2e_test_repos)
     ON CONFLICT DO NOTHING`,
  );
  await pool().query(
    `INSERT INTO e2e_test_repos (e2e_test_id, repo_id)
     SELECT DISTINCT e.id, r.id
     FROM e2e_tests e
     JOIN repos r ON r.id = e.project
     WHERE e.id NOT IN (SELECT e2e_test_id FROM e2e_test_repos)
     ON CONFLICT DO NOTHING`,
  );
  // =========================================================================
  // MULTI-ORGANISATION (v0.9.47) — tenant de premier niveau + attribution user.
  // Toutes les entités de 1er niveau portent `organization_id` ; `created_by`
  // = username (string) de l'utilisateur du panneau qui a créé la donnée.
  // Placé EN FIN de migrate() : toutes les tables existent à ce stade.
  // =========================================================================
  await pool().query(`CREATE TABLE IF NOT EXISTS organizations (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT,
    created_at  TEXT NOT NULL,
    created_by  TEXT
  )`);
  await pool().query(
    `INSERT INTO organizations (id, name, description, created_at, created_by)
     VALUES ('onirtech', 'ONIRTECH', 'Organisation ONIRTECH', $1, 'system')
     ON CONFLICT (id) DO NOTHING`, [nowIso()],
  );
  // Organisation par DÉFAUT (seule à pouvoir configurer l'écosystème).
  await pool().query("ALTER TABLE organizations ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT false");
  await pool().query(
    `UPDATE organizations SET is_default = true
     WHERE id = 'onirtech' AND NOT EXISTS (SELECT 1 FROM organizations WHERE is_default)`,
  );
  // Configuration Coder PAR ORGANISATION (v0.9.54) : URL + token (chiffré).
  await pool().query("ALTER TABLE organizations ADD COLUMN IF NOT EXISTS coder_url TEXT");
  await pool().query("ALTER TABLE organizations ADD COLUMN IF NOT EXISTS coder_token_enc TEXT");
  // Token git (PAT) PAR ORGANISATION — chiffré, utilisé pour clone/pull/push.
  await pool().query("ALTER TABLE organizations ADD COLUMN IF NOT EXISTS git_token_enc TEXT");
  // Template Coder (nom) pour la création de workspace.
  await pool().query("ALTER TABLE organizations ADD COLUMN IF NOT EXISTS coder_template TEXT");
  // Seed de l'URL Coder par défaut (ide.madatalk.fr) si absente.
  await pool().query("UPDATE organizations SET coder_url = 'https://ide.madatalk.fr' WHERE coder_url IS NULL");
  // =========================================================================
  // ORGANISATION → TOKENS GIT MULTIPLES (v0.10) : une organisation peut avoir
  // plusieurs PAT (ex. un par compte/hôte git). Le choix du token utilisé par
  // un repo associé à un projet se fait au niveau de la liaison (project_repos.
  // git_token_id). `git_token_enc` sur organizations reste le token PAR DÉFAUT
  // (rétrocompat + fallback). Chaque token est chiffré ; jamais renvoyé en clair.
  // =========================================================================
  await pool().query(`CREATE TABLE IF NOT EXISTS org_git_tokens (
    id          TEXT PRIMARY KEY,      -- gt_<org>_<slug court>
    org         TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,          -- libellé lisible (ex. 'PAT GitHub Rino', 'compte dev')
    token_enc   TEXT NOT NULL,          -- chiffré (encryptSecret)
    created_at  TEXT NOT NULL,
    created_by  TEXT
  )`);
  await pool().query("CREATE INDEX IF NOT EXISTS idx_org_git_tokens_org ON org_git_tokens(org)");
  // Liaison repo↔projet : token git choisi parmi les tokens de l'organisation.
  await pool().query("ALTER TABLE project_repos ADD COLUMN IF NOT EXISTS git_token_id TEXT");
  for (const tbl of ["projects", "repos", "recettes", "tasks", "e2e_tests", "docs", "artifacts"]) {
    await pool().query(`ALTER TABLE ${tbl} ADD COLUMN IF NOT EXISTS organization_id TEXT`);
    await pool().query(`UPDATE ${tbl} SET organization_id = 'onirtech' WHERE organization_id IS NULL`);
  }
  for (const tbl of ["recettes", "e2e_tests", "artifacts"]) {
    await pool().query(`ALTER TABLE ${tbl} ADD COLUMN IF NOT EXISTS created_by TEXT`);
  }
  for (const tbl of ["projects", "repos", "recettes", "tasks", "e2e_tests", "docs", "artifacts"]) {
    await pool().query(`UPDATE ${tbl} SET created_by = 'Rino' WHERE created_by IS NULL`);
  }
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
  // organization_id : fourni, sinon hérité du projet, sinon organisation par défaut.
  const organizationId = task.organizationId || await orgIdOfProject(task.project) || await defaultOrganizationId();
  // created_by : fourni, sinon identité de l'instance opencode (OPENCODE_USER).
  const createdBy = task.createdBy || process.env.OPENCODE_USER || null;
  await pool().query(
    `INSERT INTO tasks
       (id, request, title, project, workspace, type, audit_target, priority, deadline,
        budget_maxsteps, budget_maxcost, scope, acceptance_criteria,
        constraints, dependencies, created_at, created_by, session_id, recette_class, recette_id, direct_execution, organization_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
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
      createdBy,
      task.sessionId ?? null,
      task.recetteClass ?? null,
      task.recetteId ?? null,
      task.directExecution ? 1 : 0,
      organizationId,
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
  // Tâche ÉMERGENTE : créée hors scope pendant une tâche source. On la lie à sa
  // source avec relation_type='emergent' (tâche émergente → tâche source).
  if (task.originTaskId) {
    const src = (await pool().query("SELECT id FROM tasks WHERE id = $1", [task.originTaskId])).rows[0];
    if (src) {
      await addTaskLink({
        taskId: task.id,
        linkedTaskId: task.originTaskId,
        relationType: "emergent",
        description: task.originReason || "créée hors scope pendant la tâche " + task.originTaskId,
      });
    }
  }
  // Repos ciblés (ADR 09) : repoIds explicites ou défaut = tous ceux du projet.
  await setTaskRepos(task.id, task.repoIds);
  return getTask(task.id);
}

// --- Tâches liées (task_links) ----------------------------------------------
// relation_type : 'linked' (défaut) | 'emergent' (tâche créée hors scope pendant
// une tâche source, reliée à sa source) — permet de requêter les émergentes.
export async function addTaskLink({ taskId, linkedTaskId, description, relationType }) {
  await ensureSchema();
  if (!linkedTaskId) throw new Error("linkedTaskId requis");
  if (linkedTaskId === taskId) throw new Error("une tâche ne peut pas être liée à elle-même");
  const target = (await pool().query("SELECT id FROM tasks WHERE id = $1", [linkedTaskId])).rows[0];
  if (!target) throw new Error(`tâche liée inconnue : ${linkedTaskId}`);
  await pool().query(
    `INSERT INTO task_links (task_id, linked_task_id, description, relation_type, created_at)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (task_id, linked_task_id) DO UPDATE SET description = EXCLUDED.description, relation_type = EXCLUDED.relation_type`,
    [taskId, linkedTaskId, description ?? null, relationType || "linked", nowIso()],
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
    `SELECT l.linked_task_id, l.description, l.relation_type, l.created_at,
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
    relationType: r.relation_type || "linked",
    createdAt: r.created_at,
    linkedRequest: r.linked_request ?? null,
    linkedRecette: r.linked_recette ?? null,
    linkedStatus: r.linked_status ?? null,
    linkedPlans: Number(r.linked_plans) || 0,
    linkedArtifacts: Number(r.linked_artifacts) || 0,
  }));
}

// Tâches liées "émancipées" de la tâche : les tâches émergentes dont la SOURCE
// est `sourceTaskId` (lien inverse : task_links.task_id = tâche émergente,
// linked_task_id = source, relation_type='emergent').
export async function listTaskEmergentFrom(sourceTaskId) {
  await ensureSchema();
  const res = await pool().query(
    `SELECT t.id, t.request, t.title, t.recette_status,
            (SELECT x.status FROM executions x WHERE x.task_id = t.id ORDER BY attempt DESC LIMIT 1) AS status,
            l.description AS link_reason
     FROM task_links l
     JOIN tasks t ON t.id = l.task_id
     WHERE l.linked_task_id = $1 AND l.relation_type = 'emergent'
     ORDER BY l.id ASC`,
    [sourceTaskId],
  );
  return res.rows.map((r) => ({
    taskId: r.id,
    request: r.request,
    title: r.title ?? null,
    recetteStatus: r.recette_status ?? "pending",
    status: r.status ?? "queued",
    reason: r.link_reason ?? null,
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
    organizationId: row.organization_id ?? null,
    version: row.version,
  };
}

export async function getTask(id) {
  await ensureSchema();
  const res = await pool().query("SELECT * FROM tasks WHERE id = $1", [id]);
  return rowToTask(res.rows[0]);
}

// Repos d'une tâche (1..N, ADR 09) — ordre stable.
export async function getTaskRepos(taskId) {
  await ensureSchema();
  const res = await pool().query(
    `SELECT r.id, r.name, r.description, r.deploy, r.git_path, r.git_url, r.workspace, r.main_branch, r.e2e_repo_dir, r.e2e_base_url
     FROM repos r JOIN task_repos tr ON tr.repo_id = r.id
     WHERE tr.task_id = $1 ORDER BY r.name ASC`, [taskId],
  );
  return res.rows.map((r) => ({
    id: r.id, name: r.name, description: r.description ?? null, deploy: r.deploy ?? null,
    repoDir: r.git_path ?? null, gitUrl: r.git_url ?? null,
    workspace: r.workspace ?? null, mainBranch: r.main_branch ?? null,
    e2eRepoDir: r.e2e_repo_dir ?? null, e2eBaseUrl: r.e2e_base_url ?? null,
  }));
}

// Affecte les repos d'une tâche. Si repoIds absent/vide → défaut = TOUS les
// repos du projet de la tâche (règle ADR : une tâche couvre tous les repos du
// projet par défaut).
export async function setTaskRepos(taskId, repoIds) {
  await ensureSchema();
  const task = await getTask(taskId);
  if (!task) throw new Error(`tâche inconnue : ${taskId}`);
  let ids = (Array.isArray(repoIds) ? repoIds.map(String).filter(Boolean) : []);
  if (!ids.length) {
    const proj = (await pool().query(
      "SELECT repo_id FROM project_repos WHERE project_id = $1", [task.project],
    )).rows.map((r) => r.repo_id);
    ids = proj;
  }
  await pool().query("DELETE FROM task_repos WHERE task_id = $1", [taskId]);
  for (const rid of ids) {
    const exists = (await pool().query("SELECT 1 FROM repos WHERE id = $1", [rid])).rows[0];
    if (!exists) continue;
    await pool().query("INSERT INTO task_repos (task_id, repo_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [taskId, rid]);
  }
  return getTaskRepos(taskId);
}

// getTask enrichi des repos (lecture standard pour l'outil task_get).
export async function getTaskWithRepos(id) {
  const task = await getTask(id);
  if (!task) return null;
  task.repos = await getTaskRepos(id);
  return task;
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
    // Tâche terminée : solde les décisions/permissions encore 'awaiting'.
    // L'utilisateur a pu répondre directement dans la SESSION (chat) sans passer
    // par le panneau → aucune décision 'permission.replied' n'a été émise. On les
    // marque 'approved' avec la résolution « résolu en session » (trace que la
    // réponse est venue du chat, pas du panneau).
    if (to === "done") {
      const pending = await client.query(
        "SELECT decision_id, kind FROM decisions WHERE task_id = $1 AND status = 'awaiting'",
        [taskId],
      );
      const ts = nowIso();
      for (const d of pending.rows) {
        await client.query(
          "UPDATE decisions SET status = 'approved', resolved_at = $1, resolution = 'résolu en session' WHERE decision_id = $2",
          [ts, d.decision_id],
        );
      }
      if (pending.rows.length) {
        await client.query(
          "INSERT INTO events (event_id, task_id, ts, type, by, detail) VALUES ($1,$2,$3,'DECISIONS_RESOLVED_IN_SESSION',$4,$5)",
          [`${taskId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, taskId, ts, by ?? "system", JSON.stringify({ count: pending.rows.length, resolution: "résolu en session" })],
        );
      }
    }
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
export async function updateTask({ taskId, request, title, acceptanceCriteria, scope, priority, directExecution, linkedTasks, repoIds }) {
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
  // Repos ciblés si fournis (ADR 09) — avant le early-return des champs.
  if (repoIds !== undefined) await setTaskRepos(taskId, repoIds);
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
  return {
    id: r.id, name: r.name, workspace: r.workspace, gitPath: r.git_path, mainBranch: r.main_branch ?? null,
    e2eRepoDir: r.e2e_repo_dir ?? null, e2eBaseUrl: r.e2e_base_url ?? null,
    organizationId: r.organization_id ?? null,
    createdAt: r.created_at, createdBy: r.created_by,
  };
}

export async function registerProject({ id, name, workspace, gitPath, mainBranch, e2eRepoDir, e2eBaseUrl, organizationId, createdBy }) {
  await ensureSchema();
  const org = organizationId || await defaultOrganizationId();
  await pool().query(
    `INSERT INTO projects (id, name, workspace, git_path, main_branch, e2e_repo_dir, e2e_base_url, organization_id, created_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT(id) DO UPDATE SET
       name = EXCLUDED.name, workspace = EXCLUDED.workspace, git_path = EXCLUDED.git_path,
       main_branch = EXCLUDED.main_branch, e2e_repo_dir = EXCLUDED.e2e_repo_dir, e2e_base_url = EXCLUDED.e2e_base_url,
       organization_id = EXCLUDED.organization_id`,
    [id, name, workspace ?? null, gitPath ?? null, mainBranch ?? null, e2eRepoDir ?? null, e2eBaseUrl ?? null, org, nowIso(), createdBy ?? null],
  );
  return getProject(id);
}

export async function getProject(id) {
  await ensureSchema();
  const res = await pool().query("SELECT * FROM projects WHERE id = $1", [id]);
  const p = rowToProject(res.rows[0]);
  if (p) p.docs = await docsForProjectContext(id); // ADR-12 : contexte architecture & comportement
  return p;
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

export async function deleteRepo(id) {
  await ensureSchema();
  const existing = await getRepo(id);
  if (!existing) return null;
  await pool().query("DELETE FROM project_repos WHERE repo_id = $1", [id]);
  await pool().query("DELETE FROM repos WHERE id = $1", [id]);
  return { id, deleted: true };
}

// --- Repos (ADR 09) : dépôt de code physique, rattaché à 1..N produits -------
function rowToRepo(r) {
  if (!r) return null;
  let branches = r.branches;
  try { branches = branches ? JSON.parse(branches) : null; } catch { branches = r.branches ? [r.branches] : null; }
  return {
    id: r.id, name: r.name, description: r.description ?? null, deploy: r.deploy ?? null,
    repoDir: r.git_path ?? null,        // répertoire du dépôt (dans/du workspace Coder)
    gitPath: r.git_path ?? null,        // alias rétrocompat (== repoDir)
    gitUrl: r.git_url ?? null,
    workspace: r.workspace ?? null, branches, mainBranch: r.main_branch ?? null,
    e2eRepoDir: r.e2e_repo_dir ?? null, e2eBaseUrl: r.e2e_base_url ?? null,
    organizationId: r.organization_id ?? null,
    createdAt: r.created_at, createdBy: r.created_by, meta: r.meta ?? null,
  };
}

export async function registerRepo({ id, name, description, deploy, workspace, repoDir, gitPath, gitUrl, branches, mainBranch, e2eRepoDir, e2eBaseUrl, organizationId, createdBy }) {
  await ensureSchema();
  if (!id) throw new Error("id requis");
  const dir = repoDir ?? gitPath ?? null; // repoDir = terme courant ; gitPath = alias
  const org = organizationId || await defaultOrganizationId();
  await pool().query(
    `INSERT INTO repos (id, name, description, deploy, git_path, git_url, workspace, branches, main_branch, e2e_repo_dir, e2e_base_url, organization_id, created_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT(id) DO UPDATE SET
       name = EXCLUDED.name, description = COALESCE(EXCLUDED.description, repos.description),
       deploy = COALESCE(EXCLUDED.deploy, repos.deploy),
       git_path = EXCLUDED.git_path, git_url = EXCLUDED.git_url,
       workspace = EXCLUDED.workspace, branches = EXCLUDED.branches, main_branch = EXCLUDED.main_branch,
       e2e_repo_dir = EXCLUDED.e2e_repo_dir, e2e_base_url = EXCLUDED.e2e_base_url,
       organization_id = EXCLUDED.organization_id`,
    [id, name ?? id, description ?? null, deploy ?? null, dir, gitUrl ?? null, workspace ?? null,
     branches ? JSON.stringify(Array.isArray(branches) ? branches : [branches]) : null,
     mainBranch ?? null, e2eRepoDir ?? null, e2eBaseUrl ?? null, org, nowIso(), createdBy ?? null],
  );
  return getRepo(id);
}

export async function getRepo(id) {
  await ensureSchema();
  const res = await pool().query("SELECT * FROM repos WHERE id = $1", [id]);
  const r = rowToRepo(res.rows[0]);
  if (r) r.docs = await listDocs({ repoId: id }); // ADR-12 : docs du repo
  return r;
}

export async function listRepos(projectId) {
  await ensureSchema();
  const res = await pool().query("SELECT * FROM repos ORDER BY name ASC");
  const rows = res.rows.map(rowToRepo);
  // Association project_repos : enrichit les repos avec gitTokenId + role
  // si un projectId est fourni (permet au panneau de connaître le token choisi).
  let assocMap = {};
  if (projectId) {
    const assocRows = (await pool().query(
      "SELECT repo_id, role, git_token_id FROM project_repos WHERE project_id = $1",
      [projectId],
    )).rows;
    for (const a of assocRows) assocMap[a.repo_id] = { role: a.role ?? null, gitTokenId: a.git_token_id ?? null };
  }
  // ADR-12 : docs rattachés à chaque repo (lecture groupée).
  if (rows.length) {
    const map = {};
    const docs = (await pool().query(
      "SELECT d.*, dr.repo_id AS rid FROM docs d JOIN doc_repos dr ON dr.doc_id = d.id ORDER BY d.kind, d.title NULLS LAST",
    )).rows;
    const enriched = await enrichDocs(docs);
    const byRepo = {};
    for (const d of docs) (byRepo[d.rid] = byRepo[d.rid] || []).push(d.id);
    const byId = {};
    for (const e of enriched) byId[e.docId] = e;
    for (const r of rows) {
      r.docs = (byRepo[r.id] || []).map((id) => byId[id]).filter(Boolean);
    }
  }
  // Ajoute role + gitTokenId au repo (via clé _pr_role / _pr_git_token_id ? non,
  // on enrichit ici directement). On retourne les rows tels quels + assoc extras.
  if (projectId) {
    for (const r of rows) {
      const a = assocMap[r.id] || {};
      r.role = a.role ?? null;
      r.gitTokenId = a.gitTokenId ?? null;
    }
  }
  return rows;
}

// Associe un repo à un projet (N:N). Rôle optionnel (frontend/backend/console/outillage).
// gitTokenId (optionnel) = token git de l'ORGANISATION du projet à utiliser pour
// ce repo (clone/pull/push). Vide/absent → inchangé (ou token par défaut de l'org).
export async function linkRepoToProject({ projectId, repoId, role, gitTokenId }) {
  await ensureSchema();
  if (!(await getRepo(repoId))) throw new Error(`repo inconnu : ${repoId}`);
  const project = await getProject(projectId);
  if (!project) throw new Error(`projet inconnu : ${projectId}`);
  if (gitTokenId !== undefined && gitTokenId !== null && String(gitTokenId).trim()) {
    const org = project.organization_id || "onirtech";
    const tok = await pool().query("SELECT id FROM org_git_tokens WHERE id = $1 AND org = $2", [gitTokenId, org]);
    if (!tok.rows[0]) throw new Error(`token git ${gitTokenId} introuvable pour l'organisation ${org} (choisissez un token de cette organisation)`);
  }
  await pool().query(
    `INSERT INTO project_repos (project_id, repo_id, role, git_token_id) VALUES ($1,$2,$3,$4)
     ON CONFLICT (project_id, repo_id) DO UPDATE SET role = COALESCE(EXCLUDED.role, project_repos.role), git_token_id = COALESCE(EXCLUDED.git_token_id, project_repos.git_token_id)`,
    [projectId, repoId, role ?? null, gitTokenId !== undefined && gitTokenId !== null && String(gitTokenId).trim() ? String(gitTokenId).trim() : null],
  );
  return { ok: true, projectId, repoId };
}

export async function unlinkRepoFromProject({ projectId, repoId }) {
  await ensureSchema();
  await pool().query("DELETE FROM project_repos WHERE project_id = $1 AND repo_id = $2", [projectId, repoId]);
  return { ok: true };
}

export async function listProjectRepos(projectId) {
  await ensureSchema();
  const res = await pool().query(
    `SELECT r.*, pr.role AS pr_role, pr.git_token_id AS pr_git_token_id FROM repos r JOIN project_repos pr ON pr.repo_id = r.id
     WHERE pr.project_id = $1 ORDER BY r.name ASC`, [projectId],
  );
  return res.rows.map((r) => ({ ...rowToRepo(r), role: r.pr_role ?? null, gitTokenId: r.pr_git_token_id ?? null }));
}

export async function listProjectsWithRepos() {
  await ensureSchema();
  const projects = await listProjects();
  const assoc = (await pool().query("SELECT project_id, repo_id, role, git_token_id FROM project_repos ORDER BY repo_id")).rows;
  const map = new Map();
  for (const a of assoc) {
    if (!map.has(a.project_id)) map.set(a.project_id, []);
    map.get(a.project_id).push({ repoId: a.repo_id, role: a.role ?? null, gitTokenId: a.git_token_id ?? null });
  }
  // ADR-12 : docs applicables par projet (docs du projet + docs de ses repos).
  const repoIdsByProject = {};
  for (const p of projects) repoIdsByProject[p.id] = (map.get(p.id) || []).map((x) => x.repoId);
  const allProjectIds = projects.map((p) => p.id);
  const allRepoIds = [...new Set(Object.values(repoIdsByProject).flat())];
  const docsByTarget = await docsByProjectRepoBatch(allProjectIds, allRepoIds);
  return projects.map((p) => ({
    ...p,
    repos: repoIdsByProject[p.id],
    docs: (docsByTarget.projects[p.id] || []).concat(docsByTarget.reposForProject[p.id] || []),
  }));
}

// Lecture groupée des docs rattachés à des projets/repos (évite le N+1).
// Retourne { projects: {pid: [doc…]}, reposForProject: {pid: [doc…]}, repos: {rid: [doc…]} }.
async function docsByProjectRepoBatch(projectIds, repoIds) {
  const out = { projects: {}, reposForProject: {}, repos: {} };
  const enrich = async (rows) => enrichDocs(rows);
  if (projectIds.length) {
    const rows = (await pool().query(
      `SELECT DISTINCT d.* FROM docs d JOIN doc_projects dp ON dp.doc_id = d.id
       WHERE dp.project_id = ANY($1) ORDER BY d.kind, d.title NULLS LAST`, [projectIds],
    )).rows;
    for (const e of await enrich(rows)) (out.projects[e.projects[0]] = out.projects[e.projects[0]] || []).push(e);
  }
  if (repoIds.length) {
    const rows = (await pool().query(
      `SELECT DISTINCT d.* FROM docs d JOIN doc_repos dr ON dr.doc_id = d.id
       WHERE dr.repo_id = ANY($1) ORDER BY d.kind, d.title NULLS LAST`, [repoIds],
    )).rows;
    for (const e of await enrich(rows)) (out.repos[e.repos[0]] = out.repos[e.repos[0]] || []).push(e);
  }
  // Mappe les docs des repos vers chaque projet qui les traverse.
  const assoc = (await pool().query("SELECT project_id, repo_id FROM project_repos")).rows;
  for (const a of assoc) {
    const rdocs = out.repos[a.repo_id];
    if (rdocs && rdocs.length) {
      const seen = new Set((out.projects[a.project_id] || []).map((d) => d.docId));
      for (const d of rdocs) {
        if (!seen.has(d.docId)) { (out.reposForProject[a.project_id] = out.reposForProject[a.project_id] || []).push(d); seen.add(d.docId); }
      }
    }
  }
  return out;
}

// ===========================================================================
// ADR-12 — Documents de référence (contexte architecture & comportement).
// Registre générique N:N docs ⇄ projets et/ou repos. `path` pointe le fichier
// (workspace/checkout) que les agents lisent — jamais de contenu en base.
// kind : adr-tech | specs-fonctionnelles | scenarios-gherkin.
// ===========================================================================

export const DOC_KINDS = ["adr-tech", "specs-fonctionnelles", "scenarios-gherkin"];

function rowToDoc(r) {
  if (!r) return null;
  return {
    docId: r.id, kind: r.kind, title: r.title ?? null, path: r.path,
    description: r.description ?? null, createdAt: r.created_at, createdBy: r.created_by,
  };
}

// Retourne {docId, projectId | repoId, kind, title, path, description, createdBy}
// — avec la cible (projet et/ou repo) pour un affichage contexte.
function hydrateDocs(rows) {
  const out = [];
  for (const r of rows) out.push(rowToDoc(r));
  return out;
}

async function docTargets(docId) {
  const [projects, repos] = await Promise.all([
    (await pool().query("SELECT project_id FROM doc_projects WHERE doc_id = $1 ORDER BY project_id", [docId])).rows.map((r) => r.project_id),
    (await pool().query("SELECT repo_id FROM doc_repos WHERE doc_id = $1 ORDER BY repo_id", [docId])).rows.map((r) => r.repo_id),
  ]);
  return { projects, repos };
}

// Docs rattachés à des projets (N:N).
async function getProjectsForDocs(rows) {
  if (!rows.length) return {};
  const ids = [...new Set(rows.map((r) => r.id))];
  const links = (await pool().query(
    "SELECT doc_id, project_id FROM doc_projects WHERE doc_id = ANY($1) ORDER BY project_id", [ids],
  )).rows;
  const map = {};
  for (const l of links) (map[l.doc_id] = map[l.doc_id] || []).push(l.project_id);
  return map;
}

// Docs rattachés à des repos (N:N).
async function getReposForDocs(rows) {
  if (!rows.length) return {};
  const ids = [...new Set(rows.map((r) => r.id))];
  const links = (await pool().query(
    "SELECT doc_id, repo_id FROM doc_repos WHERE doc_id = ANY($1) ORDER BY repo_id", [ids],
  )).rows;
  const map = {};
  for (const l of links) (map[l.doc_id] = map[l.doc_id] || []).push(l.repo_id);
  return map;
}

// Un doc enrichi avec ses cibles (projets/repos). rows = lignes docs.
async function enrichDocs(rows) {
  if (!rows.length) return [];
  const [projMap, repoMap] = await Promise.all([getProjectsForDocs(rows), getReposForDocs(rows)]);
  return rows.map((r) => ({ ...rowToDoc(r), projects: projMap[r.id] || [], repos: repoMap[r.id] || [] }));
}

export async function registerDoc({ kind, title, path, description, projectId, repoId, organizationId, createdBy }) {
  await ensureSchema();
  if (!DOC_KINDS.includes(kind)) throw new Error(`kind invalide : ${kind} (attendu : ${DOC_KINDS.join(" | ")})`);
  if (!path || !String(path).trim()) throw new Error("path (chemin du fichier) requis");
  const k = String(kind).trim();
  const p = String(path).trim();
  const org = organizationId || (projectId ? await orgIdOfProject(projectId) : null) || await defaultOrganizationId();
  const id = `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  await pool().query(
    `INSERT INTO docs (id, kind, title, path, description, organization_id, created_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, k, title ? String(title).trim() : null, p, description ? String(description).trim() : null, org, nowIso(), createdBy ?? null],
  );
  if (projectId) {
    await pool().query("INSERT INTO doc_projects (doc_id, project_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [id, String(projectId).trim()]);
  }
  if (repoId) {
    await pool().query("INSERT INTO doc_repos (doc_id, repo_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [id, String(repoId).trim()]);
  }
  return getDoc(id);
}

export async function updateDoc({ docId, kind, title, path, description, addProjectId, addRepoId }) {
  await ensureSchema();
  const sets = [];
  const params = [];
  if (kind !== undefined) {
    if (!DOC_KINDS.includes(kind)) throw new Error(`kind invalide : ${kind}`);
    params.push(kind); sets.push(`kind = $${params.length}`);
  }
  if (title !== undefined) { params.push(title === null ? null : String(title).trim()); sets.push(`title = $${params.length}`); }
  if (path !== undefined) { params.push(String(path).trim()); sets.push(`path = $${params.length}`); }
  if (description !== undefined) { params.push(description === null ? null : String(description).trim()); sets.push(`description = $${params.length}`); }
  if (sets.length) {
    params.push(nowIso(), docId);
    await pool().query(`UPDATE docs SET ${sets.join(", ")} WHERE id = $${params.length - 1}`, params);
  }
  if (addProjectId) await pool().query("INSERT INTO doc_projects (doc_id, project_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [docId, String(addProjectId).trim()]);
  if (addRepoId) await pool().query("INSERT INTO doc_repos (doc_id, repo_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [docId, String(addRepoId).trim()]);
  return getDoc(docId);
}

export async function deleteDoc(docId) {
  await ensureSchema();
  const existing = await getDoc(docId);
  if (!existing) return null;
  await pool().query("DELETE FROM docs WHERE id = $1", [docId]);
  return { docId, deleted: true };
}

export async function getDoc(docId) {
  await ensureSchema();
  const r = (await pool().query("SELECT * FROM docs WHERE id = $1", [docId])).rows[0];
  if (!r) return null;
  const [e] = await enrichDocs([r]);
  return e;
}

// Liste des docs, filtrée par kind / projet / repo.
// - projectId : docs rattachés au projet (et à ses repos ? via includeRepoDocs).
// - repoId : docs rattachés au repo.
export async function listDocs({ kind, projectId, repoId, includeRepoDocs = false, limit = 500 } = {}) {
  await ensureSchema();
  const conds = [];
  const params = [];
  if (kind) {
    if (!DOC_KINDS.includes(kind)) throw new Error(`kind invalide : ${kind}`);
    params.push(kind); conds.push(`d.kind = $${params.length}`);
  }
  let rows;
  if (projectId) {
    // docs du projet + (option) docs des repos du projet (dédupliqués).
    const prj = String(projectId);
    if (includeRepoDocs) {
      params.push(prj, prj);
      rows = (await pool().query(
        `SELECT DISTINCT d.* FROM docs d
         WHERE d.id IN (SELECT doc_id FROM doc_projects WHERE project_id = $${params.length - 1})
            OR d.id IN (SELECT dr.doc_id FROM doc_repos dr JOIN project_repos pr ON pr.repo_id = dr.repo_id WHERE pr.project_id = $${params.length})
         ${conds.length ? "AND " + conds.join(" AND ") : ""} ORDER BY d.kind, d.title NULLS LAST, d.created_at DESC`,
        params,
      )).rows;
    } else {
      params.push(prj);
      rows = (await pool().query(
        `SELECT DISTINCT d.* FROM docs d JOIN doc_projects dp ON dp.doc_id = d.id WHERE dp.project_id = $${params.length}
         ${conds.length ? "AND " + conds.join(" AND ") : ""} ORDER BY d.kind, d.title NULLS LAST, d.created_at DESC`,
        params,
      )).rows;
    }
  } else if (repoId) {
    params.push(String(repoId));
    rows = (await pool().query(
      `SELECT DISTINCT d.* FROM docs d JOIN doc_repos dr ON dr.doc_id = d.id WHERE dr.repo_id = $${params.length}
       ${conds.length ? "AND " + conds.join(" AND ") : ""} ORDER BY d.kind, d.title NULLS LAST, d.created_at DESC`,
      params,
    )).rows;
  } else {
    rows = (await pool().query(
      `SELECT d.* FROM docs d ${conds.length ? "WHERE " + conds.join(" AND ") : ""} ORDER BY d.kind, d.title NULLS LAST, d.created_at DESC LIMIT ${Number(limit) || 500}`,
      params,
    )).rows;
  }
  return enrichDocs(rows);
}

// Docs applicables à un PROJET (contextes test-agent / recette) : docs portés
// par le projet + docs portés par chacun de ses repos. Chaque doc enrichi d'une
// liste d'origines (projectIds/repoIds) pour l'affichage contexte.
export async function docsForProjectContext(projectId) {
  await ensureSchema();
  const rows = (await pool().query(
    `SELECT DISTINCT d.* FROM docs d
     WHERE d.id IN (SELECT doc_id FROM doc_projects WHERE project_id = $1)
        OR d.id IN (SELECT dr.doc_id FROM doc_repos dr JOIN project_repos pr ON pr.repo_id = dr.repo_id WHERE pr.project_id = $1)
     ORDER BY d.kind, d.title NULLS LAST, d.created_at DESC`, [projectId],
  )).rows;
  return enrichDocs(rows);
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
export async function startRecette({ project, projects, title, description, taskIds, status = "pending", sessionId = null, organizationId, createdBy }) {
  await ensureSchema();
  // 1 recette = 1 PROJET unique. Les repos transverses du projet (project_repos)
  // sont la portée de la recette — pas d'ajout de projets supplémentaires.
  const projs = [...new Set(((projects && projects.length ? projects : (project ? [project] : [])).map((p) => p && String(p).trim()).filter(Boolean)))];
  if (projs.length === 0) throw new Error("un projet requis pour une recette");
  if (projs.length > 1) throw new Error(`1 recette = 1 projet (reçu ${projs.length}) : ${projs.join(", ")} — les repos transverses du projet couvrent la portée`);
  const p = projs[0];
  await assertProjectExists(p);
  const org = organizationId || await orgIdOfProject(p) || await defaultOrganizationId();
  const recetteId = `RECT-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  await pool().query(
    "INSERT INTO recettes (recette_id, project, title, description, session_id, status, created_at, organization_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [recetteId, p, title || `Recette ${p}`, description ?? null, sessionId, status, nowIso(), org, createdBy ?? null],
  );
  for (const t of taskIds || []) {
    if (t) await linkRecetteTask(recetteId, t);
  }
  return getRecetteById(recetteId);
}

// Rattache une tâche à une recette (couverture). Garde : la tâche doit appartenir
// au PROJET de la recette (1 recette = 1 projet — les repos transverses du projet
// sont la portée, pas des projets supplémentaires).
export async function linkRecetteTask(recetteId, taskId) {
  await ensureSchema();
  const rec = (await pool().query("SELECT project FROM recettes WHERE recette_id = $1", [recetteId])).rows[0];
  if (!rec) throw new Error(`recette inconnue : ${recetteId}`);
  const t = (await pool().query("SELECT project FROM tasks WHERE id = $1", [taskId])).rows[0];
  if (!t) throw new Error(`tâche inconnue : ${taskId}`);
  if (t.project && t.project !== rec.project) {
    throw new Error(`la tâche ${taskId} appartient au projet ${t.project}, différent du projet de la recette (${rec.project})`);
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

// Liste les recettes d'un projet (ou toutes) — 1 recette = 1 projet (`recettes.project`).
export async function listProjectRecettes(project) {
  await ensureSchema();
  const rows = (await pool().query(
    `SELECT r.*,
            (SELECT COUNT(*) FROM recette_tasks rt WHERE rt.recette_id = r.recette_id) AS tasks_count,
            (SELECT COUNT(*) FROM recette_items i WHERE i.recette_id = r.recette_id) AS items_count
     FROM recettes r
     ${project ? "WHERE r.project = $1" : ""}
     ORDER BY r.created_at DESC`,
    project ? [project] : [],
  )).rows;
  return Promise.all(rows.map((r) => rowToRecetteSummary(r)));
}

async function rowToRecetteSummary(r) {
  const repos = await reposOfProject(r.project);
  return {
    recetteId: r.recette_id,
    project: r.project,
    repos,
    title: r.title,
    description: r.description ?? null,
    sessionId: r.session_id,
    status: r.status,
    createdAt: r.created_at,
    confirmedAt: r.confirmed_at,
    confirmedBy: r.confirmed_by,
    tasksCount: Number(r.tasks_count),
    itemsCount: Number(r.items_count),
  };
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

// Repos transverses d'un projet (project_repos) — la portée réelle d'une recette
// de ce projet. Ex: le projet mada-talk traverse les repos [mada-talk, oniria].
async function reposOfProject(project) {
  if (!project) return [];
  const rows = (await pool().query(
    `SELECT pr.repo_id, pr.role, r.name, r.git_path AS repo_dir, r.e2e_repo_dir, r.e2e_base_url
     FROM project_repos pr LEFT JOIN repos r ON r.id = pr.repo_id
     WHERE pr.project_id = $1 ORDER BY pr.repo_id`,
    [project],
  )).rows;
  return rows.map((x) => ({ repoId: x.repo_id, role: x.role ?? null, name: x.name ?? x.repo_id, repoDir: x.repo_dir ?? null, e2eRepoDir: x.e2e_repo_dir ?? null, e2eBaseUrl: x.e2e_base_url ?? null }));
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
  const items = (await pool().query(
    "SELECT id, content, classification, discussion, scope, project, title, acceptance, exec_order, vigilance, test_intent, doc_intent, status, created_task_id, created_at FROM recette_items WHERE recette_id = $1 ORDER BY id ASC",
    [recetteId],
  )).rows.map((i) => ({
    itemId: Number(i.id),
    content: i.content,
    classification: i.classification,
    discussion: i.discussion,
    scope: i.scope ? JSON.parse(i.scope) : [],
    project: i.project ?? r.project ?? null,
    title: i.title ?? null,
    acceptance: i.acceptance ?? null,
    execOrder: i.exec_order ?? null,
    vigilance: i.vigilance ?? null,
    testIntent: parseTestIntent(i.test_intent),
    docIntent: parseDocIntent(i.doc_intent),
    status: i.status,
    createdTaskId: i.created_task_id ?? null,
    createdAt: i.created_at,
  }));
  const documents = await listRecetteDocuments(recetteId);
  const repos = await reposOfProject(r.project);
  return {
    recetteId: r.recette_id,
    project: r.project,
    repos,
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

export async function addRecetteItem({ recetteId, project, content, classification, discussion, scope, title, acceptance, execOrder, vigilance, testIntent, docIntent }) {
  await ensureSchema();
  if (!content || !String(content).trim()) throw new Error("contenu requis pour un élément de recette");
  // 1 item cible le PROJET de la recette (1 recette = 1 projet). Défaut : `recettes.project`.
  const rec = (await pool().query("SELECT project FROM recettes WHERE recette_id = $1", [recetteId])).rows[0];
  if (!rec) throw new Error(`recette inconnue : ${recetteId}`);
  const recProj = rec.project;
  const given = project && String(project).trim() ? String(project).trim() : recProj;
  if (given !== recProj) throw new Error(`1 item cible le projet de la recette (${recProj}) — reçu ${given} (les repos transverses sont des repos, pas des projets)`);
  const target = recProj;
  const intent = normalizeTestIntent(testIntent);
  const docIntentNorm = normalizeDocIntent(docIntent);
  const r = (await pool().query(
    `INSERT INTO recette_items (recette_id, project, content, classification, discussion, scope, title, acceptance, exec_order, vigilance, test_intent, doc_intent, status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'open',$13) RETURNING id`,
    [recetteId, target, String(content).trim(), classification || "rework", discussion ?? null, scope && scope.length ? JSON.stringify(scope) : null, title ?? null, acceptance ?? null, execOrder ?? null, vigilance ?? null, intent ? JSON.stringify(intent) : null, docIntentNorm ? JSON.stringify(docIntentNorm) : null, nowIso()],
  )).rows[0];
  return getRecetteItem(Number(r.id));
}

// Valide/normalise une intention TEST capturée en recette.
function normalizeTestIntent(intent) {
  if (!intent) return null;
  const action = intent.action || (intent.testAction) || null;
  if (!["create", "update", "obsolete"].includes(action)) return null;
  const type = (intent.testType || intent.type) === "e2e" ? "e2e" : "unit";
  const out = {
    action,
    testType: type,
    target: intent.target || intent.e2eTestId || intent.specFile || null,
    scenario: intent.scenario || null,
    reason: intent.reason || null,
  };
  if (!out.target && !out.scenario && !out.reason) return null;
  return out;
}

// Valide/normalise une intention DOCUMENT capturée en recette (ADR/specs/Gherkin).
function normalizeDocIntent(intent) {
  if (!intent) return null;
  const action = intent.action || null;
  if (!["create", "update", "obsolete"].includes(action)) return null;
  const type = ["adr-tech", "specs-fonctionnelles", "scenarios-gherkin"].includes(intent.docType) ? intent.docType : null;
  const out = {
    action,
    docType: type || intent.kind || null,
    target: intent.target || intent.docId || null,
    summary: intent.summary || null,
    reason: intent.reason || null,
  };
  if (!out.docType && !out.target && !out.summary && !out.reason) return null;
  return out;
}

export async function updateRecetteItem({ itemId, content, classification, discussion, scope, project, title, acceptance, execOrder, vigilance, testIntent, docIntent, status, createdTaskId }) {
  await ensureSchema();
  const sets = [];
  const params = [];
  if (content !== undefined) {
    if (!content || !String(content).trim()) throw new Error("contenu requis pour un élément de recette");
    params.push(String(content).trim()); sets.push(`content = $${params.length}`);
  }
  if (classification) { params.push(classification); sets.push(`classification = $${params.length}`); }
  if (discussion !== undefined) { params.push(discussion); sets.push(`discussion = $${params.length}`); }
  if (scope !== undefined) { params.push(scope && scope.length ? JSON.stringify(scope) : null); sets.push(`scope = $${params.length}`); }
  if (project !== undefined) { params.push(project ? String(project).trim() : null); sets.push(`project = $${params.length}`); }
  if (title !== undefined) { params.push(title); sets.push(`title = $${params.length}`); }
  if (acceptance !== undefined) { params.push(acceptance); sets.push(`acceptance = $${params.length}`); }
  if (execOrder !== undefined) { params.push(execOrder ?? null); sets.push(`exec_order = $${params.length}`); }
  if (vigilance !== undefined) { params.push(vigilance); sets.push(`vigilance = $${params.length}`); }
  if (testIntent !== undefined) {
    const intent = normalizeTestIntent(testIntent);
    params.push(intent ? JSON.stringify(intent) : null);
    sets.push(`test_intent = $${params.length}`);
  }
  if (docIntent !== undefined) {
    const intent = normalizeDocIntent(docIntent);
    params.push(intent ? JSON.stringify(intent) : null);
    sets.push(`doc_intent = $${params.length}`);
  }
  if (status) { params.push(status); sets.push(`status = $${params.length}`); }
  if (createdTaskId !== undefined) { params.push(createdTaskId); sets.push(`created_task_id = $${params.length}`); }
  if (!sets.length) return getRecetteItem(itemId);
  params.push(itemId);
  await pool().query(`UPDATE recette_items SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
  return getRecetteItem(itemId);
}

async function getRecetteItem(itemId) {
  const r = (await pool().query(
    "SELECT id, recette_id, project, content, classification, discussion, scope, title, acceptance, exec_order, vigilance, test_intent, doc_intent, status, created_task_id, created_at FROM recette_items WHERE id = $1",
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
    testIntent: parseTestIntent(r.test_intent),
    docIntent: parseDocIntent(r.doc_intent),
    status: r.status,
    createdTaskId: r.created_task_id ?? null,
    createdAt: r.created_at,
  } : null;
}

function parseTestIntent(raw) {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    return o && o.action ? o : null;
  } catch {
    return null;
  }
}

function parseDocIntent(raw) {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    return o && o.action ? o : null;
  } catch {
    return null;
  }
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
// Tests E2E Playwright (cadrage 08) — entités de 1er niveau indépendantes des
// tâches : repo source + projets couverts (N:N), paramètres, exécutions
// propriété du test (origin : task|recette|ci|manual|session).
// ===========================================================================

// ID stable d'un test : déterministe pour (repo source = project, spec_file, scenario).
export function e2eStableId(project, specFile, scenario) {
  let h = 0x811c9dc5;
  for (const part of [project, specFile, scenario]) {
    for (let i = 0; i < part.length; i++) { h ^= part.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  }
  const hash = (h >>> 0).toString(36).slice(0, 8);
  const proj = String(project).toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "APP";
  return `E2E-${proj}-${hash}`;
}

// Lecteur de projets couverts d'un test (N:N e2e_test_projects).
// Fallback : si aucune ligne, le test couvre au minimum son repo source (project).
async function getE2EProjects(e2eTestId) {
  const rows = (await pool().query("SELECT project FROM e2e_test_projects WHERE e2e_test_id = $1 ORDER BY project", [e2eTestId])).rows;
  if (rows.length) return rows.map((r) => r.project);
  const t = (await pool().query("SELECT project FROM e2e_tests WHERE id = $1", [e2eTestId])).rows[0];
  return t ? [t.project] : [];
}

// Repos traversés par le test (ADR 11) — détail complet.
async function getE2ERepos(e2eTestId) {
  const rows = (await pool().query(
    `SELECT r.id, r.name, r.description, r.git_path, r.workspace, r.main_branch, r.e2e_repo_dir, r.e2e_base_url
     FROM e2e_test_repos x JOIN repos r ON r.id = x.repo_id
     WHERE x.e2e_test_id = $1 ORDER BY r.name ASC`, [e2eTestId],
  )).rows;
  if (rows.length) {
    return rows.map((r) => ({
      id: r.id, name: r.name, description: r.description ?? null, repoDir: r.git_path ?? null,
      workspace: r.workspace ?? null, mainBranch: r.main_branch ?? null,
      e2eRepoDir: r.e2e_repo_dir ?? null, e2eBaseUrl: r.e2e_base_url ?? null,
    }));
  }
  // Rétrocompat : aucun repo explicite → déduire depuis project du test.
  const t = (await pool().query("SELECT project FROM e2e_tests WHERE id = $1", [e2eTestId])).rows[0];
  if (!t) return [];
  const viaPrj = (await pool().query(
    `SELECT r.id, r.name, r.description, r.git_path, r.workspace, r.main_branch, r.e2e_repo_dir, r.e2e_base_url
     FROM project_repos pr JOIN repos r ON r.id = pr.repo_id WHERE pr.project_id = $1 ORDER BY r.name ASC`, [t.project],
  )).rows;
  const map = (r) => ({ id: r.id, name: r.name, description: r.description ?? null, repoDir: r.git_path ?? null, workspace: r.workspace ?? null, mainBranch: r.main_branch ?? null, e2eRepoDir: r.e2e_repo_dir ?? null, e2eBaseUrl: r.e2e_base_url ?? null });
  if (viaPrj.length) return viaPrj.map(map);
  const self = (await pool().query("SELECT id,name,description,git_path,workspace,main_branch,e2e_repo_dir,e2e_base_url FROM repos WHERE id=$1", [t.project])).rows;
  return self.map(map);
}

// Réécrit les repos traversés (N:N) — le repo contenant le spec est inclus si fourni.
export async function setE2ERepos(e2eTestId, repoIds) {
  const ids = [...new Set((Array.isArray(repoIds) ? repoIds : []).map((x) => String(x).trim()).filter(Boolean))];
  await pool().query("DELETE FROM e2e_test_repos WHERE e2e_test_id = $1", [e2eTestId]);
  for (const rid of ids) {
    await pool().query("INSERT INTO e2e_test_repos (e2e_test_id, repo_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [e2eTestId, rid]);
  }
  return getE2ERepos(e2eTestId);
}

// Réécrit les projets couverts (rétrocompat ADR 08) — désormais = REPOS traversés.
async function setE2EProjects(e2eTestId, project, coveredProjects) {
  const set = new Set([project, ...(Array.isArray(coveredProjects) ? coveredProjects.map(String) : [])].map((x) => x.trim()).filter(Boolean));
  await pool().query("DELETE FROM e2e_test_projects WHERE e2e_test_id = $1", [e2eTestId]);
  for (const prj of set) {
    await pool().query("INSERT INTO e2e_test_projects (e2e_test_id, project) VALUES ($1,$2) ON CONFLICT DO NOTHING", [e2eTestId, prj]);
  }
}

// Enregistre (ou réactive) un test dans le référentiel central. 1 test() = 1 entité.
// project = PROJET (produit) ; repoIds = repos traversés (ADR 11) — le spec vit
// dans l'un d'eux. coveredProjects accepté en rétrocompat (= repos).
export async function upsertE2ETest({ project, specFile, scenario, title, description, gherkin, coveredProjects, repoIds, organizationId, createdBy }) {
  await ensureSchema();
  if (!project || !specFile || !scenario) throw new Error("project (repo source), specFile et scenario requis");
  const p = String(project).trim();
  const now = nowIso();
  const org = organizationId || await orgIdOfProject(p) || await defaultOrganizationId();
  const r = (await pool().query(
    `INSERT INTO e2e_tests (id, project, spec_file, scenario, title, description, gherkin, status, version, first_seen_at, updated_at, organization_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'ACTIVE',1,$8,$8,$9,$10)
     ON CONFLICT (project, spec_file, scenario)
     DO UPDATE SET title = EXCLUDED.title,
                   description = COALESCE(EXCLUDED.description, e2e_tests.description),
                   gherkin = COALESCE(EXCLUDED.gherkin, e2e_tests.gherkin),
                   status = 'ACTIVE', updated_at = $8
     RETURNING id`,
    [e2eStableId(p, specFile, scenario), p, String(specFile).trim(), String(scenario).trim(), title ?? null, description ?? null, gherkin ?? null, now, org, createdBy ?? null],
  )).rows[0];
  await setE2EProjects(r.id, p, coveredProjects);
  // ADR 11 : repos traversés explicites. Si absents, défaut = les repos du
  // projet (via project_repos) puis, à défaut, le repo portant l'id du projet.
  if (Array.isArray(repoIds) && repoIds.length) {
    await setE2ERepos(r.id, repoIds);
  } else {
    const def = (await pool().query(
      `SELECT repo_id FROM project_repos WHERE project_id = $1
       UNION SELECT id FROM repos WHERE id = $1 ORDER BY 1`, [p],
    )).rows.map((x) => x.repo_id);
    if (def.length) await setE2ERepos(r.id, def);
  }
  return { id: r.id, project: p, specFile: String(specFile).trim(), scenario: String(scenario).trim() };
}

// Réactive un test existant (utilisé par la sync auto T10 quand un spec reparait).
export async function reactivateE2ETest(e2eTestId) {
  await ensureSchema();
  await pool().query("UPDATE e2e_tests SET status = 'ACTIVE', updated_at = $1 WHERE id = $2", [nowIso(), e2eTestId]);
  return getE2ETest(e2eTestId);
}

// Marque un test OBSOLETE (spec disparu du repo — sync auto T10). Jamais de suppression.
export async function markE2ETestObsolete(e2eTestId) {
  await ensureSchema();
  await pool().query("UPDATE e2e_tests SET status = 'OBSOLETE', updated_at = $1 WHERE id = $2 AND status <> 'OBSOLETE'", [nowIso(), e2eTestId]);
  return getE2ETest(e2eTestId);
}

// Passe un test en DRAFT (entité en cours de création via une session test-agent).
export async function draftE2ETest(e2eTestId) {
  await ensureSchema();
  await pool().query("UPDATE e2e_tests SET status = 'DRAFT', updated_at = $1 WHERE id = $2", [nowIso(), e2eTestId]);
  return getE2ETest(e2eTestId);
}

// Rattache (ou retire) la session de création/mise à jour du test.
export async function setE2ETestSession({ e2eTestId, sessionId }) {
  await ensureSchema();
  await pool().query("UPDATE e2e_tests SET session_id = $1, updated_at = $2 WHERE id = $3", [sessionId || null, nowIso(), e2eTestId]);
  return getE2ETest(e2eTestId);
}

export async function updateE2ETestMeta({ e2eTestId, title, description, gherkin, coveredProjects, repoIds }) {
  await ensureSchema();
  const sets = [];
  const params = [];
  const now = nowIso();
  if (title !== undefined) { params.push(title); sets.push(`title = $${params.length}`); }
  if (description !== undefined) { params.push(description); sets.push(`description = $${params.length}`); }
  if (gherkin !== undefined) { params.push(gherkin); sets.push(`gherkin = $${params.length}`); }
  if (sets.length) {
    params.push(now, e2eTestId);
    await pool().query(`UPDATE e2e_tests SET ${sets.join(", ")}, updated_at = $${params.length - 1} WHERE id = $${params.length}`, params);
  }
  if (Array.isArray(coveredProjects) && coveredProjects.length) {
    const t = await getE2ETestRow(e2eTestId);
    if (t) await setE2EProjects(e2eTestId, t.project, coveredProjects);
  }
  // ADR 11 : repos traversés (repos de code associés au test = couverture du
  // comportement). Réécrit la liste N:N quand repoIds est fourni (même vide).
  if (Array.isArray(repoIds)) await setE2ERepos(e2eTestId, repoIds);
  return getE2ETest(e2eTestId);
}

async function getE2ETestRow(e2eTestId) {
  const r = (await pool().query("SELECT * FROM e2e_tests WHERE id = $1", [e2eTestId])).rows[0];
  return r || null;
}

// Déclare/remplace les paramètres d'un test (valeurs défaut NON sensibles).
export async function setE2ETestParams(e2eTestId, params) {
  await ensureSchema();
  await pool().query("DELETE FROM e2e_test_params WHERE e2e_test_id = $1", [e2eTestId]);
  for (const prm of params || []) {
    if (!prm || !prm.name) continue;
    await pool().query(
      `INSERT INTO e2e_test_params (e2e_test_id, name, kind, default_value, secret_ref, required)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (e2e_test_id, name) DO UPDATE
         SET kind = EXCLUDED.kind, default_value = EXCLUDED.default_value,
             secret_ref = EXCLUDED.secret_ref, required = EXCLUDED.required`,
      [e2eTestId, String(prm.name), prm.kind || "string", prm.defaultValue ?? prm.default_value ?? null, prm.secretRef ?? prm.secret_ref ?? null, prm.required ? 1 : 0],
    );
  }
}

async function listE2ETestParamsRow(e2eTestId) {
  const rows = (await pool().query("SELECT * FROM e2e_test_params WHERE e2e_test_id = $1 ORDER BY name", [e2eTestId])).rows;
  return rows.map((r) => ({ name: r.name, kind: r.kind, defaultValue: r.default_value, secretRef: r.secret_ref, required: Boolean(r.required) }));
}

// Associe un test à une tâche (N:N typé : CREATED|UPDATED|REGRESSION|EXISTING + raison).
// Pure association : le test existe et s'exécute indépendamment de la tâche.
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

// Détail complet d'un test (1er niveau) : projets, params, tâches liées, exécutions.
export async function getE2ETest(e2eTestId) {
  await ensureSchema();
  const t = await getE2ETestRow(e2eTestId);
  if (!t) return null;
  const [repos, projects, params, tasks, lastExec, docs] = await Promise.all([
    getE2ERepos(e2eTestId),
    getE2EProjects(e2eTestId),
    listE2ETestParamsRow(e2eTestId),
    (async () => (await pool().query(
      `SELECT te.task_id, te.relation_type, te.reason FROM task_e2e te WHERE te.e2e_test_id = $1 ORDER BY te.task_id`, [e2eTestId],
    )).rows.map((r) => ({ taskId: r.task_id, relationType: r.relation_type, reason: r.reason })))(),
    (async () => (await pool().query(
      `SELECT x.status, x.origin, x.task_id, x.created_at, x.duration_ms FROM e2e_executions x
       WHERE x.e2e_test_id = $1 ORDER BY x.created_at DESC LIMIT 1`, [e2eTestId],
    )).rows[0] || null)(),
    docsForProjectContext(t.project), // ADR-12 : docs du projet (le test peut en dépendre)
  ]);
  return {
    e2eTestId: t.id,
    project: t.project,
    specFile: t.spec_file,
    scenario: t.scenario,
    title: t.title,
    description: t.description,
    gherkin: t.gherkin,
    status: t.status,
    sessionId: t.session_id,
    version: t.version,
    firstSeenAt: t.first_seen_at,
    updatedAt: t.updated_at,
    repos,          // ADR 11 : repos traversés (détail) — le spec vit dans l'un d'eux
    projects,       // rétrocompat ADR 08 : projets couverts (obsolète, gardé)
    params,
    linkedTasks: tasks,
    docs,           // ADR-12 : docs de référence du projet (adr-tech/specs/gherkin)
    lastExecution: lastExec ? {
      status: lastExec.status,
      origin: lastExec.origin,
      taskId: lastExec.task_id,
      createdAt: lastExec.created_at,
      durationMs: lastExec.duration_ms,
    } : null,
  };
}

// Liste globale des tests (filtres : projet couvert, tâche liée, statut, recherche).
export async function listE2ETests({ project, taskId, status, search, limit = 500 }) {
  await ensureSchema();
  const conds = [];
  const params = [];
  if (project) {
    params.push(String(project));
    conds.push(`t.project = $${params.length}`); // ADR 11 : project = PROJET (produit)
  }
  if (taskId) {
    params.push(String(taskId));
    conds.push(`t.id IN (SELECT e2e_test_id FROM task_e2e WHERE task_id = $${params.length})`);
  }
  if (status) { params.push(String(status)); conds.push(`t.status = $${params.length}`); }
  if (search) {
    params.push(`%${String(search)}%`);
    conds.push(`(t.title ILIKE $${params.length} OR t.scenario ILIKE $${params.length} OR t.spec_file ILIKE $${params.length})`);
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  params.push(Number(limit) || 500);
  const rows = (await pool().query(
    `SELECT t.*,
            (SELECT COALESCE(
               (SELECT jsonb_agg(project ORDER BY project) FILTER (WHERE project IS NOT NULL)
                FROM e2e_test_projects ep WHERE ep.e2e_test_id = t.id),
               jsonb_build_array(t.project))) AS projects,
            (SELECT COALESCE(jsonb_agg(xr.repo_id ORDER BY xr.repo_id) FILTER (WHERE xr.repo_id IS NOT NULL), '[]'::jsonb)
             FROM e2e_test_repos xr WHERE xr.e2e_test_id = t.id) AS repos,
            tk.task_count,
            (SELECT x.status FROM e2e_executions x WHERE x.e2e_test_id = t.id ORDER BY x.created_at DESC LIMIT 1) AS last_status,
            (SELECT x.origin FROM e2e_executions x WHERE x.e2e_test_id = t.id ORDER BY x.created_at DESC LIMIT 1) AS last_origin,
            (SELECT x.created_at FROM e2e_executions x WHERE x.e2e_test_id = t.id ORDER BY x.created_at DESC LIMIT 1) AS last_run_at
     FROM e2e_tests t
     LEFT JOIN LATERAL (SELECT count(*)::int AS task_count FROM task_e2e te WHERE te.e2e_test_id = t.id) tk ON true
     ${where} ORDER BY t.updated_at DESC LIMIT $${params.length}`,
    params,
  )).rows;
  return rows.map((r) => ({
    e2eTestId: r.id,
    project: r.project,
    specFile: r.spec_file,
    scenario: r.scenario,
    title: r.title,
    description: r.description,
    gherkin: r.gherkin,
    status: r.status,
    sessionId: r.session_id,
    projects: r.projects || [],
    repos: r.repos || [],
    taskCount: r.task_count || 0,
    lastStatus: r.last_status,
    lastOrigin: r.last_origin,
    lastRunAt: r.last_run_at,
  }));
}

// Liste les tests associés à une tâche (avec leur dernière exécution SUR LA TÂCHE).
export async function listTaskE2E(taskId) {
  await ensureSchema();
  const rows = (await pool().query(
    `SELECT t.id, t.project, t.spec_file, t.scenario, t.title, t.description, t.gherkin, t.status, t.session_id, t.version,
            te.relation_type, te.reason,
            (SELECT x.status FROM e2e_executions x WHERE x.e2e_test_id = t.id AND x.task_id = $1 ORDER BY x.created_at DESC LIMIT 1) AS last_status,
            (SELECT x.origin FROM e2e_executions x WHERE x.e2e_test_id = t.id AND x.task_id = $1 ORDER BY x.created_at DESC LIMIT 1) AS last_origin,
            (SELECT x.duration_ms FROM e2e_executions x WHERE x.e2e_test_id = t.id AND x.task_id = $1 ORDER BY x.created_at DESC LIMIT 1) AS last_duration_ms,
            (SELECT x.id FROM e2e_executions x WHERE x.e2e_test_id = t.id AND x.task_id = $1 ORDER BY x.created_at DESC LIMIT 1) AS last_execution_id
     FROM task_e2e te JOIN e2e_tests t ON t.id = te.e2e_test_id
     WHERE te.task_id = $1 ORDER BY t.scenario`,
    [taskId],
  )).rows;
  const out = [];
  for (const r of rows) {
    const projects = await getE2EProjects(r.id);
    const repos = await getE2ERepos(r.id);
    out.push({
      e2eTestId: r.id,
      project: r.project,
      projects,
      repos,           // ADR 11 : repos traversés (couverture code du test)
      specFile: r.spec_file,
      scenario: r.scenario,
      title: r.title,
      description: r.description,
      gherkin: r.gherkin,
      status: r.status,
      sessionId: r.session_id,
      version: r.version,
      relationType: r.relation_type,
      reason: r.reason,
      lastExecutionId: r.last_execution_id,
      lastStatus: r.last_status,
      lastOrigin: r.last_origin,
      lastDurationMs: r.last_duration_ms,
    });
  }
  return out;
}

// Enregistre une exécution E2E (statut PENDING/RUNNING puis mis à jour via update).
// L'exécution appartient au TEST ; origin = task|recette|ci|manual|session.
export async function recordE2EExecution({ e2eTestId, origin = "manual", taskId, deploymentId, planId, env, commitSha, branch, pipelineRef, status = "RUNNING", attempts = 1, paramValues, skipReason }) {
  await ensureSchema();
  if (!e2eTestId) throw new Error("e2eTestId requis");
  const id = `EXE-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const pv = paramValues ? JSON.stringify(paramValues) : null;
  await pool().query(
    `INSERT INTO e2e_executions (id, e2e_test_id, origin, task_id, deployment_id, plan_id, env, commit_sha, branch, pipeline_ref, status, attempts, skip_reason, created_at, param_values)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [id, e2eTestId, origin ?? null, taskId ?? null, deploymentId ?? null, planId ?? null, env ?? null, commitSha ?? null, branch ?? null, pipelineRef ?? null, status, attempts || 1, skipReason ?? null, nowIso(), pv],
  );
  return { id, e2eTestId, taskId: taskId ?? null, origin: origin ?? null, status };
}

// Met à jour une exécution (verdict, preuves, durée).
export async function updateE2EExecution({ executionId, status, durationMs, reportArtifactId, logsUrl, videoUrl, summary, verdictBy, executedAt, origin, skipReason }) {
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
  if (origin !== undefined) { params.push(origin); sets.push(`origin = $${params.length}`); }
  if (skipReason !== undefined) { params.push(skipReason); sets.push(`skip_reason = $${params.length}`); }
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
    origin: r.origin,
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
    skipReason: r.skip_reason,
    verdictBy: r.verdict_by,
    createdAt: r.created_at,
    paramValues: r.param_values,
  };
}

export async function listE2EExecutions({ e2eTestId, taskId, origin, limit = 100 }) {
  await ensureSchema();
  const conds = [];
  const params = [];
  if (e2eTestId) { params.push(e2eTestId); conds.push(`e2e_test_id = $${params.length}`); }
  if (taskId) { params.push(taskId); conds.push(`task_id = $${params.length}`); }
  if (origin) { params.push(origin); conds.push(`origin = $${params.length}`); }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  params.push(Number(limit) || 100);
  const rows = (await pool().query(
    `SELECT * FROM e2e_executions ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params,
  )).rows;
  return rows.map((r) => ({
    id: r.id,
    e2eTestId: r.e2e_test_id,
    origin: r.origin,
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
    skipReason: r.skip_reason,
    verdictBy: r.verdict_by,
    createdAt: r.created_at,
    paramValues: r.param_values,
  }));
}

// ===========================================================================
// Vars E2E (module vars/secrets unifié) — variables d'env par PROJET.
//   kind = 'variable' : valeur non sensible, stockée EN CLAIR (`value`).
//   kind = 'secret'   : valeur sensible, chiffrée AES-256-GCM (`value_enc`).
// name = la clé d'env injectée au run (ex. E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD).
// ===========================================================================

// Crée/remplace une var de projet. kind=variable → clair ; kind=secret → chiffré.
// Jamais de retour de valeur sensible en clair par les fonctions de lecture.
export async function setE2EVar({ project, name, kind, value, purpose }) {
  await ensureSchema();
  if (!project || !name || value === undefined || value === null || value === "") throw new Error("project, name et value requis");
  const k = kind === "secret" ? "secret" : "variable";
  const now = nowIso();
  if (k === "secret") {
    const { encryptSecret } = await import("./secret-crypto.mjs");
    await pool().query(
      `INSERT INTO e2e_vars (project, name, kind, value, value_enc, purpose, created_at, updated_at)
       VALUES ($1,$2,'secret',NULL,$3,$4,$5,$5)
       ON CONFLICT (project, name) DO UPDATE SET
         kind = 'secret', value = NULL, value_enc = EXCLUDED.value_enc,
         purpose = COALESCE(EXCLUDED.purpose, e2e_vars.purpose), updated_at = EXCLUDED.updated_at`,
      [String(project).trim(), String(name).trim(), encryptSecret(String(value)), purpose ?? null, now],
    );
  } else {
    await pool().query(
      `INSERT INTO e2e_vars (project, name, kind, value, value_enc, purpose, created_at, updated_at)
       VALUES ($1,$2,'variable',$3,NULL,$4,$5,$5)
       ON CONFLICT (project, name) DO UPDATE SET
         kind = 'variable', value = EXCLUDED.value, value_enc = NULL,
         purpose = COALESCE(EXCLUDED.purpose, e2e_vars.purpose), updated_at = EXCLUDED.updated_at`,
      [String(project).trim(), String(name).trim(), String(value), purpose ?? null, now],
    );
  }
  return { ok: true, project: String(project).trim(), name: String(name).trim(), kind: k };
}

// Liste les vars d'un projet — métadonnées SEULES, jamais la valeur secrète.
// kind optionnel (variable | secret) pour filtrer.
export async function listE2EVars(project, kind) {
  await ensureSchema();
  const params = [String(project).trim()];
  let where = "project = $1";
  if (kind === "variable" || kind === "secret") { params.push(kind); where += " AND kind = $" + params.length; }
  const rows = (await pool().query(
    `SELECT project, name, kind, value, purpose, created_at, updated_at FROM e2e_vars WHERE ${where} ORDER BY name`,
    params,
  )).rows;
  return rows.map((r) => ({
    project: r.project,
    name: r.name,
    kind: r.kind,
    value: r.kind === "variable" ? r.value : null, // secret : jamais de clair
    purpose: r.purpose,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

// Retourne la valeur d'une var (déchiffrée si secret) — usage interne : injection run.
export async function getE2EVarValue(project, name) {
  await ensureSchema();
  const r = (await pool().query("SELECT kind, value, value_enc FROM e2e_vars WHERE project = $1 AND name = $2", [String(project).trim(), String(name).trim()])).rows[0];
  if (!r) return null;
  if (r.kind === "variable") return r.value;
  const { decryptSecret } = await import("./secret-crypto.mjs");
  return decryptSecret(r.value_enc);
}

export async function deleteE2EVar({ project, name }) {
  await ensureSchema();
  await pool().query("DELETE FROM e2e_vars WHERE project = $1 AND name = $2", [String(project).trim(), String(name).trim()]);
  return { ok: true };
}

// ===========================================================================
// Batch d'orchestration (v0.9.0) — 1 session, N tâches, séquencées sans conflit.
// Phase 1 : LECTURE + enregistrement (aucun auto-avancement). Readiness et
// matrice de conflit sont CALCULÉES à la volée depuis les dépendances + les
// fichiers (déclarés via plans + réels via plan_commits).
// ===========================================================================

// Fichiers touchés par une tâche : union (déclarés = plans.file/absolute_path,
// réels = plan_commits.files[].path). Normalisés (pas de `/` final, pas de `./`).
async function taskTouchedFiles(taskId) {
  await ensureSchema();
  const seen = new Set();
  const norm = (p) => String(p || "").replace(/^\.\//, "").replace(/\/+$/, "");
  const plans = await pool().query(
    "SELECT file, absolute_path FROM plans WHERE task_id = $1", [taskId],
  );
  for (const p of plans.rows) {
    for (const f of [p.file, p.absolute_path]) if (norm(f)) seen.add(norm(f));
  }
  const commits = await pool().query(
    `SELECT pc.files FROM plan_commits pc
     JOIN plans pl ON pl.id = pc.plan_id
     WHERE pl.task_id = $1`, [taskId],
  );
  for (const c of commits.rows) {
    let arr = [];
    try { arr = c.files ? JSON.parse(c.files) : []; } catch {}
    for (const f of arr) if (f && norm(f.path)) seen.add(norm(f.path));
  }
  return [...seen];
}

// --- Phase 3 — interleaving fin au niveau ÉTAPE -----------------------------
// Pour une tâche, les étapes de ses plans avec leurs fichiers + leur statut.
// Une étape `done`/`in_progress` "occupe" ses fichiers ; une étape `todo` est la
// candidate. `blocked`/`skipped` n'occupent rien.
async function taskPlanSteps(taskId) {
  await ensureSchema();
  const rows = (await pool().query(
    `SELECT ps.step_id, ps.status, ps.files, pl.id AS plan_id
     FROM plan_steps ps JOIN plans pl ON pl.id = ps.plan_id
     WHERE pl.task_id = $1 ORDER BY pl.id ASC, ps.position ASC`,
    [taskId],
  )).rows;
  return rows.map((s) => {
    let files = [];
    try { files = s.files ? JSON.parse(s.files) : []; } catch { files = []; }
    return { planId: s.plan_id, stepId: s.step_id, status: s.status, files: files.filter(isPlausibleFile) };
  });
}

// Fichiers RÉELLEMENT touchés par les commits de la tâche (plan_commits.files).
async function taskCommittedFiles(taskId) {
  await ensureSchema();
  const rows = (await pool().query(
    `SELECT pc.files FROM plan_commits pc
     JOIN plans pl ON pl.id = pc.plan_id WHERE pl.task_id = $1`,
    [taskId],
  )).rows;
  const out = [];
  for (const c of rows) {
    let arr = [];
    try { arr = c.files ? JSON.parse(c.files) : []; } catch { arr = []; }
    for (const f of arr) if (f && f.path && isPlausibleFile(f.path)) out.push(normFile(f.path));
  }
  return [...new Set(out)];
}

// Un "fichier" plausible = pas de commande (espaces), extension connue ou glob.
function isPlausibleFile(p) {
  const s = String(p || "").trim();
  if (!s || /\s/.test(s)) return false;           // commande (npm run…, git push…)
  if (s.startsWith("npm") || s.startsWith("git") || s.startsWith("yarn")) return false;
  return /\.(tsx?|jsx?|mjs|cjs|json|md|css|html|sql|ya?ml|py|vue|feature|env)$/i.test(s)
    || /\*\.([a-z0-9]+)$/i.test(s);               // glob (ex: tests/*.test.ts)
}

function normFile(p) {
  return String(p || "").replace(/^\.\//, "").replace(/\/+$/, "");
}
function fileOverlaps(a, b) {
  return scopeOverlap(normFile(a), normFile(b)) || scopeOverlap(normFile(b), normFile(a));
}

// Matrice de conflit FICHIERS d'un batch. En Phase 3, la granularité descend à
// l'ÉTAPE : conflits d'étapes DÉCLARÉES (plan_steps.files) + conflits FICHIERS
// RÉELS (commits). Une paire sans aucun conflit = interleavable.
export async function batchConflictMatrix(batchId) {
  await ensureSchema();
  const tasks = (await pool().query(
    "SELECT task_id FROM batch_tasks WHERE batch_id = $1 ORDER BY position ASC", [batchId],
  )).rows.map((r) => r.task_id);
  const stepsByTask = {};
  const committedByTask = {};
  for (const t of tasks) {
    stepsByTask[t] = await taskPlanSteps(t);
    committedByTask[t] = await taskCommittedFiles(t);
  }
  const matrix = [];
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i], b = tasks[j];
      const stepConflicts = [];
      for (const sa of stepsByTask[a]) {
        for (const sb of stepsByTask[b]) {
          const common = [];
          for (const fa of sa.files) for (const fb of sb.files) if (fileOverlaps(fa, fb)) common.push({ a: fa, b: fb });
          if (common.length) stepConflicts.push({ stepA: { planId: sa.planId, stepId: sa.stepId, status: sa.status }, stepB: { planId: sb.planId, stepId: sb.stepId, status: sb.status }, files: common.slice(0, 5) });
        }
      }
      // Conflits réels (commits) non déjà couverts par un conflit d'étape déclaré.
      const realOverlaps = [];
      if (!stepConflicts.length) {
        for (const fa of committedByTask[a]) for (const fb of committedByTask[b]) {
          if (fileOverlaps(fa, fb)) realOverlaps.push({ a: fa, b: fb });
        }
      }
      if (stepConflicts.length || realOverlaps.length) {
        matrix.push({ taskA: a, taskB: b, stepConflicts, realOverlaps: realOverlaps.slice(0, 5) });
      }
    }
  }
  return matrix;
}

// Readiness d'un batch (Phase 3) : pour chaque tâche → prêt ? au sens TÂCHE
// (deps satisfaites + aucune ÉTAPE todo en conflit avec une étape active/done
// d'une autre tâche). `blockedSteps` liste les étapes qui attendent ;
// `interleavableWith` = tâches avec lesquelles AUCUN conflit d'étape n'existe.
export async function batchReadiness(batchId) {
  await ensureSchema();
  const tasks = (await pool().query(
    `SELECT t.id, t.dependencies FROM batch_tasks bt
     JOIN tasks t ON t.id = bt.task_id
     WHERE bt.batch_id = $1 ORDER BY bt.position ASC`, [batchId],
  )).rows;
  const stepsByTask = {};
  for (const t of tasks) stepsByTask[t.id] = await taskPlanSteps(t.id);
  // Fichiers "occupés" (étapes done/in_progress) par tâche active → sources de conflit.
  const doneSet = new Set();
  const activeSet = new Set();
  const allDepIds = new Set();
  for (const t of tasks) {
    const deps = (() => { try { return t.dependencies ? JSON.parse(t.dependencies) : []; } catch { return []; } })();
    for (const d of deps) allDepIds.add(d);
  }
  // État réel des dépendances : dans le batch → doneSet local ; hors batch →
  // on lit leur exécution courante (une dep faite ailleurs ne bloque pas le batch).
  const externalStatus = new Map();
  if (allDepIds.size) {
    const ids = [...allDepIds];
    const rows = (await pool().query(
      `SELECT DISTINCT ON (t.id) t.id, e.status FROM tasks t
       LEFT JOIN executions e ON e.task_id = t.id
       WHERE t.id = ANY($1) ORDER BY t.id, e.attempt DESC`, [ids],
    )).rows;
    for (const r of rows) externalStatus.set(r.id, r.status);
  }
  for (const t of tasks) {
    const exec = await getCurrentExecution(t.id);
    const st = exec ? exec.status : "queued";
    if (st === "done") doneSet.add(t.id);
    else if (ACTIVE_STATUSES.includes(st)) activeSet.add(t.id);
  }
  const isSatisfied = (depId) => {
    if (doneSet.has(depId)) return true;
    const st = externalStatus.get(depId);
    return st === "done" || st === "deployed" || st === "post_deploy_verified";
  };
  return tasks.map((t) => {
    const deps = (() => { try { return t.dependencies ? JSON.parse(t.dependencies) : []; } catch { return []; } })();
    const unsatisfied = deps.filter((d) => !isSatisfied(d));
    const todoSteps = stepsByTask[t.id].filter((s) => s.status === "todo");
    const blockedSteps = [];
    const interleavableWith = [];
    for (const other of tasks) {
      if (other.id === t.id) continue;
      const otherBusy = stepsByTask[other.id].filter((s) => activeSet.has(other.id) ? (s.status === "done" || s.status === "in_progress") : (s.status === "done"));
      let blockedHere = [];
      for (const ts of todoSteps) {
        for (const os of otherBusy) {
          const common = [];
          for (const fa of ts.files) for (const fb of os.files) if (fileOverlaps(fa, fb)) common.push({ mine: fa, theirs: fb });
          if (common.length) { blockedHere.push({ myStep: ts.stepId, otherTask: other.id, otherStep: os.stepId, files: common.slice(0, 3) }); break; }
        }
      }
      if (blockedHere.length) blockedSteps.push(...blockedHere);
      else interleavableWith.push(other.id);
    }
    const isActive = activeSet.has(t.id);
    const ready = !doneSet.has(t.id) && unsatisfied.length === 0 && blockedSteps.length === 0;
    return {
      taskId: t.id,
      active: isActive,
      done: doneSet.has(t.id),
      dependencies: deps,
      unsatisfiedDeps: unsatisfied,
      blockedSteps,
      interleavableWith: [...new Set(interleavableWith)],
      ready,
    };
  });
}

export async function createBatch({ project, title, recetteId, taskIds, maxParallel = 2, sessionId = null, launchMode = "batch", createdBy }) {
  await ensureSchema();
  if (!project || !String(project).trim()) throw new Error("projet requis pour un batch");
  if (!title || !String(title).trim()) throw new Error("titre requis pour un batch");
  await assertProjectExists(String(project).trim());
  const mode = ["batch", "session", "manual"].includes(launchMode) ? launchMode : "batch";
  const id = `BATCH-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  await pool().query(
    `INSERT INTO batches (id, project, title, recette_id, session_id, max_parallel, launch_mode, status, created_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9)`,
    [id, String(project).trim(), String(title).trim(), recetteId ?? null, sessionId ?? null, Math.max(1, Math.min(8, maxParallel || 2)), mode, nowIso(), createdBy ?? null],
  );
  for (const [i, t] of (taskIds || []).entries()) {
    if (!t) continue;
    await pool().query(
      "INSERT INTO batch_tasks (batch_id, task_id, position) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
      [id, String(t), i],
    );
  }
  return getBatch(id);
}

export async function setBatchLaunchMode(batchId, launchMode) {
  await ensureSchema();
  if (!["batch", "session", "manual"].includes(launchMode)) throw new Error(`mode de lancement invalide : ${launchMode}`);
  const r = (await pool().query("UPDATE batches SET launch_mode = $1 WHERE id = $2 RETURNING id", [launchMode, batchId])).rows[0];
  if (!r) throw new Error(`batch inconnu : ${batchId}`);
  return getBatch(batchId);
}

export async function getBatch(batchId) {
  await ensureSchema();
  const b = (await pool().query("SELECT * FROM batches WHERE id = $1", [batchId])).rows[0];
  if (!b) return null;
  const tasks = (await pool().query(
    "SELECT task_id, position FROM batch_tasks WHERE batch_id = $1 ORDER BY position ASC", [batchId],
  )).rows.map((r) => r.task_id);
  const [readiness, conflicts] = await Promise.all([batchReadiness(batchId), batchConflictMatrix(batchId)]);
  return {
    batchId: b.id,
    project: b.project,
    title: b.title,
    recetteId: b.recette_id ?? null,
    sessionId: b.session_id ?? null,
    maxParallel: b.max_parallel,
    launchMode: b.launch_mode ?? "batch",
    status: b.status,
    createdAt: b.created_at,
    createdBy: b.created_by,
    tasks,
    readiness,
    conflictMatrix: conflicts,
  };
}

export async function listBatches(project) {
  await ensureSchema();
  const rows = (await pool().query(
    `SELECT b.*, (SELECT COUNT(*) FROM batch_tasks bt WHERE bt.batch_id = b.id) AS tasks_count
     FROM batches b ${project ? "WHERE b.project = $1" : ""} ORDER BY b.created_at DESC`,
    project ? [project] : [],
  )).rows;
  return rows.map((b) => ({
    batchId: b.id, project: b.project, title: b.title, recetteId: b.recette_id ?? null,
    sessionId: b.session_id ?? null, maxParallel: b.max_parallel, launchMode: b.launch_mode ?? "batch",
    status: b.status, createdAt: b.created_at, createdBy: b.created_by, tasksCount: Number(b.tasks_count),
  }));
}

export async function addBatchTask(batchId, taskId) {
  await ensureSchema();
  if (!(await pool().query("SELECT 1 FROM batches WHERE id = $1", [batchId])).rows[0]) throw new Error(`batch inconnu : ${batchId}`);
  if (!(await getTask(taskId))) throw new Error(`tâche inconnue : ${taskId}`);
  const pos = (await pool().query("SELECT COALESCE(MAX(position), -1)+1 AS p FROM batch_tasks WHERE batch_id = $1", [batchId])).rows[0].p;
  await pool().query(
    "INSERT INTO batch_tasks (batch_id, task_id, position) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
    [batchId, String(taskId), pos],
  );
  return getBatch(batchId);
}

export async function removeBatchTask(batchId, taskId) {
  await ensureSchema();
  await pool().query("DELETE FROM batch_tasks WHERE batch_id = $1 AND task_id = $2", [batchId, String(taskId)]);
  return getBatch(batchId);
}

export async function setBatchSession(batchId, sessionId) {
  await ensureSchema();
  const r = (await pool().query("UPDATE batches SET session_id = $1 WHERE id = $2 RETURNING id", [sessionId ?? null, batchId])).rows[0];
  if (!r) throw new Error(`batch inconnu : ${batchId}`);
  return getBatch(batchId);
}

export async function setBatchStatus(batchId, status) {
  await ensureSchema();
  if (!["active", "completed", "aborted"].includes(status)) throw new Error(`statut de batch invalide : ${status}`);
  const r = (await pool().query("UPDATE batches SET status = $1 WHERE id = $2 RETURNING id", [status, batchId])).rows[0];
  if (!r) throw new Error(`batch inconnu : ${batchId}`);
  return getBatch(batchId);
}

// ===========================================================================
// Organisations (v0.9.47) — tenant de premier niveau. Nom + description.
// ===========================================================================
export async function registerOrganization({ id, name, description, isDefault, coderUrl, coderToken, coderTemplate, gitToken, createdBy }) {
  await ensureSchema();
  if (!id || !String(id).trim()) throw new Error("identifiant d'organisation requis");
  if (!name || !String(name).trim()) throw new Error("nom d'organisation requis");
  const slug = String(id).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  await pool().query(
    `INSERT INTO organizations (id, name, description, created_at, created_by)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description`,
    [slug, String(name).trim(), description ?? null, nowIso(), createdBy ?? null],
  );
  if (coderUrl !== undefined) {
    await pool().query("UPDATE organizations SET coder_url = $1 WHERE id = $2", [coderUrl ? String(coderUrl).trim() : null, slug]);
  }
  if (coderTemplate !== undefined) {
    await pool().query("UPDATE organizations SET coder_template = $1 WHERE id = $2", [coderTemplate ? String(coderTemplate).trim() : null, slug]);
  }
  // Tokens (Coder, git) : chiffrés (jamais en clair). Fourni → remplace ; absent → inchangé.
  const { encryptSecret } = await import("./secret-crypto.mjs");
  if (coderToken !== undefined && coderToken !== null && String(coderToken).trim()) {
    await pool().query("UPDATE organizations SET coder_token_enc = $1 WHERE id = $2", [encryptSecret(String(coderToken).trim()), slug]);
  }
  if (gitToken !== undefined && gitToken !== null && String(gitToken).trim()) {
    await pool().query("UPDATE organizations SET git_token_enc = $1 WHERE id = $2", [encryptSecret(String(gitToken).trim()), slug]);
  }
  if (isDefault) await setDefaultOrganization(slug);
  return getOrganization(slug);
}

// Configuration Coder + git d'une organisation — usage INTERNE (tokens déchiffrés,
// jamais renvoyés par les outils de lecture).
export async function getOrganizationCoderConfig(id) {
  await ensureSchema();
  const r = (await pool().query("SELECT coder_url, coder_token_enc, coder_template, git_token_enc FROM organizations WHERE id = $1", [id])).rows[0];
  if (!r) return null;
  const { decryptSecret } = await import("./secret-crypto.mjs");
  const dec = (v) => { if (!v) return null; try { return decryptSecret(v); } catch { return null; } };
  return { url: r.coder_url ?? null, token: dec(r.coder_token_enc), template: r.coder_template ?? null, gitToken: dec(r.git_token_enc) };
}

// --- Tokens git multiples PAR ORGANISATION (v0.10) ---------------------------
// PAT git paramétrables par organisation. Le token à utiliser pour un repo
// associé à un projet est choisi lors de la liaison (project_repos.git_token_id) ;
// sinon fallback sur le token par défaut de l'organisation (git_token_enc).
export async function addOrgGitToken({ org, name, token, createdBy }) {
  await ensureSchema();
  if (!org || !String(org).trim()) throw new Error("organisation requise");
  if (!name || !String(name).trim()) throw new Error("libellé du token requis");
  if (!token || !String(token).trim()) throw new Error("token requis");
  if (!(await getOrganization(org))) throw new Error(`organisation inconnue : ${org}`);
  const { encryptSecret } = await import("./secret-crypto.mjs");
  const id = `gt_${String(org).toLowerCase()}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await pool().query(
    `INSERT INTO org_git_tokens (id, org, name, token_enc, created_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, org, String(name).trim(), encryptSecret(String(token).trim()), nowIso(), createdBy ?? null],
  );
  return { id, name: String(name).trim(), org };
}

export async function listOrgGitTokens(org) {
  await ensureSchema();
  const rows = (await pool().query(
    "SELECT id, org, name, token_enc, created_at, created_by FROM org_git_tokens WHERE org = $1 ORDER BY created_at ASC",
    [org],
  )).rows;
  return rows.map((r) => ({ id: r.id, org: r.org, name: r.name, hasToken: !!r.token_enc, createdAt: r.created_at, createdBy: r.created_by ?? null }));
}

export async function deleteOrgGitToken({ id, org }) {
  await ensureSchema();
  await pool().query("DELETE FROM org_git_tokens WHERE id = $1 AND org = $2", [id, org]);
  // Nettoie les liaisons repo↔projet qui référençaient ce token.
  await pool().query("UPDATE project_repos SET git_token_id = NULL WHERE git_token_id = $1", [id]);
  return { ok: true, id };
}

// Résolution DÉCHIFFRÉE d'un token git — usage INTERNE uniquement (clone/pull/push).
// Retourne { id, name, token } ou null.
export async function getOrgGitToken(org, gitTokenId) {
  await ensureSchema();
  if (!gitTokenId) return null;
  const r = (await pool().query("SELECT id, org, name, token_enc FROM org_git_tokens WHERE id = $1 AND org = $2", [gitTokenId, org])).rows[0];
  if (!r) return null;
  const { decryptSecret } = await import("./secret-crypto.mjs");
  let token = null;
  try { token = decryptSecret(r.token_enc); } catch {}
  if (!token) return null;
  return { id: r.id, name: r.name, token };
}

// Token git EFFECTIF pour une liaison repo↔projet : celui choisi à l'association
// (git_token_id) sinon le token par défaut de l'organisation. Usage INTERNE.
export async function getProjectReposGitToken(projectId, repoId) {
  await ensureSchema();
  const assoc = (await pool().query(
    "SELECT pr.git_token_id, p.organization_id FROM project_repos pr JOIN projects p ON p.id = pr.project_id WHERE pr.project_id = $1 AND pr.repo_id = $2",
    [projectId, repoId],
  )).rows[0];
  if (!assoc) return null;
  const org = assoc.organization_id || "onirtech";
  if (assoc.git_token_id) {
    const t = await getOrgGitToken(org, assoc.git_token_id);
    if (t) return t;
  }
  const cfg = await getOrganizationCoderConfig(org);
  return cfg && cfg.gitToken ? { id: null, name: null, token: cfg.gitToken } : null;
}

// Définit l'organisation par défaut (une seule ; les autres sont désactivées).
export async function setDefaultOrganization(id) {
  await ensureSchema();
  const org = await getOrganization(id);
  if (!org) throw new Error(`organisation inconnue : ${id}`);
  await pool().query("UPDATE organizations SET is_default = false WHERE is_default = true");
  await pool().query("UPDATE organizations SET is_default = true WHERE id = $1", [id]);
  return getOrganization(id);
}

export async function defaultOrganization() {
  await ensureSchema();
  const r = (await pool().query("SELECT id FROM organizations WHERE is_default = true LIMIT 1")).rows[0];
  return r ? r.id : null;
}

export async function getOrganization(id) {
  await ensureSchema();
  const r = (await pool().query("SELECT * FROM organizations WHERE id = $1", [id])).rows[0];
  if (!r) return null;
  const gitTokens = await listOrgGitTokens(id);
  return { id: r.id, name: r.name, description: r.description ?? null, isDefault: !!r.is_default, coderUrl: r.coder_url ?? null, coderTemplate: r.coder_template ?? null, hasCoderToken: !!r.coder_token_enc, hasGitToken: !!r.git_token_enc, gitTokens, createdAt: r.created_at, createdBy: r.created_by ?? null };
}

export async function listOrganizations() {
  await ensureSchema();
  const rows = (await pool().query("SELECT * FROM organizations ORDER BY is_default DESC, name ASC")).rows;
  const tokensByOrg = new Map();
  for (const org of rows) tokensByOrg.set(org.id, await listOrgGitTokens(org.id));
  return rows.map((r) => ({ id: r.id, name: r.name, description: r.description ?? null, isDefault: !!r.is_default, coderUrl: r.coder_url ?? null, coderTemplate: r.coder_template ?? null, hasCoderToken: !!r.coder_token_enc, hasGitToken: !!r.git_token_enc, gitTokens: tokensByOrg.get(r.id) || [], createdAt: r.created_at, createdBy: r.created_by ?? null }));
}

export async function deleteOrganization(id) {
  await ensureSchema();
  const used = (await pool().query("SELECT 1 FROM projects WHERE organization_id = $1 LIMIT 1", [id])).rows[0];
  if (used) throw new Error(`organisation non vide : des projets y sont rattachés`);
  await pool().query("DELETE FROM organizations WHERE id = $1", [id]);
  return { ok: true, id };
}

// organization_id d'un projet (héritage) — null si inconnu.
async function orgIdOfProject(project) {
  if (!project) return null;
  const r = (await pool().query("SELECT organization_id FROM projects WHERE id = $1", [project])).rows[0];
  return r ? r.organization_id : null;
}

// Organisation par défaut (la plus ancienne) — repli si non fournie.
async function defaultOrganizationId() {
  const r = (await pool().query("SELECT id FROM organizations ORDER BY created_at ASC LIMIT 1")).rows[0];
  return r ? r.id : "onirtech";
}
