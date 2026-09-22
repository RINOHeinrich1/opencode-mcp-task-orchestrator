// db.mjs — Couche PostgreSQL du Task Registry.
// Écriture atomique (transaction), optimistic lock (colonne version),
// journal append-only (events).
import pg from "pg";
import Database from "better-sqlite3"; // lecture seule d'opencode.db (chaîne de sessions)
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname, basename, normalize } from "node:path";
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

// Version LOGIQUE du schéma. À INCRÉMENTER à chaque évolution de `schema.sql`
// OU de `migrate()` : `ensureSchema()` saute l'apply complet quand le marqueur
// `schema_meta.schema_version` en base est à jour. L'idempotence reste
// préservée : toute version différente ⇒ rejeu complet (toutes les DDL sont
// `IF NOT EXISTS`), sous verrou advisory.
const SCHEMA_VERSION = "2026-09-22-evaluation-session";
// Clé arbitraire du verrou advisory PostgreSQL sérialisant l'apply du schéma
// entre process concurrents (session-level, libéré dans le `finally`).
const SCHEMA_LOCK_KEY = 918273645;

// Lit la version de schéma marquée en base. `null` si la table n'existe pas
// encore (base neuve) ou si la clé est absente ⇒ apply complet.
async function readSchemaVersion() {
  try {
    const r = await pool().query("SELECT value FROM schema_meta WHERE key = 'schema_version'");
    return r.rows[0] ? String(r.rows[0].value) : null;
  } catch {
    return null;
  }
}

// Écrit (upsert) le marqueur de version — UNIQUEMENT après un apply réussi.
async function writeSchemaVersion(version) {
  await pool().query(
    `INSERT INTO schema_meta (key, value, updated_at) VALUES ('schema_version', $1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [version, new Date().toISOString()],
  );
}

// Applique le schéma une fois par process. Chemin rapide : marqueur à jour ⇒
// AUCUN DDL (~2 ms) au lieu du rejeu de `schema.sql` + `migrate()` (~240 ms).
// Sinon apply complet sous `pg_advisory_lock` + re-vérification du marqueur
// après acquisition (deux process ne rejouent pas les DDL en parallèle) ;
// `_schemaPromise` est réinitialisé en cas d'échec (retentative au prochain appel).
let _schemaReady = false;
let _schemaPromise = null;
async function ensureSchema() {
  if (_schemaReady) return;
  if (!_schemaPromise) {
    _schemaPromise = (async () => {
      // 1) Chemin rapide : la base porte déjà la version courante.
      if ((await readSchemaVersion()) === SCHEMA_VERSION) {
        _schemaReady = true;
        return;
      }
      // 2) Apply complet sérialisé par un verrou advisory.
      const client = await pool().connect();
      try {
        await client.query("SELECT pg_advisory_lock($1)", [SCHEMA_LOCK_KEY]);
        // Re-check après acquisition : un autre process a pu appliquer entre-temps.
        if ((await readSchemaVersion()) !== SCHEMA_VERSION) {
          await client.query(readFileSync(join(__dirname, "schema.sql"), "utf8"));
          await migrate();
          await writeSchemaVersion(SCHEMA_VERSION);
        }
        _schemaReady = true;
      } finally {
        try { await client.query("SELECT pg_advisory_unlock($1)", [SCHEMA_LOCK_KEY]); } catch {}
        client.release();
      }
    })();
    // Échec ⇒ on oublie la promesse pour permettre une retentative propre.
    _schemaPromise.catch(() => { _schemaPromise = null; });
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
  // Signal « comportement réel ≠ scénario » (évaluateur) : remarques + auteur + date.
  await pool().query("ALTER TABLE e2e_tests ADD COLUMN IF NOT EXISTS incoherent_remarks TEXT");
  await pool().query("ALTER TABLE e2e_tests ADD COLUMN IF NOT EXISTS incoherent_by TEXT");
  await pool().query("ALTER TABLE e2e_tests ADD COLUMN IF NOT EXISTS incoherent_at TEXT");
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
  // LEGACY (T-20260920-162801-jxtr) : `recette_documents` est fusionnée dans
  // `artifacts` (doc_type ∈ {recette_doc, recette_report}, content_id = recetteId).
  // Une base NEUVE ne la crée plus ; les bases existantes sont migrées puis
  // neutralisées (renommée `legacy_recette_documents`) — JAMAIS supprimée.
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
  // ARTEFACTS — table polymorphe UNIQUE (T-20260920-162801-jxtr).
  // Expansion ADDITIVE d'une base existante : `artifacts` (ancien silo tâche)
  // reçoit les colonnes du modèle cible ; `artifact_projects`/`artifact_repos`
  // remplacent doc_projects/doc_repos. Aucune perte ; idempotent.
  // =========================================================================
  await pool().query(`CREATE TABLE IF NOT EXISTS artifacts (
    id INTEGER GENERATED ALWAYS AS IDENTITY,
    artifact_id TEXT PRIMARY KEY,
    doc_type TEXT NOT NULL DEFAULT 'autre',
    content_id TEXT,
    kind TEXT NOT NULL DEFAULT 'autre',
    title TEXT, path TEXT, nature TEXT,
    source TEXT NOT NULL DEFAULT 'import',
    meta JSONB, description TEXT, status TEXT, context TEXT,
    decision TEXT, consequences TEXT, replaced_by TEXT,
    is_global INTEGER NOT NULL DEFAULT 0,
    organization_id TEXT, created_at TEXT NOT NULL, updated_at TEXT, created_by TEXT
  )`);
  await pool().query("ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS doc_type TEXT NOT NULL DEFAULT 'autre'");
  await pool().query("ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS content_id TEXT");
  await pool().query("ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS nature TEXT");
  await pool().query("ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'import'");
  await pool().query("ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS meta JSONB");
  await pool().query("ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS description TEXT");
  await pool().query("ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS status TEXT");
  await pool().query("ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS context TEXT");
  await pool().query("ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS decision TEXT");
  await pool().query("ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS consequences TEXT");
  await pool().query("ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS replaced_by TEXT");
  await pool().query("ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS is_global INTEGER NOT NULL DEFAULT 0");
  await pool().query("ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS organization_id TEXT");
  await pool().query("ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS updated_at TEXT");
  await pool().query("ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS created_by TEXT");
  await pool().query("CREATE INDEX IF NOT EXISTS idx_artifacts_doc_type ON artifacts(doc_type)");
  await pool().query("CREATE INDEX IF NOT EXISTS idx_artifacts_content ON artifacts(content_id)");
  await pool().query("CREATE INDEX IF NOT EXISTS idx_artifacts_kind ON artifacts(kind)");
  // NB : `content_id` est ajoutée NULLABLE sur une base EXISTANTE (des lignes
  // préexistent) ; le backfill ci-dessous la remplit depuis `task_id`.
  await pool().query(`CREATE TABLE IF NOT EXISTS artifact_projects (
    artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id) ON DELETE CASCADE,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    PRIMARY KEY (artifact_id, project_id)
  )`);
  await pool().query("CREATE INDEX IF NOT EXISTS idx_artifact_projects_project ON artifact_projects(project_id)");
  await pool().query(`CREATE TABLE IF NOT EXISTS artifact_repos (
    artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id) ON DELETE CASCADE,
    repo_id     TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    PRIMARY KEY (artifact_id, repo_id)
  )`);
  await pool().query("CREATE INDEX IF NOT EXISTS idx_artifact_repos_repo ON artifact_repos(repo_id)");
  // Backfill idempotent du silo TÂCHE (ne s'exécute que si `task_id` existe).
  const hasArtifactsTaskId = (await pool().query(
    "SELECT 1 FROM information_schema.columns WHERE table_name = 'artifacts' AND column_name = 'task_id'",
  )).rows.length > 0;
  if (hasArtifactsTaskId) {
    // Levée de contrainte (PAS un DROP de colonne) : les familles non-task
    // (recette/docs/attachments) n'ont pas de `task_id`.
    await pool().query("ALTER TABLE artifacts ALTER COLUMN task_id DROP NOT NULL");
    await pool().query("UPDATE artifacts SET content_id = task_id WHERE content_id IS NULL");
  }
  await pool().query(
    `UPDATE artifacts SET doc_type = CASE kind
       WHEN 'plan' THEN 'plan' WHEN 'audit' THEN 'audit_report'
       WHEN 'report' THEN 'task_report' ELSE 'autre' END
     WHERE doc_type IS NULL OR (doc_type = 'autre' AND kind IN ('plan','audit','report'))`,
  );
  // LEGACY (T-20260920-162801-jxtr) : `docs`, `doc_projects`, `doc_repos`,
  // `doc_attachments` ne sont PLUS créées ici (fusionnées dans `artifacts`).
  // Les bases existantes sont migrées puis NEUTRALISÉES (renommées `legacy_*`)
  // par `scripts/artifacts-fusion-migration.mjs` — JAMAIS supprimées.
  // Conflits code ↔ ADR (item 125) : DDL identique à schema.sql (source logique)
  // pour créer la table sur une base PostgreSQL déjà migrée, de façon idempotente.
  await pool().query(`CREATE TABLE IF NOT EXISTS adr_conflicts (
    conflict_id TEXT PRIMARY KEY,
    adr_id      TEXT NOT NULL REFERENCES artifacts(artifact_id) ON DELETE CASCADE,
    task_id     TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    description TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'open',
    decision_id TEXT,
    created_at  TEXT NOT NULL,
    created_by  TEXT
  )`);
  await pool().query("CREATE INDEX IF NOT EXISTS idx_adr_conflicts_adr ON adr_conflicts(adr_id)");
  await pool().query("CREATE INDEX IF NOT EXISTS idx_adr_conflicts_status ON adr_conflicts(status)");
  // Points de vigilance ADR en recette/test (item 126) : DDL identique à
  // schema.sql (source logique) pour créer la table sur une base PostgreSQL
  // déjà migrée, de façon idempotente. APPEND-ONLY (aucun DELETE) ; seul
  // `status` transite open → resolved. `recettes` existe (schema.sql appliqué
  // en amont par ensureSchema) → FK valide.
  await pool().query(`CREATE TABLE IF NOT EXISTS adr_vigilances (
    vigilance_id    TEXT PRIMARY KEY,
    project         TEXT NOT NULL,
    recette_id      TEXT REFERENCES recettes(recette_id) ON DELETE CASCADE,
    task_id         TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    session_id      TEXT,
    type            TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'open',
    entity          TEXT,
    description     TEXT NOT NULL,
    adr_id          TEXT,
    related_adr_id  TEXT,
    conflict_id     TEXT,
    resolution      TEXT,
    resolution_kind TEXT,
    created_at      TEXT NOT NULL,
    created_by      TEXT,
    resolved_at     TEXT,
    resolved_by     TEXT
  )`);
  await pool().query("CREATE INDEX IF NOT EXISTS idx_adr_vigilances_project ON adr_vigilances(project)");
  await pool().query("CREATE INDEX IF NOT EXISTS idx_adr_vigilances_recette ON adr_vigilances(recette_id)");
  await pool().query("CREATE INDEX IF NOT EXISTS idx_adr_vigilances_status ON adr_vigilances(status)");
  await pool().query("CREATE INDEX IF NOT EXISTS idx_adr_vigilances_type ON adr_vigilances(type)");
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
  for (const tbl of ["projects", "repos", "recettes", "tasks", "e2e_tests", "artifacts"]) {
    await pool().query(`ALTER TABLE ${tbl} ADD COLUMN IF NOT EXISTS organization_id TEXT`);
    await pool().query(`UPDATE ${tbl} SET organization_id = 'onirtech' WHERE organization_id IS NULL`);
  }
  for (const tbl of ["recettes", "e2e_tests", "artifacts"]) {
    await pool().query(`ALTER TABLE ${tbl} ADD COLUMN IF NOT EXISTS created_by TEXT`);
  }
  for (const tbl of ["projects", "repos", "recettes", "tasks", "e2e_tests", "artifacts"]) {
    await pool().query(`UPDATE ${tbl} SET created_by = 'Rino' WHERE created_by IS NULL`);
  }
  // =========================================================================
  // MODÈLE STRUCTURÉ — Fonctionnalités (US-xxx), Règles métier (RM-xxxx),
  // Sprints + liens N:N (ADR-001, item 128). DDL IDENTIQUE à schema.sql (source
  // logique) pour créer les tables sur une base PostgreSQL déjà migrée, de
  // façon idempotente. Les documents ADR-12 (specs/gherkin) deviennent des
  // PIÈCES CLIENT ; les valeurs de référence vivent ici. NE TOUCHE PAS la
  // famille ADR (artifacts doc_type='adr', adr_*).
  // =========================================================================
  await pool().query(`CREATE TABLE IF NOT EXISTS fonctionnalites (
    id               TEXT PRIMARY KEY,
    project          TEXT NOT NULL,
    ref              TEXT NOT NULL,
    role             TEXT,
    user_story       TEXT NOT NULL,
    sourced_piece_id TEXT,
    emergent         INTEGER NOT NULL DEFAULT 0,
    emergent_origin  TEXT,
    organization_id  TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT,
    created_by       TEXT
  )`);
  await pool().query("CREATE UNIQUE INDEX IF NOT EXISTS idx_fonctionnalites_project_ref ON fonctionnalites(project, ref)");
  await pool().query("CREATE INDEX IF NOT EXISTS idx_fonctionnalites_project ON fonctionnalites(project)");
  await pool().query(`CREATE TABLE IF NOT EXISTS regles_metier (
    id               TEXT PRIMARY KEY,
    project          TEXT NOT NULL,
    ref              TEXT NOT NULL,
    content          TEXT NOT NULL,
    sourced_piece_id TEXT,
    emergent         INTEGER NOT NULL DEFAULT 0,
    emergent_origin  TEXT,
    roles            TEXT[] NOT NULL DEFAULT '{}',
    role_global      INTEGER NOT NULL DEFAULT 0,
    organization_id  TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT,
    created_by       TEXT
  )`);
  await pool().query("CREATE UNIQUE INDEX IF NOT EXISTS idx_regles_metier_project_ref ON regles_metier(project, ref)");
  await pool().query("CREATE INDEX IF NOT EXISTS idx_regles_metier_project ON regles_metier(project)");
  await pool().query(`CREATE TABLE IF NOT EXISTS sprints (
    id              TEXT PRIMARY KEY,
    project         TEXT NOT NULL,
    title           TEXT NOT NULL,
    start_date      TEXT,
    end_date        TEXT,
    status          TEXT NOT NULL DEFAULT 'open',
    session_id      TEXT,
    organization_id TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT,
    created_by      TEXT
  )`);
  await pool().query("CREATE INDEX IF NOT EXISTS idx_sprints_project ON sprints(project)");
  await pool().query("CREATE INDEX IF NOT EXISTS idx_sprints_status ON sprints(status)");
  // Sprint — cycle de vie produit : sprint par défaut, clôture auto à l'échéance, reprise.
  await pool().query("ALTER TABLE sprints ADD COLUMN IF NOT EXISTS is_default INTEGER NOT NULL DEFAULT 0");
  await pool().query("ALTER TABLE sprints ADD COLUMN IF NOT EXISTS auto_close INTEGER NOT NULL DEFAULT 1");
  await pool().query("ALTER TABLE sprints ADD COLUMN IF NOT EXISTS closed_at TEXT");
  await pool().query("ALTER TABLE sprints ADD COLUMN IF NOT EXISTS close_reason TEXT");
  await pool().query("ALTER TABLE sprints ADD COLUMN IF NOT EXISTS reopened_at TEXT");
  await pool().query("CREATE INDEX IF NOT EXISTS idx_sprints_project_status ON sprints(project, status)");
  await pool().query("CREATE UNIQUE INDEX IF NOT EXISTS idx_sprints_default ON sprints(project) WHERE is_default = 1");
  // Tâche — émergence (apparue hors sprint / après clôture) : tracée, non bloquante.
  await pool().query("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS emergent INTEGER NOT NULL DEFAULT 0");
  await pool().query("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS emergent_origin TEXT");
  await pool().query("CREATE INDEX IF NOT EXISTS idx_tasks_emergent ON tasks(project) WHERE emergent = 1");
  // FONCTIONNALITÉ — ÉTAT D'IMPLÉMENTATION + ORIGINE (T-20260921-133134-yz2i).
  // Additif et idempotent : `implemented_origin` ∈ {ecosystem, hors_ecosystem} ;
  // champs absents ⇒ implemented=0 ⇒ comportement historique (repli `done_tasks`).
  // NE TOUCHE PAS l'émergence (`emergent`/`emergent_origin`) : axe DISTINCT.
  await pool().query("ALTER TABLE fonctionnalites ADD COLUMN IF NOT EXISTS implemented INTEGER NOT NULL DEFAULT 0");
  await pool().query("ALTER TABLE fonctionnalites ADD COLUMN IF NOT EXISTS implemented_origin TEXT");
  await pool().query("ALTER TABLE fonctionnalites ADD COLUMN IF NOT EXISTS implemented_at TEXT");
  await pool().query("ALTER TABLE fonctionnalites ADD COLUMN IF NOT EXISTS implemented_by TEXT");
  await pool().query("ALTER TABLE fonctionnalites ADD COLUMN IF NOT EXISTS implemented_note TEXT");
  // FONCTIONNALITÉ — STATUT DE DÉVELOPPEMENT (axe 3, T-20260922-100651-m6va).
  // Additif et idempotent : `dev_status` ∈ {complet, non_demarre, partiel,
  // incoherent} (analyse du code) ; `dev_status_source` ∈ {analyse_code,
  // evaluateur, agent, humain} TRACE qui alimente le statut (vigilance élément
  // 149). AXE DISTINCT du verdict d'évaluation (`evaluation_fonctionnalites`)
  // et de l'implémentation (`implemented`/`implemented_origin`) : jamais fusionné.
  await pool().query("ALTER TABLE fonctionnalites ADD COLUMN IF NOT EXISTS dev_status TEXT");
  await pool().query("ALTER TABLE fonctionnalites ADD COLUMN IF NOT EXISTS dev_status_source TEXT");
  await pool().query("ALTER TABLE fonctionnalites ADD COLUMN IF NOT EXISTS dev_status_note TEXT");
  await pool().query("ALTER TABLE fonctionnalites ADD COLUMN IF NOT EXISTS dev_status_at TEXT");
  await pool().query("ALTER TABLE fonctionnalites ADD COLUMN IF NOT EXISTS dev_status_by TEXT");
  // RÈGLE MÉTIER — mêmes 5 colonnes (modèle symétrique).
  await pool().query("ALTER TABLE regles_metier ADD COLUMN IF NOT EXISTS implemented INTEGER NOT NULL DEFAULT 0");
  await pool().query("ALTER TABLE regles_metier ADD COLUMN IF NOT EXISTS implemented_origin TEXT");
  await pool().query("ALTER TABLE regles_metier ADD COLUMN IF NOT EXISTS implemented_at TEXT");
  await pool().query("ALTER TABLE regles_metier ADD COLUMN IF NOT EXISTS implemented_by TEXT");
  await pool().query("ALTER TABLE regles_metier ADD COLUMN IF NOT EXISTS implemented_note TEXT");
  // RÈGLE MÉTIER — STATUT DE RESPECT (axe dédié, T-20260922-100651-m6va).
  // `respect_status` ∈ {respectee, non_respectee} : le RESPECT de la règle, PAS
  // un statut de développement (distinction explicite de la décision de recette).
  await pool().query("ALTER TABLE regles_metier ADD COLUMN IF NOT EXISTS respect_status TEXT");
  await pool().query("ALTER TABLE regles_metier ADD COLUMN IF NOT EXISTS respect_status_note TEXT");
  await pool().query("ALTER TABLE regles_metier ADD COLUMN IF NOT EXISTS respect_status_at TEXT");
  await pool().query("ALTER TABLE regles_metier ADD COLUMN IF NOT EXISTS respect_status_by TEXT");
  // RÈGLE MÉTIER — association EXPLICITE de rôles (1..N) ou rôle GLOBAL (T-20260922-064200-e0yw).
  // Remplace le `roles` DÉRIVÉ des fonctionnalités liées : source de vérité unique.
  await pool().query("ALTER TABLE regles_metier ADD COLUMN IF NOT EXISTS roles TEXT[] NOT NULL DEFAULT '{}'");
  await pool().query("ALTER TABLE regles_metier ADD COLUMN IF NOT EXISTS role_global INTEGER NOT NULL DEFAULT 0");
  await pool().query(`CREATE TABLE IF NOT EXISTS fonctionnalite_regles (
    fonctionnalite_id TEXT NOT NULL REFERENCES fonctionnalites(id) ON DELETE CASCADE,
    regle_id          TEXT NOT NULL REFERENCES regles_metier(id) ON DELETE CASCADE,
    PRIMARY KEY (fonctionnalite_id, regle_id)
  )`);
  await pool().query("CREATE INDEX IF NOT EXISTS idx_fonctionnalite_regles_regle ON fonctionnalite_regles(regle_id)");
  await pool().query(`CREATE TABLE IF NOT EXISTS fonctionnalite_gherkin (
    fonctionnalite_id TEXT NOT NULL REFERENCES fonctionnalites(id) ON DELETE CASCADE,
    e2e_test_id       TEXT NOT NULL REFERENCES e2e_tests(id) ON DELETE CASCADE,
    PRIMARY KEY (fonctionnalite_id, e2e_test_id)
  )`);
  await pool().query("CREATE INDEX IF NOT EXISTS idx_fonctionnalite_gherkin_test ON fonctionnalite_gherkin(e2e_test_id)");
  await pool().query(`CREATE TABLE IF NOT EXISTS fonctionnalite_adr (
    fonctionnalite_id TEXT NOT NULL REFERENCES fonctionnalites(id) ON DELETE CASCADE,
    adr_id            TEXT NOT NULL REFERENCES artifacts(artifact_id) ON DELETE CASCADE,
    PRIMARY KEY (fonctionnalite_id, adr_id)
  )`);
  await pool().query("CREATE INDEX IF NOT EXISTS idx_fonctionnalite_adr_adr ON fonctionnalite_adr(adr_id)");
  // Contrainte : une ADR (existante) ne peut perdre sa dernière fonctionnalité.
  await pool().query(`CREATE OR REPLACE FUNCTION fn_fonctionnalite_adr_min() RETURNS trigger AS $$
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
$$ LANGUAGE plpgsql`);
  await pool().query("DROP TRIGGER IF EXISTS trg_fonctionnalite_adr_min ON fonctionnalite_adr");
  await pool().query(`CREATE CONSTRAINT TRIGGER trg_fonctionnalite_adr_min
    AFTER INSERT OR UPDATE OR DELETE ON fonctionnalite_adr
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION fn_fonctionnalite_adr_min()`);
  await pool().query(`CREATE TABLE IF NOT EXISTS sprint_fonctionnalites (
    sprint_id         TEXT NOT NULL REFERENCES sprints(id) ON DELETE CASCADE,
    fonctionnalite_id TEXT NOT NULL REFERENCES fonctionnalites(id) ON DELETE CASCADE,
    PRIMARY KEY (sprint_id, fonctionnalite_id)
  )`);
  await pool().query("CREATE INDEX IF NOT EXISTS idx_sprint_fonctionnalites_feat ON sprint_fonctionnalites(fonctionnalite_id)");
  await pool().query(`CREATE TABLE IF NOT EXISTS sprint_regles (
    sprint_id TEXT NOT NULL REFERENCES sprints(id) ON DELETE CASCADE,
    regle_id  TEXT NOT NULL REFERENCES regles_metier(id) ON DELETE CASCADE,
    PRIMARY KEY (sprint_id, regle_id)
  )`);
  await pool().query("CREATE INDEX IF NOT EXISTS idx_sprint_regles_regle ON sprint_regles(regle_id)");
  await pool().query(`CREATE TABLE IF NOT EXISTS sprint_pieces (
    sprint_id TEXT NOT NULL REFERENCES sprints(id) ON DELETE CASCADE,
    piece_id  TEXT NOT NULL REFERENCES artifacts(artifact_id) ON DELETE CASCADE,
    PRIMARY KEY (sprint_id, piece_id)
  )`);
  await pool().query("CREATE INDEX IF NOT EXISTS idx_sprint_pieces_piece ON sprint_pieces(piece_id)");
  await pool().query(`CREATE TABLE IF NOT EXISTS task_sprints (
    task_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    sprint_id TEXT NOT NULL REFERENCES sprints(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, sprint_id)
  )`);
  await pool().query("CREATE INDEX IF NOT EXISTS idx_task_sprints_sprint ON task_sprints(sprint_id)");
  await pool().query(`CREATE TABLE IF NOT EXISTS task_fonctionnalites (
    task_id           TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    fonctionnalite_id TEXT NOT NULL REFERENCES fonctionnalites(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, fonctionnalite_id)
  )`);
  await pool().query("CREATE INDEX IF NOT EXISTS idx_task_fonctionnalites_feat ON task_fonctionnalites(fonctionnalite_id)");
  await pool().query(`CREATE TABLE IF NOT EXISTS task_adr (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    adr_id  TEXT NOT NULL REFERENCES artifacts(artifact_id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, adr_id)
  )`);
  await pool().query("CREATE INDEX IF NOT EXISTS idx_task_adr_adr ON task_adr(adr_id)");
  // Lien ADR d'une TÂCHE — workflow PROPOSÉ → VALIDÉ (ADR-001 §5, T5/A001) :
  // l'agent PROPOSE un lien vers une ADR EXISTANTE (`status='propose'`, non
  // effectif) ; l'humain VALIDE en recette (`status='valide'` ⇒ effectif).
  // Additif : aucune colonne existante n'est modifiée. Posé ici (migrate(),
  // exécuté après schema.sql) — miroir `schema.sql` à prévoir en suivi.
  await pool().query("ALTER TABLE task_adr ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'propose'");
  await pool().query("ALTER TABLE task_adr ADD COLUMN IF NOT EXISTS proposed_by TEXT");
  await pool().query("ALTER TABLE task_adr ADD COLUMN IF NOT EXISTS proposed_at TEXT");
  await pool().query("ALTER TABLE task_adr ADD COLUMN IF NOT EXISTS validated_by TEXT");
  await pool().query("ALTER TABLE task_adr ADD COLUMN IF NOT EXISTS validated_at TEXT");
  await pool().query("ALTER TABLE task_adr ADD COLUMN IF NOT EXISTS reason TEXT");
  await pool().query("CREATE INDEX IF NOT EXISTS idx_task_adr_status ON task_adr(status)");
  await pool().query(`CREATE TABLE IF NOT EXISTS recette_sprints (
    recette_id TEXT NOT NULL REFERENCES recettes(recette_id) ON DELETE CASCADE,
    sprint_id  TEXT NOT NULL REFERENCES sprints(id) ON DELETE CASCADE,
    PRIMARY KEY (recette_id, sprint_id)
  )`);
  await pool().query("CREATE INDEX IF NOT EXISTS idx_recette_sprints_sprint ON recette_sprints(sprint_id)");
  await pool().query(`CREATE TABLE IF NOT EXISTS recette_fonctionnalites (
    recette_id        TEXT NOT NULL REFERENCES recettes(recette_id) ON DELETE CASCADE,
    fonctionnalite_id TEXT NOT NULL REFERENCES fonctionnalites(id) ON DELETE CASCADE,
    PRIMARY KEY (recette_id, fonctionnalite_id)
  )`);
  await pool().query("CREATE INDEX IF NOT EXISTS idx_recette_fonctionnalites_feat ON recette_fonctionnalites(fonctionnalite_id)");
  await pool().query(`CREATE TABLE IF NOT EXISTS recette_adr (
    recette_id TEXT NOT NULL REFERENCES recettes(recette_id) ON DELETE CASCADE,
    adr_id     TEXT NOT NULL REFERENCES artifacts(artifact_id) ON DELETE CASCADE,
    PRIMARY KEY (recette_id, adr_id)
  )`);
  await pool().query("CREATE INDEX IF NOT EXISTS idx_recette_adr_adr ON recette_adr(adr_id)");
  // Recette ↔ règle métier (T-20260922-070103-ncs1) — miroir DDL de
  // `recette_fonctionnalites`. Miroir `schema.sql` (A001).
  await pool().query(`CREATE TABLE IF NOT EXISTS recette_regles (
    recette_id TEXT NOT NULL REFERENCES recettes(recette_id) ON DELETE CASCADE,
    regle_id   TEXT NOT NULL REFERENCES regles_metier(id) ON DELETE CASCADE,
    PRIMARY KEY (recette_id, regle_id)
  )`);
  await pool().query("CREATE INDEX IF NOT EXISTS idx_recette_regles_regle ON recette_regles(regle_id)");
  // =========================================================================
  // ÉVALUATIONS — « Recette » de l'ÉVALUATEUR PRODUIT (T-20260922-100650-sbc1).
  // Objet de PREMIER NIVEAU DISTINCT de `recettes` (Cadrage technique exécuteur).
  // Miroir EXACT de la DDL `schema.sql` (A001). AUCUNE conversion en tâches.
  // =========================================================================
  await pool().query(`CREATE TABLE IF NOT EXISTS evaluations (
    evaluation_id   TEXT PRIMARY KEY,
    project         TEXT NOT NULL,
    title           TEXT NOT NULL,
    description     TEXT,
    status          TEXT NOT NULL DEFAULT 'pending',
    created_at      TEXT NOT NULL,
    confirmed_at    TEXT,
    confirmed_by    TEXT,
    organization_id TEXT,
    created_by      TEXT
  )`);
  await pool().query("CREATE INDEX IF NOT EXISTS idx_evaluations_project ON evaluations(project)");
  await pool().query("CREATE INDEX IF NOT EXISTS idx_evaluations_created_by ON evaluations(created_by)");
  // SESSION D'ÉVALUATION (agent-recette évaluateur) — colonne ADDITIVE
  // idempotente (parité recettes/sprints/tests). `sessionId` null = détachée.
  await pool().query("ALTER TABLE evaluations ADD COLUMN IF NOT EXISTS session_id TEXT");
  await pool().query(`CREATE TABLE IF NOT EXISTS evaluation_fonctionnalites (
    evaluation_id     TEXT NOT NULL REFERENCES evaluations(evaluation_id) ON DELETE CASCADE,
    fonctionnalite_id TEXT NOT NULL REFERENCES fonctionnalites(id) ON DELETE CASCADE,
    verdict           TEXT,
    verdict_comment   TEXT,
    PRIMARY KEY (evaluation_id, fonctionnalite_id)
  )`);
  await pool().query("CREATE INDEX IF NOT EXISTS idx_evaluation_fonctionnalites_feat ON evaluation_fonctionnalites(fonctionnalite_id)");
  await pool().query(`CREATE TABLE IF NOT EXISTS evaluation_regles (
    evaluation_id TEXT NOT NULL REFERENCES evaluations(evaluation_id) ON DELETE CASCADE,
    regle_id      TEXT NOT NULL REFERENCES regles_metier(id) ON DELETE CASCADE,
    PRIMARY KEY (evaluation_id, regle_id)
  )`);
  await pool().query("CREATE INDEX IF NOT EXISTS idx_evaluation_regles_regle ON evaluation_regles(regle_id)");
  await pool().query(`CREATE TABLE IF NOT EXISTS evaluation_items (
    id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    evaluation_id TEXT NOT NULL REFERENCES evaluations(evaluation_id) ON DELETE CASCADE,
    content       TEXT NOT NULL,
    category      TEXT NOT NULL DEFAULT 'recommandation',
    severity      TEXT NOT NULL DEFAULT 'medium',
    discussion    TEXT,
    status        TEXT NOT NULL DEFAULT 'open',
    created_at    TEXT NOT NULL
  )`);
  await pool().query("CREATE INDEX IF NOT EXISTS idx_evaluation_items_evaluation ON evaluation_items(evaluation_id)");
  // DÉCISION ADMIN « à traiter » (ou non), DISTINCTE du statut de suivi
  // `status`. Trace qui a décidé et quand (T-20260922-100650-3w6i, ADR-001 :
  // l'admin marque chaque élément « à traiter » ou non ; l'exécuteur n'accède
  // qu'aux éléments « à traiter »). Colonnes ADDITIVES, défaut `pending`.
  await pool().query("ALTER TABLE evaluation_items ADD COLUMN IF NOT EXISTS decision TEXT NOT NULL DEFAULT 'pending'");
  await pool().query("ALTER TABLE evaluation_items ADD COLUMN IF NOT EXISTS decided_at TEXT");
  await pool().query("ALTER TABLE evaluation_items ADD COLUMN IF NOT EXISTS decided_by TEXT");
  // REPRISE d'un élément de recette évaluateur par un CADRAGE TECHNIQUE
  // (`recettes`, alias `cadrage_*`) : lien ADDITIF pour le traçage « repris par
  // le cadrage X ». Aucune entité concurrente, aucune conversion en tâches.
  await pool().query(`CREATE TABLE IF NOT EXISTS cadrage_evaluation_items (
    recette_id         TEXT NOT NULL REFERENCES recettes(recette_id) ON DELETE CASCADE,
    evaluation_item_id INTEGER NOT NULL REFERENCES evaluation_items(id) ON DELETE CASCADE,
    created_at         TEXT NOT NULL,
    taken_by           TEXT,
    PRIMARY KEY (recette_id, evaluation_item_id)
  )`);
  await pool().query("CREATE INDEX IF NOT EXISTS idx_cadrage_evaluation_items_item ON cadrage_evaluation_items(evaluation_item_id)");
  // =========================================================================
  // CARDINALITÉS HEURISTIQUES (T6, ADR-001 §5). Trace APPEND-ONLY des manques
  // de cardinalité (recette/tâche/ADR/sprint) — SIGNALEMENT + TRAÇAGE, JAMAIS
  // bloquant. AUCUN BACKFILL : la table naît vide (l'émergence n'est jamais
  // rétroactive). L'index partiel unique garantit UN SEUL signal OPEN par
  // entité ; un nouveau passage RAFRAÎCHIT `missing`/`detail` (décision §2.5).
  // DDL posée ici (migrate(), exécuté après schema.sql) — miroir `schema.sql`
  // à prévoir en tâche de suivi (dérive DDL assumée, précédent T5).
  // =========================================================================
  await pool().query(`CREATE TABLE IF NOT EXISTS cardinality_signals (
    signal_id    TEXT PRIMARY KEY,
    project      TEXT NOT NULL,
    entity_type  TEXT NOT NULL,
    entity_id    TEXT NOT NULL,
    missing      TEXT NOT NULL,
    detail       TEXT,
    status       TEXT NOT NULL DEFAULT 'open',
    origin       TEXT,
    created_at   TEXT NOT NULL,
    created_by   TEXT,
    updated_at   TEXT,
    resolved_at  TEXT,
    resolved_by  TEXT,
    resolution   TEXT
  )`);
  await pool().query("CREATE INDEX IF NOT EXISTS idx_cardinality_signals_project ON cardinality_signals(project)");
  await pool().query("CREATE INDEX IF NOT EXISTS idx_cardinality_signals_entity ON cardinality_signals(entity_type, entity_id)");
  await pool().query("CREATE INDEX IF NOT EXISTS idx_cardinality_signals_status ON cardinality_signals(status)");
  // UN SEUL signal OPEN par entité (les signaux résolus restent en historique).
  await pool().query("CREATE UNIQUE INDEX IF NOT EXISTS idx_cardinality_signals_open_entity ON cardinality_signals(entity_type, entity_id) WHERE status = 'open'");
  // =========================================================================
  // SESSION DE MIGRATION DES ANCIENS SPRINTS (ADR-001 §6) — DDL ADDITIVE.
  // A001 : `adr_conversions` conserve le LIEN HISTORIQUE ADR d'origine ↔ ADR
  // converties (N converties pour 1 origine). L'ADR d'origine n'est JAMAIS
  // modifiée (ni doc_type, ni content_id, ni path, ni meta) : la conversion est
  // purement additive (une nouvelle ligne `artifacts` par ADR atomique).
  // DDL identique à schema.sql (source logique), idempotente (base existante
  // comme neuve). Aucune colonne existante n'est modifiée.
  // =========================================================================
  await pool().query(`CREATE TABLE IF NOT EXISTS adr_conversions (
    conversion_id     TEXT PRIMARY KEY,
    original_adr_id   TEXT NOT NULL REFERENCES artifacts(artifact_id) ON DELETE CASCADE,
    converted_adr_id  TEXT NOT NULL REFERENCES artifacts(artifact_id) ON DELETE CASCADE,
    created_at        TEXT NOT NULL,
    created_by        TEXT
  )`);
  await pool().query("CREATE INDEX IF NOT EXISTS idx_adr_conversions_original ON adr_conversions(original_adr_id)");
  await pool().query("CREATE INDEX IF NOT EXISTS idx_adr_conversions_converted ON adr_conversions(converted_adr_id)");
  // Idempotence du lien : une seule ligne par couple (origine, convertie).
  await pool().query("CREATE UNIQUE INDEX IF NOT EXISTS idx_adr_conversions_pair ON adr_conversions(original_adr_id, converted_adr_id)");
  // A002 : `migrations` porte l'entité « session de migration » d'un PROJET
  // (type dédié, à l'image des sessions sprint/recette), ancrée sur le SPRINT
  // PAR DÉFAUT (= l'ancien sprint). Une migration par projet (index unique) :
  // `startMigration` est IDEMPOTENT (relance = même ligne).
  await pool().query(`CREATE TABLE IF NOT EXISTS migrations (
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
  )`);
  await pool().query("CREATE UNIQUE INDEX IF NOT EXISTS idx_migrations_project ON migrations(project)");
  await pool().query("CREATE INDEX IF NOT EXISTS idx_migrations_status ON migrations(status)");
  await pool().query("CREATE INDEX IF NOT EXISTS idx_migrations_sprint ON migrations(sprint_id)");
}

// Détecte l'état de sprint d'un PROJET (table `sprints`, livrée par
// T-20260921-091728-nviw) — support de l'ÉMERGENCE des pièces client.
// Retourne `{ sprintId, status }` : le sprint OUVERT s'il existe, sinon le
// DERNIER sprint (quel que soit son statut, ex. `close`), sinon `null`.
// « Sprint initialisé » = existence d'au moins un sprint du projet.
export async function detectOpenSprint(projectId) {
  await ensureSchema();
  if (!projectId || !String(projectId).trim()) return null;
  const pid = String(projectId).trim();
  // La clôture AUTOMATIQUE à l'échéance est appliquée avant toute lecture : dès
  // le premier accès, un sprint échu est `close` (forme de retour inchangée).
  await autoCloseExpiredSprints({ projectId: pid });
  const open = (await pool().query(
    "SELECT id, status FROM sprints WHERE project = $1 AND status = 'open' ORDER BY created_at DESC, id DESC LIMIT 1", [pid],
  )).rows[0];
  if (open) return { sprintId: open.id, status: open.status };
  const last = (await pool().query(
    "SELECT id, status FROM sprints WHERE project = $1 ORDER BY created_at DESC, id DESC LIMIT 1", [pid],
  )).rows[0];
  return last ? { sprintId: last.id, status: last.status } : null;
}

// ===========================================================================
// SPRINT — cycle de vie PRODUIT (ADR-001). Le sprint est un objet de 1er
// niveau : durée paramétrable, statut open|close, clôture AUTOMATIQUE à
// l'échéance (DISTINCTE de la clôture d'exécution des tâches), reprise
// possible, sprint par défaut (« anciens sprints »), émergence traçable.
// Ces primitives sont réutilisées par la famille MCP `sprint_*` (T4).
// ===========================================================================

// Sérialise une ligne `sprints` → sprint (camelCase).
function rowToSprint(r) {
  if (!r) return null;
  return {
    id: r.id,
    project: r.project,
    title: r.title,
    startDate: r.start_date ?? null,
    endDate: r.end_date ?? null,
    status: r.status,
    isDefault: !!r.is_default,
    autoClose: !!r.auto_close,
    closedAt: r.closed_at ?? null,
    closeReason: r.close_reason ?? null,
    reopenedAt: r.reopened_at ?? null,
    sessionId: r.session_id ?? null,
    organizationId: r.organization_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at ?? null,
    createdBy: r.created_by ?? null,
  };
}

// Clôture BAS NIVEAU d'un sprint (idempotente). N'ÉCRIT JAMAIS sur `tasks` ni
// `executions` : la clôture de sprint est DISTINCTE de la clôture d'exécution
// des tâches (ADR-001 §1) — clôturer un sprint ne clôt aucune tâche.
// `reason` : `auto_echeance` (balayage) | `manuel` (T4).
export async function closeSprint(sprintId, { reason = "manuel", by } = {}) {
  await ensureSchema();
  if (!sprintId) throw new Error("sprintId requis");
  const id = String(sprintId);
  const row = (await pool().query("SELECT * FROM sprints WHERE id = $1", [id])).rows[0];
  if (!row) throw new Error(`sprint inconnu : ${id}`);
  if (row.status === "close") return rowToSprint(row); // idempotent : déjà clôturé
  const ts = nowIso();
  const res = await pool().query(
    `UPDATE sprints
        SET status = 'close', closed_at = $2, close_reason = $3, updated_at = $2
      WHERE id = $1 RETURNING *`,
    [id, ts, reason || "manuel"],
  );
  void by;
  return rowToSprint(res.rows[0]);
}

// CLÔTURE AUTOMATIQUE à l'échéance : passe à `close` les sprints `open`,
// `auto_close = 1` et `end_date < now`, en posant `closed_at` +
// `close_reason='auto_echeance'`. Idempotent. N'ÉCRIT JAMAIS sur `tasks` /
// `executions` (distinction exigée). `projectId` optionnel (balayage global).
export async function autoCloseExpiredSprints({ projectId } = {}) {
  await ensureSchema();
  const params = [nowIso()];
  let where = "status = 'open' AND auto_close = 1 AND end_date IS NOT NULL AND end_date < $1";
  if (projectId && String(projectId).trim()) {
    params.push(String(projectId).trim());
    where += ` AND project = $${params.length}`;
  }
  const rows = (await pool().query(
    `SELECT id FROM sprints WHERE ${where} ORDER BY end_date ASC, id ASC`, params,
  )).rows;
  const closed = [];
  for (const r of rows) {
    await closeSprint(r.id, { reason: "auto_echeance" });
    closed.push(r.id);
  }
  return { closed };
}

// Détail d'un sprint.
export async function getSprint(sprintId) {
  await ensureSchema();
  if (!sprintId) return null;
  const r = (await pool().query("SELECT * FROM sprints WHERE id = $1", [String(sprintId)])).rows[0];
  return rowToSprint(r);
}

// DÉTAIL COMPLET d'un sprint (T4, tool `sprint_get`) : sprint + pièces client
// (`sprint_pieces` JOIN `artifacts` → `rowToPiece`) + fonctionnalités
// (`sprint_fonctionnalites`) + règles métier (`sprint_regles`) + tâches
// (`task_sprints`) + recettes (`recette_sprints`) + compteurs. `null` si le
// sprint est inconnu.
export async function getSprintDetail(sprintId) {
  await ensureSchema();
  const sprint = await getSprint(sprintId);
  if (!sprint) return null;
  const sid = sprint.id;
  const [pieceRows, featRows, regleRows, taskRows, recetteRows] = await Promise.all([
    pool().query(
      `SELECT a.* FROM artifacts a
         JOIN sprint_pieces sp ON sp.piece_id = a.artifact_id
        WHERE sp.sprint_id = $1 ORDER BY a.created_at ASC, a.id ASC`, [sid]),
    pool().query(
      `SELECT f.* FROM fonctionnalites f
         JOIN sprint_fonctionnalites sf ON sf.fonctionnalite_id = f.id
        WHERE sf.sprint_id = $1 ORDER BY f.ref ASC`, [sid]),
    pool().query(
      `SELECT r.* FROM regles_metier r
         JOIN sprint_regles sr ON sr.regle_id = r.id
        WHERE sr.sprint_id = $1 ORDER BY r.ref ASC`, [sid]),
    pool().query(
      `SELECT t.id, t.title, t.request, t.project, t.emergent, t.emergent_origin, t.created_at,
              (SELECT e.status FROM executions e WHERE e.task_id = t.id ORDER BY e.attempt DESC LIMIT 1) AS status
         FROM tasks t JOIN task_sprints ts ON ts.task_id = t.id
        WHERE ts.sprint_id = $1 ORDER BY t.created_at ASC, t.id ASC`, [sid]),
    pool().query(
      `SELECT r.recette_id, r.title, r.status, r.project FROM recettes r
         JOIN recette_sprints rs ON rs.recette_id = r.recette_id
        WHERE rs.sprint_id = $1 ORDER BY r.created_at ASC`, [sid]),
  ]);
  const pieces = pieceRows.rows.map(rowToPiece);
  const fonctionnalites = featRows.rows.map((r) => ({
    id: r.id,
    ref: r.ref,
    role: r.role ?? null,
    userStory: r.user_story,
    sourcedPieceId: r.sourced_piece_id ?? null,
    emergent: !!r.emergent,
    emergentOrigin: r.emergent_origin ?? null,
    createdAt: r.created_at,
  }));
  const regles = regleRows.rows.map((r) => ({
    id: r.id,
    ref: r.ref,
    content: r.content,
    sourcedPieceId: r.sourced_piece_id ?? null,
    emergent: !!r.emergent,
    emergentOrigin: r.emergent_origin ?? null,
    createdAt: r.created_at,
  }));
  const tasks = taskRows.rows.map((r) => ({
    id: r.id,
    title: r.title ?? null,
    request: r.request ?? null,
    project: r.project ?? null,
    status: r.status ?? "queued",
    emergent: !!r.emergent,
    emergentOrigin: r.emergent_origin ?? null,
    createdAt: r.created_at,
  }));
  const recettes = recetteRows.rows.map((r) => ({
    recetteId: r.recette_id,
    title: r.title ?? null,
    status: r.status ?? null,
    project: r.project ?? null,
  }));
  return {
    sprint,
    pieces,
    fonctionnalites,
    regles,
    tasks,
    recettes,
    counts: {
      pieces: pieces.length,
      fonctionnalites: fonctionnalites.length,
      regles: regles.length,
      tasks: tasks.length,
      recettes: recettes.length,
    },
  };
}

// SUPPRESSION d'un SPRINT (`sprint_delete`, T-20260922-060057-febv).
//
// REFUS DUR (pas de flag `force`) :
//   - le SPRINT PAR DÉFAUT (`is_default=1`) : ancre des migrations / « ancien
//     sprint » (`ensureDefaultSprint`, `migrations.sprint_id`) — message
//     préfixé `[SPRINT_DEFAULT]` ;
//   - un sprint portant des TÂCHES (`task_sprints`) ou des RECETTES
//     (`recette_sprints`) : le détachement est EXPLICITE via les tools
//     `task_sprint_unlink` / `recette_sprint_unlink`, jamais silencieux (perte
//     de traçabilité) — message préfixé `[SPRINT_LINKED]` avec les compteurs.
//
// AUTORISÉ sinon : les liens `sprint_fonctionnalites` / `sprint_regles` /
// `sprint_pieces` sont détachés (les entités restent au projet), `migrations.
// sprint_id` passe à `NULL` (FK `ON DELETE SET NULL`), et les signaux de
// cardinalité `open` du sprint sont nettoyés (aucune FK → évite un orphelin).
// Retourne `{ sprintId, deleted:true, detached:{fonctionnalites,regles,pieces} }`.
export async function deleteSprint(sprintId) {
  await ensureSchema();
  const sprint = await getSprint(sprintId);
  if (!sprint) return null;
  const sid = sprint.id;
  if (sprint.isDefault) {
    throw new Error(
      `[SPRINT_DEFAULT] suppression refusée : le sprint ${sid} est le SPRINT PAR DÉFAUT du projet ` +
      `« ${sprint.project} » (ancre des migrations / « ancien sprint »). Il ne peut pas être supprimé.`,
    );
  }
  const [taskRow, recetteRow] = await Promise.all([
    pool().query("SELECT count(*) AS n FROM task_sprints WHERE sprint_id = $1", [sid]),
    pool().query("SELECT count(*) AS n FROM recette_sprints WHERE sprint_id = $1", [sid]),
  ]);
  const taskCount = Number(taskRow.rows[0]?.n) || 0;
  const recetteCount = Number(recetteRow.rows[0]?.n) || 0;
  if (taskCount || recetteCount) {
    throw new Error(
      `[SPRINT_LINKED] suppression refusée : le sprint ${sid} porte ${taskCount} tâche(s) et ` +
      `${recetteCount} recette(s) rattachée(s). Détachez-les d'abord ` +
      `(\`task_sprint_unlink\` / \`recette_sprint_unlink\`).`,
    );
  }
  const detached = await withTransaction(async (client) => {
    const f = (await client.query("DELETE FROM sprint_fonctionnalites WHERE sprint_id = $1", [sid])).rowCount;
    const r = (await client.query("DELETE FROM sprint_regles WHERE sprint_id = $1", [sid])).rowCount;
    const p = (await client.query("DELETE FROM sprint_pieces WHERE sprint_id = $1", [sid])).rowCount;
    // Signaux de cardinalité `open` du sprint (entity_type/entity_id génériques,
    // AUCUNE FK) : on évite un signal orphelin après suppression.
    await client.query(
      "DELETE FROM cardinality_signals WHERE entity_type = 'sprint' AND entity_id = $1 AND status = 'open'",
      [sid],
    );
    await client.query("DELETE FROM sprints WHERE id = $1", [sid]);
    return { fonctionnalites: f, regles: r, pieces: p };
  });
  return { sprintId: sid, deleted: true, detached };
}

// Liste des sprints d'un projet (du plus récent au plus ancien). Filtre `status`.
export async function listProjectSprints(projectId, { status } = {}) {
  await ensureSchema();
  if (!projectId || !String(projectId).trim()) throw new Error("projectId requis");
  const pid = String(projectId).trim();
  const params = [pid];
  let where = "project = $1";
  if (status) {
    params.push(String(status));
    where += ` AND status = $${params.length}`;
  }
  const rows = (await pool().query(
    `SELECT * FROM sprints WHERE ${where} ORDER BY created_at DESC, id DESC`, params,
  )).rows;
  return rows.map(rowToSprint);
}

// RATTACHEMENT de pièces client à un sprint (T4). Garde NATURE (A001
// `assertAttachablePiece`) + lien `sprint_pieces`. ÉMERGENCE (ADR-001 §5) :
//   - `atInit=true` : pièces rattachées à la CRÉATION du sprint → NON émergentes
//                     (elles constituent le sprint) ;
//   - sinon         : pièce reçue APRÈS l'init → émergente, origine
//                     `apres_cloture` (sprint `close`) ou `apres_init_sprint`
//                     (sprint `open`), selon l'état du sprint cible.
// Idempotent sur le lien (`ON CONFLICT DO NOTHING`). Retourne
// `{ sprintId, attached, pieces }` (`attached` = liens réellement créés).
export async function attachPiecesToSprint(sprintId, { pieceIds, atInit = false, by } = {}) {
  await ensureSchema();
  if (!sprintId) throw new Error("sprintId requis");
  const id = String(sprintId);
  const sprint = await getSprint(id);
  if (!sprint) throw new Error(`sprint inconnu : ${id}`);
  const ids = Array.isArray(pieceIds)
    ? pieceIds
        .filter((p) => p !== undefined && p !== null && String(p).trim())
        .map((p) => String(p).trim())
    : [];
  const emergent = atInit ? false : true;
  const origin = atInit ? null : sprint.status === "close" ? "apres_cloture" : "apres_init_sprint";
  const ts = nowIso();
  const pieces = [];
  let attached = 0;
  for (const pid of ids) {
    const piece = await assertAttachablePiece(pid); // garde nature (A001)
    const ins = await pool().query(
      "INSERT INTO sprint_pieces (sprint_id, piece_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [id, pid],
    );
    if (ins.rowCount > 0) attached++;
    // Marquage d'émergence dans `meta` (jamais doc_type / content_id / liens).
    const marker = {
      emergent,
      emergent_origin: origin,
      sprint_id: id,
      piece_nature: piece.nature,
      attached_at: ts,
      attached_by: by ?? null,
    };
    await pool().query(
      "UPDATE artifacts SET meta = COALESCE(meta, '{}'::jsonb) || $2::jsonb, updated_at = $3 WHERE artifact_id = $1",
      [pid, JSON.stringify(marker), ts],
    );
    pieces.push({ ...piece, emergent, emergentOrigin: origin, meta: { ...(piece.meta && typeof piece.meta === "object" ? piece.meta : {}), ...marker } });
  }
  return { sprintId: id, attached, pieces };
}

// GARDE UNIQUE d'ÉMERGENCE (ADR-001 §5). JAMAIS bloquante, JAMAIS rétroactive :
// elle ne fait que CLASSER un élément en cours de création.
//   kind='piece'   : un sprint existe → émergent (apres_init_sprint si open,
//                    apres_cloture si close) ; aucun sprint → non émergent.
//   kind='element' : (fonctionnalité / règle / tâche) aucun sprint → émergent
//                    `hors_sprint` ; dernier sprint close → `apres_cloture` ;
//                    sprint open → non émergent (appartient au sprint courant),
//                    SAUF si `fromRecette=true` (→ `recette`) ou si
//                    `hasFeature === false` (→ `sans_fonctionnalite`).
//
// PRIORITÉ des origines d'émergence (T6) — la plus haute l'emporte :
//   1. `hors_sprint`        (aucun sprint du projet)
//   2. `apres_cloture`      (dernier sprint clôturé)
//   3. `recette`            (élément apparu en recette : règle/tâche/fonctionnalité)
//   4. `sans_fonctionnalite`(élément du sprint courant sans fonctionnalité)
// `apres_init_sprint` (pièces, T2/T4) reste INCHANGÉ et hors de cette échelle.
//
// RÉTROCOMPATIBILITÉ : `hasFeature` / `fromRecette` sont OPTIONNELS ; les
// appels legacy `{kind:'element'}` / `{kind:'piece'}` produisent EXACTEMENT
// le même résultat qu'avant T6.
// Balaye d'abord la clôture auto (l'état lu est à jour).
export async function classifyEmergence(projectId, { kind = "element", hasFeature, fromRecette } = {}) {
  await ensureSchema();
  const pid = projectId ? String(projectId).trim() : "";
  if (!pid) return { sprintId: null, sprintStatus: null, emergent: false, emergentOrigin: null };
  await autoCloseExpiredSprints({ projectId: pid });
  const sprint = await detectOpenSprint(pid);
  const isPiece = kind === "piece";
  if (!sprint) {
    return isPiece
      ? { sprintId: null, sprintStatus: null, emergent: false, emergentOrigin: null }
      : { sprintId: null, sprintStatus: null, emergent: true, emergentOrigin: "hors_sprint" };
  }
  if (sprint.status === "open") {
    if (isPiece) {
      return { sprintId: sprint.sprintId, sprintStatus: "open", emergent: true, emergentOrigin: "apres_init_sprint" };
    }
    // Élément dans le sprint courant : origine `recette` (3) puis
    // `sans_fonctionnalite` (4) ; sinon non émergent.
    if (fromRecette === true) {
      return { sprintId: sprint.sprintId, sprintStatus: "open", emergent: true, emergentOrigin: "recette" };
    }
    if (hasFeature === false) {
      return { sprintId: sprint.sprintId, sprintStatus: "open", emergent: true, emergentOrigin: "sans_fonctionnalite" };
    }
    return { sprintId: sprint.sprintId, sprintStatus: "open", emergent: false, emergentOrigin: null };
  }
  return { sprintId: sprint.sprintId, sprintStatus: "close", emergent: true, emergentOrigin: "apres_cloture" };
}

// SPRINT PAR DÉFAUT du projet (« anciens sprints »). Idempotent : si un sprint
// `is_default = 1` existe, il est retourné. Sinon INSERT `SPRINT-<ts>-<rand>`
// (statut `close` + `close_reason='auto_echeance'` si `endDate` est passée,
// sinon `open`). Un seul sprint par défaut par projet (index partiel unique).
export async function ensureDefaultSprint(projectId, { title, startDate, endDate, createdBy } = {}) {
  await ensureSchema();
  if (!projectId || !String(projectId).trim()) throw new Error("projectId requis");
  const pid = String(projectId).trim();
  await assertProjectExists(pid);
  const existing = (await pool().query(
    "SELECT * FROM sprints WHERE project = $1 AND is_default = 1 ORDER BY created_at DESC LIMIT 1", [pid],
  )).rows[0];
  if (existing) return rowToSprint(existing);

  const end = endDate ? String(endDate) : null;
  const ts = nowIso();
  const expired = end ? end < ts : false;
  const org = (await orgIdOfProject(pid)) || (await defaultOrganizationId());
  const id = `SPRINT-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const inserted = (await pool().query(
    `INSERT INTO sprints
       (id, project, title, start_date, end_date, status, is_default, auto_close,
        closed_at, close_reason, organization_id, created_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,1,1,$7,$8,$9,$10,$11)
     ON CONFLICT (project) WHERE is_default = 1 DO NOTHING
     RETURNING id`,
    [
      id, pid,
      title ? String(title).trim() : `Sprint par défaut — ${pid}`,
      startDate ? String(startDate) : null,
      end,
      expired ? "close" : "open",
      expired ? ts : null,
      expired ? "auto_echeance" : null,
      org, ts, createdBy ?? null,
    ],
  )).rows[0];
  if (!inserted) {
    // Course concurrente : un autre sprint par défaut vient d'être créé.
    const again = (await pool().query(
      "SELECT * FROM sprints WHERE project = $1 AND is_default = 1 LIMIT 1", [pid],
    )).rows[0];
    return rowToSprint(again);
  }
  return getSprint(inserted.id);
}

// CRÉATION d'un sprint NOMINAL à DURÉE PARAMÉTRABLE (T4, tool `sprint_start`).
// `startDate`/`endDate` ISO 8601 ; `autoClose` (défaut true) = clôture
// AUTOMATIQUE à l'échéance. Statut initial : `open`, ou `close` +
// `close_reason='auto_echeance'` si l'échéance est DÉJÀ passée (même logique que
// `ensureDefaultSprint`). `is_default=0` : un sprint nominal n'est PAS le sprint
// par défaut (« anciens sprints »). `pieces` (0..N) est rattaché à la CRÉATION
// via A002 (`atInit=true`, pièces NON émergentes). `endDate >= startDate` exigé.
// Retourne le détail du sprint (`getSprintDetail`).
export async function createSprint({ projectId, title, startDate, endDate, autoClose = true, sessionId, createdBy, pieces } = {}) {
  await ensureSchema();
  if (!projectId || !String(projectId).trim()) throw new Error("projectId requis");
  const pid = String(projectId).trim();
  await assertProjectExists(pid);
  const t = title ? String(title).trim() : "";
  if (!t) throw new Error("title requis (titre du sprint)");
  const start = startDate ? String(startDate) : null;
  const end = endDate ? String(endDate) : null;
  if (start && end && end < start) {
    throw new Error(`durée invalide : endDate (${end}) antérieure à startDate (${start})`);
  }
  const ts = nowIso();
  const expired = end ? end < ts : false;
  const org = (await orgIdOfProject(pid)) || (await defaultOrganizationId());
  const id = `SPRINT-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  await pool().query(
    `INSERT INTO sprints
       (id, project, title, start_date, end_date, status, is_default, auto_close,
        closed_at, close_reason, session_id, organization_id, created_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8,$9,$10,$11,$12,$13)`,
    [
      id, pid, t, start, end,
      expired ? "close" : "open",
      autoClose ? 1 : 0,
      expired ? ts : null,
      expired ? "auto_echeance" : null,
      sessionId ? String(sessionId) : null,
      org, ts, createdBy ?? null,
    ],
  );
  if (Array.isArray(pieces) && pieces.length > 0) {
    await attachPiecesToSprint(id, { pieceIds: pieces, atInit: true, by: createdBy });
  }
  // SIGNAL de cardinalité (T6, NON bloquant) : un sprint neuf n'a ni
  // fonctionnalité ni règle — le manque est signalé + tracé, jamais bloquant.
  try { await recordCardinalitySignal({ entityType: "sprint", entityId: id, projectId: pid, by: createdBy }); } catch {}
  return getSprintDetail(id);
}

// ASSOCIE une session IA DÉDIÉE à un sprint EXISTANT (T8, tool
// `sprint_session_set`). Miroir de `setRecetteSession` MAIS sans toucher au
// statut du sprint : `open`/`close` (et donc la garde d'émergence) restent
// pilotés par `sprint_close`/`sprint_reopen` — rattacher une session ne clôt ni
// ne rouvre rien. `sessionId` null détache la session. Retourne le sprint.
export async function setSprintSession({ sprintId, sessionId }) {
  await ensureSchema();
  if (!sprintId) throw new Error("sprintId requis");
  const id = String(sprintId);
  const row = (await pool().query("SELECT id FROM sprints WHERE id = $1", [id])).rows[0];
  if (!row) throw new Error(`sprint inconnu : ${id}`);
  await pool().query(
    "UPDATE sprints SET session_id = $1, updated_at = $2 WHERE id = $3",
    [sessionId != null ? String(sessionId) : null, nowIso(), id],
  );
  return getSprint(id);
}

// MIGRATION des éléments EXISTANTS vers le sprint par défaut du projet :
// rattache `recette_sprints` / `task_sprints` pour les recettes/tâches SANS lien
// sprint. AUCUN marquage émergent (émergence NON rétroactive — ADR-001 §2).
export async function migrateExistingToDefaultSprint({ projectId, title, startDate, endDate, createdBy } = {}) {
  await ensureSchema();
  if (!projectId || !String(projectId).trim()) throw new Error("projectId requis");
  const pid = String(projectId).trim();
  const sprint = await ensureDefaultSprint(pid, { title, startDate, endDate, createdBy });
  const rec = await pool().query(
    `INSERT INTO recette_sprints (recette_id, sprint_id)
     SELECT r.recette_id, $2 FROM recettes r
      WHERE r.project = $1
        AND NOT EXISTS (SELECT 1 FROM recette_sprints rs WHERE rs.recette_id = r.recette_id)
     ON CONFLICT DO NOTHING`,
    [pid, sprint.id],
  );
  const tsk = await pool().query(
    `INSERT INTO task_sprints (task_id, sprint_id)
     SELECT t.id, $2 FROM tasks t
      WHERE t.project = $1
        AND NOT EXISTS (SELECT 1 FROM task_sprints ts WHERE ts.task_id = t.id)
     ON CONFLICT DO NOTHING`,
    [pid, sprint.id],
  );
  return { sprintId: sprint.id, recettes: rec.rowCount, tasks: tsk.rowCount, sprint };
}

// ===========================================================================
// SESSION DE MIGRATION DES ANCIENS SPRINTS (ADR-001 §6) — A005/A006/A007.
// Entité « migration » d'un PROJET (type dédié, à l'image des sessions
// sprint/recette), ANCRÉE sur le SPRINT PAR DÉFAUT du projet (= l'ancien
// sprint). GARDE CRITIQUE : l'émergence n'est JAMAIS rétroactive — les
// rattachements se font par INSERT DIRECTS, sans écrire `emergent`/
// `emergent_origin` et sans passer par `attachPiecesToSprint`.
// ===========================================================================

// Statuts d'une session de migration (cycle de vie simple et idempotent).
export const MIGRATION_STATUS = ["open", "in_progress", "done", "aborted"];

// Sérialise une ligne `migrations` (camelCase).
function rowToMigration(r) {
  if (!r) return null;
  return {
    migrationId: r.migration_id,
    project: r.project,
    sprintId: r.sprint_id ?? null,
    sessionId: r.session_id ?? null,
    status: r.status,
    title: r.title ?? null,
    organizationId: r.organization_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at ?? null,
    finishedAt: r.finished_at ?? null,
    createdBy: r.created_by ?? null,
  };
}

// DÉMARRE (ou résout) la session de migration d'un projet. IDEMPOTENT : si une
// migration existe pour le projet, elle est retournée (le sprint par défaut est
// ré-ancré s'il manquait). Le sprint cible est le SPRINT PAR DÉFAUT
// (`ensureDefaultSprint`) — c'est l'ANCIEN sprint auquel tous les éléments
// migrés sont rattachés. Retourne `{ migration, sprint }`.
export async function startMigration({ projectId, title, startDate, endDate, createdBy } = {}) {
  await ensureSchema();
  if (!projectId || !String(projectId).trim()) throw new Error("projectId requis");
  const pid = String(projectId).trim();
  await assertProjectExists(pid);
  // Ancien sprint = sprint par défaut du projet (créé au besoin, idempotent).
  const sprint = await ensureDefaultSprint(pid, { startDate, endDate, createdBy });
  const ts = nowIso();
  const existing = (await pool().query("SELECT * FROM migrations WHERE project = $1 LIMIT 1", [pid])).rows[0];
  if (existing) {
    if (!existing.sprint_id) {
      await pool().query(
        "UPDATE migrations SET sprint_id = $1, updated_at = $2 WHERE migration_id = $3",
        [sprint.id, ts, existing.migration_id],
      );
    }
    return { migration: await getMigration(existing.migration_id), sprint };
  }
  const org = (await orgIdOfProject(pid)) || (await defaultOrganizationId());
  const id = `MIG-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  await pool().query(
    `INSERT INTO migrations (migration_id, project, sprint_id, status, title, organization_id, created_at, created_by)
     VALUES ($1,$2,$3,'open',$4,$5,$6,$7)
     ON CONFLICT (project) DO NOTHING`,
    [
      id, pid, sprint.id,
      title ? String(title).trim() : `Migration des anciens sprints — ${pid}`,
      org, ts, createdBy ?? null,
    ],
  );
  // Course concurrente possible : relire la ligne effectivement présente.
  const row = (await pool().query("SELECT * FROM migrations WHERE project = $1 LIMIT 1", [pid])).rows[0];
  return { migration: rowToMigration(row), sprint };
}

// DÉTAIL d'une migration (+ sprint cible résolu). `null` si inconnue.
export async function getMigration(migrationId) {
  await ensureSchema();
  if (!migrationId) return null;
  const r = (await pool().query(
    "SELECT * FROM migrations WHERE migration_id = $1", [String(migrationId)],
  )).rows[0];
  if (!r) return null;
  const m = rowToMigration(r);
  m.sprint = m.sprintId ? await getSprint(m.sprintId) : null;
  return m;
}

// LISTE les migrations (toutes, ou celles d'un projet), plus récentes d'abord.
export async function listMigrations({ project, limit = 500 } = {}) {
  await ensureSchema();
  const params = [];
  let where = "";
  if (project) { params.push(String(project).trim()); where = `WHERE project = $${params.length}`; }
  params.push(limit);
  const rows = (await pool().query(
    `SELECT * FROM migrations ${where} ORDER BY created_at DESC, migration_id DESC LIMIT $${params.length}`, params,
  )).rows;
  return rows.map(rowToMigration);
}

// RATTACHE / REPREND la SESSION IA dédiée (agent-migration) à une migration
// EXISTANTE. Miroir de `setSprintSession` : NE TOUCHE PAS au statut du sprint
// (open/close et donc la garde d'émergence restent inchangés). Une migration
// `open` passe `in_progress` au rattachement ; un statut terminal n'est pas
// modifié. `sessionId` null détache la session. Retourne la migration.
export async function setMigrationSession({ migrationId, sessionId }) {
  await ensureSchema();
  if (!migrationId) throw new Error("migrationId requis");
  const id = String(migrationId);
  const row = (await pool().query("SELECT migration_id, status FROM migrations WHERE migration_id = $1", [id])).rows[0];
  if (!row) throw new Error(`migration inconnue : ${id}`);
  const nextStatus = row.status === "open" ? "in_progress" : row.status;
  await pool().query(
    "UPDATE migrations SET session_id = $1, status = $2, updated_at = $3 WHERE migration_id = $4",
    [sessionId != null ? String(sessionId) : null, nextStatus, nowIso(), id],
  );
  return getMigration(id);
}

// CLÔTURE d'une session de migration (`done` = migrée, `aborted` = abandonnée).
// Pose `finished_at`. Idempotent (re-clôturer met à jour l'horodatage).
export async function finishMigration({ migrationId, status = "done", by } = {}) {
  await ensureSchema();
  if (!migrationId) throw new Error("migrationId requis");
  const id = String(migrationId);
  const row = (await pool().query("SELECT migration_id FROM migrations WHERE migration_id = $1", [id])).rows[0];
  if (!row) throw new Error(`migration inconnue : ${id}`);
  const st = status ? String(status).trim() : "done";
  if (!["done", "aborted"].includes(st)) throw new Error(`status invalide : ${st} (attendu : done | aborted)`);
  const ts = nowIso();
  await pool().query(
    "UPDATE migrations SET status = $1, finished_at = $2, updated_at = $3 WHERE migration_id = $4",
    [st, ts, ts, id],
  );
  return getMigration(id);
}

// A007 — RATTACHEMENT des éléments EXISTANTS à l'ANCIEN SPRINT (sprint par
// défaut du projet) : fonctionnalités (`sprint_fonctionnalites`), règles métier
// (`sprint_regles`), pièces client (`sprint_pieces`), tâches (`task_sprints`) et
// recettes (`recette_sprints`) SANS lien sprint. IDEMPOTENT.
//
// GARDE CRITIQUE — AUCUN FAUX ÉMERGENT : les rattachements sont des INSERT
// DIRECTS (`INSERT ... SELECT ... ON CONFLICT DO NOTHING`). On n'appelle JAMAIS
// `attachPiecesToSprint` (qui écrit `meta.emergent`/`emergent_origin`) et on
// n'écrit AUCUNE colonne `emergent`/`emergent_origin` : l'émergence n'est jamais
// rétroactive (ADR-001 §5). Retourne les compteurs par type.
export async function migrateProjectElementsToDefaultSprint({ projectId, title, startDate, endDate, createdBy } = {}) {
  await ensureSchema();
  if (!projectId || !String(projectId).trim()) throw new Error("projectId requis");
  const pid = String(projectId).trim();
  await assertProjectExists(pid);
  const sprint = await ensureDefaultSprint(pid, { title, startDate, endDate, createdBy });
  const sid = sprint.id;
  const feats = await pool().query(
    `INSERT INTO sprint_fonctionnalites (sprint_id, fonctionnalite_id)
     SELECT $2, f.id FROM fonctionnalites f
      WHERE f.project = $1
        AND NOT EXISTS (SELECT 1 FROM sprint_fonctionnalites sf WHERE sf.fonctionnalite_id = f.id)
     ON CONFLICT DO NOTHING`,
    [pid, sid],
  );
  const regs = await pool().query(
    `INSERT INTO sprint_regles (sprint_id, regle_id)
     SELECT $2, r.id FROM regles_metier r
      WHERE r.project = $1
        AND NOT EXISTS (SELECT 1 FROM sprint_regles sr WHERE sr.regle_id = r.id)
     ON CONFLICT DO NOTHING`,
    [pid, sid],
  );
  // Pièces client : artefact `doc_type='piece'` rattaché au projet
  // (`artifact_projects`). INSERT direct — JAMAIS `attachPiecesToSprint`.
  const pieces = await pool().query(
    `INSERT INTO sprint_pieces (sprint_id, piece_id)
     SELECT $2, a.artifact_id FROM artifacts a
      WHERE a.doc_type = 'piece'
        AND EXISTS (SELECT 1 FROM artifact_projects ap WHERE ap.artifact_id = a.artifact_id AND ap.project_id = $1)
        AND NOT EXISTS (SELECT 1 FROM sprint_pieces sp WHERE sp.piece_id = a.artifact_id)
     ON CONFLICT DO NOTHING`,
    [pid, sid],
  );
  // Anciennes tâches associées à l'ancien sprint — SANS marquage émergent.
  const tasks = await pool().query(
    `INSERT INTO task_sprints (task_id, sprint_id)
     SELECT t.id, $2 FROM tasks t
      WHERE t.project = $1
        AND NOT EXISTS (SELECT 1 FROM task_sprints ts WHERE ts.task_id = t.id)
     ON CONFLICT DO NOTHING`,
    [pid, sid],
  );
  const recs = await pool().query(
    `INSERT INTO recette_sprints (recette_id, sprint_id)
     SELECT r.recette_id, $2 FROM recettes r
      WHERE r.project = $1
        AND NOT EXISTS (SELECT 1 FROM recette_sprints rs WHERE rs.recette_id = r.recette_id)
     ON CONFLICT DO NOTHING`,
    [pid, sid],
  );
  return {
    sprintId: sid,
    sprint,
    fonctionnalites: feats.rowCount,
    regles: regs.rowCount,
    pieces: pieces.rowCount,
    tasks: tasks.rowCount,
    recettes: recs.rowCount,
  };
}

// REPRISE / RÉOUVERTURE d'un sprint clôturé (le cycle n'est PAS définitif,
// contrairement à la clôture d'une tâche) : repasse `status='open'`, efface
// `closed_at`/`close_reason`, pose `reopened_at`.
// Règle anti re-clôture immédiate : si l'échéance résultante est PASSÉE et que
// `autoClose` n'est pas explicitement fourni → `auto_close = 0` (sinon le
// balayage re-clôturerait aussitôt). Une prolongation vers une date FUTURE
// rétablit `auto_close = 1`.
export async function reopenSprint(sprintId, { endDate, autoClose, by } = {}) {
  await ensureSchema();
  if (!sprintId) throw new Error("sprintId requis");
  const id = String(sprintId);
  const row = (await pool().query("SELECT * FROM sprints WHERE id = $1", [id])).rows[0];
  if (!row) throw new Error(`sprint inconnu : ${id}`);
  const ts = nowIso();
  const newEnd = endDate !== undefined && endDate !== null ? String(endDate) : (row.end_date ?? null);
  const expired = newEnd ? newEnd < ts : false;
  let newAutoClose;
  if (autoClose !== undefined && autoClose !== null) {
    newAutoClose = autoClose ? 1 : 0;
  } else if (expired) {
    newAutoClose = 0; // reprise sans prolongation (ou prolongation déjà échue)
  } else if (endDate !== undefined && endDate !== null && String(endDate) !== (row.end_date ?? null)) {
    newAutoClose = 1; // prolongation vers une échéance future
  } else {
    newAutoClose = row.auto_close ? 1 : 0;
  }
  const res = await pool().query(
    `UPDATE sprints
        SET status = 'open', closed_at = NULL, close_reason = NULL, reopened_at = $2,
            end_date = $3, auto_close = $4, updated_at = $2
      WHERE id = $1 RETURNING *`,
    [id, ts, newEnd, newAutoClose],
  );
  void by;
  return rowToSprint(res.rows[0]);
}

// RAPPORT DE SPRINT (agrégation REGISTRE, ADR-001 §4) : fonctionnalités
// implémentées (≥1 tâche liée dont la DERNIÈRE exécution est `done`) et
// émergentes, tâches effectuées / émergentes, règles émergentes, pièces
// (+ émergentes), recettes. Retourne `{ sprint, stats, sections, markdown }`.
export async function buildSprintReport(sprintId, { format = "markdown" } = {}) {
  await ensureSchema();
  if (!sprintId) throw new Error("sprintId requis");
  const sprint = await getSprint(sprintId);
  if (!sprint) throw new Error(`sprint inconnu : ${sprintId}`);
  const sid = sprint.id;

  // Fonctionnalités du sprint : `done_tasks` = nb de tâches liées dont la
  // dernière exécution est `done` (définition historique « implémentée »).
  // T-20260921-133134-yz2i : « implémentée » = état EXPLICITE (`implemented=1`)
  // **OU** signal écosystème (`done_tasks >= 1`) ; l'origine est alors explicite
  // (`implemented_origin`) ou dérivée (`ecosystem`). L'émergence reste distincte.
  const feats = (await pool().query(
    `SELECT f.*,
            (SELECT COUNT(DISTINCT tf.task_id) FROM task_fonctionnalites tf
              WHERE tf.fonctionnalite_id = f.id
                AND EXISTS (SELECT 1 FROM executions e
                             WHERE e.task_id = tf.task_id AND e.status = 'done'
                               AND e.attempt = (SELECT MAX(x.attempt) FROM executions x WHERE x.task_id = tf.task_id))
            ) AS done_tasks,
            (SELECT COUNT(*) FROM task_fonctionnalites tf2 WHERE tf2.fonctionnalite_id = f.id) AS total_tasks
       FROM fonctionnalites f
       JOIN sprint_fonctionnalites sf ON sf.fonctionnalite_id = f.id
      WHERE sf.sprint_id = $1
      ORDER BY f.ref ASC`, [sid],
  )).rows.map((r) => {
    const doneTasks = Number(r.done_tasks) || 0;
    const explicit = !!r.implemented;
    const implemented = explicit || doneTasks >= 1;
    const implementedOrigin = explicit
      ? (r.implemented_origin || (doneTasks >= 1 ? "ecosystem" : null))
      : (doneTasks >= 1 ? "ecosystem" : null);
    return {
      id: r.id,
      ref: r.ref,
      role: r.role ?? null,
      userStory: r.user_story,
      emergent: !!r.emergent,
      emergentOrigin: r.emergent_origin ?? null,
      doneTasks,
      totalTasks: Number(r.total_tasks) || 0,
      implemented,
      implementedOrigin,
      implementedAt: r.implemented_at ?? null,
      implementedBy: r.implemented_by ?? null,
      implementedNote: r.implemented_note ?? null,
    };
  });

  const tasks = (await pool().query(
    `SELECT t.id, t.title, t.request, t.emergent, t.emergent_origin, t.created_at,
            (SELECT e.status FROM executions e WHERE e.task_id = t.id ORDER BY e.attempt DESC LIMIT 1) AS status
       FROM tasks t JOIN task_sprints ts ON ts.task_id = t.id
      WHERE ts.sprint_id = $1
      ORDER BY t.created_at ASC, t.id ASC`, [sid],
  )).rows.map((r) => ({
    id: r.id,
    title: r.title ?? null,
    request: r.request,
    status: r.status ?? "queued",
    done: (r.status ?? "") === "done",
    emergent: !!r.emergent,
    emergentOrigin: r.emergent_origin ?? null,
    createdAt: r.created_at,
  }));

  // Règles métier du sprint. T-20260921-133134-yz2i : aucune table `task_regles`
  // n'existe → le signal écosystème d'une règle est DÉRIVÉ par transitivité
  // (`task_fonctionnalites` ⨝ `fonctionnalite_regles`) : nb de tâches DISTINCTES
  // `done` liées à une fonctionnalité qui PORTE cette règle. Une qualification
  // explicite (`implemented=1`) prime (origine explicite). Conséquence assumée :
  // une règle rattachée à une fonctionnalité `hors_ecosystem` n'est pas marquée
  // implémentée « par ricochet » (elle doit être qualifiée elle-même).
  const regles = (await pool().query(
    `SELECT r.*,
            (SELECT COUNT(DISTINCT tf.task_id)
               FROM fonctionnalite_regles fr
               JOIN task_fonctionnalites tf ON tf.fonctionnalite_id = fr.fonctionnalite_id
              WHERE fr.regle_id = r.id
                AND EXISTS (SELECT 1 FROM executions e
                             WHERE e.task_id = tf.task_id AND e.status = 'done'
                               AND e.attempt = (SELECT MAX(x.attempt) FROM executions x WHERE x.task_id = tf.task_id))
            ) AS done_tasks
       FROM regles_metier r
       JOIN sprint_regles sr ON sr.regle_id = r.id
      WHERE sr.sprint_id = $1
      ORDER BY r.ref ASC`, [sid],
  )).rows.map((r) => {
    const doneTasks = Number(r.done_tasks) || 0;
    const explicit = !!r.implemented;
    const implemented = explicit || doneTasks >= 1;
    const implementedOrigin = explicit
      ? (r.implemented_origin || (doneTasks >= 1 ? "ecosystem" : null))
      : (doneTasks >= 1 ? "ecosystem" : null);
    return {
      id: r.id,
      ref: r.ref,
      content: r.content,
      emergent: !!r.emergent,
      emergentOrigin: r.emergent_origin ?? null,
      doneTasks,
      implemented,
      implementedOrigin,
      implementedAt: r.implemented_at ?? null,
      implementedBy: r.implemented_by ?? null,
      implementedNote: r.implemented_note ?? null,
    };
  });

  const pieces = (await pool().query(
    `SELECT a.* FROM artifacts a
       JOIN sprint_pieces sp ON sp.piece_id = a.artifact_id
      WHERE sp.sprint_id = $1
      ORDER BY a.created_at ASC, a.id ASC`, [sid],
  )).rows.map((r) => {
    const p = rowToPiece(r);
    return { pieceId: p.pieceId, nature: p.nature, title: p.title, url: p.url, emergent: p.emergent, emergentOrigin: p.emergentOrigin };
  });

  const recettes = (await pool().query(
    `SELECT r.recette_id, r.title, r.status FROM recettes r
       JOIN recette_sprints rs ON rs.recette_id = r.recette_id
      WHERE rs.sprint_id = $1
      ORDER BY r.created_at ASC`, [sid],
  )).rows.map((r) => ({ recetteId: r.recette_id, title: r.title ?? null, status: r.status ?? null }));

  const sections = {
    fonctionnalitesImplementees: feats.filter((f) => f.implemented),
    fonctionnalitesEmergentes: feats.filter((f) => f.emergent),
    tachesEffectuees: tasks.filter((t) => t.done),
    tachesEmergentes: tasks.filter((t) => t.emergent),
    regles: regles,
    // Section « Règles métier implémentées » (T-20260921-133134-yz2i) — les
    // règles n'étaient comptées que par émergence.
    reglesImplementees: regles.filter((r) => r.implemented),
    reglesEmergentes: regles.filter((r) => r.emergent),
    pieces: pieces,
    piecesEmergentes: pieces.filter((p) => p.emergent),
    recettes: recettes,
  };

  // Ventilation E/H (T-20260921-133134-yz2i) : « dont E dans l'écosystème,
  // H hors écosystème ». Additif (les consommateurs existants ne cassent pas).
  const countByOrigin = (arr, origin) => arr.filter((x) => x.implementedOrigin === origin).length;
  const stats = {
    fonctionnalites: {
      total: feats.length,
      implementees: sections.fonctionnalitesImplementees.length,
      implementeesEcosystem: countByOrigin(sections.fonctionnalitesImplementees, "ecosystem"),
      implementeesHorsEcosystem: countByOrigin(sections.fonctionnalitesImplementees, "hors_ecosystem"),
      emergentes: sections.fonctionnalitesEmergentes.length,
    },
    taches: { total: tasks.length, effectuees: sections.tachesEffectuees.length, emergentes: sections.tachesEmergentes.length },
    regles: {
      total: regles.length,
      implementees: sections.reglesImplementees.length,
      implementeesEcosystem: countByOrigin(sections.reglesImplementees, "ecosystem"),
      implementeesHorsEcosystem: countByOrigin(sections.reglesImplementees, "hors_ecosystem"),
      emergentes: sections.reglesEmergentes.length,
    },
    pieces: { total: pieces.length, emergentes: sections.piecesEmergentes.length },
    recettes: { total: recettes.length },
  };

  const md = [];
  md.push(`# Rapport de sprint — ${sprint.title}`);
  md.push("");
  md.push(`- **Sprint** : \`${sprint.id}\`${sprint.isDefault ? " (sprint par défaut)" : ""}`);
  md.push(`- **Projet** : \`${sprint.project}\``);
  md.push(`- **Période** : ${sprint.startDate || "?"} → ${sprint.endDate || "?"}`);
  md.push(`- **Statut** : \`${sprint.status}\`${sprint.closedAt ? ` (clôturé le ${sprint.closedAt}${sprint.closeReason ? ` — ${sprint.closeReason}` : ""})` : ""}`);
  md.push(`- **Rapport généré** : ${nowIso()}`);
  md.push("");
  md.push("## Synthèse");
  md.push("");
  md.push("| Élément | Total | Détail |");
  md.push("|---|---|---|");
  md.push(`| Fonctionnalités | ${stats.fonctionnalites.total} | ${stats.fonctionnalites.implementees} implémentée(s) — dont ${stats.fonctionnalites.implementeesEcosystem} dans l'écosystème, ${stats.fonctionnalites.implementeesHorsEcosystem} hors écosystème ; ${stats.fonctionnalites.emergentes} émergente(s) |`);
  md.push(`| Tâches | ${stats.taches.total} | ${stats.taches.effectuees} effectuée(s), ${stats.taches.emergentes} émergente(s) |`);
  md.push(`| Règles métier | ${stats.regles.total} | ${stats.regles.implementees} implémentée(s) — dont ${stats.regles.implementeesEcosystem} dans l'écosystème, ${stats.regles.implementeesHorsEcosystem} hors écosystème ; ${stats.regles.emergentes} émergente(s) |`);
  md.push(`| Pièces client | ${stats.pieces.total} | ${stats.pieces.emergentes} émergente(s) |`);
  md.push(`| Recettes | ${stats.recettes.total} | — |`);
  md.push("");
  const list = (title, arr, fmt) => {
    md.push(`## ${title} (${arr.length})`);
    md.push("");
    if (!arr.length) { md.push("_Aucun élément._"); md.push(""); return; }
    for (const it of arr) md.push(`- ${fmt(it)}`);
    md.push("");
  };
  // Libellé d'origine d'une implémentation (ventilation lisible).
  const originLabel = (x) => (x.implementedOrigin === "hors_ecosystem" ? "hors écosystème" : "écosystème");
  list("Fonctionnalités implémentées", sections.fonctionnalitesImplementees, (f) => `**${f.ref}** — ${f.userStory} — implémentée (${originLabel(f)})${f.implementedNote ? ` — ${f.implementedNote}` : ""} (${f.doneTasks}/${f.totalTasks} tâche(s) done)`);
  list("Fonctionnalités émergentes", sections.fonctionnalitesEmergentes, (f) => `**${f.ref}** — ${f.userStory} _(origine : ${f.emergentOrigin || "?"})_`);
  list("Tâches effectuées", sections.tachesEffectuees, (t) => `\`${t.id}\` — ${t.title || t.request}`);
  list("Tâches émergentes", sections.tachesEmergentes, (t) => `\`${t.id}\` — ${t.title || t.request} _(origine : ${t.emergentOrigin || "?"}, statut : ${t.status})_`);
  list("Règles métier implémentées", sections.reglesImplementees, (r) => `**${r.ref}** — ${r.content} — implémentée (${originLabel(r)})${r.implementedNote ? ` — ${r.implementedNote}` : ""}`);
  list("Règles métier", sections.regles, (r) => `**${r.ref}** — ${r.content}${r.implemented ? ` — implémentée (${originLabel(r)})${r.implementedNote ? ` — ${r.implementedNote}` : ""}` : ""}${r.emergent ? ` _(émergente : ${r.emergentOrigin || "?"})_` : ""}`);
  list("Pièces client", sections.pieces, (p) => `[${p.nature || "?"}] ${p.title || p.pieceId}${p.url ? ` — ${p.url}` : ""}${p.emergent ? ` _(émergente : ${p.emergentOrigin || "?"})_` : ""}`);
  list("Recettes", sections.recettes, (r) => `\`${r.recetteId}\` — ${r.title || ""} (${r.status || "?"})`);

  return { sprint, stats, sections, markdown: md.join("\n") };
}

// ===========================================================================
// FONCTIONNALITÉS / RÈGLES MÉTIER / LIAISONS (ADR-001, T5). CRUD MCP au-dessus
// des tables T1 (`fonctionnalites`, `regles_metier`) + outils de LIAISON sur
// les tables N:N T1. Règles structurantes :
//   - PIÈCE SOURCE gardée par la garde T2 (`assertAttachablePiece`) ;
//   - ÉMERGENCE réutilisant `classifyEmergence` (`hors_sprint`/`apres_cloture`),
//     jamais bloquante ni rétroactive, rattachable à un sprint ULTÉRIEUR ;
//   - LIEN ADR d'une tâche PROPOSÉ par l'agent → EFFECTIF après validation
//     humaine (`task_adr.status` : `propose` → `valide`) ;
//   - aucune création systématique d'ADR (liaison vers une ADR EXISTANTE).
// NE TOUCHE PAS la famille ADR (`artifacts` doc_type='adr', `adr_*`).
// ===========================================================================

// Sérialise une ligne `fonctionnalites` → fonctionnalité (camelCase).
function rowToFonctionnalite(r) {
  if (!r) return null;
  return {
    id: r.id,
    project: r.project,
    ref: r.ref,
    role: r.role ?? null,
    userStory: r.user_story,
    sourcedPieceId: r.sourced_piece_id ?? null,
    emergent: !!r.emergent,
    emergentOrigin: r.emergent_origin ?? null,
    // État d'implémentation explicite + origine (T-20260921-133134-yz2i).
    implemented: !!r.implemented,
    implementedOrigin: r.implemented_origin ?? null,
    implementedAt: r.implemented_at ?? null,
    implementedBy: r.implemented_by ?? null,
    implementedNote: r.implemented_note ?? null,
    // STATUT DE DÉVELOPPEMENT (axe 3, analyse du code) + source tracée.
    devStatus: r.dev_status ?? null,
    devStatusSource: r.dev_status_source ?? null,
    devStatusNote: r.dev_status_note ?? null,
    devStatusAt: r.dev_status_at ?? null,
    devStatusBy: r.dev_status_by ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at ?? null,
    createdBy: r.created_by ?? null,
  };
}

// Sérialise une ligne `regles_metier` → règle métier (camelCase).
function rowToRegle(r) {
  if (!r) return null;
  return {
    id: r.id,
    project: r.project,
    ref: r.ref,
    content: r.content,
    sourcedPieceId: r.sourced_piece_id ?? null,
    emergent: !!r.emergent,
    emergentOrigin: r.emergent_origin ?? null,
    // État d'implémentation explicite + origine (T-20260921-133134-yz2i).
    implemented: !!r.implemented,
    implementedOrigin: r.implemented_origin ?? null,
    implementedAt: r.implemented_at ?? null,
    implementedBy: r.implemented_by ?? null,
    implementedNote: r.implemented_note ?? null,
    // STATUT DE RESPECT (axe dédié, distinct du développement) + traçabilité.
    respectStatus: r.respect_status ?? null,
    respectStatusNote: r.respect_status_note ?? null,
    respectStatusAt: r.respect_status_at ?? null,
    respectStatusBy: r.respect_status_by ?? null,
    // Association EXPLICITE de rôles (1..N) ou rôle GLOBAL (T-20260922-064200-e0yw).
    // `pg` renvoie TEXT[] comme tableau JS natif ; repli `[]` si NULL.
    roles: Array.isArray(r.roles) ? r.roles : [],
    roleGlobal: !!r.role_global,
    createdAt: r.created_at,
    updatedAt: r.updated_at ?? null,
    createdBy: r.created_by ?? null,
  };
}

// GARDE d'appartenance : la pièce SOURCE d'une fonctionnalité/règle doit
// appartenir au PROJET (pièce `piece` : `content_id = projectId` ; doc ADR-12
// requalifié : lien `artifact_projects`). Lève une erreur explicite sinon.
async function assertPieceOwnedByProject(pieceId, projectId) {
  const r = (await pool().query(
    `SELECT 1 FROM artifacts a
      WHERE a.artifact_id = $1
        AND (a.content_id = $2
             OR EXISTS (SELECT 1 FROM artifact_projects ap
                         WHERE ap.artifact_id = a.artifact_id AND ap.project_id = $2))
      LIMIT 1`, [String(pieceId), String(projectId)],
  )).rows[0];
  if (!r) throw new Error(`pièce source ${pieceId} non rattachée au projet ${projectId}`);
  return true;
}

// CRÉATION d'une FONCTIONNALITÉ (`US-xxx`, ADR-001 §3). `projectId` + `ref` +
// `userStory` requis ; `role` libre ; `sourcedPieceId` optionnel mais GARDÉ
// (garde nature T2 `assertAttachablePiece` + appartenance au projet).
// ÉMERGENCE (`classifyEmergence`, kind='element') : hors sprint → `hors_sprint`,
// dernier sprint clôturé → `apres_cloture` ; sprint OUVERT → non émergente et
// rattachée au sprint courant (`sprint_fonctionnalites`). `recetteId` optionnel
// (T6) → origine `recette` (élément apparu en recette). `fromRecette` optionnel
// (T6) → signal EXPLICITE d'origine recette, pour une création déclenchée
// DEPUIS une recette/cadrage sans identifiant de recette encore disponible
// (ex. modale de création) ou depuis une recette évaluateur (`evaluation`).
// `fromRecette` est un paramètre d'APPEL : jamais persisté ; seule la colonne
// existante `emergent_origin` est écrite (valeur `recette`). `organization_id`
// héritée du projet. `ref` déjà utilisée pour le projet → erreur explicite.
export async function registerFeature({ projectId, ref, role, userStory, sourcedPieceId, recetteId, fromRecette, createdBy } = {}) {
  await ensureSchema();
  if (!projectId || !String(projectId).trim()) throw new Error("projectId requis");
  const pid = String(projectId).trim();
  await assertProjectExists(pid);
  const rf = ref ? String(ref).trim() : "";
  if (!rf) throw new Error("ref requise (ex. US-xxx)");
  const us = userStory ? String(userStory).trim() : "";
  if (!us) throw new Error("userStory requise");

  let pieceId = null;
  if (sourcedPieceId !== undefined && sourcedPieceId !== null && String(sourcedPieceId).trim()) {
    const id = String(sourcedPieceId).trim();
    await assertAttachablePiece(id); // garde nature (T2)
    await assertPieceOwnedByProject(id, pid); // appartenance au projet
    pieceId = id;
  }
  const dup = (await pool().query(
    "SELECT id FROM fonctionnalites WHERE project = $1 AND ref = $2", [pid, rf],
  )).rows[0];
  if (dup) throw new Error(`référence déjà utilisée pour le projet ${pid} : ${rf} (${dup.id})`);

  const em = await classifyEmergence(pid, { kind: "element", fromRecette: !!(recetteId || fromRecette) });
  const org = (await orgIdOfProject(pid)) || (await defaultOrganizationId());
  const id = `FEAT-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const ts = nowIso();
  await pool().query(
    `INSERT INTO fonctionnalites
       (id, project, ref, role, user_story, sourced_piece_id, emergent, emergent_origin, organization_id, created_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, pid, rf, role ? String(role).trim() : null, us, pieceId, em.emergent ? 1 : 0, em.emergentOrigin, org, ts, createdBy ?? null],
  );
  // Non émergente (sprint ouvert) → rattachement au sprint courant.
  if (!em.emergent && em.sprintId) {
    await pool().query(
      "INSERT INTO sprint_fonctionnalites (sprint_id, fonctionnalite_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [em.sprintId, id],
    );
  }
  return getFeature(id);
}

// MODIFICATION partielle d'une FONCTIONNALITÉ (champs fournis uniquement).
// Re-gardage de la pièce source si elle change (projet inchangé) ; `updated_at`.
// Étendue (T-20260921-133134-yz2i) : `implemented`/`implementedOrigin`/
// `implementedNote` qualifient l'état d'implémentation via le helper UNIQUE
// `applyImplementationQualification`. Si SEULS ces champs sont fournis, le
// helper pose `updated_at` et on retourne sans second UPDATE (anti double écriture).
export async function updateFeature({ featureId, ref, role, userStory, sourcedPieceId, implemented, implementedOrigin, implementedNote, devStatus, devStatusSource, devStatusNote, by } = {}) {
  await ensureSchema();
  if (!featureId) throw new Error("featureId requis");
  const cur = (await pool().query("SELECT * FROM fonctionnalites WHERE id = $1", [String(featureId)])).rows[0];
  if (!cur) throw new Error(`fonctionnalité inconnue : ${featureId}`);
  const hasImplFields = implemented !== undefined || implementedOrigin !== undefined || implementedNote !== undefined;
  const hasDevFields = devStatus !== undefined || devStatusSource !== undefined || devStatusNote !== undefined;
  const sets = [];
  const params = [];
  if (ref !== undefined) {
    const rf = ref ? String(ref).trim() : "";
    if (!rf) throw new Error("ref ne peut être vide");
    if (rf !== cur.ref) {
      const dup = (await pool().query(
        "SELECT id FROM fonctionnalites WHERE project = $1 AND ref = $2 AND id <> $3", [cur.project, rf, cur.id],
      )).rows[0];
      if (dup) throw new Error(`référence déjà utilisée pour le projet ${cur.project} : ${rf} (${dup.id})`);
      params.push(rf); sets.push(`ref = $${params.length}`);
    }
  }
  if (role !== undefined) { params.push(role ? String(role).trim() : null); sets.push(`role = $${params.length}`); }
  if (userStory !== undefined) {
    const us = userStory ? String(userStory).trim() : "";
    if (!us) throw new Error("userStory ne peut être vide");
    params.push(us); sets.push(`user_story = $${params.length}`);
  }
  if (sourcedPieceId !== undefined) {
    if (sourcedPieceId === null || sourcedPieceId === "" || !String(sourcedPieceId).trim()) {
      params.push(null); sets.push(`sourced_piece_id = $${params.length}`);
    } else {
      const id = String(sourcedPieceId).trim();
      await assertAttachablePiece(id);
      await assertPieceOwnedByProject(id, cur.project);
      params.push(id); sets.push(`sourced_piece_id = $${params.length}`);
    }
  }
  if (!sets.length) {
    // Seuls les champs d'implémentation / de développement (ou aucun) : les
    // helpers écrivent `updated_at`.
    if (hasImplFields) {
      await applyImplementationQualification({ table: "fonctionnalites", id: cur.id, implemented, origin: implementedOrigin, note: implementedNote, by });
    }
    if (hasDevFields) {
      await applyDevStatusQualification({ table: "fonctionnalites", id: cur.id, devStatus, source: devStatusSource, note: devStatusNote, by });
    }
    return getFeature(cur.id);
  }
  const ts = nowIso();
  params.push(ts); const tsIdx = params.length;
  params.push(cur.id); const idIdx = params.length;
  await pool().query(`UPDATE fonctionnalites SET ${sets.join(", ")}, updated_at = $${tsIdx} WHERE id = $${idIdx}`, params);
  if (hasImplFields) {
    await applyImplementationQualification({ table: "fonctionnalites", id: cur.id, implemented, origin: implementedOrigin, note: implementedNote, by });
  }
  if (hasDevFields) {
    await applyDevStatusQualification({ table: "fonctionnalites", id: cur.id, devStatus, source: devStatusSource, note: devStatusNote, by });
  }
  return getFeature(cur.id);
}

// ===========================================================================
// ÉTAT D'IMPLÉMENTATION + ORIGINE (T-20260921-133134-yz2i) — modèle ADDITIF.
// Une fonctionnalité/règle peut être QUALIFIÉE « implémentée » avec son ORIGINE :
//   - `ecosystem`      : implémentée par une/des tâche(s) de l'écosystème
//                        (le signal historique `done_tasks >= 1` reste la
//                        définition de repli, cf. buildSprintReport) ;
//   - `hors_ecosystem` : implémentée EN DEHORS de l'écosystème (IDE/agents des
//                        devs), SANS tâche écosystème liée.
// L'ÉMERGENCE reste un axe DISTINCT : ces helpers n'écrivent JAMAIS
// `emergent`/`emergent_origin`.
// ===========================================================================

// Origines d'implémentation admises (validation stricte).
export const IMPLEMENTED_ORIGINS = ["ecosystem", "hors_ecosystem"];

// ===========================================================================
// STATUT DE DÉVELOPPEMENT (fonctionnalité) & STATUT DE RESPECT (règle métier)
// (T-20260922-100651-m6va) — vocabulaire UNIQUE, validé à l'écriture.
//   - `DEV_STATUSES` : issu de l'ANALYSE DU CODE (axe 3) — complet / non_demarre
//     / partiel / incoherent. `incoherent` RÉUTILISE le signal évaluateur
//     `e2e_tests.status='INCOHERENT'` (ADR-003) : lien documentaire/lecture,
//     JAMAIS une écriture croisée sur `e2e_tests`.
//   - `DEV_STATUS_SOURCES` : trace QUI alimente le statut (vigilance élément 149).
//   - `RESPECT_STATUSES` : le RESPECT de la règle (axe distinct du développement).
// AXES DISTINCTS, jamais fusionnés avec `implemented`/`implemented_origin` (axe 1
// Intégration) ni avec le verdict d'évaluation (`evaluation_fonctionnalites`).
// ===========================================================================
export const DEV_STATUSES = ["complet", "non_demarre", "partiel", "incoherent"];
export const DEV_STATUS_SOURCES = ["analyse_code", "evaluateur", "agent", "humain"];
export const RESPECT_STATUSES = ["respectee", "non_respectee"];

// QUALIFICATION D'IMPLÉMENTATION — helper interne UNIQUE, partagé par les deux
// tables (`fonctionnalites`, `regles_metier`) et les quatre points d'entrée
// (updateFeature/updateRule + markFeatureImplemented/markRuleImplemented).
// Règles (décision §2.6 du plan) :
//   - `origin` fourni ⇒ `implemented` FORCÉ à 1, origine REQUISE ∈
//     {ecosystem, hors_ecosystem} (toute autre valeur ⇒ erreur) ;
//   - `implemented === false` ⇒ RESET des 4 champs de traçabilité ;
//   - `implemented === true` sans origine ⇒ conserve l'origine existante si
//     valide, sinon erreur (« origine requise ») ;
//   - `note` seule (ni implemented ni origin) ⇒ met à jour le motif sans
//     toucher à l'état ; rien à qualifier ⇒ aucun écrit.
// Idempotent : re-qualifier écrase proprement (`implemented_at` re-stampé).
// Retourne `true` si une écriture a eu lieu, `false` sinon.
async function applyImplementationQualification({ table, id, implemented, origin, note, by } = {}) {
  const TABLES = { fonctionnalites: "fonctionnalites", regles_metier: "regles_metier" };
  const tbl = TABLES[table];
  if (!tbl) throw new Error(`table inconnue pour la qualification d'implémentation : ${table}`);
  if (!id) throw new Error("identifiant requis pour la qualification d'implémentation");

  const hasImpl = implemented !== undefined && implemented !== null;
  const hasOrigin = origin !== undefined && origin !== null && String(origin).trim() !== "";
  const hasNote = note !== undefined;
  if (!hasImpl && !hasOrigin && !hasNote) return false; // rien à qualifier

  const cur = (await pool().query(`SELECT implemented, implemented_origin FROM ${tbl} WHERE id = $1`, [String(id)])).rows[0];
  if (!cur) throw new Error(`élément inconnu : ${id}`);

  // `note` seule : mise à jour du motif, état conservé.
  if (!hasImpl && !hasOrigin) {
    const ts = nowIso();
    await pool().query(
      `UPDATE ${tbl} SET implemented_note = $1, updated_at = $2 WHERE id = $3`,
      [note != null && String(note).trim() ? String(note).trim() : null, ts, String(id)],
    );
    return true;
  }

  let impl = hasImpl ? !!implemented : false;
  let org = null;
  if (hasOrigin) {
    org = String(origin).trim();
    if (!IMPLEMENTED_ORIGINS.includes(org)) {
      throw new Error(`implementedOrigin invalide : ${org} (attendu : ecosystem | hors_ecosystem)`);
    }
    impl = true; // origine fournie ⇒ implémentée (décision §2.6)
  } else if (impl) {
    const prev = cur.implemented_origin;
    if (!IMPLEMENTED_ORIGINS.includes(prev)) {
      throw new Error("implementedOrigin requis pour marquer implémentée (ecosystem | hors_ecosystem)");
    }
    org = prev;
  }

  const ts = nowIso();
  if (impl) {
    const sets = [
      "implemented = 1",
      "implemented_origin = $1",
      "implemented_at = $2",
      "implemented_by = $3",
    ];
    const params = [org, ts, by ? String(by) : null];
    if (hasNote) {
      params.push(note != null && String(note).trim() ? String(note).trim() : null);
      sets.push(`implemented_note = $${params.length}`);
    }
    params.push(ts); const tsIdx = params.length;
    params.push(String(id)); const idIdx = params.length;
    await pool().query(`UPDATE ${tbl} SET ${sets.join(", ")}, updated_at = $${tsIdx} WHERE id = $${idIdx}`, params);
    return true;
  }
  // Déqualification : reset complet de l'état et de la traçabilité.
  await pool().query(
    `UPDATE ${tbl} SET implemented = 0, implemented_origin = NULL, implemented_at = NULL,
            implemented_by = NULL, implemented_note = NULL, updated_at = $1 WHERE id = $2`,
    [ts, String(id)],
  );
  return true;
}

// QUALIFICATION DU STATUT DE DÉVELOPPEMENT — helper interne UNIQUE (table
// `fonctionnalites`). Règles :
//   - `devStatus` fourni ⇒ REQUIS ∈ DEV_STATUSES (sinon erreur) ;
//   - `devStatus` explicitement null/vide ⇒ DÉQUALIFICATION (reset des 5 champs) ;
//   - `source` fourni ⇒ REQUIS ∈ DEV_STATUS_SOURCES ; lors d'une POSE (statut
//     non nul) la source est OBLIGATOIRE (à défaut la source existante valide est
//     conservée) — jamais de statut « orphelin » non tracé ;
//   - `note` seule ⇒ met à jour le motif sans toucher au statut ;
//   - pose : `dev_status_at = now`, `dev_status_by = by`.
// Idempotent. Retourne `true` si une écriture a eu lieu, `false` sinon.
async function applyDevStatusQualification({ table, id, devStatus, source, note, by } = {}) {
  const TABLES = { fonctionnalites: "fonctionnalites" };
  const tbl = TABLES[table];
  if (!tbl) throw new Error(`table inconnue pour la qualification de développement : ${table}`);
  if (!id) throw new Error("identifiant requis pour la qualification de développement");

  const hasStatus = devStatus !== undefined;
  const hasSource = source !== undefined && source !== null && String(source).trim() !== "";
  const hasNote = note !== undefined;
  if (!hasStatus && !hasSource && !hasNote) return false; // rien à qualifier

  const cur = (await pool().query(`SELECT dev_status, dev_status_source FROM ${tbl} WHERE id = $1`, [String(id)])).rows[0];
  if (!cur) throw new Error(`élément inconnu : ${id}`);

  // `note` seule : mise à jour du motif, statut conservé.
  if (!hasStatus && !hasSource) {
    const ts = nowIso();
    await pool().query(
      `UPDATE ${tbl} SET dev_status_note = $1, updated_at = $2 WHERE id = $3`,
      [note != null && String(note).trim() ? String(note).trim() : null, ts, String(id)],
    );
    return true;
  }

  // DÉQUALIFICATION : statut explicitement null/vide ⇒ reset complet.
  if (hasStatus && (devStatus === null || String(devStatus).trim() === "")) {
    const ts = nowIso();
    await pool().query(
      `UPDATE ${tbl} SET dev_status = NULL, dev_status_source = NULL, dev_status_note = NULL,
              dev_status_at = NULL, dev_status_by = NULL, updated_at = $1 WHERE id = $2`,
      [ts, String(id)],
    );
    return true;
  }

  // Résolution du statut EFFECTIF (fourni, sinon courant requis).
  let st;
  if (hasStatus) {
    st = String(devStatus).trim();
    if (!DEV_STATUSES.includes(st)) {
      throw new Error(`devStatus invalide : ${st} (attendu : ${DEV_STATUSES.join(" | ")})`);
    }
  } else {
    st = cur.dev_status;
    if (!DEV_STATUSES.includes(st)) {
      throw new Error("devStatus requis pour qualifier (statut de développement absent)");
    }
  }
  // Résolution de la SOURCE (fournie, sinon conservée si valide, sinon erreur).
  let src;
  if (hasSource) {
    src = String(source).trim();
    if (!DEV_STATUS_SOURCES.includes(src)) {
      throw new Error(`devStatusSource invalide : ${src} (attendu : ${DEV_STATUS_SOURCES.join(" | ")})`);
    }
  } else {
    src = DEV_STATUS_SOURCES.includes(cur.dev_status_source) ? cur.dev_status_source : null;
    if (!src) {
      throw new Error("devStatusSource requis pour poser un statut de développement (analyse_code | evaluateur | agent | humain)");
    }
  }
  const ts = nowIso();
  const sets = ["dev_status = $1", "dev_status_source = $2", "dev_status_at = $3", "dev_status_by = $4"];
  const params = [st, src, ts, by ? String(by) : null];
  if (hasNote) {
    params.push(note != null && String(note).trim() ? String(note).trim() : null);
    sets.push(`dev_status_note = $${params.length}`);
  }
  params.push(ts); const tsIdx = params.length;
  params.push(String(id)); const idIdx = params.length;
  await pool().query(`UPDATE ${tbl} SET ${sets.join(", ")}, updated_at = $${tsIdx} WHERE id = $${idIdx}`, params);
  return true;
}

// QUALIFICATION DU STATUT DE RESPECT — helper interne UNIQUE (table
// `regles_metier`). Miroir du helper de développement, vocabulaire propre :
//   - `respectStatus` fourni ⇒ REQUIS ∈ RESPECT_STATUSES ;
//   - `respectStatus` explicitement null/vide ⇒ DÉQUALIFICATION (reset des 4 champs) ;
//   - `note` seule ⇒ met à jour le motif sans toucher au statut ;
//   - pose : `respect_status_at = now`, `respect_status_by = by`.
// Idempotent. Retourne `true` si une écriture a eu lieu, `false` sinon.
async function applyRespectStatusQualification({ table, id, respectStatus, note, by } = {}) {
  const TABLES = { regles_metier: "regles_metier" };
  const tbl = TABLES[table];
  if (!tbl) throw new Error(`table inconnue pour la qualification de respect : ${table}`);
  if (!id) throw new Error("identifiant requis pour la qualification de respect");

  const hasStatus = respectStatus !== undefined;
  const hasNote = note !== undefined;
  if (!hasStatus && !hasNote) return false; // rien à qualifier

  const cur = (await pool().query(`SELECT respect_status FROM ${tbl} WHERE id = $1`, [String(id)])).rows[0];
  if (!cur) throw new Error(`élément inconnu : ${id}`);

  // `note` seule : mise à jour du motif, statut conservé.
  if (!hasStatus) {
    const ts = nowIso();
    await pool().query(
      `UPDATE ${tbl} SET respect_status_note = $1, updated_at = $2 WHERE id = $3`,
      [note != null && String(note).trim() ? String(note).trim() : null, ts, String(id)],
    );
    return true;
  }

  // DÉQUALIFICATION : statut explicitement null/vide ⇒ reset complet.
  if (respectStatus === null || String(respectStatus).trim() === "") {
    const ts = nowIso();
    await pool().query(
      `UPDATE ${tbl} SET respect_status = NULL, respect_status_note = NULL,
              respect_status_at = NULL, respect_status_by = NULL, updated_at = $1 WHERE id = $2`,
      [ts, String(id)],
    );
    return true;
  }

  const st = String(respectStatus).trim();
  if (!RESPECT_STATUSES.includes(st)) {
    throw new Error(`respectStatus invalide : ${st} (attendu : ${RESPECT_STATUSES.join(" | ")})`);
  }
  const ts = nowIso();
  const sets = ["respect_status = $1", "respect_status_at = $2", "respect_status_by = $3"];
  const params = [st, ts, by ? String(by) : null];
  if (hasNote) {
    params.push(note != null && String(note).trim() ? String(note).trim() : null);
    sets.push(`respect_status_note = $${params.length}`);
  }
  params.push(ts); const tsIdx = params.length;
  params.push(String(id)); const idIdx = params.length;
  await pool().query(`UPDATE ${tbl} SET ${sets.join(", ")}, updated_at = $${tsIdx} WHERE id = $${idIdx}`, params);
  return true;
}

// MARQUE une FONCTIONNALITÉ comme implémentée avec son ORIGINE (intention
// explicite, wrappers des agents/du panneau). `origin` REQUIS. Idempotent.
export async function markFeatureImplemented({ featureId, origin, note, by } = {}) {
  await ensureSchema();
  if (!featureId) throw new Error("featureId requis");
  const org = origin != null ? String(origin).trim() : "";
  if (!IMPLEMENTED_ORIGINS.includes(org)) {
    throw new Error("origin requis (ecosystem | hors_ecosystem)");
  }
  const cur = (await pool().query("SELECT id FROM fonctionnalites WHERE id = $1", [String(featureId)])).rows[0];
  if (!cur) throw new Error(`fonctionnalité inconnue : ${featureId}`);
  await applyImplementationQualification({ table: "fonctionnalites", id: cur.id, implemented: true, origin: org, note, by });
  return getFeature(cur.id);
}

// MARQUE le STATUT DE DÉVELOPPEMENT d'une fonctionnalité (intention explicite
// des agents/du panneau — miroir `markFeatureImplemented`). `devStatus` REQUIS
// ∈ DEV_STATUSES ; `source` REQUISE ∈ DEV_STATUS_SOURCES (traçabilité « qui
// alimente le statut »). Idempotent (re-qualifier écrase proprement).
export async function markFeatureDevStatus({ featureId, devStatus, source, note, by } = {}) {
  await ensureSchema();
  if (!featureId) throw new Error("featureId requis");
  const st = devStatus != null ? String(devStatus).trim() : "";
  if (!DEV_STATUSES.includes(st)) {
    throw new Error(`devStatus requis (${DEV_STATUSES.join(" | ")})`);
  }
  const src = source != null ? String(source).trim() : "";
  if (!DEV_STATUS_SOURCES.includes(src)) {
    throw new Error(`source requise (${DEV_STATUS_SOURCES.join(" | ")})`);
  }
  const cur = (await pool().query("SELECT id FROM fonctionnalites WHERE id = $1", [String(featureId)])).rows[0];
  if (!cur) throw new Error(`fonctionnalité inconnue : ${featureId}`);
  await applyDevStatusQualification({ table: "fonctionnalites", id: cur.id, devStatus: st, source: src, note, by });
  return getFeature(cur.id);
}

// LECTURE détaillée d'une FONCTIONNALITÉ + liens : règles, scénarios Gherkin
// (`e2e_tests`), ADR, sprints, tâches, recettes. `null` si inconnue.
export async function getFeature(featureId) {
  await ensureSchema();
  if (!featureId) return null;
  const row = (await pool().query("SELECT * FROM fonctionnalites WHERE id = $1", [String(featureId)])).rows[0];
  if (!row) return null;
  const feature = rowToFonctionnalite(row);
  const [regleRows, gherkinRows, adrRows, sprintRows, taskRows, recetteRows, evalRows] = await Promise.all([
    pool().query(
      `SELECT r.* FROM regles_metier r
         JOIN fonctionnalite_regles fr ON fr.regle_id = r.id
        WHERE fr.fonctionnalite_id = $1 ORDER BY r.ref ASC`, [feature.id]),
    pool().query(
      `SELECT e.id, e.project, e.spec_file, e.scenario, e.title, e.status, e.gherkin
         FROM e2e_tests e JOIN fonctionnalite_gherkin fg ON fg.e2e_test_id = e.id
        WHERE fg.fonctionnalite_id = $1 ORDER BY e.id ASC`, [feature.id]),
    pool().query(
      `SELECT a.artifact_id, a.title, a.doc_type, a.kind, a.path
         FROM artifacts a JOIN fonctionnalite_adr fa ON fa.adr_id = a.artifact_id
        WHERE fa.fonctionnalite_id = $1 ORDER BY a.artifact_id ASC`, [feature.id]),
    pool().query(
      `SELECT s.* FROM sprints s JOIN sprint_fonctionnalites sf ON sf.sprint_id = s.id
        WHERE sf.fonctionnalite_id = $1 ORDER BY s.created_at ASC`, [feature.id]),
    pool().query(
      `SELECT t.id, t.title, t.request, t.project, t.emergent, t.emergent_origin
         FROM tasks t JOIN task_fonctionnalites tf ON tf.task_id = t.id
        WHERE tf.fonctionnalite_id = $1 ORDER BY t.created_at ASC, t.id ASC`, [feature.id]),
    pool().query(
      `SELECT r.recette_id, r.title, r.status FROM recettes r
         JOIN recette_fonctionnalites rf ON rf.recette_id = r.recette_id
        WHERE rf.fonctionnalite_id = $1 ORDER BY r.created_at ASC`, [feature.id]),
    // VERDICTS D'ÉVALUATION (recette évaluateur) — LECTURE SEULE, AXE DISTINCT
    // du statut de développement (`devStatus`) et de l'implémentation. Aucune
    // écriture : `evaluation_fonctionnalites` n'est jamais modifiée ici.
    pool().query(
      `SELECT ef.evaluation_id, e.title, e.status, ef.verdict, ef.verdict_comment
         FROM evaluation_fonctionnalites ef
         JOIN evaluations e ON e.evaluation_id = ef.evaluation_id
        WHERE ef.fonctionnalite_id = $1 ORDER BY e.created_at ASC`, [feature.id]),
  ]);
  return {
    ...feature,
    regles: regleRows.rows.map(rowToRegle),
    gherkin: gherkinRows.rows.map((g) => ({
      e2eTestId: g.id, project: g.project, specFile: g.spec_file, scenario: g.scenario,
      title: g.title ?? null, status: g.status, gherkin: g.gherkin ?? null,
    })),
    adrs: adrRows.rows.map((a) => ({ adrId: a.artifact_id, title: a.title ?? null, docType: a.doc_type, kind: a.kind ?? null, path: a.path ?? null })),
    sprints: sprintRows.rows.map(rowToSprint),
    tasks: taskRows.rows.map((t) => ({ id: t.id, title: t.title ?? null, request: t.request ?? null, project: t.project ?? null, emergent: !!t.emergent, emergentOrigin: t.emergent_origin ?? null })),
    recettes: recetteRows.rows.map((r) => ({ recetteId: r.recette_id, title: r.title ?? null, status: r.status ?? null })),
    // VERDICTS d'évaluation (lecture seule) — axe DISTINCT du statut de
    // développement. Exposés pour rendre la distinction visible (0 duplication).
    evaluationVerdicts: evalRows.rows.map((e) => ({
      evaluationId: e.evaluation_id,
      title: e.title ?? null,
      status: e.status ?? null,
      verdict: e.verdict ?? null,
      verdictComment: e.verdict_comment ?? null,
    })),
  };
}

// SUPPRESSION d'une FONCTIONNALITÉ (`feature_delete`, T-20260922-060057-febv).
// Détache EXPLICITEMENT les 6 tables de liens (les FK `ON DELETE CASCADE` sont
// le filet de sécurité), puis supprime la fonctionnalité.
//
// GARDE D'INTÉGRITÉ « ADR ≥ 1 fonctionnalité » (invariant métier, trigger
// différé `trg_fonctionnalite_adr_min`) : si la suppression ferait perdre à une
// ADR EXISTANTE sa DERNIÈRE fonctionnalité, l'appel est REFUSÉ avec un message
// préfixé `[ADR_LAST_FEATURE]` (marqueur stable lu par le panneau) — SAUF si
// `cascadeAdrs=true`. Dans ce cas les ADR devenues orphelines sont supprimées
// DANS LA MÊME TRANSACTION, AVANT les liens `fonctionnalite_adr`, afin que le
// CONSTRAINT TRIGGER différé ne les voie plus au COMMIT.
//
// Retourne `{ featureId, deleted:true, cascadedAdrs:[…] }` (ou `null` si la
// fonctionnalité est inconnue).
export async function deleteFeature(featureId, { cascadeAdrs, by } = {}) {
  await ensureSchema();
  const feature = await getFeature(featureId);
  if (!feature) return null;
  const fid = feature.id;
  void by;
  return withTransaction(async (client) => {
    // 1) ADR qui perdraient leur DERNIÈRE fonctionnalité si `fid` disparaît.
    const orphanRows = (await client.query(
      `SELECT fa.adr_id AS adr_id
         FROM fonctionnalite_adr fa
        WHERE fa.fonctionnalite_id = $1
          AND EXISTS (SELECT 1 FROM artifacts a WHERE a.artifact_id = fa.adr_id)
          AND NOT EXISTS (SELECT 1 FROM fonctionnalite_adr x
                           WHERE x.adr_id = fa.adr_id AND x.fonctionnalite_id <> $1)`,
      [fid],
    )).rows.map((r) => r.adr_id);

    if (orphanRows.length && cascadeAdrs !== true) {
      const e = new Error(
        `[ADR_LAST_FEATURE] suppression refusée : l'ADR ${orphanRows.join(", ")} ` +
        `perdrait sa dernière fonctionnalité (invariant « ADR ≥ 1 fonctionnalité »). ` +
        `Rattachez une autre fonctionnalité, supprimez l'ADR (\`doc_delete\`), ` +
        `ou relancez avec \`cascadeAdrs=true\` pour supprimer aussi l'ADR.`,
      );
      e.code = "ADR_LAST_FEATURE";
      e.adrIds = orphanRows;
      throw e;
    }

    // 2) Cascade ADR : supprimer les ADR orphelines AVANT les liens
    //    `fonctionnalite_adr` (miroir exact de `deleteDoc` : pièces jointes
    //    `adr_file` puis l'artefact ADR).
    const cascadedAdrs = [];
    for (const adrId of orphanRows) {
      await client.query("DELETE FROM artifacts WHERE content_id = $1 AND doc_type = 'adr_file'", [adrId]);
      await client.query("DELETE FROM artifacts WHERE artifact_id = $1 AND doc_type = ANY($2)", [adrId, DOCS_DOC_TYPES]);
      cascadedAdrs.push(adrId);
    }

    // 3) Détachement explicite des 6 tables de liens (miroir des FK CASCADE).
    await client.query("DELETE FROM fonctionnalite_regles WHERE fonctionnalite_id = $1", [fid]);
    await client.query("DELETE FROM fonctionnalite_gherkin WHERE fonctionnalite_id = $1", [fid]);
    await client.query("DELETE FROM fonctionnalite_adr WHERE fonctionnalite_id = $1", [fid]);
    await client.query("DELETE FROM sprint_fonctionnalites WHERE fonctionnalite_id = $1", [fid]);
    await client.query("DELETE FROM task_fonctionnalites WHERE fonctionnalite_id = $1", [fid]);
    await client.query("DELETE FROM recette_fonctionnalites WHERE fonctionnalite_id = $1", [fid]);
    await client.query("DELETE FROM fonctionnalites WHERE id = $1", [fid]);
    return { featureId: fid, deleted: true, cascadedAdrs };
  });
}

// Compteurs de LIENS des fonctionnalités — UNE requête bulk (pas de N+1 SQL).
// `unnest($1::text[])` produit une ligne par id et 6 sous-requêtes `count(*)`
// comptent les liens de chaque nature. Retourne
// `{ [id]: { rules, gherkin, adrs, sprints, tasks, recettes } }` (zéros inclus).
async function featureLinkCounts(ids) {
  const out = {};
  const list = (ids || []).map((x) => String(x)).filter(Boolean);
  if (!list.length) return out;
  const rows = (await pool().query(
    `SELECT i.id AS id,
            (SELECT count(*) FROM fonctionnalite_regles   x WHERE x.fonctionnalite_id = i.id) AS rules,
            (SELECT count(*) FROM fonctionnalite_gherkin  x WHERE x.fonctionnalite_id = i.id) AS gherkin,
            (SELECT count(*) FROM fonctionnalite_adr      x WHERE x.fonctionnalite_id = i.id) AS adrs,
            (SELECT count(*) FROM sprint_fonctionnalites  x WHERE x.fonctionnalite_id = i.id) AS sprints,
            (SELECT array_agg(sf.sprint_id)
               FROM sprint_fonctionnalites sf
              WHERE sf.fonctionnalite_id = i.id) AS "sprintIds",
            (SELECT count(*) FROM task_fonctionnalites    x WHERE x.fonctionnalite_id = i.id) AS tasks,
            (SELECT count(*) FROM recette_fonctionnalites x WHERE x.fonctionnalite_id = i.id) AS recettes
       FROM unnest($1::text[]) AS i(id)`,
    [list],
  )).rows;
  for (const r of rows) {
    out[r.id] = {
      rules: Number(r.rules) || 0,
      gherkin: Number(r.gherkin) || 0,
      adrs: Number(r.adrs) || 0,
      sprints: Number(r.sprints) || 0,
      sprintIds: Array.from(new Set((r.sprintIds || []).filter(Boolean))).sort(),
      tasks: Number(r.tasks) || 0,
      recettes: Number(r.recettes) || 0,
    };
  }
  return out;
}

// LIENS E2E (scénarios Gherkin) des fonctionnalités — UNE requête bulk (pas de
// N+1 SQL, contrainte tenue par le panneau). Retourne
// `{ [id]: [{ e2eTestId, title, status }] }` (ordre stable `e2eTestId`).
async function featureGherkinTests(ids) {
  const out = {};
  const list = (ids || []).map((x) => String(x)).filter(Boolean);
  if (!list.length) return out;
  const rows = (await pool().query(
    `SELECT fg.fonctionnalite_id AS fid, e.id AS e2e_test_id, e.title, e.status
       FROM fonctionnalite_gherkin fg
       JOIN e2e_tests e ON e.id = fg.e2e_test_id
      WHERE fg.fonctionnalite_id = ANY($1::text[])
      ORDER BY fg.fonctionnalite_id ASC, e.id ASC`,
    [list],
  )).rows;
  for (const r of rows) {
    const k = r.fid;
    if (!out[k]) out[k] = [];
    out[k].push({ e2eTestId: r.e2e_test_id, title: r.title ?? null, status: r.status ?? null });
  }
  return out;
}

// Compteurs de LIENS des règles métier — UNE requête bulk (pas de N+1 SQL).
// Retourne `{ [id]: { features, sprints, sprintIds } }` (zéros / tableau vide inclus).
// `sprintIds` = ids des sprints liés (`sprint_regles`), exposés pour le filtre
// CLIENT « lié au sprint X » sans N+1. Le `roles` DÉRIVÉ des fonctionnalités liées
// a été RETIRÉ (T-20260922-064200-e0yw) : les rôles proviennent désormais de la
// colonne explicite `regles_metier.roles` (via `rowToRegle`), source unique.
async function ruleLinkCounts(ids) {
  const out = {};
  const list = (ids || []).map((x) => String(x)).filter(Boolean);
  if (!list.length) return out;
  const rows = (await pool().query(
    `SELECT i.id AS id,
            (SELECT count(*) FROM fonctionnalite_regles x WHERE x.regle_id = i.id) AS features,
            (SELECT count(*) FROM sprint_regles         x WHERE x.regle_id = i.id) AS sprints,
            (SELECT array_agg(sr.sprint_id)
               FROM sprint_regles sr
              WHERE sr.regle_id = i.id) AS "sprintIds"
       FROM unnest($1::text[]) AS i(id)`,
    [list],
  )).rows;
  for (const r of rows) {
    out[r.id] = {
      features: Number(r.features) || 0,
      sprints: Number(r.sprints) || 0,
      // Dédup + tri déterministes (sortie stable pour les options de select).
      sprintIds: Array.from(new Set((r.sprintIds || []).filter(Boolean))).sort(),
    };
  }
  return out;
}

// LISTE des fonctionnalités d'un projet. Filtres : `emergent`, recherche
// (`ref`/`user_story`), `limit` (défaut 500). Tri stable (`ref`, `created_at`).
export async function listFeatures({ projectId, emergent, search, limit } = {}) {
  await ensureSchema();
  if (!projectId || !String(projectId).trim()) throw new Error("projectId requis");
  const params = [String(projectId).trim()];
  let where = "project = $1";
  if (emergent !== undefined && emergent !== null) {
    params.push(emergent ? 1 : 0);
    where += ` AND emergent = $${params.length}`;
  }
  if (search && String(search).trim()) {
    params.push(`%${String(search).trim()}%`);
    where += ` AND (ref ILIKE $${params.length} OR user_story ILIKE $${params.length})`;
  }
  const lim = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : 500;
  params.push(lim);
  const rows = (await pool().query(
    `SELECT * FROM fonctionnalites WHERE ${where} ORDER BY ref ASC, created_at ASC LIMIT $${params.length}`, params,
  )).rows;
  const features = rows.map(rowToFonctionnalite);
  // Compteurs de liens portés par la liste (⇒ 0 appel réseau côté panneau) :
  // UNE requête bulk, jamais de N+1. Recalculés à CHAQUE appel (pas de cache
  // périmable — compatible avec le polling `refreshActive()`).
  const counts = await featureLinkCounts(features.map((f) => f.id));
  // Liens E2E 1..N (id + titre + statut) — MÊME pattern bulk, 0 N+1.
  const gherkinTests = await featureGherkinTests(features.map((f) => f.id));
  return features.map((f) => {
    const c = counts[f.id] || {};
    return {
      ...f,
      // Champ ADDITIF : tests E2E liés (liens cliquables côté panneau).
      gherkinTests: gherkinTests[f.id] || [],
      // `links` STRICTEMENT inchangé (`{ rules, gherkin, adrs, sprints, tasks, recettes }`) :
      // ré-extraction explicite pour éviter toute fuite de `sprintIds` dans ce contrat.
      links: {
        rules: c.rules || 0,
        gherkin: c.gherkin || 0,
        adrs: c.adrs || 0,
        sprints: c.sprints || 0,
        tasks: c.tasks || 0,
        recettes: c.recettes || 0,
      },
      // Champ ADDITIF : ids des sprints liés ([] = « Sans sprint »), même requête bulk.
      sprintIds: c.sprintIds || [],
    };
  });
}

// Normalise/valide l'association EXPLICITE de rôles d'une règle métier :
// **≥1 rôle OU rôle GLOBAL** (garde unique, partagée création/édition).
// Trim, dédoublonnage, rejet des chaînes vides ; l'ordre est déterministe.
function normalizeRuleRoles({ roles, roleGlobal } = {}) {
  const global = !!roleGlobal;
  let list = [];
  if (Array.isArray(roles)) {
    list = roles.map((x) => (x == null ? "" : String(x).trim())).filter(Boolean);
  } else if (typeof roles === "string" && roles.trim()) {
    list = [roles.trim()];
  }
  list = Array.from(new Set(list));
  if (!global && !list.length) {
    throw new Error("au moins 1 rôle ou roleGlobal=true requis");
  }
  return { roles: list, roleGlobal: global };
}

// CRÉATION d'une RÈGLE MÉTIER (`RM-xxxx`, ADR-001 §3). Mêmes gardes que
// `registerFeature` (projet, pièce source, émergence). Non émergente ⇒ lien
// `sprint_regles` au sprint ouvert. `recetteId` optionnel (T6) → origine
// `recette` (règle métier apparue en recette). `fromRecette` optionnel (T6) →
// signal EXPLICITE d'origine recette (miroir exact de `registerFeature`) ;
// paramètre d'appel, jamais persisté.
export async function registerRule({ projectId, ref, content, sourcedPieceId, recetteId, fromRecette, roles, roleGlobal, createdBy } = {}) {
  await ensureSchema();
  if (!projectId || !String(projectId).trim()) throw new Error("projectId requis");
  const pid = String(projectId).trim();
  await assertProjectExists(pid);
  const rf = ref ? String(ref).trim() : "";
  if (!rf) throw new Error("ref requise (ex. RM-xxxx)");
  const ct = content ? String(content).trim() : "";
  if (!ct) throw new Error("content requis");

  let pieceId = null;
  if (sourcedPieceId !== undefined && sourcedPieceId !== null && String(sourcedPieceId).trim()) {
    const id = String(sourcedPieceId).trim();
    await assertAttachablePiece(id);
    await assertPieceOwnedByProject(id, pid);
    pieceId = id;
  }
  const dup = (await pool().query(
    "SELECT id FROM regles_metier WHERE project = $1 AND ref = $2", [pid, rf],
  )).rows[0];
  if (dup) throw new Error(`référence déjà utilisée pour le projet ${pid} : ${rf} (${dup.id})`);

  // Association EXPLICITE de rôles : garde « ≥1 rôle OU global » (T-20260922-064200-e0yw).
  const { roles: roleList, roleGlobal: isGlobal } = normalizeRuleRoles({ roles, roleGlobal });

  const em = await classifyEmergence(pid, { kind: "element", fromRecette: !!(recetteId || fromRecette) });
  const org = (await orgIdOfProject(pid)) || (await defaultOrganizationId());
  const id = `RMET-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const ts = nowIso();
  await pool().query(
    `INSERT INTO regles_metier
       (id, project, ref, content, sourced_piece_id, emergent, emergent_origin, roles, role_global, organization_id, created_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, pid, rf, ct, pieceId, em.emergent ? 1 : 0, em.emergentOrigin, roleList, isGlobal ? 1 : 0, org, ts, createdBy ?? null],
  );
  if (!em.emergent && em.sprintId) {
    await pool().query(
      "INSERT INTO sprint_regles (sprint_id, regle_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [em.sprintId, id],
    );
  }
  return getRule(id);
}

// MODIFICATION partielle d'une RÈGLE MÉTIER ; re-gardage de la pièce source.
// Étendue (T-20260921-133134-yz2i) : `implemented`/`implementedOrigin`/
// `implementedNote` qualifient l'état d'implémentation (même helper unique).
export async function updateRule({ ruleId, ref, content, sourcedPieceId, implemented, implementedOrigin, implementedNote, respectStatus, respectStatusNote, roles, roleGlobal, by } = {}) {
  await ensureSchema();
  if (!ruleId) throw new Error("ruleId requis");
  const cur = (await pool().query("SELECT * FROM regles_metier WHERE id = $1", [String(ruleId)])).rows[0];
  if (!cur) throw new Error(`règle inconnue : ${ruleId}`);
  const hasImplFields = implemented !== undefined || implementedOrigin !== undefined || implementedNote !== undefined;
  const hasRespectFields = respectStatus !== undefined || respectStatusNote !== undefined;
  const sets = [];
  const params = [];
  if (ref !== undefined) {
    const rf = ref ? String(ref).trim() : "";
    if (!rf) throw new Error("ref ne peut être vide");
    if (rf !== cur.ref) {
      const dup = (await pool().query(
        "SELECT id FROM regles_metier WHERE project = $1 AND ref = $2 AND id <> $3", [cur.project, rf, cur.id],
      )).rows[0];
      if (dup) throw new Error(`référence déjà utilisée pour le projet ${cur.project} : ${rf} (${dup.id})`);
      params.push(rf); sets.push(`ref = $${params.length}`);
    }
  }
  if (content !== undefined) {
    const ct = content ? String(content).trim() : "";
    if (!ct) throw new Error("content ne peut être vide");
    params.push(ct); sets.push(`content = $${params.length}`);
  }
  if (sourcedPieceId !== undefined) {
    if (sourcedPieceId === null || sourcedPieceId === "" || !String(sourcedPieceId).trim()) {
      params.push(null); sets.push(`sourced_piece_id = $${params.length}`);
    } else {
      const id = String(sourcedPieceId).trim();
      await assertAttachablePiece(id);
      await assertPieceOwnedByProject(id, cur.project);
      params.push(id); sets.push(`sourced_piece_id = $${params.length}`);
    }
  }
  if (roles !== undefined || roleGlobal !== undefined) {
    // État EFFECTIF en update PARTIEL : champ non fourni ⇒ valeur courante
    // conservée, puis garde « ≥1 rôle OU global » (T-20260922-064200-e0yw).
    const effRoles = roles !== undefined ? roles : cur.roles;
    const effGlobal = roleGlobal !== undefined ? !!roleGlobal : !!cur.role_global;
    const { roles: roleList, roleGlobal: isGlobal } = normalizeRuleRoles({ roles: effRoles, roleGlobal: effGlobal });
    params.push(roleList); sets.push(`roles = $${params.length}`);
    params.push(isGlobal ? 1 : 0); sets.push(`role_global = $${params.length}`);
  }
  if (!sets.length) {
    if (hasImplFields) {
      await applyImplementationQualification({ table: "regles_metier", id: cur.id, implemented, origin: implementedOrigin, note: implementedNote, by });
    }
    if (hasRespectFields) {
      await applyRespectStatusQualification({ table: "regles_metier", id: cur.id, respectStatus, note: respectStatusNote, by });
    }
    return getRule(cur.id);
  }
  const ts = nowIso();
  params.push(ts); const tsIdx = params.length;
  params.push(cur.id); const idIdx = params.length;
  await pool().query(`UPDATE regles_metier SET ${sets.join(", ")}, updated_at = $${tsIdx} WHERE id = $${idIdx}`, params);
  if (hasImplFields) {
    await applyImplementationQualification({ table: "regles_metier", id: cur.id, implemented, origin: implementedOrigin, note: implementedNote, by });
  }
  if (hasRespectFields) {
    await applyRespectStatusQualification({ table: "regles_metier", id: cur.id, respectStatus, note: respectStatusNote, by });
  }
  return getRule(cur.id);
}

// MARQUE une RÈGLE MÉTIER comme implémentée avec son ORIGINE (`origin` REQUIS).
// Idempotent (re-qualifier écrase proprement).
export async function markRuleImplemented({ ruleId, origin, note, by } = {}) {
  await ensureSchema();
  if (!ruleId) throw new Error("ruleId requis");
  const org = origin != null ? String(origin).trim() : "";
  if (!IMPLEMENTED_ORIGINS.includes(org)) {
    throw new Error("origin requis (ecosystem | hors_ecosystem)");
  }
  const cur = (await pool().query("SELECT id FROM regles_metier WHERE id = $1", [String(ruleId)])).rows[0];
  if (!cur) throw new Error(`règle inconnue : ${ruleId}`);
  await applyImplementationQualification({ table: "regles_metier", id: cur.id, implemented: true, origin: org, note, by });
  return getRule(cur.id);
}

// MARQUE le STATUT DE RESPECT d'une règle métier (intention explicite des
// agents/du panneau — miroir `markRuleImplemented`). `respectStatus` REQUIS ∈
// RESPECT_STATUSES. Idempotent.
export async function markRuleRespectStatus({ ruleId, respectStatus, note, by } = {}) {
  await ensureSchema();
  if (!ruleId) throw new Error("ruleId requis");
  const st = respectStatus != null ? String(respectStatus).trim() : "";
  if (!RESPECT_STATUSES.includes(st)) {
    throw new Error(`respectStatus requis (${RESPECT_STATUSES.join(" | ")})`);
  }
  const cur = (await pool().query("SELECT id FROM regles_metier WHERE id = $1", [String(ruleId)])).rows[0];
  if (!cur) throw new Error(`règle inconnue : ${ruleId}`);
  await applyRespectStatusQualification({ table: "regles_metier", id: cur.id, respectStatus: st, note, by });
  return getRule(cur.id);
}

// LECTURE détaillée d'une RÈGLE MÉTIER + liens : fonctionnalités (inverse),
// sprints. `null` si inconnue.
export async function getRule(ruleId) {
  await ensureSchema();
  if (!ruleId) return null;
  const row = (await pool().query("SELECT * FROM regles_metier WHERE id = $1", [String(ruleId)])).rows[0];
  if (!row) return null;
  const regle = rowToRegle(row);
  const [featRows, sprintRows] = await Promise.all([
    pool().query(
      `SELECT f.* FROM fonctionnalites f
         JOIN fonctionnalite_regles fr ON fr.fonctionnalite_id = f.id
        WHERE fr.regle_id = $1 ORDER BY f.ref ASC`, [regle.id]),
    pool().query(
      `SELECT s.* FROM sprints s JOIN sprint_regles sr ON sr.sprint_id = s.id
        WHERE sr.regle_id = $1 ORDER BY s.created_at ASC`, [regle.id]),
  ]);
  return {
    ...regle,
    fonctionnalites: featRows.rows.map(rowToFonctionnalite),
    sprints: sprintRows.rows.map(rowToSprint),
  };
}

// SUPPRESSION d'une RÈGLE MÉTIER (`rule_delete`, T-20260922-060057-febv).
// Aucun invariant métier : les liens `fonctionnalite_regles` / `sprint_regles`
// sont détachés (FK CASCADE = filet de sécurité), puis la règle est supprimée.
// Retourne `{ ruleId, deleted:true }` (ou `null` si la règle est inconnue).
export async function deleteRule(ruleId) {
  await ensureSchema();
  const rule = await getRule(ruleId);
  if (!rule) return null;
  const rid = rule.id;
  await withTransaction(async (client) => {
    await client.query("DELETE FROM fonctionnalite_regles WHERE regle_id = $1", [rid]);
    await client.query("DELETE FROM sprint_regles WHERE regle_id = $1", [rid]);
    await client.query("DELETE FROM recette_regles WHERE regle_id = $1", [rid]);
    await client.query("DELETE FROM regles_metier WHERE id = $1", [rid]);
  });
  return { ruleId: rid, deleted: true };
}

// LISTE des règles métier d'un projet. Filtres : `emergent`, recherche
// (`ref`/`content`), `limit` (défaut 500).
export async function listRules({ projectId, emergent, search, limit } = {}) {
  await ensureSchema();
  if (!projectId || !String(projectId).trim()) throw new Error("projectId requis");
  const params = [String(projectId).trim()];
  let where = "project = $1";
  if (emergent !== undefined && emergent !== null) {
    params.push(emergent ? 1 : 0);
    where += ` AND emergent = $${params.length}`;
  }
  if (search && String(search).trim()) {
    params.push(`%${String(search).trim()}%`);
    where += ` AND (ref ILIKE $${params.length} OR content ILIKE $${params.length})`;
  }
  const lim = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : 500;
  params.push(lim);
  const rows = (await pool().query(
    `SELECT * FROM regles_metier WHERE ${where} ORDER BY ref ASC, created_at ASC LIMIT $${params.length}`, params,
  )).rows;
  const rules = rows.map(rowToRegle);
  // Compteurs de liens + ids de sprints liés portés par la liste (⇒ 0 appel réseau
  // côté panneau) : UNE requête bulk, jamais de N+1. Recalculés à CHAQUE appel.
  // `roles`/`roleGlobal` proviennent de la ligne (`rowToRegle`) — plus de dérivation.
  const counts = await ruleLinkCounts(rules.map((r) => r.id));
  return rules.map((r) => {
    const c = counts[r.id] || { features: 0, sprints: 0, sprintIds: [] };
    return {
      ...r,
      // `links` STRICTEMENT inchangé (`{ features, sprints }`) : ré-extraction
      // explicite pour éviter toute fuite dans ce contrat existant.
      links: { features: c.features, sprints: c.sprints },
      // Champ ADDITIF : ids des sprints liés ([] = « Sans sprint »).
      sprintIds: c.sprintIds || [],
    };
  });
}

// --- Liaisons N:N (T1) ------------------------------------------------------

// Liaison FONCTIONNALITÉ ↔ RÈGLE MÉTIER (`fonctionnalite_regles`, idempotente).
export async function linkFeatureRule({ featureId, regleId } = {}) {
  await ensureSchema();
  const f = await getFeature(featureId);
  if (!f) throw new Error(`fonctionnalité inconnue : ${featureId}`);
  const r = await getRule(regleId);
  if (!r) throw new Error(`règle inconnue : ${regleId}`);
  const ins = await pool().query(
    "INSERT INTO fonctionnalite_regles (fonctionnalite_id, regle_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
    [f.id, r.id],
  );
  return { ok: true, featureId: f.id, regleId: r.id, linked: ins.rowCount > 0 };
}

export async function unlinkFeatureRule({ featureId, regleId } = {}) {
  await ensureSchema();
  if (!featureId || !regleId) throw new Error("featureId et regleId requis");
  const del = await pool().query(
    "DELETE FROM fonctionnalite_regles WHERE fonctionnalite_id = $1 AND regle_id = $2",
    [String(featureId), String(regleId)],
  );
  return { ok: true, featureId: String(featureId), regleId: String(regleId), unlinked: del.rowCount > 0 };
}

// Liaison FONCTIONNALITÉ ↔ SCÉNARIO GHERKIN EXISTANT (`fonctionnalite_gherkin`
// → `e2e_tests`). AUCUNE création de test : le test doit EXISTER.
export async function linkFeatureGherkin({ featureId, e2eTestId } = {}) {
  await ensureSchema();
  const f = await getFeature(featureId);
  if (!f) throw new Error(`fonctionnalité inconnue : ${featureId}`);
  const t = await getE2ETestRow(String(e2eTestId ?? ""));
  if (!t) throw new Error(`scénario Gherkin (test E2E) inconnu : ${e2eTestId}`);
  const ins = await pool().query(
    "INSERT INTO fonctionnalite_gherkin (fonctionnalite_id, e2e_test_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
    [f.id, t.id],
  );
  return { ok: true, featureId: f.id, e2eTestId: t.id, linked: ins.rowCount > 0 };
}

export async function unlinkFeatureGherkin({ featureId, e2eTestId } = {}) {
  await ensureSchema();
  if (!featureId || !e2eTestId) throw new Error("featureId et e2eTestId requis");
  const del = await pool().query(
    "DELETE FROM fonctionnalite_gherkin WHERE fonctionnalite_id = $1 AND e2e_test_id = $2",
    [String(featureId), String(e2eTestId)],
  );
  return { ok: true, featureId: String(featureId), e2eTestId: String(e2eTestId), unlinked: del.rowCount > 0 };
}

// Liaison FONCTIONNALITÉ ↔ ADR (`fonctionnalite_adr`). L'ADR doit EXISTER
// (`getAdr`, kind='adr-tech'). `unlinkFeatureAdr` LAISSE REMONTER l'erreur du
// trigger T1 `trg_fonctionnalite_adr_min` (une ADR garde ≥1 fonctionnalité).
export async function linkFeatureAdr({ featureId, adrId } = {}) {
  await ensureSchema();
  const f = await getFeature(featureId);
  if (!f) throw new Error(`fonctionnalité inconnue : ${featureId}`);
  const adr = await getAdr(adrId);
  if (!adr) throw new Error(`ADR inconnue (kind='adr-tech' attendu) : ${adrId}`);
  const ins = await pool().query(
    "INSERT INTO fonctionnalite_adr (fonctionnalite_id, adr_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
    [f.id, adr.adrId],
  );
  return { ok: true, featureId: f.id, adrId: adr.adrId, linked: ins.rowCount > 0 };
}

export async function unlinkFeatureAdr({ featureId, adrId } = {}) {
  await ensureSchema();
  if (!featureId || !adrId) throw new Error("featureId et adrId requis");
  // Pas de contournement : si c'est la DERNIÈRE fonctionnalité de l'ADR, le
  // trigger T1 lève une erreur explicite (remontée telle quelle).
  const del = await pool().query(
    "DELETE FROM fonctionnalite_adr WHERE fonctionnalite_id = $1 AND adr_id = $2",
    [String(featureId), String(adrId)],
  );
  return { ok: true, featureId: String(featureId), adrId: String(adrId), unlinked: del.rowCount > 0 };
}

// Rattachement d'une FONCTIONNALITÉ (souvent émergente) à un SPRINT
// (`sprint_fonctionnalites`, ADR-001 §5). N'EFFACE PAS le flag `emergent`.
export async function linkFeatureSprint({ featureId, sprintId } = {}) {
  await ensureSchema();
  const f = await getFeature(featureId);
  if (!f) throw new Error(`fonctionnalité inconnue : ${featureId}`);
  const s = await getSprint(sprintId);
  if (!s) throw new Error(`sprint inconnu : ${sprintId}`);
  const ins = await pool().query(
    "INSERT INTO sprint_fonctionnalites (sprint_id, fonctionnalite_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
    [s.id, f.id],
  );
  return { ok: true, featureId: f.id, sprintId: s.id, linked: ins.rowCount > 0 };
}

export async function unlinkFeatureSprint({ featureId, sprintId } = {}) {
  await ensureSchema();
  if (!featureId || !sprintId) throw new Error("featureId et sprintId requis");
  const del = await pool().query(
    "DELETE FROM sprint_fonctionnalites WHERE sprint_id = $1 AND fonctionnalite_id = $2",
    [String(sprintId), String(featureId)],
  );
  return { ok: true, featureId: String(featureId), sprintId: String(sprintId), unlinked: del.rowCount > 0 };
}

// Rattachement d'une RÈGLE MÉTIER (souvent émergente) à un SPRINT
// (`sprint_regles`). N'EFFACE PAS le flag `emergent`.
export async function linkRuleSprint({ regleId, sprintId } = {}) {
  await ensureSchema();
  const r = await getRule(regleId);
  if (!r) throw new Error(`règle inconnue : ${regleId}`);
  const s = await getSprint(sprintId);
  if (!s) throw new Error(`sprint inconnu : ${sprintId}`);
  const ins = await pool().query(
    "INSERT INTO sprint_regles (sprint_id, regle_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
    [s.id, r.id],
  );
  return { ok: true, regleId: r.id, sprintId: s.id, linked: ins.rowCount > 0 };
}

export async function unlinkRuleSprint({ regleId, sprintId } = {}) {
  await ensureSchema();
  if (!regleId || !sprintId) throw new Error("regleId et sprintId requis");
  const del = await pool().query(
    "DELETE FROM sprint_regles WHERE sprint_id = $1 AND regle_id = $2",
    [String(sprintId), String(regleId)],
  );
  return { ok: true, regleId: String(regleId), sprintId: String(sprintId), unlinked: del.rowCount > 0 };
}

// Liaison TÂCHE ↔ SPRINT (`task_sprints`).
export async function linkTaskSprint({ taskId, sprintId } = {}) {
  await ensureSchema();
  await assertTaskExists(taskId);
  const s = await getSprint(sprintId);
  if (!s) throw new Error(`sprint inconnu : ${sprintId}`);
  const ins = await pool().query(
    "INSERT INTO task_sprints (task_id, sprint_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
    [String(taskId), s.id],
  );
  return { ok: true, taskId: String(taskId), sprintId: s.id, linked: ins.rowCount > 0 };
}

export async function unlinkTaskSprint({ taskId, sprintId } = {}) {
  await ensureSchema();
  if (!taskId || !sprintId) throw new Error("taskId et sprintId requis");
  const del = await pool().query(
    "DELETE FROM task_sprints WHERE task_id = $1 AND sprint_id = $2",
    [String(taskId), String(sprintId)],
  );
  return { ok: true, taskId: String(taskId), sprintId: String(sprintId), unlinked: del.rowCount > 0 };
}

// Liaison TÂCHE ↔ FONCTIONNALITÉ (`task_fonctionnalites`) — alimente
// `buildSprintReport` (fonctionnalités implémentées).
export async function linkTaskFeature({ taskId, featureId } = {}) {
  await ensureSchema();
  await assertTaskExists(taskId);
  const f = await getFeature(featureId);
  if (!f) throw new Error(`fonctionnalité inconnue : ${featureId}`);
  const ins = await pool().query(
    "INSERT INTO task_fonctionnalites (task_id, fonctionnalite_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
    [String(taskId), f.id],
  );
  return { ok: true, taskId: String(taskId), featureId: f.id, linked: ins.rowCount > 0 };
}

export async function unlinkTaskFeature({ taskId, featureId } = {}) {
  await ensureSchema();
  if (!taskId || !featureId) throw new Error("taskId et featureId requis");
  const del = await pool().query(
    "DELETE FROM task_fonctionnalites WHERE task_id = $1 AND fonctionnalite_id = $2",
    [String(taskId), String(featureId)],
  );
  return { ok: true, taskId: String(taskId), featureId: String(featureId), unlinked: del.rowCount > 0 };
}

// --- Lien ADR d'une TÂCHE — workflow PROPOSÉ → VALIDÉ (A001/A019) -----------

// PROPOSITION (action AGENT) : upsert `task_adr.status='propose'` vers une ADR
// EXISTANTE (`getAdr`). Idempotent ; NE RÉTROGRADE JAMAIS un lien déjà `valide`.
// Aucune création d'ADR : si aucune ADR pertinente n'existe, utiliser
// `adr_register` + `adr_report_missing` (hors périmètre T5).
export async function proposeTaskAdr({ taskId, adrId, reason, by } = {}) {
  await ensureSchema();
  await assertTaskExists(taskId);
  if (!adrId) throw new Error("adrId requis");
  const adr = await getAdr(adrId);
  if (!adr) throw new Error(`ADR inconnue (kind='adr-tech' attendu) : ${adrId}`);
  const tid = String(taskId);
  const aid = adr.adrId;
  const ts = nowIso();
  const existing = (await pool().query(
    "SELECT * FROM task_adr WHERE task_id = $1 AND adr_id = $2", [tid, aid],
  )).rows[0];
  if (existing) {
    if (existing.status === "valide") {
      return { ok: true, taskId: tid, adrId: aid, status: "valide", effective: true, unchanged: true };
    }
    await pool().query(
      `UPDATE task_adr
          SET status = 'propose',
              proposed_by = COALESCE($3, proposed_by),
              proposed_at = COALESCE(proposed_at, $4),
              reason = COALESCE($5, reason)
        WHERE task_id = $1 AND adr_id = $2`,
      [tid, aid, by ?? null, ts, reason ?? null],
    );
    return { ok: true, taskId: tid, adrId: aid, status: "propose", effective: false, updated: true };
  }
  await pool().query(
    `INSERT INTO task_adr (task_id, adr_id, status, proposed_by, proposed_at, reason)
     VALUES ($1,$2,'propose',$3,$4,$5)`,
    [tid, aid, by ?? null, ts, reason ?? null],
  );
  return { ok: true, taskId: tid, adrId: aid, status: "propose", effective: false, created: true };
}

// VALIDATION (action HUMAINE, en recette) : `status='valide'` + `validated_by`
// / `validated_at` ⇒ lien EFFECTIF. Erreur si AUCUNE proposition n'existe.
// Idempotent si le lien est déjà validé.
export async function validateTaskAdr({ taskId, adrId, by } = {}) {
  await ensureSchema();
  await assertTaskExists(taskId);
  if (!adrId) throw new Error("adrId requis");
  const tid = String(taskId);
  const aid = String(adrId);
  const row = (await pool().query(
    "SELECT * FROM task_adr WHERE task_id = $1 AND adr_id = $2", [tid, aid],
  )).rows[0];
  if (!row) {
    throw new Error(`aucune proposition de lien ADR en attente pour la tâche ${tid} et l'ADR ${aid} (utiliser task_adr_propose d'abord)`);
  }
  if (row.status === "valide") {
    return { ok: true, taskId: tid, adrId: aid, status: "valide", effective: true, alreadyValidated: true };
  }
  const ts = nowIso();
  await pool().query(
    "UPDATE task_adr SET status = 'valide', validated_by = $3, validated_at = $4 WHERE task_id = $1 AND adr_id = $2",
    [tid, aid, by ?? null, ts],
  );
  return { ok: true, taskId: tid, adrId: aid, status: "valide", effective: true, validatedBy: by ?? null, validatedAt: ts };
}

export async function unlinkTaskAdr({ taskId, adrId } = {}) {
  await ensureSchema();
  if (!taskId || !adrId) throw new Error("taskId et adrId requis");
  const del = await pool().query(
    "DELETE FROM task_adr WHERE task_id = $1 AND adr_id = $2", [String(taskId), String(adrId)],
  );
  return { ok: true, taskId: String(taskId), adrId: String(adrId), unlinked: del.rowCount > 0 };
}

// LISTE des liens ADR d'une tâche, filtrable par statut ; `effective` = validé.
export async function listTaskAdrs({ taskId, status } = {}) {
  await ensureSchema();
  if (!taskId) throw new Error("taskId requis");
  const params = [String(taskId)];
  let where = "ta.task_id = $1";
  if (status) { params.push(String(status)); where += ` AND ta.status = $${params.length}`; }
  const rows = (await pool().query(
    `SELECT ta.task_id, ta.adr_id, ta.status, ta.proposed_by, ta.proposed_at,
            ta.validated_by, ta.validated_at, ta.reason,
            a.title AS adr_title, a.doc_type, a.kind, a.path
       FROM task_adr ta
       LEFT JOIN artifacts a ON a.artifact_id = ta.adr_id
      WHERE ${where} ORDER BY ta.adr_id ASC`, params,
  )).rows;
  return rows.map((r) => ({
    taskId: r.task_id,
    adrId: r.adr_id,
    status: r.status,
    effective: r.status === "valide",
    reason: r.reason ?? null,
    proposedBy: r.proposed_by ?? null,
    proposedAt: r.proposed_at ?? null,
    validatedBy: r.validated_by ?? null,
    validatedAt: r.validated_at ?? null,
    adr: { adrId: r.adr_id, title: r.adr_title ?? null, docType: r.doc_type ?? null, kind: r.kind ?? null, path: r.path ?? null },
  }));
}

// ===========================================================================
// CARDINALITÉS HEURISTIQUES + GOUVERNANCE DE L'ÉMERGENCE (T6, ADR-001 §5).
// SIGNALEMENT + TRAÇAGE, JAMAIS BLOQUANT : ces gardes ne refusent aucune
// création ; elles calculent les manques (`checkCardinality`), les TRACENT
// (`cardinality_signals`, append-only) et exposent des VUES de suivi.
// L'ÉMERGENCE n'est JAMAIS RÉTROACTIVE : aucune fonction de ce bloc ne marque
// les éléments EXISTANTS (aucun backfill ; le marquage n'a lieu qu'à la
// création, cf. `createTask`/`startRecette`/`registerFeature`/`registerRule`).
// ===========================================================================

// Origines d'émergence connues (flag `emergent_origin`). `sans_piece` est
// conservée pour compatibilité ascendante (héritage T1) mais n'est produite
// par aucune étape T6.
export const EMERGENT_ORIGINS = [
  "hors_sprint",
  "apres_cloture",
  "apres_init_sprint",
  "recette",
  "sans_fonctionnalite",
  "sans_piece",
];

// Cardinalités attendues par type d'entité (heuristiques, non bloquantes).
//   recette : 1 sprint + 1..N fonctionnalités + 1..N ADR
//   task    : 1 sprint + 1 fonctionnalité + 1..N ADR EFFECTIF (lien validé)
//   adr     : 1..N fonctionnalités
//   sprint  : 1..N fonctionnalités + 1..N règles métier
export const CARDINALITY_RULES = {
  recette: { sprint: 1, fonctionnalite: 1, adr: 1 },
  task: { sprint: 1, fonctionnalite: 1, adr: 1 },
  adr: { fonctionnalite: 1 },
  sprint: { fonctionnalite: 1, regle: 1 },
};
export const CARDINALITY_ENTITY_TYPES = ["recette", "task", "adr", "sprint"];
export const CARDINALITY_VIEWS = [
  "tache_sans_adr",
  "tache_sans_fonctionnalite",
  "tache_sans_sprint",
  "recette_sans_adr",
  "recette_sans_fonctionnalite",
  "recette_sans_sprint",
  "adr_sans_fonctionnalite",
  "sprint_sans_fonctionnalite",
  "sprint_sans_regle",
  "emergents",
];

// Parse tolérant d'une colonne JSON TEXT (legacy) ou déjà objet.
function parseJsonSafe(raw, fallback) {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw); } catch { return fallback; }
}

function rowToCardinalitySignal(r) {
  if (!r) return null;
  return {
    signalId: r.signal_id,
    project: r.project,
    entityType: r.entity_type,
    entityId: r.entity_id,
    missing: parseJsonSafe(r.missing, []),
    detail: parseJsonSafe(r.detail, {}),
    status: r.status,
    origin: r.origin ?? null,
    createdAt: r.created_at,
    createdBy: r.created_by ?? null,
    updatedAt: r.updated_at ?? null,
    resolvedAt: r.resolved_at ?? null,
    resolvedBy: r.resolved_by ?? null,
    resolution: r.resolution ?? null,
  };
}

async function getCardinalitySignalById(signalId) {
  if (!signalId) return null;
  const r = (await pool().query("SELECT * FROM cardinality_signals WHERE signal_id = $1", [String(signalId)])).rows[0];
  return rowToCardinalitySignal(r);
}

// CALCUL LIVE des manques de cardinalité d'une entité. NE THROW JAMAIS sur un
// manque : retourne `{ ok, found, entityType, entityId, projectId, missing[], detail }`
// où `ok = (missing.length === 0)` et `found` distingue une entité inconnue.
export async function checkCardinality({ entityType, entityId, projectId } = {}) {
  await ensureSchema();
  const type = entityType ? String(entityType).trim() : "";
  const id = entityId ? String(entityId).trim() : "";
  const out = {
    ok: true,
    found: true,
    entityType: type,
    entityId: id,
    projectId: projectId ? String(projectId).trim() : null,
    missing: [],
    detail: {},
  };
  if (!type || !id) {
    out.ok = false; out.found = false;
    out.detail = { error: "entityType et entityId requis" };
    return out;
  }
  if (!CARDINALITY_ENTITY_TYPES.includes(type)) {
    out.ok = false; out.found = false;
    out.detail = { error: `entityType inconnu : ${type} (attendu : ${CARDINALITY_ENTITY_TYPES.join(" | ")})` };
    return out;
  }
  try {
    if (type === "task") {
      const t = await getTask(id);
      if (!t) { out.ok = false; out.found = false; out.detail = { error: `tâche inconnue : ${id}` }; return out; }
      out.projectId = out.projectId || t.project || null;
      const [sp, fe, adr, adrProp] = await Promise.all([
        pool().query("SELECT COUNT(*) AS n FROM task_sprints WHERE task_id = $1", [id]),
        pool().query("SELECT COUNT(*) AS n FROM task_fonctionnalites WHERE task_id = $1", [id]),
        pool().query("SELECT COUNT(*) AS n FROM task_adr WHERE task_id = $1 AND status = 'valide'", [id]),
        pool().query("SELECT COUNT(*) AS n FROM task_adr WHERE task_id = $1 AND status = 'propose'", [id]),
      ]);
      const nSp = Number(sp.rows[0].n) || 0;
      const nFe = Number(fe.rows[0].n) || 0;
      const nAdr = Number(adr.rows[0].n) || 0;
      out.detail = { sprint: nSp, fonctionnalite: nFe, adr: nAdr, adrPropose: Number(adrProp.rows[0].n) || 0 };
      if (nSp < 1) out.missing.push("sprint");
      if (nFe < 1) out.missing.push("fonctionnalite");
      if (nAdr < 1) out.missing.push("adr");
    } else if (type === "recette") {
      const r = await getRecetteById(id);
      if (!r) { out.ok = false; out.found = false; out.detail = { error: `recette inconnue : ${id}` }; return out; }
      out.projectId = out.projectId || r.project || null;
      const [sp, fe, adr] = await Promise.all([
        pool().query("SELECT COUNT(*) AS n FROM recette_sprints WHERE recette_id = $1", [id]),
        pool().query("SELECT COUNT(*) AS n FROM recette_fonctionnalites WHERE recette_id = $1", [id]),
        pool().query("SELECT COUNT(*) AS n FROM recette_adr WHERE recette_id = $1", [id]),
      ]);
      const nSp = Number(sp.rows[0].n) || 0;
      const nFe = Number(fe.rows[0].n) || 0;
      const nAdr = Number(adr.rows[0].n) || 0;
      out.detail = { sprint: nSp, fonctionnalite: nFe, adr: nAdr };
      if (nSp < 1) out.missing.push("sprint");
      if (nFe < 1) out.missing.push("fonctionnalite");
      if (nAdr < 1) out.missing.push("adr");
    } else if (type === "adr") {
      const a = await getAdr(id);
      if (!a) { out.ok = false; out.found = false; out.detail = { error: `ADR inconnue (kind='adr-tech' attendu) : ${id}` }; return out; }
      if (!out.projectId && Array.isArray(a.projects) && a.projects.length) out.projectId = a.projects[0];
      const fe = await pool().query("SELECT COUNT(*) AS n FROM fonctionnalite_adr WHERE adr_id = $1", [id]);
      const nFe = Number(fe.rows[0].n) || 0;
      out.detail = { fonctionnalite: nFe };
      if (nFe < 1) out.missing.push("fonctionnalite");
    } else if (type === "sprint") {
      const s = await getSprint(id);
      if (!s) { out.ok = false; out.found = false; out.detail = { error: `sprint inconnu : ${id}` }; return out; }
      out.projectId = out.projectId || s.project || null;
      const [fe, re] = await Promise.all([
        pool().query("SELECT COUNT(*) AS n FROM sprint_fonctionnalites WHERE sprint_id = $1", [id]),
        pool().query("SELECT COUNT(*) AS n FROM sprint_regles WHERE sprint_id = $1", [id]),
      ]);
      const nFe = Number(fe.rows[0].n) || 0;
      const nRe = Number(re.rows[0].n) || 0;
      out.detail = { fonctionnalite: nFe, regle: nRe };
      if (nFe < 1) out.missing.push("fonctionnalite");
      if (nRe < 1) out.missing.push("regle");
    }
  } catch (e) {
    out.ok = false;
    out.detail = { error: e.message };
    return out;
  }
  out.ok = out.missing.length === 0;
  return out;
}

// PERSISTE le signal de cardinalité OPEN d'une entité (upsert par entité :
// l'index partiel unique garantit 1 seul OPEN ; un nouveau passage RAFRAÎCHIT
// `missing`/`detail`). NE THROW JAMAIS (try/catch intégral) : le flot de
// création (panneau) reste intact même si la garde échoue. `by` est tracé.
export async function recordCardinalitySignal({ entityType, entityId, projectId, by } = {}) {
  try {
    await ensureSchema();
    const check = await checkCardinality({ entityType, entityId, projectId });
    if (!check.found) return { ok: false, error: (check.detail && check.detail.error) || "entité inconnue", check };
    const pid = check.projectId || (projectId ? String(projectId).trim() : null);
    if (!pid) return { ok: false, error: "projectId introuvable pour le signal", check };
    const type = check.entityType;
    const id = check.entityId;
    const ts = nowIso();
    const existing = (await pool().query(
      "SELECT * FROM cardinality_signals WHERE entity_type = $1 AND entity_id = $2 AND status = 'open' ORDER BY created_at DESC LIMIT 1",
      [type, id],
    )).rows[0];
    if (check.missing.length === 0) {
      // Aucun manque : on rafraîchit un éventuel OPEN (il devient « stale » côté
      // lecture) sans en créer ; sinon rien (pas de signal inutile).
      if (existing) {
        await pool().query(
          "UPDATE cardinality_signals SET missing = $2, detail = $3, updated_at = $4 WHERE signal_id = $1",
          [existing.signal_id, JSON.stringify([]), JSON.stringify(check.detail), ts],
        );
        return { ok: true, signal: await getCardinalitySignalById(existing.signal_id), created: false, refreshed: true, missing: [] };
      }
      return { ok: true, signal: null, created: false, missing: [] };
    }
    if (existing) {
      await pool().query(
        "UPDATE cardinality_signals SET missing = $2, detail = $3, updated_at = $4 WHERE signal_id = $1",
        [existing.signal_id, JSON.stringify(check.missing), JSON.stringify(check.detail), ts],
      );
      return { ok: true, signal: await getCardinalitySignalById(existing.signal_id), created: false, refreshed: true, missing: check.missing };
    }
    const signalId = `card-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    await pool().query(
      `INSERT INTO cardinality_signals
         (signal_id, project, entity_type, entity_id, missing, detail, status, origin, created_at, created_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'open',$7,$8,$9,$8)`,
      [signalId, pid, type, id, JSON.stringify(check.missing), JSON.stringify(check.detail), null, ts, by ?? null],
    );
    // Événement de tâche (traçage) — uniquement quand l'entité est une tâche.
    if (type === "task") {
      try {
        await appendEvent({
          eventId: `${id}-CARD-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          taskId: id,
          type: "CARDINALITY_SIGNAL",
          by: by || "build-notify",
          detail: { signalId, missing: check.missing, detail: check.detail },
        });
      } catch {}
    }
    return { ok: true, signal: await getCardinalitySignalById(signalId), created: true, missing: check.missing };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// HISTORIQUE filtrable des signaux (append-only, lecture seule). Chaque signal
// est enrichi du calcul LIVE `currentGaps`/`currentOk` et du drapeau `stale`
// (signal OPEN dont les manques sont désormais COMBLÉS).
export async function listCardinalitySignals({ projectId, entityType, entityId, status, limit } = {}) {
  await ensureSchema();
  const conds = [];
  const params = [];
  if (projectId) { params.push(String(projectId)); conds.push(`project = $${params.length}`); }
  if (entityType) { params.push(String(entityType)); conds.push(`entity_type = $${params.length}`); }
  if (entityId) { params.push(String(entityId)); conds.push(`entity_id = $${params.length}`); }
  if (status) { params.push(String(status)); conds.push(`status = $${params.length}`); }
  const lim = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.min(Number(limit), 5000) : 500;
  params.push(lim);
  const rows = (await pool().query(
    `SELECT * FROM cardinality_signals ${conds.length ? `WHERE ${conds.join(" AND ")}` : ""} ORDER BY created_at DESC, signal_id DESC LIMIT $${params.length}`,
    params,
  )).rows;
  const out = [];
  for (const r of rows) {
    const signal = rowToCardinalitySignal(r);
    try {
      const check = await checkCardinality({ entityType: signal.entityType, entityId: signal.entityId, projectId: signal.project });
      signal.currentGaps = check.missing;
      signal.currentOk = check.ok;
      signal.stale = signal.status === "open" && check.missing.length === 0;
    } catch {
      signal.currentGaps = null;
      signal.currentOk = null;
      signal.stale = false;
    }
    out.push(signal);
  }
  return out;
}

// CLÔTURE TRACÉE d'un signal (open → resolved). `resolution` (raison) est
// OBLIGATOIRE : jamais de clôture silencieuse. Style `resolveAdrVigilance`.
export async function resolveCardinalitySignal({ signalId, resolution, resolvedBy } = {}) {
  await ensureSchema();
  if (!signalId) throw new Error("signalId requis");
  const res = resolution === undefined || resolution === null ? "" : String(resolution).trim();
  if (!res) throw new Error("resolution requise (raison tracée de la clôture)");
  const row = (await pool().query("SELECT * FROM cardinality_signals WHERE signal_id = $1", [String(signalId)])).rows[0];
  if (!row) throw new Error(`signal de cardinalité inconnu : ${signalId}`);
  if (row.status !== "open") throw new Error(`signal déjà résolu : ${signalId}`);
  const ts = nowIso();
  await pool().query(
    `UPDATE cardinality_signals
        SET status = 'resolved', resolved_at = $2, resolved_by = $3, resolution = $4, updated_at = $2
      WHERE signal_id = $1`,
    [String(signalId), ts, resolvedBy ?? "human", res],
  );
  return getCardinalitySignalById(signalId);
}

// RATTACHEMENT NON BLOQUANT au sprint PAR DÉFAUT du projet (décision T6 §2.3) :
// uniquement si l'entité (task | recette) n'a AUCUN lien sprint ET que le projet
// n'a AUCUN sprint. Idempotent, jamais bloquant (try/catch intégral).
export async function ensureDefaultSprintLink({ entityType, entityId, projectId, by } = {}) {
  try {
    await ensureSchema();
    const type = entityType ? String(entityType).trim() : "";
    const id = entityId ? String(entityId).trim() : "";
    if (!["task", "recette"].includes(type) || !id) {
      return { ok: false, linked: false, error: "entityType (task|recette) et entityId requis" };
    }
    let pid = projectId ? String(projectId).trim() : "";
    if (!pid) {
      if (type === "task") { const t = await getTask(id); pid = t ? (t.project || "") : ""; }
      else { const r = await getRecetteById(id); pid = r ? (r.project || "") : ""; }
    }
    if (!pid) return { ok: false, linked: false, error: "projectId introuvable" };
    const linkTable = type === "task" ? "task_sprints" : "recette_sprints";
    const col = type === "task" ? "task_id" : "recette_id";
    const existing = (await pool().query(`SELECT sprint_id FROM ${linkTable} WHERE ${col} = $1 LIMIT 1`, [id])).rows[0];
    if (existing) return { ok: true, linked: false, reason: "deja_lie", sprintId: existing.sprint_id };
    const anySprint = (await pool().query("SELECT id FROM sprints WHERE project = $1 LIMIT 1", [pid])).rows[0];
    if (anySprint) return { ok: true, linked: false, reason: "projet_a_un_sprint", sprintId: anySprint.id };
    const sprint = await ensureDefaultSprint(pid, { createdBy: by });
    if (!sprint) return { ok: false, linked: false, error: "sprint par défaut non créé" };
    if (type === "task") await linkTaskSprint({ taskId: id, sprintId: sprint.id });
    else await linkRecetteSprint({ recetteId: id, sprintId: sprint.id });
    return { ok: true, linked: true, sprintId: sprint.id, sprint };
  } catch (e) {
    return { ok: false, linked: false, error: e.message };
  }
}

// VUE DE TRAÇAGE live (10 vues). Retourne `{ view, count, items }`. Lève
// uniquement si `projectId` ou `view` sont invalides (paramètres d'appel).
export async function cardinalityView({ projectId, view } = {}) {
  await ensureSchema();
  if (!projectId || !String(projectId).trim()) throw new Error("projectId requis");
  const pid = String(projectId).trim();
  const v = view ? String(view).trim() : "";
  if (!CARDINALITY_VIEWS.includes(v)) {
    throw new Error(`vue inconnue : ${view} (attendu : ${CARDINALITY_VIEWS.join(" | ")})`);
  }
  let items = [];
  if (v === "tache_sans_adr") {
    items = (await pool().query(
      `SELECT t.id, t.title, t.request, t.emergent, t.emergent_origin, t.created_at
         FROM tasks t
        WHERE t.project = $1
          AND NOT EXISTS (SELECT 1 FROM task_adr ta WHERE ta.task_id = t.id AND ta.status = 'valide')
        ORDER BY t.created_at ASC, t.id ASC`, [pid],
    )).rows.map((r) => ({ entityType: "task", id: r.id, title: r.title ?? null, request: r.request ?? null, emergent: !!r.emergent, emergentOrigin: r.emergent_origin ?? null, createdAt: r.created_at }));
  } else if (v === "tache_sans_fonctionnalite") {
    items = (await pool().query(
      `SELECT t.id, t.title, t.request, t.emergent, t.emergent_origin, t.created_at
         FROM tasks t
        WHERE t.project = $1
          AND NOT EXISTS (SELECT 1 FROM task_fonctionnalites tf WHERE tf.task_id = t.id)
        ORDER BY t.created_at ASC, t.id ASC`, [pid],
    )).rows.map((r) => ({ entityType: "task", id: r.id, title: r.title ?? null, request: r.request ?? null, emergent: !!r.emergent, emergentOrigin: r.emergent_origin ?? null, createdAt: r.created_at }));
  } else if (v === "tache_sans_sprint") {
    items = (await pool().query(
      `SELECT t.id, t.title, t.request, t.emergent, t.emergent_origin, t.created_at
         FROM tasks t
        WHERE t.project = $1
          AND NOT EXISTS (SELECT 1 FROM task_sprints ts WHERE ts.task_id = t.id)
        ORDER BY t.created_at ASC, t.id ASC`, [pid],
    )).rows.map((r) => ({ entityType: "task", id: r.id, title: r.title ?? null, request: r.request ?? null, emergent: !!r.emergent, emergentOrigin: r.emergent_origin ?? null, createdAt: r.created_at }));
  } else if (v === "recette_sans_adr") {
    items = (await pool().query(
      `SELECT r.recette_id, r.title, r.status, r.created_at
         FROM recettes r
        WHERE r.project = $1
          AND NOT EXISTS (SELECT 1 FROM recette_adr ra WHERE ra.recette_id = r.recette_id)
        ORDER BY r.created_at ASC`, [pid],
    )).rows.map((r) => ({ entityType: "recette", id: r.recette_id, title: r.title ?? null, status: r.status ?? null, createdAt: r.created_at }));
  } else if (v === "recette_sans_fonctionnalite") {
    items = (await pool().query(
      `SELECT r.recette_id, r.title, r.status, r.created_at
         FROM recettes r
        WHERE r.project = $1
          AND NOT EXISTS (SELECT 1 FROM recette_fonctionnalites rf WHERE rf.recette_id = r.recette_id)
        ORDER BY r.created_at ASC`, [pid],
    )).rows.map((r) => ({ entityType: "recette", id: r.recette_id, title: r.title ?? null, status: r.status ?? null, createdAt: r.created_at }));
  } else if (v === "recette_sans_sprint") {
    items = (await pool().query(
      `SELECT r.recette_id, r.title, r.status, r.created_at
         FROM recettes r
        WHERE r.project = $1
          AND NOT EXISTS (SELECT 1 FROM recette_sprints rs WHERE rs.recette_id = r.recette_id)
        ORDER BY r.created_at ASC`, [pid],
    )).rows.map((r) => ({ entityType: "recette", id: r.recette_id, title: r.title ?? null, status: r.status ?? null, createdAt: r.created_at }));
  } else if (v === "adr_sans_fonctionnalite") {
    items = (await pool().query(
      `SELECT a.artifact_id, a.title, a.path, a.status, a.created_at
         FROM artifacts a
         JOIN artifact_projects ap ON ap.artifact_id = a.artifact_id
        WHERE a.doc_type = 'adr' AND ap.project_id = $1
          AND NOT EXISTS (SELECT 1 FROM fonctionnalite_adr fa WHERE fa.adr_id = a.artifact_id)
        ORDER BY a.created_at ASC, a.artifact_id ASC`, [pid],
    )).rows.map((r) => ({ entityType: "adr", id: r.artifact_id, title: r.title ?? null, path: r.path ?? null, status: r.status ?? null, createdAt: r.created_at }));
  } else if (v === "sprint_sans_fonctionnalite") {
    items = (await pool().query(
      `SELECT s.id, s.title, s.status, s.is_default, s.created_at
         FROM sprints s
        WHERE s.project = $1
          AND NOT EXISTS (SELECT 1 FROM sprint_fonctionnalites sf WHERE sf.sprint_id = s.id)
        ORDER BY s.created_at ASC, s.id ASC`, [pid],
    )).rows.map((r) => ({ entityType: "sprint", id: r.id, title: r.title ?? null, status: r.status ?? null, isDefault: !!r.is_default, createdAt: r.created_at }));
  } else if (v === "sprint_sans_regle") {
    items = (await pool().query(
      `SELECT s.id, s.title, s.status, s.is_default, s.created_at
         FROM sprints s
        WHERE s.project = $1
          AND NOT EXISTS (SELECT 1 FROM sprint_regles sr WHERE sr.sprint_id = s.id)
        ORDER BY s.created_at ASC, s.id ASC`, [pid],
    )).rows.map((r) => ({ entityType: "sprint", id: r.id, title: r.title ?? null, status: r.status ?? null, isDefault: !!r.is_default, createdAt: r.created_at }));
  } else if (v === "emergents") {
    const [tasks, feats, regles, pieces] = await Promise.all([
      pool().query(
        `SELECT id, title, request, emergent_origin, created_at FROM tasks
          WHERE project = $1 AND emergent = 1 ORDER BY created_at ASC, id ASC`, [pid]),
      pool().query(
        `SELECT id, ref, user_story, emergent_origin, created_at FROM fonctionnalites
          WHERE project = $1 AND emergent = 1 ORDER BY ref ASC`, [pid]),
      pool().query(
        `SELECT id, ref, content, emergent_origin, created_at FROM regles_metier
          WHERE project = $1 AND emergent = 1 ORDER BY ref ASC`, [pid]),
      pool().query(
        `SELECT artifact_id, title, meta, created_at FROM artifacts
          WHERE doc_type = 'piece' AND content_id = $1
            AND COALESCE(meta, '{}'::jsonb)->>'emergent' = 'true'
          ORDER BY created_at ASC, artifact_id ASC`, [pid]),
    ]);
    items = [
      ...tasks.rows.map((r) => ({ entityType: "task", id: r.id, title: r.title ?? null, request: r.request ?? null, emergentOrigin: r.emergent_origin ?? null, createdAt: r.created_at })),
      ...feats.rows.map((r) => ({ entityType: "fonctionnalite", id: r.id, ref: r.ref, title: r.user_story ?? null, emergentOrigin: r.emergent_origin ?? null, createdAt: r.created_at })),
      ...regles.rows.map((r) => ({ entityType: "regle", id: r.id, ref: r.ref, title: r.content ?? null, emergentOrigin: r.emergent_origin ?? null, createdAt: r.created_at })),
      ...pieces.rows.map((r) => ({ entityType: "piece", id: r.artifact_id, title: r.title ?? null, emergentOrigin: parseJsonSafe(r.meta, {}).emergent_origin ?? null, createdAt: r.created_at })),
    ];
  }
  return { view: v, count: items.length, items };
}

// AGRÉGAT de traçage d'un projet : compteurs par vue + vues complètes +
// synthèse des signaux (total/open/resolved/stale). Lecture seule.
export async function cardinalityReport({ projectId } = {}) {
  await ensureSchema();
  if (!projectId || !String(projectId).trim()) throw new Error("projectId requis");
  const pid = String(projectId).trim();
  const views = {};
  const counts = {};
  for (const v of CARDINALITY_VIEWS) {
    views[v] = await cardinalityView({ projectId: pid, view: v });
    counts[v] = views[v].count;
  }
  const signals = await listCardinalitySignals({ projectId: pid });
  const open = signals.filter((s) => s.status === "open");
  return {
    projectId: pid,
    generatedAt: nowIso(),
    counts,
    views,
    signals: {
      total: signals.length,
      open: open.length,
      resolved: signals.length - open.length,
      stale: open.filter((s) => s.stale).length,
      items: signals,
    },
  };
}

// --- Liaisons RECETTE ↔ sprint / fonctionnalité(s) / ADR(s) -----------------

export async function linkRecetteSprint({ recetteId, sprintId } = {}) {
  await ensureSchema();
  const rec = await getRecetteById(recetteId);
  if (!rec) throw new Error(`recette inconnue : ${recetteId}`);
  const s = await getSprint(sprintId);
  if (!s) throw new Error(`sprint inconnu : ${sprintId}`);
  const ins = await pool().query(
    "INSERT INTO recette_sprints (recette_id, sprint_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
    [rec.recetteId, s.id],
  );
  return { ok: true, recetteId: rec.recetteId, sprintId: s.id, linked: ins.rowCount > 0 };
}

export async function unlinkRecetteSprint({ recetteId, sprintId } = {}) {
  await ensureSchema();
  if (!recetteId || !sprintId) throw new Error("recetteId et sprintId requis");
  const del = await pool().query(
    "DELETE FROM recette_sprints WHERE recette_id = $1 AND sprint_id = $2",
    [String(recetteId), String(sprintId)],
  );
  return { ok: true, recetteId: String(recetteId), sprintId: String(sprintId), unlinked: del.rowCount > 0 };
}

export async function linkRecetteFeature({ recetteId, featureId } = {}) {
  await ensureSchema();
  const rec = await getRecetteById(recetteId);
  if (!rec) throw new Error(`recette inconnue : ${recetteId}`);
  const f = await getFeature(featureId);
  if (!f) throw new Error(`fonctionnalité inconnue : ${featureId}`);
  const ins = await pool().query(
    "INSERT INTO recette_fonctionnalites (recette_id, fonctionnalite_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
    [rec.recetteId, f.id],
  );
  return { ok: true, recetteId: rec.recetteId, featureId: f.id, linked: ins.rowCount > 0 };
}

export async function unlinkRecetteFeature({ recetteId, featureId } = {}) {
  await ensureSchema();
  if (!recetteId || !featureId) throw new Error("recetteId et featureId requis");
  const del = await pool().query(
    "DELETE FROM recette_fonctionnalites WHERE recette_id = $1 AND fonctionnalite_id = $2",
    [String(recetteId), String(featureId)],
  );
  return { ok: true, recetteId: String(recetteId), featureId: String(featureId), unlinked: del.rowCount > 0 };
}

export async function linkRecetteAdr({ recetteId, adrId } = {}) {
  await ensureSchema();
  const rec = await getRecetteById(recetteId);
  if (!rec) throw new Error(`recette inconnue : ${recetteId}`);
  const adr = await getAdr(adrId);
  if (!adr) throw new Error(`ADR inconnue (kind='adr-tech' attendu) : ${adrId}`);
  const ins = await pool().query(
    "INSERT INTO recette_adr (recette_id, adr_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
    [rec.recetteId, adr.adrId],
  );
  return { ok: true, recetteId: rec.recetteId, adrId: adr.adrId, linked: ins.rowCount > 0 };
}

export async function unlinkRecetteAdr({ recetteId, adrId } = {}) {
  await ensureSchema();
  if (!recetteId || !adrId) throw new Error("recetteId et adrId requis");
  const del = await pool().query(
    "DELETE FROM recette_adr WHERE recette_id = $1 AND adr_id = $2",
    [String(recetteId), String(adrId)],
  );
  return { ok: true, recetteId: String(recetteId), adrId: String(adrId), unlinked: del.rowCount > 0 };
}

// Recette ↔ règle métier (T-20260922-070103-ncs1). Miroir de `linkRecetteFeature`.
export async function linkRecetteRule({ recetteId, ruleId } = {}) {
  await ensureSchema();
  const rec = await getRecetteById(recetteId);
  if (!rec) throw new Error(`recette inconnue : ${recetteId}`);
  const rule = await getRule(ruleId);
  if (!rule) throw new Error(`règle métier inconnue : ${ruleId}`);
  const ins = await pool().query(
    "INSERT INTO recette_regles (recette_id, regle_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
    [rec.recetteId, rule.id],
  );
  return { ok: true, recetteId: rec.recetteId, ruleId: rule.id, linked: ins.rowCount > 0 };
}

export async function unlinkRecetteRule({ recetteId, ruleId } = {}) {
  await ensureSchema();
  if (!recetteId || !ruleId) throw new Error("recetteId et ruleId requis");
  const del = await pool().query(
    "DELETE FROM recette_regles WHERE recette_id = $1 AND regle_id = $2",
    [String(recetteId), String(ruleId)],
  );
  return { ok: true, recetteId: String(recetteId), ruleId: String(ruleId), unlinked: del.rowCount > 0 };
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
  // LIENS OPTIONNELS (T6) — NON BLOQUANTS : sprint explicite OU sprint par
  // défaut (si le projet n'a AUCUN sprint), fonctionnalités, ADR PROPOSÉES
  // (l'humain valide en recette). Chaque garde est en try/catch : la création
  // ne peut JAMAIS échouer à cause d'un lien.
  try {
    if (task.sprintId) await linkTaskSprint({ taskId: task.id, sprintId: task.sprintId });
    else await ensureDefaultSprintLink({ entityType: "task", entityId: task.id, projectId: task.project, by: createdBy });
  } catch {}
  for (const fid of Array.isArray(task.featureIds) ? task.featureIds : []) {
    if (!fid) continue;
    try { await linkTaskFeature({ taskId: task.id, featureId: fid }); } catch {}
  }
  for (const aid of Array.isArray(task.adrIds) ? task.adrIds : []) {
    if (!aid) continue;
    try { await proposeTaskAdr({ taskId: task.id, adrId: aid, by: createdBy, reason: "lien ADR proposé à la création (T6)" }); } catch {}
  }
  // ÉMERGENCE de la TÂCHE (ADR-001 §5) via la garde partagée : créée hors sprint
  // (`hors_sprint`), après clôture (`apres_cloture`), issue d'une recette
  // (`recette`) ou sans fonctionnalité dans le sprint courant
  // (`sans_fonctionnalite`) → marquée émergente, TRACÉE et NON BLOQUANTE.
  // Jamais rétroactif (les tâches existantes ne sont pas re-marquées — T9).
  const hasFeature = Array.isArray(task.featureIds) && task.featureIds.length > 0;
  const fromRecette = !!task.recetteId;
  const emergence = await classifyEmergence(task.project, { kind: "element", hasFeature, fromRecette });
  if (emergence.emergent) {
    await pool().query(
      "UPDATE tasks SET emergent = 1, emergent_origin = $2 WHERE id = $1",
      [task.id, emergence.emergentOrigin],
    );
  }
  // SIGNAL de cardinalité (traçage, NON bloquant) : la tâche manque-t-elle
  // encore sprint / fonctionnalité / ADR EFFECTIF ?
  try { await recordCardinalitySignal({ entityType: "task", entityId: task.id, projectId: task.project, by: createdBy }); } catch {}
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
            (SELECT COUNT(*) FROM artifacts a WHERE a.content_id = l.linked_task_id AND a.doc_type = ANY($2)) AS linked_artifacts
     FROM task_links l
     LEFT JOIN tasks t ON t.id = l.linked_task_id
     WHERE l.task_id = $1
     ORDER BY l.id ASC`,
    [taskId, TASK_DOC_TYPES],
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
    emergent: !!row.emergent,
    emergentOrigin: row.emergent_origin ?? null,
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

// --- Artefacts (table polymorphe UNIQUE) -----------------------------------
// T-20260920-162801-jxtr : `artifacts` porte TOUS les artefacts, identifiés par
// le couple (doc_type, content_id). Rétrocompat : `artifact_add(taskId, kind,
// path)` et `artifact_list(taskId)` restent fonctionnels (familles TASK_DOC_TYPES).
export async function addArtifact({
  taskId, docType, contentId, kind, title, path, nature, meta, source, organizationId, createdBy,
}) {
  await ensureSchema();
  const k = kind ? String(kind).trim() : "autre";
  if (!ARTIFACT_KINDS.includes(k)) throw new Error(`kind invalide : ${kind} (attendu : ${ARTIFACT_KINDS.join(" | ")})`);
  // docType dérivé de `kind` si absent (rétrocompat artifact_add(taskId, kind, path)).
  const dt = docType ? String(docType).trim() : (DOC_TYPE_BY_ARTIFACT_KIND[k] || "autre");
  if (!DOC_TYPES.includes(dt)) throw new Error(`docType invalide : ${docType} (attendu : ${DOC_TYPES.join(" | ")})`);
  const cid = contentId ? String(contentId).trim() : (taskId ? String(taskId).trim() : null);
  if (!cid) throw new Error("contentId requis (ou taskId)");
  // Famille task : la tâche porteuse doit exister (rétrocompat).
  if (TASK_DOC_TYPES.includes(dt)) await assertTaskExists(cid);
  // Idempotence par (doc_type, content_id, kind, path).
  const existing = (await pool().query(
    "SELECT * FROM artifacts WHERE doc_type = $1 AND content_id = $2 AND kind = $3 AND path = $4 ORDER BY id LIMIT 1",
    [dt, cid, k, path ?? null],
  )).rows[0];
  if (existing) return rowToArtifact(existing);
  const src = source ? String(source).trim() : "import";
  if (!ARTIFACT_SOURCES.includes(src)) throw new Error(`source invalide : ${source} (attendu : ${ARTIFACT_SOURCES.join(" | ")})`);
  let org = organizationId || null;
  if (!org && TASK_DOC_TYPES.includes(dt)) {
    const t = (await pool().query("SELECT organization_id FROM tasks WHERE id = $1", [cid])).rows[0];
    org = (t && t.organization_id) || null;
  }
  if (!org) org = await defaultOrganizationId();
  const artifactId = `ART-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  await pool().query(
    `INSERT INTO artifacts (artifact_id, doc_type, content_id, kind, title, path, nature, source, meta, organization_id, created_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [artifactId, dt, cid, k, title ?? null, path ?? null, nature ?? null, src, meta ?? null, org, nowIso(), createdBy ?? null],
  );
  return getArtifact(artifactId);
}

function rowToArtifact(r) {
  if (!r) return null;
  const dt = r.doc_type || "autre";
  return {
    artifactId: r.artifact_id,
    id: r.id === undefined || r.id === null ? null : Number(r.id),
    docType: dt,
    contentId: r.content_id ?? null,
    // Rétrocompat `artifact_list(taskId)` : `taskId` = content_id (famille task).
    taskId: TASK_DOC_TYPES.includes(dt) ? (r.content_id ?? null) : null,
    kind: r.kind,
    title: r.title ?? null,
    path: r.path ?? null,
    nature: r.nature ?? null,
    source: r.source ?? null,
    meta: parseDocMeta(r.meta),
    description: r.description ?? null,
    status: r.status ?? null,
    context: r.context ?? null,
    decision: r.decision ?? null,
    consequences: r.consequences ?? null,
    replacedBy: r.replaced_by ?? null,
    isGlobal: r.is_global === 1 || r.is_global === true,
    organizationId: r.organization_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at ?? null,
    createdBy: r.created_by ?? null,
  };
}

// Cibles N:N d'un artefact (remplacent docTargets/getProjectsForDocs/getReposForDocs).
export async function getArtifactProjects(artifactId) {
  return (await pool().query(
    "SELECT project_id FROM artifact_projects WHERE artifact_id = $1 ORDER BY project_id", [artifactId],
  )).rows.map((r) => r.project_id);
}

export async function getArtifactRepos(artifactId) {
  return (await pool().query(
    "SELECT repo_id FROM artifact_repos WHERE artifact_id = $1 ORDER BY repo_id", [artifactId],
  )).rows.map((r) => r.repo_id);
}

async function getArtifactProjectsBatch(rows) {
  if (!rows.length) return {};
  const ids = [...new Set(rows.map((r) => r.artifact_id || r.id))];
  const links = (await pool().query(
    "SELECT artifact_id, project_id FROM artifact_projects WHERE artifact_id = ANY($1) ORDER BY project_id", [ids],
  )).rows;
  const map = {};
  for (const l of links) (map[l.artifact_id] = map[l.artifact_id] || []).push(l.project_id);
  return map;
}

async function getArtifactReposBatch(rows) {
  if (!rows.length) return {};
  const ids = [...new Set(rows.map((r) => r.artifact_id || r.id))];
  const links = (await pool().query(
    "SELECT artifact_id, repo_id FROM artifact_repos WHERE artifact_id = ANY($1) ORDER BY repo_id", [ids],
  )).rows;
  const map = {};
  for (const l of links) (map[l.artifact_id] = map[l.artifact_id] || []).push(l.repo_id);
  return map;
}

// Pièces jointes d'ADR : artefacts `doc_type='adr_file'` portés par `artifactId`.
async function listArtifactAttachments(artifactId) {
  const rows = (await pool().query(
    "SELECT * FROM artifacts WHERE content_id = $1 AND doc_type = 'adr_file' ORDER BY created_at", [artifactId],
  )).rows;
  return rows.map(rowToAttachment);
}

export async function getArtifact(artifactId) {
  await ensureSchema();
  const res = await pool().query("SELECT * FROM artifacts WHERE artifact_id = $1", [artifactId]);
  if (!res.rows[0]) return null;
  const base = rowToArtifact(res.rows[0]);
  const [projects, repos, attachments] = await Promise.all([
    getArtifactProjects(artifactId),
    getArtifactRepos(artifactId),
    listArtifactAttachments(artifactId),
  ]);
  return { ...base, projects, repos, attachments };
}

// Lecture centrale filtrée. `listArtifacts(taskId)` (string) reste RÉTROCOMPATIBLE.
export async function listArtifacts(arg) {
  await ensureSchema();
  const opts = typeof arg === "string" ? { taskId: arg } : (arg || {});
  const conds = [];
  const params = [];
  if (opts.taskId) {
    params.push(String(opts.taskId)); conds.push(`content_id = $${params.length}`);
    params.push(TASK_DOC_TYPES); conds.push(`doc_type = ANY($${params.length})`);
  }
  if (opts.docType) { params.push(String(opts.docType)); conds.push(`doc_type = $${params.length}`); }
  if (opts.contentId) { params.push(String(opts.contentId)); conds.push(`content_id = $${params.length}`); }
  if (opts.kind) { params.push(String(opts.kind)); conds.push(`kind = $${params.length}`); }
  if (opts.q) { params.push(`%${String(opts.q)}%`); conds.push(`(title ILIKE $${params.length} OR path ILIKE $${params.length})`); }
  const lim = Number.isFinite(Number(opts.limit)) && Number(opts.limit) > 0 ? Math.min(Number(opts.limit), 5000) : 500;
  params.push(lim);
  const res = await pool().query(
    `SELECT * FROM artifacts ${conds.length ? "WHERE " + conds.join(" AND ") : ""} ORDER BY id DESC LIMIT $${params.length}`,
    params,
  );
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
      `SELECT d.*, dr.repo_id AS rid FROM artifacts d JOIN artifact_repos dr ON dr.artifact_id = d.artifact_id
       WHERE d.doc_type = ANY($1) ORDER BY d.doc_type, d.title NULLS LAST`, [DOCS_DOC_TYPES],
    )).rows;
    const enriched = await enrichDocs(docs);
    const byRepo = {};
    for (const d of docs) (byRepo[d.rid] = byRepo[d.rid] || []).push(d.artifact_id);
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
      `SELECT DISTINCT d.* FROM artifacts d JOIN artifact_projects dp ON dp.artifact_id = d.artifact_id
       WHERE dp.project_id = ANY($1) AND d.doc_type = ANY($2) ORDER BY d.doc_type, d.title NULLS LAST`, [projectIds, DOCS_DOC_TYPES],
    )).rows;
    for (const e of await enrich(rows)) (out.projects[e.projects[0]] = out.projects[e.projects[0]] || []).push(e);
  }
  if (repoIds.length) {
    const rows = (await pool().query(
      `SELECT DISTINCT d.* FROM artifacts d JOIN artifact_repos dr ON dr.artifact_id = d.artifact_id
       WHERE dr.repo_id = ANY($1) AND d.doc_type = ANY($2) ORDER BY d.doc_type, d.title NULLS LAST`, [repoIds, DOCS_DOC_TYPES],
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

// ADR (item 120) : référentiel unique des statuts, partagé avec index.mjs (zod).
export const ADR_STATUS = ["Proposé", "Accepté", "Déprécié", "Remplacé"];

// Valide un statut ADR. `undefined`/`null`/"" → null (docs legacy sans statut).
function assertAdrStatus(status) {
  if (status === undefined || status === null || String(status).trim() === "") return null;
  const s = String(status).trim();
  if (!ADR_STATUS.includes(s)) {
    throw new Error(`status invalide : ${status} (attendu : ${ADR_STATUS.join(" | ")})`);
  }
  return s;
}

// Pièces jointes d'ADR (item 122) : référentiel unique des sources, partagé
// avec index.mjs (zod). registry = document du registre ; import = fichier
// importé (storage/ref-docs) ; ref = fichier référencé par chemin.
export const DOC_ATTACHMENT_SOURCES = ["registry", "import", "ref"];

// Taxonomie `doc_type` (fusion polymorphe — table unique `artifacts`).
// Référentiel central partagé : voir `docs/nomenclature-doc-type.md`
// (panneau orchestrator-panel) et la tâche T-20260920-162801-jxtr.
// Une SEULE table `artifacts` porte tous les artefacts, identifiés par le
// couple (doc_type, content_id). `kind` est la NATURE, distincte de `doc_type`.
export const DOC_TYPES = ["adr", "specs", "gherkin", "project_doc", "adr_file", "plan", "task_synthese", "task_report", "audit_report", "recette_report", "recette_doc", "e2e_report", "e2e_video", "piece", "autre"];
// Famille « pièce client » (ADR-001) : matière première des sprints. Une pièce
// est un artefact `doc_type='piece'`, `content_id = projectId` (le PROJET est
// l'entité porteuse), `kind='autre'` ; les métadonnées vivent dans `meta` (JSONB).
export const PIECE_DOC_TYPES = ["piece"];
// Natures ADMISES d'une pièce client : markdown | pdf | docx | lien externe
// (lien Drive public, mis en PUBLIC par l'utilisateur). PHOTO et VIDÉO sont REFUSÉES.
export const PIECE_NATURES = ["markdown", "pdf", "docx", "lien"];
// Extension de fichier → nature admise.
export const PIECE_NATURE_BY_EXT = { ".md": "markdown", ".markdown": "markdown", ".pdf": "pdf", ".docx": "docx" };
// Extensions PHOTO / VIDÉO explicitement REFUSÉES (import de fichier ET lien externe).
export const PIECE_REFUSED_EXT = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".bmp", ".tiff", ".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"];
// Hôtes vidéo connus REFUSÉS pour les liens externes (une vidéo n'est pas une pièce client).
export const PIECE_REFUSED_HOSTS = ["youtube.com", "youtu.be", "vimeo.com", "dailymotion.com", "twitch.tv", "tiktok.com"];
// Avertissement de sécurité attaché aux pièces « lien » (URL publique = accès ouvert).
export const PIECE_LINK_SECURITY_NOTE = "Lien public : toute personne disposant de l'URL accède au contenu (limite de sécurité assumée — ADR-001, mécanisme plus strict prévu ultérieurement). Ne jamais y placer de contenu sensible.";
// Famille « docs » (ADR-12) : documents du registre + leurs pièces jointes.
export const DOCS_DOC_TYPES = ["adr", "specs", "gherkin", "project_doc", "adr_file"];
// Famille « task » : artefacts rattachés à une tâche (content_id = taskId).
export const TASK_DOC_TYPES = ["plan", "task_synthese", "task_report", "audit_report", "autre"];
// Famille « recette » : documents d'appui et rapports de recette.
export const RECETTE_DOC_TYPES = ["recette_report", "recette_doc"];
// Pièces jointes d'une ÉVALUATION (recette évaluateur) — artefacts
// `doc_type='evaluation_doc'`, `content_id` = evaluationId. Famille ISOLÉE des
// pièces client : sa garde CIBLÉE est `assertEvaluationDocAllowed` (voir plus
// bas), qui ADMET explicitement les PHOTOS et VIDÉOS (preuves visuelles de
// l'évaluateur). La garde photo/vidéo des pièces client (`assertPieceAllowed`)
// ne s'applique PAS ici.
export const EVALUATION_DOC_TYPES = ["evaluation_doc"];
// Natures ADMISES d'une pièce d'ÉVALUATION (recette évaluateur, ADR-003) :
// lien | document | photo | video | maquette | performance. DISTINCTE de
// `PIECE_NATURES` (pièces client de sprint) : les PHOTOS et VIDÉOS y sont
// ADMISES — l'évaluateur joint des preuves visuelles (captures, photos, vidéos
// de parcours) à ses éléments. `maquette` = maquette HTML/CSS/JS (données mock)
// servie par le panneau comme page statique (URL) ; `performance` = rapport de
// test de performance (durées réseau + Core Web Vitals + stress) préprod.
// CONVERGENCE (ADR-003) : aucune table neuve, ce sont 2 natures SUPPLÉMENTAIRES
// de la famille `doc_type='evaluation_doc'`.
export const EVALUATION_DOC_NATURES = ["lien", "document", "photo", "video", "maquette", "performance"];
// Extension de fichier → nature d'évaluation. Les extensions photo/vidéo sont
// résolues EXPLICITEMENT (au lieu d'être refusées comme pour les pièces client).
export const EVALUATION_DOC_NATURE_BY_EXT = {
  ".md": "document", ".markdown": "document", ".pdf": "document", ".docx": "document",
  ".jpg": "photo", ".jpeg": "photo", ".png": "photo", ".gif": "photo", ".webp": "photo",
  ".heic": "photo", ".bmp": "photo", ".tiff": "photo",
  ".mp4": "video", ".mov": "video", ".avi": "video", ".mkv": "video", ".webm": "video", ".m4v": "video",
};
// Répertoire de stockage des MAQUETTES d'évaluation (pages statiques HTML/CSS/JS
// servies par le PANNEAU comme page accessible par URL). Il DOIT coïncider avec
// `EVALUATION_MAQUETTE_DIR` du panneau (server.mjs) : le tool MCP
// `evaluation_maquette_add` écrit ici, et le panneau sert ces fichiers via
// `GET /api/evaluations/:id/maquette/*`. Surchargeable par env (worktree / test).
export const EVALUATION_MAQUETTE_DIR =
  process.env.EVALUATION_MAQUETTE_DIR || "/root/orchestrator-panel/storage/evaluation-maquettes";
// Garde d'un chemin RELATIF de fichier de maquette : refuse l'absolu et toute
// remontée (`..`) — les fichiers restent confinés au dossier de la maquette.
function assertSafeMaquettePath(rel) {
  const p = String(rel || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!p) throw new Error("chemin de fichier de maquette vide");
  if (p.startsWith("/") || /^[a-zA-Z]:/.test(p)) throw new Error(`chemin de maquette absolu refusé : ${rel}`);
  const norm = normalize(p);
  if (norm === ".." || norm.startsWith("../") || norm.includes("/../")) {
    throw new Error(`chemin de maquette invalide (remontée '..') : ${rel}`);
  }
  return norm;
}
// Slug sûr d'un dossier de maquette (dérivé du titre + suffixe aléatoire).
function maquetteSlug(title, fallback = "maquette") {
  const base = String(title || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `${base || fallback}-${Math.random().toString(36).slice(2, 7)}`;
}
// Nature d'un artefact (`kind`) — distincte de `doc_type`.
export const ARTIFACT_KINDS = ["plan", "audit", "report", "autre"];
// Domaine d'origine d'un artefact (`source`).
export const ARTIFACT_SOURCES = ["import", "artifact", "registry", "ref"];
// Mapping `docs.kind` (ADR-12) ↔ `doc_type` (table polymorphe).
export const DOC_TYPE_BY_DOC_KIND = { "adr-tech": "adr", "specs-fonctionnelles": "specs", "scenarios-gherkin": "gherkin" };
export const DOC_KIND_BY_DOC_TYPE = { "adr": "adr-tech", "specs": "specs-fonctionnelles", "gherkin": "scenarios-gherkin" };
// Mapping `artifacts.kind` (legacy) → `doc_type` cible (migration).
export const DOC_TYPE_BY_ARTIFACT_KIND = { "plan": "plan", "audit": "audit_report", "report": "task_report", "autre": "autre" };

// Valide une source de pièce jointe. `undefined`/`null`/"" → 'registry'.
function assertAttachmentSource(source) {
  const s = source === undefined || source === null || String(source).trim() === "" ? "registry" : String(source).trim();
  if (!DOC_ATTACHMENT_SOURCES.includes(s)) {
    throw new Error(`source invalide : ${source} (attendu : ${DOC_ATTACHMENT_SOURCES.join(" | ")})`);
  }
  return s;
}

// `meta` est stocké en TEXT (JSON sérialisé) — tolérant aux valeurs legacy.
function parseDocMeta(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw); } catch { return raw; }
}

// Sérialise une ligne `artifacts` de famille `adr_file` (camelCase) — réutilisé
// par les fonctions et les tools. `meta` tolérant aux valeurs legacy.
function rowToAttachment(r) {
  if (!r) return null;
  const meta = parseDocMeta(r.meta);
  return {
    attachmentId: r.artifact_id,
    docId: r.content_id,
    docType: r.doc_type,
    contentId: r.content_id,
    kind: r.kind ?? null,
    nature: r.nature ?? null,
    title: r.title ?? null,
    path: r.path ?? null,
    targetDocId: meta && typeof meta === "object" ? (meta.targetDocId ?? null) : null,
    source: r.source,
    meta,
    createdAt: r.created_at,
    createdBy: r.created_by ?? null,
  };
}

// Mappe une ligne `artifacts` → forme `doc_*` (rétrocompat agents/panneau).
// `docId` = artifact_id ; `kind` ADR-12 = inverse de doc_type.
function rowToDoc(r) {
  if (!r) return null;
  const dt = r.doc_type || "autre";
  return {
    docId: r.artifact_id, kind: DOC_KIND_BY_DOC_TYPE[dt] || dt, title: r.title ?? null, path: r.path,
    description: r.description ?? null,
    status: r.status ?? null,
    context: r.context ?? null,
    decision: r.decision ?? null,
    consequences: r.consequences ?? null,
    replacedBy: r.replaced_by ?? null,
    isGlobal: r.is_global === 1 || r.is_global === true,
    meta: parseDocMeta(r.meta),
    updatedAt: r.updated_at ?? null,
    createdAt: r.created_at, createdBy: r.created_by,
  };
}

// Retourne {docId, projectId | repoId, kind, title, path, description, createdBy}
// — avec la cible (projet et/ou repo) pour un affichage contexte.
function hydrateDocs(rows) {
  const out = [];
  for (const r of rows) out.push(rowToDoc(r));
  return out;
}

// Pièces jointes d'ADR rattachées à des docs (0..N) — une requête batch.
async function getAttachmentsForDocs(rows) {
  if (!rows.length) return {};
  const ids = [...new Set(rows.map((r) => r.artifact_id))];
  const links = (await pool().query(
    "SELECT * FROM artifacts WHERE content_id = ANY($1) AND doc_type = 'adr_file' ORDER BY created_at", [ids],
  )).rows;
  const map = {};
  for (const l of links) (map[l.content_id] = map[l.content_id] || []).push(rowToAttachment(l));
  return map;
}

// Un doc enrichi avec ses cibles (projets/repos) et ses pièces jointes (0..N).
// rows = lignes `artifacts`. `attachments` additif (rétrocompat item 120).
async function enrichDocs(rows) {
  if (!rows.length) return [];
  const [projMap, repoMap, attMap] = await Promise.all([
    getArtifactProjectsBatch(rows), getArtifactReposBatch(rows), getAttachmentsForDocs(rows),
  ]);
  return rows.map((r) => ({
    ...rowToDoc(r),
    projects: projMap[r.artifact_id] || [],
    repos: repoMap[r.artifact_id] || [],
    attachments: attMap[r.artifact_id] || [],
  }));
}

export async function registerDoc({
  kind, title, path, description, projectId, repoId,
  status, context, decision, consequences, replacedBy, repoIds, global: isGlobal,
  organizationId, createdBy,
}) {
  await ensureSchema();
  if (!DOC_KINDS.includes(kind)) throw new Error(`kind invalide : ${kind} (attendu : ${DOC_KINDS.join(" | ")})`);
  if (!path || !String(path).trim()) throw new Error("path (chemin du fichier) requis");
  if (isGlobal === true && !projectId) {
    throw new Error("global=true exige projectId (une ADR globale est rattachée à tous les repos du projet)");
  }
  const k = String(kind).trim();
  const p = String(path).trim();
  const st = assertAdrStatus(status);
  const org = organizationId || (projectId ? await orgIdOfProject(projectId) : null) || await defaultOrganizationId();
  const id = `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const globalFlag = isGlobal === true ? 1 : 0;
  const ts = nowIso();
  // REBASAGE : un doc ADR-12 est un artefact `doc_type` ∈ DOCS_DOC_TYPES,
  // `content_id = id` (le doc est sa propre entité porteuse), `source='registry'`.
  await pool().query(
    `INSERT INTO artifacts (artifact_id, doc_type, content_id, kind, title, path, description,
                            status, context, decision, consequences, replaced_by, is_global,
                            source, organization_id, created_at, created_by, updated_at)
     VALUES ($1,$2,$3,'autre',$4,$5,$6,$7,$8,$9,$10,$11,$12,'registry',$13,$14,$15,$16)`,
    [
      id, DOC_TYPE_BY_DOC_KIND[k], id,
      title ? String(title).trim() : null, p,
      description ? String(description).trim() : null,
      st,
      context === undefined || context === null ? null : String(context),
      decision === undefined || decision === null ? null : String(decision),
      consequences === undefined || consequences === null ? null : String(consequences),
      replacedBy === undefined || replacedBy === null ? null : String(replacedBy).trim(),
      globalFlag, org, ts, createdBy ?? null, ts,
    ],
  );
  if (projectId) {
    await pool().query("INSERT INTO artifact_projects (artifact_id, project_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [id, String(projectId).trim()]);
  }
  // Rattachement repos : repoId legacy + repoIds (1..N) + ADR globale (tous les
  // repos du projet, résolus depuis project_repos).
  const repoSet = new Set();
  if (repoId) repoSet.add(String(repoId).trim());
  if (Array.isArray(repoIds)) for (const r of repoIds) { if (r) repoSet.add(String(r).trim()); }
  if (globalFlag === 1) {
    const rows = (await pool().query("SELECT repo_id FROM project_repos WHERE project_id = $1", [String(projectId).trim()])).rows;
    for (const r of rows) repoSet.add(r.repo_id);
  }
  for (const r of repoSet) {
    await pool().query("INSERT INTO artifact_repos (artifact_id, repo_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [id, r]);
  }
  return getDoc(id);
}

export async function updateDoc({
  docId, kind, title, path, description,
  status, context, decision, consequences, replacedBy,
  addProjectId, addRepoId, addRepoIds, setGlobal,
}) {
  await ensureSchema();
  const sets = [];
  const params = [];
  if (kind !== undefined) {
    if (!DOC_KINDS.includes(kind)) throw new Error(`kind invalide : ${kind}`);
    params.push(DOC_TYPE_BY_DOC_KIND[kind]); sets.push(`doc_type = $${params.length}`);
  }
  if (title !== undefined) { params.push(title === null ? null : String(title).trim()); sets.push(`title = $${params.length}`); }
  if (path !== undefined) { params.push(String(path).trim()); sets.push(`path = $${params.length}`); }
  if (description !== undefined) { params.push(description === null ? null : String(description).trim()); sets.push(`description = $${params.length}`); }
  if (status !== undefined) { params.push(assertAdrStatus(status)); sets.push(`status = $${params.length}`); }
  if (context !== undefined) { params.push(context === null ? null : String(context)); sets.push(`context = $${params.length}`); }
  if (decision !== undefined) { params.push(decision === null ? null : String(decision)); sets.push(`decision = $${params.length}`); }
  if (consequences !== undefined) { params.push(consequences === null ? null : String(consequences)); sets.push(`consequences = $${params.length}`); }
  if (replacedBy !== undefined) { params.push(replacedBy === null ? null : String(replacedBy).trim()); sets.push(`replaced_by = $${params.length}`); }
  if (sets.length) {
    // `updated_at` référencé par un placeholder (correction du param `nowIso()`
    // auparavant poussé sans placeholder → UPDATE avec un paramètre en trop).
    params.push(nowIso());
    sets.push(`updated_at = $${params.length}`);
    params.push(docId);
    await pool().query(`UPDATE artifacts SET ${sets.join(", ")} WHERE artifact_id = $${params.length}`, params);
  }
  if (addProjectId) await pool().query("INSERT INTO artifact_projects (artifact_id, project_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [docId, String(addProjectId).trim()]);
  if (addRepoId) await pool().query("INSERT INTO artifact_repos (artifact_id, repo_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [docId, String(addRepoId).trim()]);
  if (Array.isArray(addRepoIds)) {
    for (const r of addRepoIds) {
      if (r) await pool().query("INSERT INTO artifact_repos (artifact_id, repo_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [docId, String(r).trim()]);
    }
  }
  // ADR globale : `setGlobal=true` rattache TOUS les repos des projets du doc
  // (+ is_global=1) ; `setGlobal=false` remet is_global=0 sans retirer les liens.
  if (setGlobal === true) {
    const projectIds = (await pool().query("SELECT project_id FROM artifact_projects WHERE artifact_id = $1", [docId])).rows.map((r) => r.project_id);
    if (!projectIds.length) throw new Error("setGlobal=true exige au moins un projet rattaché au doc");
    await pool().query("UPDATE artifacts SET is_global = 1, updated_at = $2 WHERE artifact_id = $1", [docId, nowIso()]);
    for (const pid of projectIds) {
      const rows = (await pool().query("SELECT repo_id FROM project_repos WHERE project_id = $1", [pid])).rows;
      for (const r of rows) {
        await pool().query("INSERT INTO artifact_repos (artifact_id, repo_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [docId, r.repo_id]);
      }
    }
  } else if (setGlobal === false) {
    await pool().query("UPDATE artifacts SET is_global = 0, updated_at = $2 WHERE artifact_id = $1", [docId, nowIso()]);
  }
  return getDoc(docId);
}

// REBASAGE doc_delete : supprime l'artefact (famille docs) + ses pièces jointes
// (`adr_file`) ; les liens artifact_projects/artifact_repos suivent en CASCADE.
export async function deleteDoc(docId) {
  await ensureSchema();
  const existing = await getDoc(docId);
  if (!existing) return null;
  await pool().query("DELETE FROM artifacts WHERE content_id = $1 AND doc_type = 'adr_file'", [docId]);
  await pool().query("DELETE FROM artifacts WHERE artifact_id = $1 AND doc_type = ANY($2)", [docId, DOCS_DOC_TYPES]);
  return { docId, deleted: true };
}

// --- Pièces jointes d'ADR (item 122) ---------------------------------------
// Le registre ne stocke JAMAIS de contenu : une pièce jointe est un lien vers
// un document du registre (target_doc_id) ou un chemin de fichier (import/ref).
// 3 natures : registry (document), import (fichier importé), ref (fichier
// référencé par chemin). Retourne le doc porteur enrichi (attachments à jour).
export async function addDocAttachment({
  docId, targetDocId, path, title, kind, nature, source, meta, createdBy,
}) {
  await ensureSchema();
  if (!docId) throw new Error("docId requis");
  // Porteur : un artefact de la famille docs (adr/specs/gherkin/project_doc).
  const doc = (await pool().query(
    "SELECT artifact_id FROM artifacts WHERE artifact_id = $1 AND doc_type = ANY($2)", [docId, DOCS_DOC_TYPES],
  )).rows[0];
  if (!doc) throw new Error(`doc porteur inconnu : ${docId}`);
  const src = assertAttachmentSource(source);
  let target = null;
  let p = null;
  if (src === "registry") {
    target = targetDocId ? String(targetDocId).trim() : "";
    if (!target) throw new Error("source='registry' exige targetDocId (document du registre)");
    if (target === String(docId)) throw new Error("une pièce jointe ne peut pas cibler l'ADR porteuse elle-même");
    const t = (await pool().query(
      "SELECT artifact_id FROM artifacts WHERE artifact_id = $1 AND doc_type = ANY($2)", [target, DOCS_DOC_TYPES],
    )).rows[0];
    if (!t) throw new Error(`document cible inconnu : ${target}`);
  } else {
    p = path ? String(path).trim() : "";
    if (!p) throw new Error(`source='${src}' exige path (chemin du fichier)`);
  }
  const defaultNature = { registry: "document", import: "fichier", ref: "lien" };
  const nat = nature && String(nature).trim() ? String(nature).trim() : defaultNature[src];
  let metaObj = meta === undefined || meta === null
    ? null
    : (typeof meta === "string" ? parseDocMeta(meta) : meta);
  if (src === "registry") {
    metaObj = { ...(metaObj && typeof metaObj === "object" ? metaObj : {}), targetDocId: target };
  }
  const id = `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const ts = nowIso();
  // REBASAGE : une pièce jointe est un artefact `doc_type='adr_file'` porté par
  // l'ADR (`content_id = docId`) ; la cible registre vit dans `meta.targetDocId`.
  await pool().query(
    `INSERT INTO artifacts
       (artifact_id, doc_type, content_id, kind, nature, title, path, source, meta, created_at, created_by)
     VALUES ($1,'adr_file',$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      id, String(docId),
      kind ? String(kind).trim() : null,
      nat,
      title ? String(title).trim() : null,
      p, src, metaObj, ts, createdBy ?? null,
    ],
  );
  return getDoc(docId);
}

// Retrait d'une pièce jointe par son ID stable. Si `docId` est fourni, vérifie
// l'appartenance. Ne touche ni au fichier ni aux rattachements projet/repo.
export async function removeDocAttachment({ attachmentId, docId }) {
  await ensureSchema();
  if (!attachmentId) throw new Error("attachmentId requis");
  const row = (await pool().query(
    "SELECT * FROM artifacts WHERE artifact_id = $1 AND doc_type = 'adr_file'", [attachmentId],
  )).rows[0];
  if (!row) return null;
  if (docId && String(docId) !== String(row.content_id)) {
    throw new Error(`la pièce jointe ${attachmentId} n'appartient pas au doc ${docId}`);
  }
  await pool().query("DELETE FROM artifacts WHERE artifact_id = $1", [attachmentId]);
  return { attachmentId, docId: row.content_id, deleted: true };
}

// Lecture dédiée des pièces jointes d'une ADR (symétrie artifact_list).
export async function listDocAttachments({ docId }) {
  await ensureSchema();
  if (!docId) throw new Error("docId requis");
  const rows = (await pool().query(
    "SELECT * FROM artifacts WHERE content_id = $1 AND doc_type = 'adr_file' ORDER BY created_at", [String(docId)],
  )).rows;
  return rows.map(rowToAttachment);
}

export async function getDoc(docId) {
  await ensureSchema();
  const r = (await pool().query(
    "SELECT * FROM artifacts WHERE artifact_id = $1 AND doc_type = ANY($2)", [docId, DOCS_DOC_TYPES],
  )).rows[0];
  if (!r) return null;
  const [e] = await enrichDocs([r]);
  return e;
}

// Liste des docs, filtrée par kind / projet / repo.
// - projectId : docs rattachés au projet (et à ses repos ? via includeRepoDocs).
// - repoId : docs rattachés au repo.
export async function listDocs({ kind, status, projectId, repoId, includeRepoDocs = false, limit = 500 } = {}) {
  await ensureSchema();
  const conds = [];
  const params = [];
  // Base : famille docs (doc_type adr/specs/gherkin/project_doc).
  params.push(DOCS_DOC_TYPES); conds.push(`d.doc_type = ANY($${params.length})`);
  if (kind) {
    if (!DOC_KINDS.includes(kind)) throw new Error(`kind invalide : ${kind}`);
    params.push(DOC_TYPE_BY_DOC_KIND[kind]); conds.push(`d.doc_type = $${params.length}`);
  }
  // Filtre ADR par statut (ajoute une condition). La branche `includeRepoDocs`
  // parenthèse l'expression `OR` pour que ce filtre s'applique aux docs du
  // PROJET comme à ceux des repos (INC-011 : `AND` prime sur `OR`).
  if (status) {
    const s = assertAdrStatus(status);
    params.push(s); conds.push(`d.status = $${params.length}`);
  }
  let rows;
  if (projectId) {
    // docs du projet + (option) docs des repos du projet (dédupliqués).
    const prj = String(projectId);
    if (includeRepoDocs) {
      params.push(prj, prj);
      rows = (await pool().query(
        `SELECT DISTINCT d.* FROM artifacts d
         WHERE ( d.artifact_id IN (SELECT artifact_id FROM artifact_projects WHERE project_id = $${params.length - 1})
            OR d.artifact_id IN (SELECT ar.artifact_id FROM artifact_repos ar JOIN project_repos pr ON pr.repo_id = ar.repo_id WHERE pr.project_id = $${params.length}) )
         ${conds.length ? "AND " + conds.join(" AND ") : ""} ORDER BY d.doc_type, d.title NULLS LAST, d.created_at DESC`,
        params,
      )).rows;
    } else {
      params.push(prj);
      rows = (await pool().query(
        `SELECT DISTINCT d.* FROM artifacts d JOIN artifact_projects dp ON dp.artifact_id = d.artifact_id WHERE dp.project_id = $${params.length}
         ${conds.length ? "AND " + conds.join(" AND ") : ""} ORDER BY d.doc_type, d.title NULLS LAST, d.created_at DESC`,
        params,
      )).rows;
    }
  } else if (repoId) {
    params.push(String(repoId));
    rows = (await pool().query(
      `SELECT DISTINCT d.* FROM artifacts d JOIN artifact_repos dr ON dr.artifact_id = d.artifact_id WHERE dr.repo_id = $${params.length}
       ${conds.length ? "AND " + conds.join(" AND ") : ""} ORDER BY d.doc_type, d.title NULLS LAST, d.created_at DESC`,
      params,
    )).rows;
  } else {
    rows = (await pool().query(
      `SELECT d.* FROM artifacts d ${conds.length ? "WHERE " + conds.join(" AND ") : ""} ORDER BY d.doc_type, d.title NULLS LAST, d.created_at DESC LIMIT ${Number(limit) || 500}`,
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
    `SELECT DISTINCT d.* FROM artifacts d
     WHERE d.doc_type = ANY($2)
       AND (d.artifact_id IN (SELECT artifact_id FROM artifact_projects WHERE project_id = $1)
         OR d.artifact_id IN (SELECT ar.artifact_id FROM artifact_repos ar JOIN project_repos pr ON pr.repo_id = ar.repo_id WHERE pr.project_id = $1))
     ORDER BY d.doc_type, d.title NULLS LAST, d.created_at DESC`, [projectId, DOCS_DOC_TYPES],
  )).rows;
  return enrichDocs(rows);
}

// ===========================================================================
// Famille ADR (item 125) — sur-ensemble STRUCTURÉ du module `doc_*` (ADR-12).
// Une ADR reste un doc (`kind='adr-tech'`) : ces fonctions RÉUTILISENT les
// primitives docs/doc_projects/doc_repos/doc_attachments — aucun second modèle.
// ⚠️ INC-011 : `listDocs` a un bug de précédence SQL dans sa branche
// `includeRepoDocs` + `status`. `listAdrs`/`searchAdrs`/`buildAdrContext` ne
// passent JAMAIS `status` à `listDocs` et filtrent le statut côté JS.
// ===========================================================================

// Transitions autorisées entre statuts d'ADR (aucun saut incohérent).
export const ADR_TRANSITIONS = {
  "Proposé": ["Accepté", "Déprécié"],
  "Accepté": ["Déprécié", "Remplacé"],
  "Déprécié": ["Remplacé"],
  "Remplacé": [],
};

// Normalisation pour recherche insensible à la casse ET aux accents.
function normalizeText(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

// Chaîne de recherche d'une ADR : titre/contexte/décision/conséquences/description/chemin.
function adrHaystack(d) {
  return normalizeText(
    [d.title, d.context, d.decision, d.consequences, d.description, d.path].filter(Boolean).join(" \n "),
  );
}

// Condensé sur une ligne (pour le bloc de contexte).
function oneLine(s, max = 400) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

// Une ADR correspond-elle à un scope (chemin) ? Une ADR globale correspond
// toujours ; sinon correspondance d'un segment du scope (ou du chemin complet)
// avec titre/décision/contexte/conséquences/chemin.
function adrMatchesScope(adr, scope) {
  if (adr.isGlobal) return true;
  const hay = adrHaystack(adr);
  for (const s of scope) {
    const norm = normalizeText(s);
    if (!norm) continue;
    if (hay.includes(norm)) return true;
    for (const seg of norm.split(/[/\\]+/)) {
      if (seg.length >= 4 && hay.includes(seg)) return true;
    }
  }
  return false;
}

// Bloc markdown prêt à injecter dans un prompt agent (une section par ADR).
function renderAdrContextBlock(adrs, projectId) {
  if (!adrs.length) return "";
  const lines = ["## ADR de référence", ""];
  if (projectId) lines.push(`Projet : ${projectId}`, "");
  for (const a of adrs) {
    lines.push(`### ${a.title || a.docId || a.adrId} — ${a.status || "sans statut"}`);
    const repos = Array.isArray(a.repos) ? a.repos : [];
    if (a.isGlobal) lines.push(`- Repos : ${repos.length ? repos.join(", ") : "(tous les repos du projet)"} — ADR globale`);
    else if (repos.length) lines.push(`- Repos : ${repos.join(", ")}`);
    if (a.decision) lines.push(`- Décision : ${oneLine(a.decision)}`);
    if (a.consequences) lines.push(`- Conséquence : ${oneLine(a.consequences)}`);
    if (a.path) lines.push(`- Chemin : ${a.path}`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

// Bloc markdown « Fonctionnalités de référence » (une section par fonctionnalité).
// Vide si aucune fonctionnalité (⇒ aucun bloc injecté).
function renderFeatureContextBlock(features, projectId) {
  if (!features.length) return "";
  const lines = ["## Fonctionnalités de référence", ""];
  if (projectId) lines.push(`Projet : ${projectId}`, "");
  for (const f of features) {
    lines.push(`### ${f.ref || f.id} — ${f.role || "sans rôle"}`);
    if (f.userStory) lines.push(`- User story : ${oneLine(f.userStory)}`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

// Bloc markdown « Règles métier de référence » (une section par règle). Une règle
// `roleGlobal` affiche « tous les rôles — globale » (et non une liste vide).
// Vide si aucune règle (⇒ aucun bloc injecté).
function renderRuleContextBlock(rules, projectId) {
  if (!rules.length) return "";
  const lines = ["## Règles métier de référence", ""];
  if (projectId) lines.push(`Projet : ${projectId}`, "");
  for (const r of rules) {
    lines.push(`### ${r.ref || r.id}`);
    if (r.content) lines.push(`- Contenu : ${oneLine(r.content)}`);
    const roles = Array.isArray(r.roles) ? r.roles.filter(Boolean) : [];
    if (r.roleGlobal) lines.push("- Rôles : (tous les rôles — globale)");
    else lines.push(`- Rôles : ${roles.length ? roles.join(", ") : "(aucun)"}`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function rowToAdrConflict(r) {
  if (!r) return null;
  return {
    conflictId: r.conflict_id,
    adrId: r.adr_id,
    taskId: r.task_id ?? null,
    description: r.description,
    status: r.status,
    decisionId: r.decision_id ?? null,
    createdAt: r.created_at,
    createdBy: r.created_by ?? null,
  };
}

// ---------------------------------------------------------------------------
// Vigilances ADR (item 126) — points de vigilance ADR remontés par une session
// de RECETTE / TEST : ADR manquante (type='missing') ou conflit d'ADR
// (type='conflict'). HISTORIQUE APPEND-ONLY (aucun DELETE) ; seul `status`
// transite `open → resolved` avec une raison TRACÉE (`resolution`).
// Un point ouvert rattaché à une recette BLOQUE sa terminaison (confirmRecette).
// ---------------------------------------------------------------------------
export const ADR_VIGILANCE_TYPES = ["missing", "conflict"];
export const ADR_VIGILANCE_STATUS = ["open", "resolved"];
export const ADR_VIGILANCE_RESOLUTION_KINDS = ["adr_created", "adr_deprecated", "manual", "decision"];

function rowToAdrVigilance(r) {
  if (!r) return null;
  return {
    vigilanceId: r.vigilance_id,
    project: r.project,
    recetteId: r.recette_id ?? null,
    taskId: r.task_id ?? null,
    sessionId: r.session_id ?? null,
    type: r.type,
    status: r.status,
    entity: r.entity ?? null,
    description: r.description,
    adrId: r.adr_id ?? null,
    relatedAdrId: r.related_adr_id ?? null,
    conflictId: r.conflict_id ?? null,
    resolution: r.resolution ?? null,
    resolutionKind: r.resolution_kind ?? null,
    createdAt: r.created_at,
    createdBy: r.created_by ?? null,
    resolvedAt: r.resolved_at ?? null,
    resolvedBy: r.resolved_by ?? null,
  };
}

// Raison EXPLICITE et normalisée d'un point de vigilance — réutilisée par la
// garde de terminaison (`confirmRecette`) et par l'UI (« Terminer la recette »
// bloqué avec la raison). Ex : « ADR manquant pour [entité] » /
// « Conflit d'ADR : [ancienne] vs [nouvelle] ».
export function adrVigilanceReason(v) {
  if (!v) return "";
  if (v.type === "conflict") {
    const a = v.adrId || "?";
    const b = v.relatedAdrId || "?";
    return `Conflit d'ADR : ${a} vs ${b}`;
  }
  return `ADR manquant pour ${v.entity || "?"}`;
}

// Helper interne d'INSERT (réutilisé par reportAdrMissing / reportAdrConflict).
async function insertAdrVigilance(fields = {}) {
  const vigilanceId = fields.vigilanceId || `adr-vig-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  await pool().query(
    `INSERT INTO adr_vigilances
       (vigilance_id, project, recette_id, task_id, session_id, type, status, entity,
        description, adr_id, related_adr_id, conflict_id, resolution, resolution_kind,
        created_at, created_by, resolved_at, resolved_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [
      vigilanceId,
      String(fields.project),
      fields.recetteId ? String(fields.recetteId) : null,
      fields.taskId ? String(fields.taskId) : null,
      fields.sessionId ? String(fields.sessionId) : null,
      fields.type,
      fields.status || "open",
      fields.entity ?? null,
      String(fields.description),
      fields.adrId ? String(fields.adrId) : null,
      fields.relatedAdrId ? String(fields.relatedAdrId) : null,
      fields.conflictId ? String(fields.conflictId) : null,
      fields.resolution ?? null,
      fields.resolutionKind ?? null,
      nowIso(),
      fields.by ?? fields.createdBy ?? null,
      fields.resolvedAt ?? null,
      fields.resolvedBy ?? null,
    ],
  );
  return vigilanceId;
}

// Détail d'un point de vigilance (avec sa raison explicite).
export async function getAdrVigilance(vigilanceId) {
  await ensureSchema();
  if (!vigilanceId) return null;
  const row = (await pool().query(
    "SELECT * FROM adr_vigilances WHERE vigilance_id = $1",
    [String(vigilanceId)],
  )).rows[0];
  if (!row) return null;
  const v = rowToAdrVigilance(row);
  return { ...v, reason: adrVigilanceReason(v) };
}

// Vue CONDENSÉE des ADR d'un projet — point d'entrée de tout agent.
// Le statut est filtré en JS (jamais passé à `listDocs` → ne dépend pas d'INC-011).
export async function listAdrs({ projectId, repoIds, status, search, includeRepoDocs = true, limit = 500 } = {}) {
  await ensureSchema();
  const docs = await listDocs({ kind: "adr-tech", projectId, includeRepoDocs, limit });
  const wantedRepos = Array.isArray(repoIds) ? repoIds.map(String) : null;
  const wantedStatus = status ? assertAdrStatus(status) : null;
  const q = search ? normalizeText(search) : null;
  return docs
    .filter((d) => !wantedStatus || d.status === wantedStatus)
    .filter((d) => {
      if (!wantedRepos || wantedRepos.length === 0) return true;
      if (d.isGlobal) return true;
      return (d.repos || []).some((r) => wantedRepos.includes(String(r)));
    })
    .filter((d) => !q || adrHaystack(d).includes(q))
    .map((d) => ({
      adrId: d.docId,
      title: d.title ?? null,
      status: d.status ?? null,
      repos: d.repos || [],
      isGlobal: !!d.isGlobal,
      decision: d.decision ?? null,
      path: d.path,
      updatedAt: d.updatedAt ?? null,
    }));
}

// Contenu complet structuré d'une ADR (+ conflits ouverts). `null` si inconnue
// ou si le doc n'est pas une ADR (`kind !== 'adr-tech'`).
export async function getAdr(adrId) {
  await ensureSchema();
  if (!adrId) return null;
  const doc = await getDoc(adrId);
  if (!doc || doc.kind !== "adr-tech") return null;
  const conflicts = await listAdrConflicts({ adrId, status: "open" });
  return { ...doc, adrId: doc.docId, conflicts };
}

// Recherche texte dans les ADR → retrouver la règle pertinente (avec extrait).
export async function searchAdrs({ query, projectId } = {}) {
  await ensureSchema();
  const q = normalizeText(query);
  if (!q) throw new Error("query requis");
  const docs = await listDocs({ kind: "adr-tech", projectId, includeRepoDocs: true });
  const results = [];
  for (const d of docs) {
    const fields = [d.title, d.context, d.decision, d.consequences, d.description, d.path].filter(Boolean).map(String);
    const hit = fields.find((f) => normalizeText(f).includes(q));
    if (!hit) continue;
    const idx = normalizeText(hit).indexOf(q);
    const excerpt = idx >= 0 ? hit.slice(Math.max(0, idx - 60), idx + 140).trim() : oneLine(hit, 200);
    results.push({
      adrId: d.docId,
      title: d.title ?? null,
      status: d.status ?? null,
      path: d.path,
      decision: d.decision ?? null,
      excerpt,
    });
  }
  return results;
}

// Bloc de contexte ADR prêt à injecter dans un prompt agent.
// ADR = `adrIds` (sélection explicite) sinon les ADR ACTIVES (Proposé/Accepté)
// du projet ; si `scope` est fourni, garde les ADR globales ou en correspondance.
// `taskId` résout `projectId`/`scope` depuis la tâche.
export async function buildAdrContext({ projectId, scope, adrIds, taskId } = {}) {
  await ensureSchema();
  let pid = projectId || null;
  let sc = Array.isArray(scope) ? scope.map(String).filter(Boolean) : [];
  if (taskId) {
    const task = await getTask(taskId);
    if (task) {
      if (!pid) pid = task.project || null;
      if (sc.length === 0) sc = Array.isArray(task.scope) ? task.scope.map(String).filter(Boolean) : [];
    }
  }
  let adrs;
  if (Array.isArray(adrIds) && adrIds.length) {
    // Sélection EXPLICITE : elle PRIME sur le filtre de scope (la sélection de
    // l'utilisateur doit produire le bloc injecté — pas être filtrée).
    const fetched = await Promise.all(adrIds.map((id) => getAdr(id)));
    adrs = fetched.filter(Boolean);
  } else {
    // Liste AUTOMATIQUE : ADR actives (Proposé/Accepté) du projet, filtrées par scope.
    const docs = await listDocs({ kind: "adr-tech", projectId: pid, includeRepoDocs: true });
    adrs = docs
      .filter((d) => d.status === "Proposé" || d.status === "Accepté")
      .map((d) => ({ ...d, adrId: d.docId }));
    if (sc.length) adrs = adrs.filter((a) => adrMatchesScope(a, sc));
  }
  const context = renderAdrContextBlock(adrs, pid);
  return { projectId: pid, count: adrs.length, adrs, context };
}

// Bloc de contexte « Fonctionnalités de référence » prêt à injecter dans un
// prompt agent. Sélection EXPLICITE uniquement (`featureIds`) ; lecture BULK
// `WHERE id = ANY($1::text[])` (1 requête, 0 N+1 — pas de `getFeature` par id).
// Les ids inconnus sont ignorés. `context` = "" si vide ⇒ aucun bloc (facultatif).
export async function buildFeatureContext({ projectId, featureIds } = {}) {
  await ensureSchema();
  const pid = projectId || null;
  const ids = (Array.isArray(featureIds) ? featureIds : []).map((x) => String(x)).filter(Boolean);
  let features = [];
  if (ids.length) {
    const rows = (await pool().query(
      "SELECT * FROM fonctionnalites WHERE id = ANY($1::text[]) ORDER BY ref ASC",
      [ids],
    )).rows;
    features = rows.map(rowToFonctionnalite).filter(Boolean);
  }
  const context = renderFeatureContextBlock(features, pid);
  return { projectId: pid, count: features.length, features, context };
}

// Bloc de contexte « Règles métier de référence » (analogue à buildFeatureContext).
// Sélection EXPLICITE uniquement (`ruleIds`) ; lecture BULK (1 requête, 0 N+1).
export async function buildRuleContext({ projectId, ruleIds } = {}) {
  await ensureSchema();
  const pid = projectId || null;
  const ids = (Array.isArray(ruleIds) ? ruleIds : []).map((x) => String(x)).filter(Boolean);
  let rules = [];
  if (ids.length) {
    const rows = (await pool().query(
      "SELECT * FROM regles_metier WHERE id = ANY($1::text[]) ORDER BY ref ASC",
      [ids],
    )).rows;
    rules = rows.map(rowToRegle).filter(Boolean);
  }
  const context = renderRuleContextBlock(rules, pid);
  return { projectId: pid, count: rules.length, rules, context };
}

// Crée une ADR structurée — statut initial 'Proposé' par défaut (l'acceptation
// est une décision humaine, pas une écriture d'agent). `attachments[]` :
// { repoId?, docId?, path?, title?, kind?, nature?, source?, meta? }.
export async function registerAdr({
  projectId, repoIds, title, path, description, status, context, decision, consequences,
  global: isGlobal, attachments, organizationId, createdBy,
} = {}) {
  await ensureSchema();
  if (!projectId) throw new Error("projectId requis");
  const st = assertAdrStatus(status) || "Proposé";
  const doc = await registerDoc({
    kind: "adr-tech", title, path, description, projectId, repoIds, status: st,
    context, decision, consequences, global: isGlobal, organizationId, createdBy,
  });
  const adrId = doc.docId;
  if (Array.isArray(attachments)) {
    for (const att of attachments) {
      if (!att) continue;
      if (att.repoId) await updateDoc({ docId: adrId, addRepoId: att.repoId });
      if (att.docId || att.path) {
        await addDocAttachment({
          docId: adrId, targetDocId: att.docId, path: att.path, title: att.title,
          kind: att.kind, nature: att.nature,
          source: att.source || (att.docId ? "registry" : "ref"),
          meta: att.meta, createdBy,
        });
      }
    }
  }
  // SIGNAL de cardinalité (T6, NON bloquant) : ADR → 1..N fonctionnalités.
  try { await recordCardinalitySignal({ entityType: "adr", entityId: adrId, projectId, by: createdBy }); } catch {}
  return getAdr(adrId);
}

// Fait transiter une ADR selon ADR_TRANSITIONS. `Remplacé` exige `replacedBy`
// (docId existant, ≠ adrId). Un doc legacy SANS statut accepte une initialisation.
export async function setAdrStatus({ adrId, status, replacedBy } = {}) {
  await ensureSchema();
  const adr = await getAdr(adrId);
  if (!adr) throw new Error(`ADR inconnue (kind='adr-tech' attendu) : ${adrId}`);
  const target = assertAdrStatus(status);
  if (!target) throw new Error("status requis");
  const current = adr.status || null;
  // Doc legacy sans statut : initialisation libre (aucun état antérieur à contredire).
  const allowed = current ? (ADR_TRANSITIONS[current] || []) : ADR_STATUS.slice();
  if (!allowed.includes(target)) {
    throw new Error(
      `transition ADR invalide : ${current || "(sans statut)"} → ${target} (permis : ${allowed.length ? allowed.join(" | ") : "aucune — statut terminal"})`,
    );
  }
  let rep = null;
  if (target === "Remplacé") {
    rep = replacedBy ? String(replacedBy).trim() : "";
    if (!rep) throw new Error("status 'Remplacé' exige replacedBy (docId de l'ADR qui remplace)");
    if (rep === String(adrId)) throw new Error("replacedBy ne peut pas être l'ADR elle-même");
    if (!(await getDoc(rep))) throw new Error(`ADR de remplacement inconnue : ${rep}`);
  }
  await updateDoc({ docId: adrId, status: target, ...(rep ? { replacedBy: rep } : {}) });
  return getAdr(adrId);
}

// Rattache à une ADR : un repo (1..N cumulable) et/ou une pièce jointe
// (docId du registre, ou path import/ref). Au moins un des trois requis.
export async function attachAdr({ adrId, repoId, docId, path, title, kind, nature, source, meta, createdBy } = {}) {
  await ensureSchema();
  const adr = await getAdr(adrId);
  if (!adr) throw new Error(`ADR inconnue (kind='adr-tech' attendu) : ${adrId}`);
  if (!repoId && !docId && !path) throw new Error("attachAdr exige au moins repoId, docId ou path");
  if (repoId) await updateDoc({ docId: adrId, addRepoId: repoId });
  if (docId || path) {
    await addDocAttachment({
      docId: adrId, targetDocId: docId, path, title, kind, nature,
      source: source || (docId ? "registry" : "ref"), meta, createdBy,
    });
  }
  return getAdr(adrId);
}

// ===========================================================================
// CONVERSION D'ADR (ADR-001 §6) — A003/A004.
// Une ADR MONOLITHIQUE d'origine (kind='adr-tech', colonnes structurées vides)
// est CONVERTIE en PLUSIEURS ADR ATOMIQUES (titre/statut/contexte/décision/
// conséquences). Les grands détails partent en PIÈCES JOINTES (`adr_file`).
// GARANTIES :
//   - l'ADR d'origine reste INTACTE (jamais de UPDATE doc_type/content_id/path/
//     meta) — la conversion est purement ADDITIVE (nouvelles lignes `artifacts`) ;
//   - le LIEN HISTORIQUE est conservé dans `adr_conversions` (N converties / 1
//     origine) ET rappelé dans `meta.converted_from_adr_id` de la convertie ;
//   - IDEMPOTENT sur le couple (origine, convertie).
// ===========================================================================

// Sérialise une ligne `adr_conversions` (camelCase).
function rowToAdrConversion(r) {
  if (!r) return null;
  return {
    conversionId: r.conversion_id,
    originalAdrId: r.original_adr_id,
    convertedAdrId: r.converted_adr_id,
    createdAt: r.created_at,
    createdBy: r.created_by ?? null,
  };
}

// Écrit le lien de conversion ADR d'origine → ADR convertie. GARDES : les deux
// ADR doivent exister (`kind='adr-tech'`) et différer. IDEMPOTENT : un couple
// déjà lié retourne la ligne existante (aucun doublon).
export async function linkAdrConversion({ originalAdrId, convertedAdrId, createdBy } = {}) {
  await ensureSchema();
  if (!originalAdrId) throw new Error("originalAdrId requis");
  if (!convertedAdrId) throw new Error("convertedAdrId requis");
  const orig = String(originalAdrId).trim();
  const conv = String(convertedAdrId).trim();
  if (orig === conv) throw new Error("originalAdrId et convertedAdrId doivent différer");
  if (!(await getAdr(orig))) throw new Error(`ADR d'origine inconnue (kind='adr-tech' attendu) : ${orig}`);
  if (!(await getAdr(conv))) throw new Error(`ADR convertie inconnue (kind='adr-tech' attendu) : ${conv}`);
  const existing = (await pool().query(
    "SELECT * FROM adr_conversions WHERE original_adr_id = $1 AND converted_adr_id = $2", [orig, conv],
  )).rows[0];
  if (existing) return rowToAdrConversion(existing);
  const id = `cnv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  await pool().query(
    `INSERT INTO adr_conversions (conversion_id, original_adr_id, converted_adr_id, created_at, created_by)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (original_adr_id, converted_adr_id) DO NOTHING`,
    [id, orig, conv, nowIso(), createdBy ?? null],
  );
  const row = (await pool().query(
    "SELECT * FROM adr_conversions WHERE original_adr_id = $1 AND converted_adr_id = $2", [orig, conv],
  )).rows[0];
  return rowToAdrConversion(row);
}

// Liste les liens de conversion (par ADR d'origine et/ou par ADR convertie).
export async function listAdrConversions({ originalAdrId, convertedAdrId, limit = 500 } = {}) {
  await ensureSchema();
  const conds = [];
  const params = [];
  if (originalAdrId) { params.push(String(originalAdrId).trim()); conds.push(`original_adr_id = $${params.length}`); }
  if (convertedAdrId) { params.push(String(convertedAdrId).trim()); conds.push(`converted_adr_id = $${params.length}`); }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  params.push(limit);
  const rows = (await pool().query(
    `SELECT * FROM adr_conversions ${where} ORDER BY created_at, conversion_id LIMIT $${params.length}`, params,
  )).rows;
  return rows.map(rowToAdrConversion);
}

// CONVERTIT un monolithe en UNE ADR ATOMIQUE. Crée l'ADR atomique (via
// `registerAdr`, donc signal de cardinalité ADR→1..N fonctionnalités NON
// bloquant), rattache les détails en pièces jointes (`attachments`, source
// registry/import/ref), écrit le lien `adr_conversions` et rappelle l'origine
// dans `meta.converted_from_adr_id`. NE MODIFIE JAMAIS l'ADR d'origine.
// R3 : le projet est résolu depuis l'ADR d'origine (`artifact_projects`) ;
// erreur explicite si aucun projet n'est rattaché. `path` (optionnel) : chemin
// du fichier de l'ADR atomique (défaut : celui de l'origine — l'extrait vient
// du même document, dont les détails restent en pièces jointes).
export async function convertAdr({
  originalAdrId, title, status, context, decision, consequences, description,
  path, repoIds, global: isGlobal, attachments, createdBy, by,
} = {}) {
  await ensureSchema();
  if (!originalAdrId) throw new Error("originalAdrId requis");
  const orig = String(originalAdrId).trim();
  const original = await getAdr(orig);
  if (!original) throw new Error(`ADR d'origine inconnue (kind='adr-tech' attendu) : ${orig}`);
  const t = title ? String(title).trim() : "";
  if (!t) throw new Error("title requis (titre de l'ADR atomique)");
  // R3 — résolution du projet depuis l'ADR d'origine.
  let projectId = Array.isArray(original.projects) && original.projects.length ? original.projects[0] : null;
  if (!projectId) {
    const r = (await pool().query(
      "SELECT project_id FROM artifact_projects WHERE artifact_id = $1 ORDER BY project_id LIMIT 1", [orig],
    )).rows[0];
    projectId = r ? r.project_id : null;
  }
  if (!projectId) {
    throw new Error(`impossible de résoudre le projet de l'ADR d'origine ${orig} (aucun artifact_projects rattaché)`);
  }
  const actor = createdBy ?? by ?? null;
  const repos = Array.isArray(repoIds) && repoIds.length ? repoIds.map(String) : (original.repos || []).map(String);
  // Statut : demandé, sinon hérité de l'origine, sinon 'Proposé' (défaut registerAdr).
  const st = status ? assertAdrStatus(status) : (original.status || undefined);
  const adr = await registerAdr({
    projectId,
    repoIds: repos,
    title: t,
    path: path ? String(path).trim() : original.path,
    description,
    status: st,
    context,
    decision,
    consequences,
    global: isGlobal,
    attachments,
    createdBy: actor,
  });
  const conversion = await linkAdrConversion({ originalAdrId: orig, convertedAdrId: adr.adrId, createdBy: actor });
  // Traçabilité lisible (meta) sur l'ADR CONVERTIE uniquement — l'origine intacte.
  await pool().query(
    "UPDATE artifacts SET meta = COALESCE(meta, '{}'::jsonb) || $2::jsonb, updated_at = $3 WHERE artifact_id = $1",
    [adr.adrId, JSON.stringify({ converted_from_adr_id: orig, conversion_id: conversion.conversionId }), nowIso()],
  );
  return {
    adr: await getAdr(adr.adrId),
    conversion,
    original: await getAdr(orig),
  };
}

// Signale un conflit code ↔ ADR. Le conflit est TOUJOURS persisté ; si `taskId`
// est fourni, une décision humaine `kind='conflict'` est créée en plus (résolue
// ⇒ conflit clôturé par resolveDecisionAndTransition). Aucune violation silencieuse.
// `recetteId` (OPTIONNEL, rétrocompat) : un conflit signalé PENDANT une recette
// devient aussi un POINT DE VIGILANCE GLOBALE de la recette (bloquant sa
// terminaison) — en plus de la ligne `adr_conflicts`.
export async function reportAdrConflict({ adrId, taskId, recetteId, description, by, entity, relatedAdrId } = {}) {
  await ensureSchema();
  if (!adrId) throw new Error("adrId requis");
  const desc = description === undefined || description === null ? "" : String(description).trim();
  if (!desc) throw new Error("description requise");
  const adr = await getDoc(adrId);
  if (!adr || adr.kind !== "adr-tech") throw new Error(`ADR inconnue (kind='adr-tech' attendu) : ${adrId}`);
  let decision = null;
  let decisionId = null;
  if (taskId) {
    decision = await requestDecision({
      taskId,
      kind: "conflict",
      detail: `Conflit ADR ${adrId} : ${desc}`,
      requestedBy: by ?? null,
    });
    decisionId = decision?.decisionId || null;
  }
  const conflictId = `adr-conf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  await pool().query(
    `INSERT INTO adr_conflicts (conflict_id, adr_id, task_id, description, status, decision_id, created_at, created_by)
     VALUES ($1,$2,$3,$4,'open',$5,$6,$7)`,
    [conflictId, String(adrId), taskId ? String(taskId) : null, desc, decisionId, nowIso(), by ?? null],
  );
  const conflict = rowToAdrConflict(
    (await pool().query("SELECT * FROM adr_conflicts WHERE conflict_id = $1", [conflictId])).rows[0],
  );
  // Point de vigilance GLOBAL de recette (uniquement si `recetteId` — comportement
  // inchangé sans lui). Le projet est celui de la recette.
  let vigilance = null;
  if (recetteId) {
    const r = (await pool().query("SELECT project FROM recettes WHERE recette_id = $1", [String(recetteId)])).rows[0];
    if (!r) throw new Error(`recette inconnue : ${recetteId}`);
    const vigilanceId = await insertAdrVigilance({
      project: r.project, recetteId, taskId,
      type: "conflict", status: "open",
      entity: entity ?? null, description: desc,
      adrId, relatedAdrId: relatedAdrId || null, conflictId,
      by,
    });
    vigilance = await getAdrVigilance(vigilanceId);
  }
  return { conflict, decision, vigilance };
}

// Historique des conflits d'ADR (filtrable par ADR et/ou statut) — append-only.
export async function listAdrConflicts({ adrId, status } = {}) {
  await ensureSchema();
  const conds = [];
  const params = [];
  if (adrId) { params.push(String(adrId)); conds.push(`adr_id = $${params.length}`); }
  if (status) { params.push(String(status)); conds.push(`status = $${params.length}`); }
  const rows = (await pool().query(
    `SELECT * FROM adr_conflicts ${conds.length ? `WHERE ${conds.join(" AND ")}` : ""} ORDER BY created_at DESC`,
    params,
  )).rows;
  return rows.map(rowToAdrConflict);
}

// Signale une ADR MANQUANTE pour une entité réellement discutée (recette/test).
// Exige `entity` ET `description` (évite les fausses alertes). Résout le projet :
// recette → `recettes.project`, sinon tâche → `tasks.project`, sinon `projectId`.
// `proposedAdrId` (optionnel) référence l'ADR Proposé créée depuis la session.
// Retourne le point de vigilance (avec `reason` explicite).
export async function reportAdrMissing({ recetteId, taskId, projectId, entity, description, proposedAdrId, sessionId, by } = {}) {
  await ensureSchema();
  const ent = entity === undefined || entity === null ? "" : String(entity).trim();
  if (!ent) throw new Error("entity requis (entité réellement discutée)");
  const desc = description === undefined || description === null ? "" : String(description).trim();
  if (!desc) throw new Error("description requise");
  let project = projectId ? String(projectId) : null;
  if (!project && recetteId) {
    const r = (await pool().query("SELECT project FROM recettes WHERE recette_id = $1", [String(recetteId)])).rows[0];
    if (!r) throw new Error(`recette inconnue : ${recetteId}`);
    project = r.project;
  }
  if (!project && taskId) {
    const t = (await pool().query("SELECT project FROM tasks WHERE id = $1", [String(taskId)])).rows[0];
    if (!t) throw new Error(`tâche inconnue : ${taskId}`);
    project = t.project;
  }
  if (!project) throw new Error("projectId requis (ou recetteId/taskId permettant de le résoudre)");
  if (proposedAdrId && !(await getAdr(proposedAdrId))) {
    throw new Error(`ADR proposée inconnue (kind='adr-tech' attendu) : ${proposedAdrId}`);
  }
  const vigilanceId = await insertAdrVigilance({
    project, recetteId, taskId, sessionId,
    type: "missing", status: "open", entity: ent, description: desc,
    adrId: proposedAdrId || null, by,
  });
  return getAdrVigilance(vigilanceId);
}

// HISTORIQUE des points de vigilance ADR — filtrable (projet, recette, type,
// statut, plage de dates) et APPEND-ONLY (lecture seule). Chaque point porte sa
// `reason` explicite (réutilisée par la garde de terminaison et l'UI).
export async function listAdrVigilances({ projectId, recetteId, type, status, from, to, limit = 500 } = {}) {
  await ensureSchema();
  const conds = [];
  const params = [];
  if (projectId) { params.push(String(projectId)); conds.push(`project = $${params.length}`); }
  if (recetteId) { params.push(String(recetteId)); conds.push(`recette_id = $${params.length}`); }
  if (type) { params.push(String(type)); conds.push(`type = $${params.length}`); }
  if (status) { params.push(String(status)); conds.push(`status = $${params.length}`); }
  if (from) { params.push(String(from)); conds.push(`created_at >= $${params.length}`); }
  if (to) { params.push(String(to)); conds.push(`created_at <= $${params.length}`); }
  const lim = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.min(Number(limit), 5000) : 500;
  params.push(lim);
  const rows = (await pool().query(
    `SELECT * FROM adr_vigilances ${conds.length ? `WHERE ${conds.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  )).rows;
  return rows.map((r) => {
    const v = rowToAdrVigilance(r);
    return { ...v, reason: adrVigilanceReason(v) };
  });
}

// LÈVE un point de vigilance (ADR créée / dépréciation actée / décision explicite
// / levée manuelle). `resolution` (raison TRACÉE) est OBLIGATOIRE : le blocage
// de terminaison n'est jamais infini mais jamais silencieux non plus. Seul
// `status` transite (open → resolved) ; les colonnes de résolution sont AJOUTÉES.
export async function resolveAdrVigilance({ vigilanceId, resolution, resolvedBy, adrId, resolutionKind } = {}) {
  await ensureSchema();
  if (!vigilanceId) throw new Error("vigilanceId requis");
  const res = resolution === undefined || resolution === null ? "" : String(resolution).trim();
  if (!res) throw new Error("resolution requise (raison tracée de la levée)");
  const row = (await pool().query("SELECT * FROM adr_vigilances WHERE vigilance_id = $1", [String(vigilanceId)])).rows[0];
  if (!row) throw new Error(`point de vigilance ADR inconnu : ${vigilanceId}`);
  if (row.status !== "open") throw new Error(`point de vigilance déjà résolu : ${vigilanceId}`);
  if (resolutionKind && !ADR_VIGILANCE_RESOLUTION_KINDS.includes(String(resolutionKind))) {
    throw new Error(`resolutionKind invalide : ${resolutionKind} (attendu : ${ADR_VIGILANCE_RESOLUTION_KINDS.join(" | ")})`);
  }
  if (adrId && !(await getAdr(adrId))) {
    throw new Error(`ADR inconnue (kind='adr-tech' attendu) : ${adrId}`);
  }
  await pool().query(
    `UPDATE adr_vigilances
       SET status = 'resolved', resolved_at = $1, resolved_by = $2, resolution = $3,
           resolution_kind = COALESCE($4, 'manual'), related_adr_id = COALESCE($5, related_adr_id)
     WHERE vigilance_id = $6`,
    [nowIso(), resolvedBy ?? "human", res, resolutionKind ? String(resolutionKind) : null, adrId ? String(adrId) : null, String(vigilanceId)],
  );
  return getAdrVigilance(vigilanceId);
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
    // ON DELETE famille task (content_id polymorphe → pas de FK).
    await client.query("DELETE FROM artifacts WHERE content_id = $1 AND doc_type = ANY($2)", [taskId, TASK_DOC_TYPES]);
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

    // Conflit d'ADR (kind='conflict') : la décision résolue CLÔT le conflit
    // correspondant. Aucune transition de tâche (le kind n'est pas `validation`).
    if (decision.kind === "conflict") {
      await client.query(
        "UPDATE adr_conflicts SET status = 'resolved' WHERE decision_id = $1",
        [decisionId],
      );
      // Lève AUSSI le point de vigilance ADR de recette lié (item 126) : trancher
      // le conflit (décision humaine) ne doit pas laisser de blocage orphelin.
      await client.query(
        `UPDATE adr_vigilances
           SET status = 'resolved', resolved_at = $1, resolved_by = $2,
               resolution_kind = 'decision', resolution = $3
         WHERE status = 'open'
           AND conflict_id IN (SELECT conflict_id FROM adr_conflicts WHERE decision_id = $4)`,
        [ts, by_, "Conflit d'ADR résolu par décision humaine", decisionId],
      );
    }
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
// `sprintId`/`featureIds`/`ruleIds`/`adrIds` (T6, OPTIONNELS) : liens posés à la
// création (NON bloquants). Sans `sprintId`, rattachement au SPRINT PAR DÉFAUT si
// le projet n'a aucun sprint. Un signal de cardinalité est tracé (recette → ≥1 ADR
// + ≥1 fonctionnalité + 1 sprint).
export async function startRecette({ project, projects, title, description, taskIds, sprintId, featureIds, ruleIds, adrIds, status = "pending", sessionId = null, organizationId, createdBy }) {
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
  // LIENS OPTIONNELS (T6) — NON BLOQUANTS : sprint explicite OU sprint par
  // défaut (si le projet n'a aucun sprint), fonctionnalités, ADR.
  try {
    if (sprintId) await linkRecetteSprint({ recetteId, sprintId });
    else await ensureDefaultSprintLink({ entityType: "recette", entityId: recetteId, projectId: p, by: createdBy });
  } catch {}
  for (const fid of Array.isArray(featureIds) ? featureIds : []) {
    if (!fid) continue;
    try { await linkRecetteFeature({ recetteId, featureId: fid }); } catch {}
  }
  for (const rid of Array.isArray(ruleIds) ? ruleIds : []) {
    if (!rid) continue;
    try { await linkRecetteRule({ recetteId, ruleId: rid }); } catch {}
  }
  for (const aid of Array.isArray(adrIds) ? adrIds : []) {
    if (!aid) continue;
    try { await linkRecetteAdr({ recetteId, adrId: aid }); } catch {}
  }
  // SIGNAL de cardinalité (traçage, NON bloquant).
  try { await recordCardinalitySignal({ entityType: "recette", entityId: recetteId, projectId: p, by: createdBy }); } catch {}
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
  // Points de vigilance ADR (item 126) — historique append-only de la recette
  // (+ sous-ensemble OUVERT qui BLOQUE la terminaison).
  const adrVigilances = await listAdrVigilances({ recetteId });
  // Liens N:N recette↔sprint / fonctionnalité(s) / ADR(s) (T5/A023) — lecture
  // ADDITIVE des tables T1 (`recette_sprints`, `recette_fonctionnalites`,
  // `recette_adr`). N'altère ni `recette_start` ni `recette_item_*`.
  const [sprintRows, featureRows, ruleRows, adrRows] = await Promise.all([
    pool().query(
      `SELECT s.* FROM sprints s JOIN recette_sprints rs ON rs.sprint_id = s.id
        WHERE rs.recette_id = $1 ORDER BY s.created_at ASC`, [recetteId]),
    pool().query(
      `SELECT f.* FROM fonctionnalites f JOIN recette_fonctionnalites rf ON rf.fonctionnalite_id = f.id
        WHERE rf.recette_id = $1 ORDER BY f.ref ASC`, [recetteId]),
    pool().query(
      `SELECT rm.* FROM regles_metier rm JOIN recette_regles rr ON rr.regle_id = rm.id
        WHERE rr.recette_id = $1 ORDER BY rm.ref ASC`, [recetteId]),
    pool().query(
      `SELECT a.artifact_id, a.title, a.doc_type, a.kind, a.path FROM artifacts a
         JOIN recette_adr ra ON ra.adr_id = a.artifact_id
        WHERE ra.recette_id = $1 ORDER BY a.artifact_id ASC`, [recetteId]),
  ]);
  const sprints = sprintRows.rows.map(rowToSprint);
  const fonctionnalites = featureRows.rows.map(rowToFonctionnalite);
  const regles = ruleRows.rows.map(rowToRegle);
  const adrs = adrRows.rows.map((a) => ({ adrId: a.artifact_id, title: a.title ?? null, docType: a.doc_type, kind: a.kind ?? null, path: a.path ?? null }));
  // Éléments de recette évaluateur REPRIS par ce cadrage (traçage additif).
  const evaluationItems = await listCadrageEvaluationItems({ recetteId });
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
    sprints,
    fonctionnalites,
    regles,
    adrs,
    evaluationItems,
    adrVigilances,
    adrVigilancesOpen: adrVigilances.filter((v) => v.status === "open"),
  };
}

// --- Documents de recette (rebasés sur `artifacts`) ------------------------
// Un document de recette est un artefact `doc_type` ∈ {recette_doc,
// recette_report}, `content_id` = recetteId. `documentId` reste un ENTIER
// (= artifacts.id IDENTITY) pour la rétrocompat des routes panneau `[0-9]+`.
export async function addRecetteDocument({ recetteId, title, nature, source, path, artifactId }) {
  await ensureSchema();
  let docType = "recette_doc";
  if (artifactId) {
    const a = (await pool().query("SELECT kind FROM artifacts WHERE artifact_id = $1", [artifactId])).rows[0];
    if (a && a.kind === "report") docType = "recette_report";
  }
  const id = `ART-REC-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  await pool().query(
    `INSERT INTO artifacts (artifact_id, doc_type, content_id, kind, title, nature, source, path, meta, created_at)
     VALUES ($1,$2,$3,'report',$4,$5,$6,$7,$8,$9)`,
    [id, docType, String(recetteId), title ?? null, nature ?? null, source || "import", path ?? null,
     artifactId ? { artifactId } : null, nowIso()],
  );
  return listRecetteDocuments(recetteId);
}

export async function listRecetteDocuments(recetteId) {
  await ensureSchema();
  const rows = (await pool().query(
    `SELECT d.id, d.artifact_id, d.content_id, d.title, d.nature, d.source, d.path, d.created_at,
            a.title AS artifact_title, a.content_id AS artifact_task
     FROM artifacts d
     LEFT JOIN artifacts a ON a.artifact_id = (d.meta->>'artifactId')
     WHERE d.content_id = $1 AND d.doc_type = ANY($2) ORDER BY d.id ASC`,
    [String(recetteId), RECETTE_DOC_TYPES],
  )).rows;
  return rows.map((r) => ({
    documentId: Number(r.id),
    recetteId: r.content_id,
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
    "DELETE FROM artifacts WHERE id = $1 AND doc_type = ANY($2) RETURNING content_id",
    [documentId, RECETTE_DOC_TYPES],
  )).rows[0];
  return r ? r.content_id : null;
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
// GARDE ADR (item 126) : refuse tant qu'un point de vigilance ADR (ADR manquante /
// conflit) est OUVERT sur la recette, avec la RAISON EXPLICITE de chaque point.
// La levée se fait par résolution (adr_vigilance_resolve : ADR créée / dépréciation
// actée / décision) ou par décision explicite de l'utilisateur (raison tracée).
export async function confirmRecette({ recetteId, confirmedBy }) {
  await ensureSchema();
  const open = await listAdrVigilances({ recetteId, status: "open" });
  if (open.length) {
    throw new Error(
      `terminaison bloquée : ${open.map(adrVigilanceReason).join(" ; ")} — résolvez chaque point (adr_vigilance_resolve) ou levez-le explicitement avec une raison tracée`,
    );
  }
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
// ÉVALUATIONS — « Recette » de l'ÉVALUATEUR PRODUIT (T-20260922-100650-sbc1).
// Objet de PREMIER NIVEAU DISTINCT de `recettes` (Cadrage technique exécuteur).
// L'évaluateur décrit le PARCOURS ÉVALUÉ, rattache 1..N fonctionnalités (verdict
// porté par le lien) + 1..N règles métier, enregistre des ÉLÉMENTS
// (recommandation | problème) et joint des PIÈCES. Cycle de vie :
// pending → in_progress → done. AUCUNE conversion en tâches.
// ===========================================================================

// Catégories / sévérités / statuts de suivi d'un élément d'évaluation.
export const EVALUATION_ITEM_CATEGORIES = ["recommandation", "probleme"];
export const EVALUATION_ITEM_SEVERITIES = ["low", "medium", "high", "critical"];
export const EVALUATION_ITEM_STATUSES = ["open", "treated", "dismissed"];
// DÉCISION ADMIN « à traiter » (ou non) — DISTINCTE du statut de suivi
// `status` : l'admin marque chaque élément ; l'exécuteur n'accède qu'aux
// éléments `a_traiter` (ADR-001).
export const EVALUATION_ITEM_DECISIONS = ["pending", "a_traiter", "non_retenu"];
// Verdicts possibles d'une fonctionnalité évaluée.
export const EVALUATION_VERDICTS = ["conforme", "non_conforme", "a_ameliorer"];

function normalizeVerdict(v) {
  return EVALUATION_VERDICTS.includes(v) ? v : null;
}

// Crée une recette évaluateur (EVAL-*, status 'pending'). `created_by` est
// renseigné (indispensable au filtre propriétaire côté panneau). Les liens
// fonctionnalités/règles sont OPTIONNELS et NON bloquants (comme `startRecette`).
export async function startEvaluation({ project, title, description, featureIds, ruleIds, organizationId, createdBy }) {
  await ensureSchema();
  const p = project && String(project).trim();
  if (!p) throw new Error("un projet requis pour une évaluation");
  await assertProjectExists(p);
  const org = organizationId || await orgIdOfProject(p) || await defaultOrganizationId();
  const evaluationId = `EVAL-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  await pool().query(
    `INSERT INTO evaluations (evaluation_id, project, title, description, status, created_at, organization_id, created_by)
     VALUES ($1,$2,$3,$4,'pending',$5,$6,$7)`,
    [evaluationId, p, title || `Recette ${p}`, description ?? null, nowIso(), org, createdBy ?? null],
  );
  for (const fid of Array.isArray(featureIds) ? featureIds : []) {
    if (!fid) continue;
    try { await linkEvaluationFeature({ evaluationId, featureId: fid }); } catch {}
  }
  for (const rid of Array.isArray(ruleIds) ? ruleIds : []) {
    if (!rid) continue;
    try { await linkEvaluationRule({ evaluationId, ruleId: rid }); } catch {}
  }
  return getEvaluationById(evaluationId);
}

// Liste les évaluations d'un projet (ou toutes).
export async function listProjectEvaluations(project) {
  await ensureSchema();
  const rows = (await pool().query(
    `SELECT e.*,
            (SELECT COUNT(*) FROM evaluation_items i WHERE i.evaluation_id = e.evaluation_id) AS items_count,
            (SELECT COUNT(*) FROM evaluation_items i WHERE i.evaluation_id = e.evaluation_id AND i.decision = 'a_traiter') AS treatable_count,
            (SELECT COUNT(*) FROM evaluation_fonctionnalites ef WHERE ef.evaluation_id = e.evaluation_id) AS features_count,
            (SELECT COUNT(*) FROM evaluation_regles er WHERE er.evaluation_id = e.evaluation_id) AS rules_count
     FROM evaluations e
     ${project ? "WHERE e.project = $1" : ""}
     ORDER BY e.created_at DESC`,
    project ? [project] : [],
  )).rows;
  return Promise.all(rows.map(rowToEvaluationSummary));
}

async function rowToEvaluationSummary(r) {
  const repos = await reposOfProject(r.project);
  return {
    evaluationId: r.evaluation_id,
    project: r.project,
    repos,
    title: r.title,
    description: r.description ?? null,
    status: r.status,
    createdAt: r.created_at,
    confirmedAt: r.confirmed_at,
    confirmedBy: r.confirmed_by,
    createdBy: r.created_by ?? null,
    sessionId: r.session_id ?? null,
    itemsCount: Number(r.items_count),
    treatableCount: Number(r.treatable_count),
    featuresCount: Number(r.features_count),
    rulesCount: Number(r.rules_count),
  };
}

// Détail complet : éléments + verdicts (fonctionnalités) + règles + pièces.
export async function getEvaluationById(evaluationId) {
  await ensureSchema();
  const r = (await pool().query("SELECT * FROM evaluations WHERE evaluation_id = $1", [evaluationId])).rows[0];
  if (!r) return null;
  const itemRows = (await pool().query(
    "SELECT id, content, category, severity, discussion, status, decision, decided_at, decided_by, created_at FROM evaluation_items WHERE evaluation_id = $1 ORDER BY id ASC",
    [evaluationId],
  )).rows;
  const documents = await listEvaluationDocuments(evaluationId);
  // Reprises « par le cadrage X » (traçage) — une requête pour tous les items.
  const reprisRows = itemRows.length ? (await pool().query(
    `SELECT cei.evaluation_item_id, cei.recette_id, cei.created_at, cei.taken_by, r.title
       FROM cadrage_evaluation_items cei
       LEFT JOIN recettes r ON r.recette_id = cei.recette_id
      WHERE cei.evaluation_item_id = ANY($1) ORDER BY cei.created_at ASC`,
    [itemRows.map((i) => Number(i.id))],
  )).rows : [];
  const reprisByItem = new Map();
  for (const x of reprisRows) {
    const k = Number(x.evaluation_item_id);
    if (!reprisByItem.has(k)) reprisByItem.set(k, []);
    reprisByItem.get(k).push({ cadrageId: x.recette_id, title: x.title ?? null, createdAt: x.created_at, takenBy: x.taken_by ?? null });
  }
  const items = itemRows.map((i) => ({
    itemId: Number(i.id),
    content: i.content,
    category: i.category,
    severity: i.severity,
    discussion: i.discussion,
    status: i.status,
    decision: i.decision,
    decidedAt: i.decided_at ?? null,
    decidedBy: i.decided_by ?? null,
    createdAt: i.created_at,
    documents: documents.filter((d) => d.itemId === Number(i.id)),
    reprisPar: reprisByItem.get(Number(i.id)) || [],
  }));
  const repos = await reposOfProject(r.project);
  const [featureRows, ruleRows] = await Promise.all([
    pool().query(
      `SELECT f.*, ef.verdict, ef.verdict_comment FROM fonctionnalites f
         JOIN evaluation_fonctionnalites ef ON ef.fonctionnalite_id = f.id
        WHERE ef.evaluation_id = $1 ORDER BY f.ref ASC`, [evaluationId]),
    pool().query(
      `SELECT rm.* FROM regles_metier rm JOIN evaluation_regles er ON er.regle_id = rm.id
        WHERE er.evaluation_id = $1 ORDER BY rm.ref ASC`, [evaluationId]),
  ]);
  const fonctionnalites = featureRows.rows.map((x) => ({
    ...rowToFonctionnalite(x),
    verdict: x.verdict ?? null,
    verdictComment: x.verdict_comment ?? null,
  }));
  const regles = ruleRows.rows.map(rowToRegle);
  return {
    evaluationId: r.evaluation_id,
    project: r.project,
    repos,
    title: r.title,
    description: r.description ?? null,
    status: r.status,
    createdAt: r.created_at,
    confirmedAt: r.confirmed_at,
    confirmedBy: r.confirmed_by,
    createdBy: r.created_by ?? null,
    organizationId: r.organization_id ?? null,
    sessionId: r.session_id ?? null,
    items,
    documents,
    fonctionnalites,
    regles,
  };
}

// ASSOCIE une session IA DÉDIÉE (agent-recette ÉVALUATEUR) à une évaluation
// EXISTANTE (tool `evaluation_session_set`). Miroir de `setSprintSession` :
// n'écrit QUE `session_id` (l'évaluation n'a pas d'`updated_at` ni de statut
// piloté par ce rattachement). `sessionId` null détache la session.
export async function setEvaluationSession(evaluationId, sessionId) {
  await ensureSchema();
  if (!evaluationId) throw new Error("evaluationId requis");
  const id = String(evaluationId);
  const row = (await pool().query("SELECT evaluation_id FROM evaluations WHERE evaluation_id = $1", [id])).rows[0];
  if (!row) throw new Error(`évaluation inconnue : ${id}`);
  await pool().query(
    "UPDATE evaluations SET session_id = $1 WHERE evaluation_id = $2",
    [sessionId != null ? String(sessionId) : null, id],
  );
  return getEvaluationById(id);
}

// Éléments ACCESSIBLES À L'EXÉCUTEUR : uniquement ceux que l'admin a marqués
// « à traiter » (`decision='a_traiter'`). Contexte de sélection d'un cadrage
// technique. Filtre `project` optionnel. Inclut le traçage `reprisPar`.
export async function listTreatableEvaluationItems({ project } = {}) {
  await ensureSchema();
  const rows = (await pool().query(
    `SELECT i.id, i.evaluation_id, i.content, i.category, i.severity, i.discussion, i.status,
            i.decision, i.decided_at, i.decided_by, i.created_at,
            e.title AS evaluation_title, e.project
       FROM evaluation_items i
       JOIN evaluations e ON e.evaluation_id = i.evaluation_id
      WHERE i.decision = 'a_traiter'${project ? " AND e.project = $1" : ""}
      ORDER BY i.id ASC`,
    project ? [project] : [],
  )).rows;
  const reprisRows = rows.length ? (await pool().query(
    `SELECT cei.evaluation_item_id, cei.recette_id, cei.created_at, cei.taken_by, r.title
       FROM cadrage_evaluation_items cei
       LEFT JOIN recettes r ON r.recette_id = cei.recette_id
      WHERE cei.evaluation_item_id = ANY($1) ORDER BY cei.created_at ASC`,
    [rows.map((i) => Number(i.id))],
  )).rows : [];
  const reprisByItem = new Map();
  for (const x of reprisRows) {
    const k = Number(x.evaluation_item_id);
    if (!reprisByItem.has(k)) reprisByItem.set(k, []);
    reprisByItem.get(k).push({ cadrageId: x.recette_id, title: x.title ?? null, createdAt: x.created_at, takenBy: x.taken_by ?? null });
  }
  return rows.map((i) => ({
    itemId: Number(i.id),
    evaluationId: i.evaluation_id,
    evaluationTitle: i.evaluation_title ?? null,
    project: i.project,
    category: i.category,
    severity: i.severity,
    content: i.content,
    discussion: i.discussion,
    status: i.status,
    decision: i.decision,
    decidedAt: i.decided_at ?? null,
    decidedBy: i.decided_by ?? null,
    createdAt: i.created_at,
    reprisPar: reprisByItem.get(Number(i.id)) || [],
  }));
}

// --- Reprise d'un élément de recette par un CADRAGE technique ---------------
// Lien ADDITIF cadrage (`recettes`) ↔ élément (`evaluation_items`). GARDE :
// on ne reprend QUE des éléments `decision='a_traiter'` (ADR-001/002).
export async function linkCadrageEvaluationItem({ recetteId, itemId, by } = {}) {
  await ensureSchema();
  if (!recetteId || itemId === undefined || itemId === null) throw new Error("recetteId et itemId requis");
  const rec = (await pool().query("SELECT recette_id FROM recettes WHERE recette_id = $1", [recetteId])).rows[0];
  if (!rec) throw new Error(`cadrage inconnu : ${recetteId}`);
  const item = (await pool().query("SELECT id, decision FROM evaluation_items WHERE id = $1", [Number(itemId)])).rows[0];
  if (!item) throw new Error(`élément d'évaluation introuvable : ${itemId}`);
  if (item.decision !== "a_traiter") {
    throw new Error(`élément ${itemId} non « à traiter » (décision = ${item.decision}) : reprise refusée`);
  }
  const ins = await pool().query(
    `INSERT INTO cadrage_evaluation_items (recette_id, evaluation_item_id, created_at, taken_by)
     VALUES ($1,$2,$3,$4) ON CONFLICT (recette_id, evaluation_item_id) DO NOTHING`,
    [String(recetteId), Number(itemId), nowIso(), by ?? null],
  );
  return { ok: true, recetteId: String(recetteId), itemId: Number(itemId), linked: ins.rowCount > 0 };
}

export async function unlinkCadrageEvaluationItem({ recetteId, itemId } = {}) {
  await ensureSchema();
  if (!recetteId || itemId === undefined || itemId === null) throw new Error("recetteId et itemId requis");
  const del = await pool().query(
    "DELETE FROM cadrage_evaluation_items WHERE recette_id = $1 AND evaluation_item_id = $2",
    [String(recetteId), Number(itemId)],
  );
  return { ok: true, recetteId: String(recetteId), itemId: Number(itemId), unlinked: del.rowCount > 0 };
}

export async function listCadrageEvaluationItems({ recetteId } = {}) {
  await ensureSchema();
  if (!recetteId) throw new Error("recetteId requis");
  const rows = (await pool().query(
    `SELECT i.id, i.evaluation_id, i.content, i.category, i.severity, i.discussion, i.status, i.decision, i.created_at,
            e.title AS evaluation_title
       FROM cadrage_evaluation_items cei
       JOIN evaluation_items i ON i.id = cei.evaluation_item_id
       JOIN evaluations e ON e.evaluation_id = i.evaluation_id
      WHERE cei.recette_id = $1 ORDER BY i.id ASC`,
    [String(recetteId)],
  )).rows;
  return rows.map((i) => ({
    itemId: Number(i.id),
    evaluationId: i.evaluation_id,
    evaluationTitle: i.evaluation_title ?? null,
    category: i.category,
    severity: i.severity,
    content: i.content,
    status: i.status,
    decision: i.decision,
  }));
}

// --- Éléments (recommandation | problème) ----------------------------------
export async function addEvaluationItem({ evaluationId, content, category, severity, discussion }) {
  await ensureSchema();
  if (!content || !String(content).trim()) throw new Error("contenu requis pour un élément d'évaluation");
  const ev = (await pool().query("SELECT evaluation_id FROM evaluations WHERE evaluation_id = $1", [evaluationId])).rows[0];
  if (!ev) throw new Error(`évaluation inconnue : ${evaluationId}`);
  const cat = EVALUATION_ITEM_CATEGORIES.includes(category) ? category : "recommandation";
  const sev = EVALUATION_ITEM_SEVERITIES.includes(severity) ? severity : "medium";
  const r = (await pool().query(
    `INSERT INTO evaluation_items (evaluation_id, content, category, severity, discussion, status, created_at)
     VALUES ($1,$2,$3,$4,$5,'open',$6) RETURNING id`,
    [evaluationId, String(content).trim(), cat, sev, discussion ?? null, nowIso()],
  )).rows[0];
  return getEvaluationItem(Number(r.id));
}

export async function updateEvaluationItem({ itemId, content, category, severity, discussion, status }) {
  await ensureSchema();
  const sets = [];
  const params = [];
  if (content !== undefined) {
    if (!content || !String(content).trim()) throw new Error("contenu requis pour un élément d'évaluation");
    params.push(String(content).trim()); sets.push(`content = $${params.length}`);
  }
  if (category !== undefined) { params.push(EVALUATION_ITEM_CATEGORIES.includes(category) ? category : "recommandation"); sets.push(`category = $${params.length}`); }
  if (severity !== undefined) { params.push(EVALUATION_ITEM_SEVERITIES.includes(severity) ? severity : "medium"); sets.push(`severity = $${params.length}`); }
  if (discussion !== undefined) { params.push(discussion); sets.push(`discussion = $${params.length}`); }
  if (status !== undefined) { params.push(EVALUATION_ITEM_STATUSES.includes(status) ? status : "open"); sets.push(`status = $${params.length}`); }
  if (!sets.length) return getEvaluationItem(itemId);
  params.push(Number(itemId));
  const r = await pool().query(`UPDATE evaluation_items SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING id`, params);
  if (!r.rows[0]) throw new Error(`élément d'évaluation introuvable : ${itemId}`);
  return getEvaluationItem(Number(itemId));
}

export async function deleteEvaluationItem({ itemId }) {
  await ensureSchema();
  const r = await pool().query("DELETE FROM evaluation_items WHERE id = $1 RETURNING id", [Number(itemId)]);
  if (!r.rows[0]) throw new Error(`élément d'évaluation introuvable : ${itemId}`);
  return { ok: true, itemId: Number(itemId) };
}

// DÉCISION ADMIN « à traiter » (ou non) d'un élément — action TRACÉE,
// DISTINCTE du statut de suivi (`updateEvaluationItem`). `decision` ∈
// EVALUATION_ITEM_DECISIONS ; `by` = auteur de la décision.
export async function setEvaluationItemDecision({ itemId, decision, by } = {}) {
  await ensureSchema();
  if (!EVALUATION_ITEM_DECISIONS.includes(decision)) {
    throw new Error(`décision invalide : ${decision} (attendu : ${EVALUATION_ITEM_DECISIONS.join(" | ")})`);
  }
  const r = await pool().query(
    "UPDATE evaluation_items SET decision = $1, decided_at = $2, decided_by = $3 WHERE id = $4 RETURNING id",
    [decision, nowIso(), by ?? null, Number(itemId)],
  );
  if (!r.rows[0]) throw new Error(`élément d'évaluation introuvable : ${itemId}`);
  return getEvaluationItem(Number(itemId));
}

async function getEvaluationItem(itemId) {
  const r = (await pool().query(
    "SELECT id, evaluation_id, content, category, severity, discussion, status, decision, decided_at, decided_by, created_at FROM evaluation_items WHERE id = $1",
    [itemId],
  )).rows[0];
  return r ? {
    itemId: Number(r.id),
    evaluationId: r.evaluation_id,
    content: r.content,
    category: r.category,
    severity: r.severity,
    discussion: r.discussion,
    status: r.status,
    decision: r.decision,
    decidedAt: r.decided_at ?? null,
    decidedBy: r.decided_by ?? null,
    createdAt: r.created_at,
  } : null;
}

// --- Liens fonctionnalités (verdict porté par le lien) ---------------------
export async function linkEvaluationFeature({ evaluationId, featureId, verdict, verdictComment } = {}) {
  await ensureSchema();
  const ev = (await pool().query("SELECT evaluation_id FROM evaluations WHERE evaluation_id = $1", [evaluationId])).rows[0];
  if (!ev) throw new Error(`évaluation inconnue : ${evaluationId}`);
  const f = await getFeature(featureId);
  if (!f) throw new Error(`fonctionnalité inconnue : ${featureId}`);
  const v = normalizeVerdict(verdict);
  const ins = await pool().query(
    `INSERT INTO evaluation_fonctionnalites (evaluation_id, fonctionnalite_id, verdict, verdict_comment)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (evaluation_id, fonctionnalite_id) DO UPDATE
       SET verdict = COALESCE(EXCLUDED.verdict, evaluation_fonctionnalites.verdict),
           verdict_comment = COALESCE(EXCLUDED.verdict_comment, evaluation_fonctionnalites.verdict_comment)`,
    [evaluationId, f.id, v, verdictComment ?? null],
  );
  return { ok: true, evaluationId, featureId: f.id, verdict: v, linked: ins.rowCount > 0 };
}

export async function unlinkEvaluationFeature({ evaluationId, featureId } = {}) {
  await ensureSchema();
  if (!evaluationId || !featureId) throw new Error("evaluationId et featureId requis");
  const del = await pool().query(
    "DELETE FROM evaluation_fonctionnalites WHERE evaluation_id = $1 AND fonctionnalite_id = $2",
    [String(evaluationId), String(featureId)],
  );
  return { ok: true, evaluationId: String(evaluationId), featureId: String(featureId), unlinked: del.rowCount > 0 };
}

// --- Liens règles métier ----------------------------------------------------
export async function linkEvaluationRule({ evaluationId, ruleId } = {}) {
  await ensureSchema();
  const ev = (await pool().query("SELECT evaluation_id FROM evaluations WHERE evaluation_id = $1", [evaluationId])).rows[0];
  if (!ev) throw new Error(`évaluation inconnue : ${evaluationId}`);
  const rule = await getRule(ruleId);
  if (!rule) throw new Error(`règle métier inconnue : ${ruleId}`);
  const ins = await pool().query(
    "INSERT INTO evaluation_regles (evaluation_id, regle_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
    [evaluationId, rule.id],
  );
  return { ok: true, evaluationId, ruleId: rule.id, linked: ins.rowCount > 0 };
}

export async function unlinkEvaluationRule({ evaluationId, ruleId } = {}) {
  await ensureSchema();
  if (!evaluationId || !ruleId) throw new Error("evaluationId et ruleId requis");
  const del = await pool().query(
    "DELETE FROM evaluation_regles WHERE evaluation_id = $1 AND regle_id = $2",
    [String(evaluationId), String(ruleId)],
  );
  return { ok: true, evaluationId: String(evaluationId), ruleId: String(ruleId), unlinked: del.rowCount > 0 };
}

// Positionne le VERDICT d'une fonctionnalité DÉJÀ rattachée à l'évaluation.
export async function setEvaluationVerdict({ evaluationId, fonctionnaliteId, verdict, verdictComment } = {}) {
  await ensureSchema();
  const v = normalizeVerdict(verdict);
  const r = await pool().query(
    `UPDATE evaluation_fonctionnalites SET verdict = $1, verdict_comment = $2
      WHERE evaluation_id = $3 AND fonctionnalite_id = $4 RETURNING fonctionnalite_id`,
    [v, verdictComment ?? null, evaluationId, fonctionnaliteId],
  );
  if (!r.rows[0]) throw new Error(`fonctionnalité ${fonctionnaliteId} non rattachée à l'évaluation ${evaluationId}`);
  return { ok: true, evaluationId, fonctionnaliteId, verdict: v };
}

// --- Pièces jointes (lien / document / photo / vidéo) -----------------------
// `itemId` (optionnel) rattache la pièce à un ÉLÉMENT précis (via `meta.itemId`),
// sans table nouvelle ; sans `itemId`, la pièce reste au niveau de l'évaluation.
export async function addEvaluationDocument({ evaluationId, title, nature, source, path, artifactId, itemId }) {
  await ensureSchema();
  const ev = (await pool().query("SELECT evaluation_id FROM evaluations WHERE evaluation_id = $1", [evaluationId])).rows[0];
  if (!ev) throw new Error(`évaluation inconnue : ${evaluationId}`);
  // GARDE CIBLÉE : valide la nature d'une pièce d'ÉVALUATION (photos/vidéos
  // ADMISES) et retourne la nature RÉSOLUE. La garde des pièces client
  // (`assertPieceAllowed`) ne s'applique PAS à cette famille.
  const resolvedNature = assertEvaluationDocAllowed({ nature, path });
  const id = `ART-EVAL-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const meta = {
    ...(artifactId ? { artifactId } : {}),
    ...(itemId !== undefined && itemId !== null && itemId !== "" ? { itemId: Number(itemId) } : {}),
  };
  await pool().query(
    `INSERT INTO artifacts (artifact_id, doc_type, content_id, kind, title, nature, source, path, meta, created_at)
     VALUES ($1,'evaluation_doc',$2,'autre',$3,$4,$5,$6,$7,$8)`,
    [id, String(evaluationId), title ?? null, resolvedNature, source || "import", path ?? null,
     Object.keys(meta).length ? meta : null, nowIso()],
  );
  return listEvaluationDocuments(evaluationId);
}

// DÉPOSE une MAQUETTE (HTML/CSS/JS, données mock) rattachée à une évaluation et
// retourne une URL consultable. Les fichiers sont écrits sous
// `EVALUATION_MAQUETTE_DIR/<evaluationId>/<slug>/` et le PANNEAU les sert comme
// page statique (`GET /api/evaluations/:id/maquette/*`). Nature de pièce
// `maquette` (famille `evaluation_doc`) : `meta.url` / `meta.maquetteDir` /
// `meta.entry` / `meta.files`. `itemId` (optionnel) rattache la maquette à un
// ÉLÉMENT précis. Aucune table neuve (convergence ADR-003).
export async function addEvaluationMaquette({ evaluationId, title, entry, files, itemId } = {}) {
  await ensureSchema();
  const ev = (await pool().query("SELECT evaluation_id FROM evaluations WHERE evaluation_id = $1", [evaluationId])).rows[0];
  if (!ev) throw new Error(`évaluation inconnue : ${evaluationId}`);
  const list = Array.isArray(files) ? files : [];
  if (!list.length) throw new Error("files requis (au moins un fichier { path, content })");
  const entryRel = assertSafeMaquettePath(entry || "index.html");
  const slug = maquetteSlug(title);
  const dir = join(EVALUATION_MAQUETTE_DIR, String(evaluationId), slug);
  mkdirSync(dir, { recursive: true });
  const written = [];
  for (const f of list) {
    const rel = assertSafeMaquettePath(f && (f.path || f.name));
    const content = f && f.content !== undefined && f.content !== null ? String(f.content) : "";
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
    written.push(rel);
  }
  if (!written.includes(entryRel)) {
    throw new Error(`entry '${entryRel}' absent des fichiers fournis (${written.join(", ")})`);
  }
  const url = `/api/evaluations/${encodeURIComponent(String(evaluationId))}/maquette/${slug}/${entryRel}`;
  const id = `ART-EVAL-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const meta = {
    url, maquetteDir: dir, entry: entryRel, slug, files: written,
    ...(itemId !== undefined && itemId !== null && itemId !== "" ? { itemId: Number(itemId) } : {}),
  };
  await pool().query(
    `INSERT INTO artifacts (artifact_id, doc_type, content_id, kind, title, nature, source, path, meta, created_at)
     VALUES ($1,'evaluation_doc',$2,'autre',$3,'maquette','import',$4,$5,$6)`,
    [id, String(evaluationId), title ?? `Maquette ${slug}`, join(dir, entryRel), meta, nowIso()],
  );
  const documents = await listEvaluationDocuments(evaluationId);
  return { ok: true, evaluationId: String(evaluationId), url, maquetteDir: dir, entry: entryRel, document: documents.find((d) => d.artifactId === id) || null, documents };
}

// ENREGISTRE un RAPPORT DE PERFORMANCE (test préprod : durées réseau, timings,
// Core Web Vitals, stress) comme pièce d'évaluation de nature `performance`.
// `meta` porte le résumé (`metrics`) et le chemin du rapport (`reportPath`).
// `e2eTestId` (optionnel) rattache la mesure à un test Playwright existant.
export async function addEvaluationPerfResult({ evaluationId, title, reportPath, metrics, summary, itemId, e2eTestId } = {}) {
  await ensureSchema();
  const ev = (await pool().query("SELECT evaluation_id FROM evaluations WHERE evaluation_id = $1", [evaluationId])).rows[0];
  if (!ev) throw new Error(`évaluation inconnue : ${evaluationId}`);
  const id = `ART-EVAL-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const meta = {
    ...(reportPath ? { reportPath: String(reportPath) } : {}),
    ...(metrics && typeof metrics === "object" ? { metrics } : {}),
    ...(summary ? { summary: String(summary) } : {}),
    ...(e2eTestId ? { e2eTestId: String(e2eTestId) } : {}),
    ...(itemId !== undefined && itemId !== null && itemId !== "" ? { itemId: Number(itemId) } : {}),
  };
  await pool().query(
    `INSERT INTO artifacts (artifact_id, doc_type, content_id, kind, title, nature, source, path, meta, created_at)
     VALUES ($1,'evaluation_doc',$2,'autre',$3,'performance','import',$4,$5,$6)`,
    [id, String(evaluationId), title ?? "Rapport de performance", reportPath ?? null, Object.keys(meta).length ? meta : null, nowIso()],
  );
  const documents = await listEvaluationDocuments(evaluationId);
  return { ok: true, evaluationId: String(evaluationId), document: documents.find((d) => d.artifactId === id) || null, documents };
}

export async function listEvaluationDocuments(evaluationId, { itemId } = {}) {
  await ensureSchema();
  const params = [String(evaluationId), EVALUATION_DOC_TYPES];
  let filter = "";
  if (itemId !== undefined && itemId !== null && itemId !== "") {
    params.push(String(Number(itemId)));
    filter = ` AND d.meta->>'itemId' = $${params.length}`;
  }
  const rows = (await pool().query(
    `SELECT d.id, d.artifact_id, d.content_id, d.title, d.nature, d.source, d.path, d.meta, d.created_at,
            a.title AS artifact_title
     FROM artifacts d
     LEFT JOIN artifacts a ON a.artifact_id = (d.meta->>'artifactId')
     WHERE d.content_id = $1 AND d.doc_type = ANY($2)${filter} ORDER BY d.id ASC`,
    params,
  )).rows;
  return rows.map((r) => ({
    documentId: Number(r.id),
    evaluationId: r.content_id,
    title: r.title || r.artifact_title || (r.path ? r.path.split("/").pop() : null) || null,
    nature: r.nature,
    source: r.source,
    path: r.path,
    meta: r.meta ?? null,
    itemId: r.meta && r.meta.itemId !== undefined && r.meta.itemId !== null ? Number(r.meta.itemId) : null,
    artifactId: r.artifact_id ?? null,
    createdAt: r.created_at,
  }));
}

export async function removeEvaluationDocument(documentId) {
  await ensureSchema();
  const row = (await pool().query(
    "SELECT content_id, nature, meta FROM artifacts WHERE id = $1 AND doc_type = ANY($2)",
    [documentId, EVALUATION_DOC_TYPES],
  )).rows[0];
  if (!row) return null;
  // Nettoyage des fichiers physiques d'une MAQUETTE (`meta.maquetteDir`),
  // confiné au répertoire des maquettes d'évaluation (garde anti-traversée).
  const meta = row.meta && typeof row.meta === "object" ? row.meta : parseDocMeta(row.meta);
  const dir = meta && typeof meta === "object" ? meta.maquetteDir : null;
  if (dir && String(dir).startsWith(EVALUATION_MAQUETTE_DIR + "/")) {
    try { rmSync(String(dir), { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  await pool().query("DELETE FROM artifacts WHERE id = $1 AND doc_type = ANY($2)", [documentId, EVALUATION_DOC_TYPES]);
  return row.content_id;
}

// Clôture (`pending→in_progress→done`) SANS créer de tâche (ADR-001).
export async function confirmEvaluation({ evaluationId, confirmedBy } = {}) {
  await ensureSchema();
  const r = (await pool().query(
    "UPDATE evaluations SET status = 'done', confirmed_at = $1, confirmed_by = $2 WHERE evaluation_id = $3 RETURNING evaluation_id",
    [nowIso(), confirmedBy ?? "human", evaluationId],
  )).rows[0];
  if (!r) throw new Error(`évaluation inconnue : ${evaluationId}`);
  return getEvaluationById(evaluationId);
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

// Signal ÉVALUATEUR : le comportement réel ne correspond pas au scénario / à la règle.
// UNIQUE écriture E2E permise à l'évaluateur : statut INCOHERENT + remarques (auteur + date).
// Aucune modification du code de test : c'est un signal, pas une édition du spec.
export async function markE2ETestIncoherent({ e2eTestId, remarks, by }) {
  await ensureSchema();
  const txt = String(remarks || "").trim();
  if (!txt) throw new Error("remarks requis : décrivez l'incohérence constatée (comportement réel ≠ scénario).");
  const now = nowIso();
  const r = await pool().query(
    `UPDATE e2e_tests SET status = 'INCOHERENT', incoherent_remarks = $1, incoherent_by = $2,
       incoherent_at = $3, updated_at = $3 WHERE id = $4 RETURNING id`,
    [txt, by ? String(by) : null, now, e2eTestId],
  );
  if (!r.rows[0]) throw new Error(`test inconnu : ${e2eTestId}`);
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
    // Signal évaluateur « comportement réel ≠ scénario » (statut INCOHERENT).
    incoherentRemarks: t.incoherent_remarks,
    incoherentBy: t.incoherent_by,
    incoherentAt: t.incoherent_at,
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
    incoherentRemarks: r.incoherent_remarks,
    incoherentBy: r.incoherent_by,
    incoherentAt: r.incoherent_at,
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
  // TAXONOMIE E2E (T-20260920-162801-jxtr) : les preuves deviennent des artefacts
  // (`e2e_report` = rapport texte ; `e2e_video` = preuve HUMAINE) visibles dans le
  // gestionnaire central. `report_artifact_id` reste un `artifact_id` inchangé.
  const row = (await pool().query("SELECT e2e_test_id FROM e2e_executions WHERE id = $1", [executionId])).rows[0];
  if (row) {
    if (reportArtifactId) {
      const a = (await pool().query("SELECT 1 FROM artifacts WHERE artifact_id = $1", [reportArtifactId])).rows[0];
      if (!a) console.error(`[e2e] reportArtifactId inconnu : ${reportArtifactId} (exécution ${executionId})`);
    }
    if (videoUrl) {
      const existing = (await pool().query(
        "SELECT artifact_id FROM artifacts WHERE doc_type = 'e2e_video' AND content_id = $1 AND path = $2 LIMIT 1",
        [String(row.e2e_test_id), String(videoUrl)],
      )).rows[0];
      if (!existing) {
        await pool().query(
          `INSERT INTO artifacts (artifact_id, doc_type, content_id, kind, title, path, source, meta, created_at)
           VALUES ($1,'e2e_video',$2,'autre',$3,$4,'artifact',$5,$6)`,
          [`ART-E2E-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
           String(row.e2e_test_id), `Vidéo E2E — ${row.e2e_test_id}`, String(videoUrl),
           { executionId, videoUrl: String(videoUrl) }, nowIso()],
        );
      }
    }
  }
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

// ===========================================================================
// PIÈCES CLIENT (ADR-001, item 4) — matière première des sprints.
// Une pièce est un artefact `doc_type='piece'`, `content_id = projectId`.
// Natures admises : markdown | pdf | docx | lien externe (Drive public).
// PHOTO et VIDÉO REFUSÉES (garde `assertPieceAllowed`, import ET lien externe).
// Requalification SANS PERTE des docs ADR-12 (marqueur `meta.piece_client`).
// ===========================================================================

// Extension (minuscule, sans query/fragment) d'un chemin ou d'une URL.
function pieceExtOf(p) {
  if (!p) return "";
  const clean = String(p).trim().toLowerCase().split("?")[0].split("#")[0];
  const i = clean.lastIndexOf(".");
  return i >= 0 ? clean.slice(i) : "";
}

// Nature déduite du chemin d'un document (repli : markdown — texte).
export function pieceNatureFromPath(p) {
  return PIECE_NATURE_BY_EXT[pieceExtOf(p)] || "markdown";
}

// GARDE AUTORITATIVE des natures de pièce client.
// Refuse : (1) une PHOTO/VIDÉO importée (extension fichier), (2) un LIEN externe
// vers une vidéo (hôte connu) ou une photo/vidéo (extension de l'URL).
// Retourne la nature RÉSOLUE (markdown | pdf | docx | lien).
export function assertPieceAllowed({ nature, path, url, filename } = {}) {
  const p = path ? String(path).trim() : null;
  const u = url ? String(url).trim() : null;
  const f = filename ? String(filename).trim() : null;

  // (1) Import de fichier : refus photo/vidéo par extension.
  for (const cand of [f, p]) {
    const ext = pieceExtOf(cand);
    if (ext && PIECE_REFUSED_EXT.includes(ext)) {
      throw new Error(`pièce refusée : les photos et vidéos ne sont pas admises (extension « ${ext} »). Natures admises : ${PIECE_NATURES.join(" | ")}`);
    }
  }

  // (2) Lien externe : refus vidéo (hôte connu) / photo-vidéo (extension d'URL).
  if (u) {
    let host = "";
    let pathname = "";
    try {
      const parsed = new URL(u);
      if (!/^https?:$/.test(parsed.protocol)) throw new Error("protocole non http(s)");
      host = parsed.hostname.toLowerCase().replace(/^www\./, "");
      pathname = parsed.pathname || "";
    } catch {
      throw new Error(`lien invalide : ${u} (une URL http(s) publique est attendue)`);
    }
    if (PIECE_REFUSED_HOSTS.some((h) => host === h || host.endsWith("." + h))) {
      throw new Error(`lien refusé : la vidéo (${host}) n'est pas une pièce client admise. Natures admises : ${PIECE_NATURES.join(" | ")}`);
    }
    const ext = pieceExtOf(pathname);
    if (ext && PIECE_REFUSED_EXT.includes(ext)) {
      throw new Error(`lien refusé : photo/vidéo non admise (extension « ${ext} »). Natures admises : ${PIECE_NATURES.join(" | ")}`);
    }
  }

  // (3) Nature résolue puis validée.
  let nat = nature ? String(nature).trim() : "";
  if (u) nat = "lien";
  else if (!nat) nat = PIECE_NATURE_BY_EXT[pieceExtOf(f || p)] || "";
  if (!PIECE_NATURES.includes(nat)) {
    throw new Error(`nature de pièce invalide : ${nature || "(absente)"} (attendu : ${PIECE_NATURES.join(" | ")})`);
  }
  if (nat === "lien") {
    if (!u) throw new Error("nature 'lien' exige une URL publique (url)");
  } else if (!p && !f) {
    throw new Error(`nature '${nat}' exige un fichier (path ou filename)`);
  }
  return nat;
}

// GARDE CIBLÉE des natures de PIÈCE D'ÉVALUATION (recette évaluateur, ADR-003).
// DIFFÉRENCE CLÉ avec `assertPieceAllowed` (pièces client de sprint) : elle
// ADMET explicitement les PHOTOS et VIDÉOS, à l'import de fichier COMME pour un
// lien externe. AUCUN refus d'extension photo/vidéo ni d'hôte vidéo n'est
// appliqué ici — l'évaluateur joint des preuves visuelles à ses éléments.
// Elle VALIDE seulement que la nature résolue ∈ `EVALUATION_DOC_NATURES` et
// retourne cette nature RÉSOLUE (persistée par `addEvaluationDocument`).
// Résolution : URL → 'lien' ; sinon nature explicite ; sinon extension
// (`EVALUATION_DOC_NATURE_BY_EXT`, repli 'document' si localisation présente).
// Tolérance legacy : ni nature ni localisation → `null` (rien à qualifier).
export function assertEvaluationDocAllowed({ nature, path, url, filename } = {}) {
  const p = path ? String(path).trim() : null;
  const u = url ? String(url).trim() : null;
  const f = filename ? String(filename).trim() : null;

  let nat = nature ? String(nature).trim() : "";
  if (!nat) {
    if (u) {
      nat = "lien";
    } else {
      nat = EVALUATION_DOC_NATURE_BY_EXT[pieceExtOf(f || p)] || "";
      if (!nat) {
        if (!p && !f) return null; // legacy : pièce sans nature ni localisation
        nat = "document";
      }
    }
  }
  if (!EVALUATION_DOC_NATURES.includes(nat)) {
    throw new Error(
      `nature de pièce d'évaluation invalide : ${nature || "(absente)"} (attendu : ${EVALUATION_DOC_NATURES.join(" | ")})`,
    );
  }
  return nat;
}

// Sérialise une ligne `artifacts` → pièce client (nouvelle OU doc requalifié).
function rowToPiece(r) {
  if (!r) return null;
  const meta = parseDocMeta(r.meta);
  const m = meta && typeof meta === "object" ? meta : {};
  return {
    pieceId: r.artifact_id,
    docType: r.doc_type,
    contentId: r.content_id,
    kind: r.kind ?? null,
    nature: m.piece_nature ?? r.nature ?? null,
    title: r.title ?? null,
    path: r.path ?? null,
    url: m.url ?? null,
    filename: m.filename ?? null,
    description: r.description ?? null,
    source: r.source ?? null,
    emergent: m.emergent === true || m.emergent === "true",
    emergentOrigin: m.emergent_origin ?? null,
    sprintId: m.sprint_id ?? null,
    securityNote: m.security_note ?? null,
    requalified: m.piece_client === true || m.piece_client === "true",
    meta: meta,
    createdAt: r.created_at,
    createdBy: r.created_by ?? null,
  };
}

// GARDE NATURE du RATTACHEMENT d'une pièce à un sprint (T4). Une pièce
// rattachable est une pièce CLIENT (`doc_type='piece'`) OU un document ADR-12
// REQUALIFIÉ (`meta.piece_client=true`) ; sa nature est RE-VÉRIFIÉE via la garde
// autoritative `assertPieceAllowed` (refus photo/vidéo, nature ∈ PIECE_NATURES).
// Retourne la pièce (forme `rowToPiece`, nature résolue) ; lève une erreur
// explicite si l'artefact est inconnu, non-pièce, ou de nature refusée.
export async function assertAttachablePiece(pieceId) {
  await ensureSchema();
  if (!pieceId) throw new Error("pieceId requis");
  const id = String(pieceId);
  const row = (await pool().query("SELECT * FROM artifacts WHERE artifact_id = $1", [id])).rows[0];
  if (!row) throw new Error(`pièce inconnue : ${id}`);
  const meta = parseDocMeta(row.meta);
  const m = meta && typeof meta === "object" ? meta : {};
  const isPiece = row.doc_type === "piece";
  const isRequalified = m.piece_client === true || m.piece_client === "true";
  if (!isPiece && !isRequalified) {
    throw new Error(
      `artefact non rattachable : ${id} (doc_type='${row.doc_type}' ; attendu : pièce 'piece' ou doc ADR-12 requalifié meta.piece_client=true)`,
    );
  }
  const piece = rowToPiece(row);
  // Re-vérifie la NATURE (refus photo/vidéo) — garde autoritative partagée.
  const resolved = assertPieceAllowed({
    nature: piece.nature,
    path: piece.path ?? null,
    url: piece.url ?? null,
    filename: piece.filename ?? null,
  });
  return { ...piece, nature: resolved, attachable: true };
}

// Ajoute une PIÈCE CLIENT à un projet. Garde `assertPieceAllowed` incluse.
// Traçage : artefact `doc_type='piece'`, `content_id=projectId`, lien
// `artifact_projects`. ÉMERGENCE (non bloquante) : si le projet possède un
// sprint, la pièce est marquée `emergent` + `sprint_pieces`.
export async function addPiece({ projectId, nature, title, path, url, filename, description, createdBy } = {}) {
  await ensureSchema();
  if (!projectId || !String(projectId).trim()) throw new Error("projectId requis (une pièce client appartient à un projet)");
  const pid = String(projectId).trim();
  await assertProjectExists(pid);
  const resolvedNature = assertPieceAllowed({ nature, path, url, filename });
  const p = path ? String(path).trim() : null;
  const u = url ? String(url).trim() : null;
  const f = filename ? String(filename).trim() : (p ? basename(p) : null);
  // `path` est NOT NULL dans `artifacts` : un lien stocke son URL comme localisation.
  const storedPath = p || u;

  // Idempotence : même projet + même localisation (chemin OU url).
  const existing = (await pool().query(
    "SELECT * FROM artifacts WHERE doc_type = 'piece' AND content_id = $1 AND path = $2 ORDER BY id LIMIT 1", [pid, storedPath],
  )).rows[0];
  if (existing) return getPiece(existing.artifact_id);

  // Émergence (JAMAIS bloquante) via la GARDE PARTAGÉE `classifyEmergence` :
  // pièce reçue après l'initialisation d'un sprint → `emergent`, origine
  // `apres_init_sprint` (sprint open) ou `apres_cloture` (sprint close).
  // Comportement T2 conservé (mêmes origines, même lien `sprint_pieces`).
  const em = await classifyEmergence(pid, { kind: "piece" });
  const meta = {
    piece_nature: resolvedNature,
    url: u,
    filename: f,
    emergent: em.emergent,
    emergent_origin: em.emergentOrigin,
    sprint_id: em.sprintId,
    security_note: resolvedNature === "lien" ? PIECE_LINK_SECURITY_NOTE : null,
  };
  const src = u ? "ref" : "import";
  const org = (await orgIdOfProject(pid)) || (await defaultOrganizationId());
  const artifactId = `ART-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const ts = nowIso();
  await pool().query(
    `INSERT INTO artifacts (artifact_id, doc_type, content_id, kind, title, path, nature, source, meta, description, organization_id, created_at, created_by)
     VALUES ($1,'piece',$2,'autre',$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      artifactId, pid,
      title ? String(title).trim() : (f || u || "pièce client"),
      storedPath, resolvedNature, src, meta,
      description ? String(description).trim() : null,
      org, ts, createdBy ?? null,
    ],
  );
  await pool().query("INSERT INTO artifact_projects (artifact_id, project_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [artifactId, pid]);
  if (em.sprintId) {
    await pool().query("INSERT INTO sprint_pieces (sprint_id, piece_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [em.sprintId, artifactId]);
  }
  return getPiece(artifactId);
}

// Détail d'une pièce client (forme pièce + cibles projet/repo).
export async function getPiece(pieceId) {
  await ensureSchema();
  const r = (await pool().query("SELECT * FROM artifacts WHERE artifact_id = $1 AND doc_type = 'piece'", [String(pieceId)])).rows[0];
  if (!r) return null;
  const [projects, repos] = await Promise.all([getArtifactProjects(r.artifact_id), getArtifactRepos(r.artifact_id)]);
  return { ...rowToPiece(r), projects, repos };
}

// Liste unifiée des pièces d'un projet : pièces NOUVELLES (`doc_type='piece'`)
// + docs ADR-12 REQUALIFIÉS (`meta.piece_client=true`, `requalified=true`).
// Filtres : nature, emergent ; includeRequalified (défaut true).
export async function listPieces({ projectId, nature, emergent, includeRequalified = true } = {}) {
  await ensureSchema();
  if (!projectId || !String(projectId).trim()) throw new Error("projectId requis");
  const pid = String(projectId).trim();

  const params = [pid];
  const conds = ["a.doc_type = 'piece'", "a.content_id = $1"];
  if (nature) { params.push(String(nature)); conds.push(`a.meta->>'piece_nature' = $${params.length}`); }
  if (emergent !== undefined && emergent !== null) {
    params.push(emergent ? "true" : "false");
    conds.push(`COALESCE(a.meta->>'emergent', 'false') = $${params.length}`);
  }
  const pieceRows = (await pool().query(
    `SELECT a.* FROM artifacts a WHERE ${conds.join(" AND ")} ORDER BY a.created_at DESC, a.id DESC`, params,
  )).rows;
  const [pieceProj, pieceRepo] = await Promise.all([getArtifactProjectsBatch(pieceRows), getArtifactReposBatch(pieceRows)]);
  const pieces = pieceRows.map((r) => ({ ...rowToPiece(r), projects: pieceProj[r.artifact_id] || [], repos: pieceRepo[r.artifact_id] || [] }));

  let requalified = [];
  if (includeRequalified !== false && emergent !== true) {
    const rqParams = [pid, DOCS_DOC_TYPES];
    const rqConds = ["ap.project_id = $1", "a.doc_type = ANY($2)", "(a.meta->>'piece_client') = 'true'"];
    if (nature) { rqParams.push(String(nature)); rqConds.push(`a.meta->>'piece_nature' = $${rqParams.length}`); }
    const rqRows = (await pool().query(
      `SELECT DISTINCT a.* FROM artifacts a JOIN artifact_projects ap ON ap.artifact_id = a.artifact_id
        WHERE ${rqConds.join(" AND ")} ORDER BY a.doc_type, a.title NULLS LAST`, rqParams,
    )).rows;
    const [rqProj, rqRepo] = await Promise.all([getArtifactProjectsBatch(rqRows), getArtifactReposBatch(rqRows)]);
    requalified = rqRows.map((r) => ({ ...rowToPiece(r), projects: rqProj[r.artifact_id] || [], repos: rqRepo[r.artifact_id] || [] }));
  }
  return [...pieces, ...requalified];
}

// REQUALIFICATION SANS PERTE des documents ADR-12 en PIÈCES CLIENT du projet.
// N'écrit QUE `meta` (marqueur `piece_client` + nature + traçage) : jamais
// `doc_type` / `content_id` / `path` / liens `artifact_projects`|`artifact_repos`.
// Idempotente (les docs déjà requalifiés sont ignorés). Sans `projectId` :
// requalifie TOUS les docs ADR-12 du registre.
export async function requalifyDocsAsPieces({ projectId } = {}) {
  await ensureSchema();
  const pid = projectId ? String(projectId).trim() : null;
  const rows = pid
    ? (await pool().query(
        `SELECT DISTINCT a.* FROM artifacts a JOIN artifact_projects ap ON ap.artifact_id = a.artifact_id
          WHERE ap.project_id = $1 AND a.doc_type = ANY($2) ORDER BY a.id`, [pid, DOCS_DOC_TYPES],
      )).rows
    : (await pool().query("SELECT * FROM artifacts WHERE doc_type = ANY($1) ORDER BY id", [DOCS_DOC_TYPES])).rows;
  const ts = nowIso();
  const requalified = [];
  let alreadyCount = 0;
  for (const r of rows) {
    const meta = parseDocMeta(r.meta);
    const m = meta && typeof meta === "object" ? meta : {};
    if (m.piece_client === true || m.piece_client === "true") { alreadyCount++; continue; }
    const nature = pieceNatureFromPath(r.path);
    const marker = {
      piece_client: true,
      piece_nature: nature,
      requalified_at: ts,
      requalified_from_doc_type: r.doc_type,
    };
    await pool().query(
      `UPDATE artifacts SET meta = COALESCE(meta, '{}'::jsonb) || $2::jsonb, updated_at = $3 WHERE artifact_id = $1`,
      [r.artifact_id, JSON.stringify(marker), ts],
    );
    requalified.push({ docId: r.artifact_id, docType: r.doc_type, nature, path: r.path ?? null });
  }
  return { count: requalified.length, total: rows.length, alreadyRequalified: alreadyCount, requalified };
}

// Retire une pièce client (famille `piece` uniquement). Les liens
// `artifact_projects` / `sprint_pieces` suivent en CASCADE.
export async function removePiece({ pieceId } = {}) {
  await ensureSchema();
  if (!pieceId) throw new Error("pieceId requis");
  const id = String(pieceId);
  const row = (await pool().query("SELECT * FROM artifacts WHERE artifact_id = $1 AND doc_type = 'piece'", [id])).rows[0];
  if (!row) return null;
  await pool().query("DELETE FROM artifacts WHERE artifact_id = $1", [id]);
  return { pieceId: id, deleted: true };
}
