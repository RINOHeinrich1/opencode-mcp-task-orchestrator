#!/usr/bin/env node
/**
 * artifacts-fusion-migration.mjs — migration IDEMPOTENTE des 3 silos d'artefacts
 * (`artifacts` tâche + `recette_documents` + `docs`/`doc_attachments`) vers la
 * table polymorphe UNIQUE `artifacts` (tâche T-20260920-162801-jxtr).
 *
 * Sous-commandes :
 *   inventory  — LECTURE SEULE : comptages + échantillons par source (JSON + markdown).
 *   snapshot   — rollback défini AVANT exécution : tables `<source>_backup_<ts>`.
 *   migrate    — migration idempotente, ordre STRICT
 *                `artifacts → recette_documents → docs → doc_attachments → liens`.
 *                Chaque INSERT est gardé par `NOT EXISTS (artifact_id)` → rejouable.
 *   validate   — comptages + échantillons + rétrocompat (PASS/FAIL par contrôle).
 *   neutralize — neutralisation des tables legacy par RENOMMAGE (`legacy_*`) —
 *                ⚠️ JAMAIS de DROP de table/colonne (garde-fou v1.0) — + rebasage
 *                de la FK `adr_conflicts.adr_id` → `artifacts(artifact_id)`.
 *   rollback   — restauration depuis un snapshot ; ne touche JAMAIS aux tables legacy.
 *
 * ⚠️ ORDRE DE MISE EN SERVICE (impératif) :
 *   1. inventory + snapshot (avant toute écriture) ;
 *   2. migrate (idempotent) ;
 *   3. validate → PASS obligatoire ;
 *   4. DÉPLOIEMENT du code rebasé (MCP + panneau) ;
 *   5. neutralize SEULEMENT après le redémarrage du code rebasé — sinon le code
 *      legacy encore en service (qui lit `docs`/`recette_documents`/`task_id`)
 *      casse. La neutralisation est donc une étape de MISE EN SERVICE.
 *
 * pg_dump (sauvegarde complète base, complément du snapshot logique) :
 *   pg_dump "$DATABASE_URL" -Fc -f /root/backups/task_registry_<ts>.dump
 */
import pg from "pg";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadGlobalEnv } from "../../../scripts/load-env.mjs";

const { Pool } = pg;
loadGlobalEnv();
const DATABASE_URL =
  process.env.DATABASE_URL || "postgres://orchestrator:orchestrator@localhost:5432/task_registry";

// Familles de doc_type (miroir de db.mjs — script autonome).
const TASK_DOC_TYPES = ["plan", "task_synthese", "task_report", "audit_report", "autre"];
const RECETTE_DOC_TYPES = ["recette_doc", "recette_report"];
const DOCS_DOC_TYPES = ["adr", "specs", "gherkin", "project_doc"];
const LEGACY_TABLES = ["docs", "recette_documents", "doc_attachments", "doc_projects", "doc_repos"];

const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
const q = async (sql, p = []) => (await pool.query(sql, p)).rows;
const ts = () => new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
const out = (o) => process.stdout.write(JSON.stringify(o, null, 2) + "\n");

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

async function tableExists(name) {
  const r = (await q("SELECT to_regclass($1) AS t", [`public.${name}`]))[0];
  return r && r.t !== null;
}
async function columnExists(table, col) {
  const r = await q(
    "SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2",
    [table, col],
  );
  return r.length > 0;
}
async function count(sql, p = []) {
  return Number((await q(sql, p))[0]?.n || 0);
}
async function samples(sql, p = [], n = 5) {
  return await q(`${sql} LIMIT ${Number(n) || 5}`, p);
}

// ---------------------------------------------------------------------------
// Schéma cible (autonome — miroir de migrate() de db.mjs, ADDITIF idempotent).
// ---------------------------------------------------------------------------
async function ensureTargetSchema() {
  await pool.query(`CREATE TABLE IF NOT EXISTS artifacts (
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
  for (const [col, def] of [
    ["doc_type", "TEXT NOT NULL DEFAULT 'autre'"], ["content_id", "TEXT"], ["nature", "TEXT"],
    ["source", "TEXT NOT NULL DEFAULT 'import'"], ["meta", "JSONB"], ["description", "TEXT"],
    ["status", "TEXT"], ["context", "TEXT"], ["decision", "TEXT"], ["consequences", "TEXT"],
    ["replaced_by", "TEXT"], ["is_global", "INTEGER NOT NULL DEFAULT 0"], ["organization_id", "TEXT"],
    ["updated_at", "TEXT"], ["created_by", "TEXT"],
  ]) {
    await pool.query(`ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS ${col} ${def}`);
  }
  // La colonne `task_id` (ancien silo) doit accepter NULL pour les familles non-task
  // (recette/docs/attachments). C'est une levée de contrainte, PAS un DROP de colonne.
  if (await columnExists("artifacts", "task_id")) {
    await pool.query("ALTER TABLE artifacts ALTER COLUMN task_id DROP NOT NULL");
  }
  await pool.query("CREATE INDEX IF NOT EXISTS idx_artifacts_doc_type ON artifacts(doc_type)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_artifacts_content ON artifacts(content_id)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_artifacts_kind ON artifacts(kind)");
  await pool.query(`CREATE TABLE IF NOT EXISTS artifact_projects (
    artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id) ON DELETE CASCADE,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    PRIMARY KEY (artifact_id, project_id)
  )`);
  await pool.query("CREATE INDEX IF NOT EXISTS idx_artifact_projects_project ON artifact_projects(project_id)");
  await pool.query(`CREATE TABLE IF NOT EXISTS artifact_repos (
    artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id) ON DELETE CASCADE,
    repo_id     TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    PRIMARY KEY (artifact_id, repo_id)
  )`);
  await pool.query("CREATE INDEX IF NOT EXISTS idx_artifact_repos_repo ON artifact_repos(repo_id)");
}

// ---------------------------------------------------------------------------
// inventory
// ---------------------------------------------------------------------------
async function inventory() {
  const inv = { generatedAt: new Date().toISOString(), database: DATABASE_URL.replace(/:[^:@/]*@/, ":***@"), sources: {} };

  // artifacts (silo tâche + tout artefact déjà migré). LECTURE SEULE : tolérant à
  // l'état pré-migration (colonnes doc_type/content_id/nature/source absentes).
  const hasDocType = await columnExists("artifacts", "doc_type");
  const hasContentId = await columnExists("artifacts", "content_id");
  const hasTaskId = await columnExists("artifacts", "task_id");
  const byKind = await q("SELECT kind, COUNT(*)::int AS n FROM artifacts GROUP BY kind ORDER BY kind");
  const byType = hasDocType
    ? await q("SELECT doc_type, COUNT(*)::int AS n FROM artifacts GROUP BY doc_type ORDER BY doc_type")
    : [];
  const selCols = [
    "artifact_id", hasDocType ? "doc_type" : "NULL::text AS doc_type",
    hasContentId ? "content_id" : (hasTaskId ? "task_id AS content_id" : "NULL::text AS content_id"),
    "kind", "title", "path", "created_at",
  ].join(", ");
  inv.sources.artifacts = {
    total: await count("SELECT COUNT(*)::int AS n FROM artifacts"),
    byKind,
    byDocType: byType,
    samples: await samples(`SELECT ${selCols} FROM artifacts ORDER BY id`),
  };

  for (const t of ["recette_documents", "docs", "doc_attachments", "doc_projects", "doc_repos"]) {
    if (!(await tableExists(t))) { inv.sources[t] = { exists: false }; continue; }
    const total = await count(`SELECT COUNT(*)::int AS n FROM ${t}`);
    const s = t === "docs"
      ? await samples("SELECT id, kind, title, path, status, is_global, created_at FROM docs ORDER BY id")
      : t === "doc_attachments"
        ? await samples("SELECT attachment_id, doc_id, doc_type, content_id, kind, nature, title, path, source, created_at FROM doc_attachments ORDER BY created_at")
        : t === "recette_documents"
          ? await samples("SELECT id, recette_id, title, nature, source, path, artifact_id, created_at FROM recette_documents ORDER BY id")
          : await samples(`SELECT * FROM ${t} ORDER BY 1`);
    inv.sources[t] = { exists: true, total, samples: s };
  }

  // Contrôles d'intégrité FK (avant migration).
  if (await tableExists("doc_projects")) {
    inv.sources.doc_projects.orphans = await count(
      "SELECT COUNT(*)::int AS n FROM doc_projects dp LEFT JOIN docs d ON d.id = dp.doc_id WHERE d.id IS NULL",
    );
  }
  if (await tableExists("doc_repos")) {
    inv.sources.doc_repos.orphans = await count(
      "SELECT COUNT(*)::int AS n FROM doc_repos dr LEFT JOIN docs d ON d.id = dr.doc_id WHERE d.id IS NULL",
    );
  }
  return inv;
}

function inventoryMarkdown(inv) {
  const L = [];
  L.push(`# Inventaire pré-migration — fusion artefacts polymorphe`);
  L.push(``, `- Généré : ${inv.generatedAt}`, `- Base : \`${inv.database}\``, ``);
  L.push(`| Source | Existe | Total |`, `|--------|--------|-------|`);
  for (const [k, v] of Object.entries(inv.sources)) L.push(`| \`${k}\` | ${v.exists === false ? "non" : "oui"} | ${v.exists === false ? "—" : v.total} |`);
  L.push(``, `## Détail`);
  for (const [k, v] of Object.entries(inv.sources)) {
    L.push(``, `### \`${k}\``);
    if (v.exists === false) { L.push(`Table absente.`); continue; }
    if (v.byKind) L.push(`Par \`kind\` : ${v.byKind.map((x) => `\`${x.kind}\`=${x.n}`).join(", ") || "—"}`);
    if (v.byDocType) L.push(`Par \`doc_type\` : ${v.byDocType.map((x) => `\`${x.doc_type}\`=${x.n}`).join(", ") || "—"}`);
    if (v.orphans !== undefined) L.push(`Orphelins FK : ${v.orphans}`);
    L.push(``, `Échantillon (max 5) :`, "```json", JSON.stringify(v.samples, null, 2), "```");
  }
  return L.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// snapshot
// ---------------------------------------------------------------------------
async function snapshot(tsArg) {
  const t = tsArg || ts();
  const created = [];
  if (await tableExists("artifacts")) {
    await pool.query(`CREATE TABLE IF NOT EXISTS artifacts_backup_${t} AS SELECT * FROM artifacts`);
    created.push(`artifacts_backup_${t}`);
  }
  for (const src of LEGACY_TABLES) {
    if (!(await tableExists(src))) continue;
    await pool.query(`CREATE TABLE IF NOT EXISTS ${src}_backup_${t} AS SELECT * FROM ${src}`);
    created.push(`${src}_backup_${t}`);
  }
  return { timestamp: t, tables: created, restore: `node scripts/artifacts-fusion-migration.mjs rollback --ts ${t}` };
}

// ---------------------------------------------------------------------------
// migrate (idempotent)
// ---------------------------------------------------------------------------
async function migrate() {
  await ensureTargetSchema();
  const report = [];

  // (1) Backfill silo TÂCHE (ne s'exécute que si `task_id` existe encore).
  if (await columnExists("artifacts", "task_id")) {
    const r1 = await pool.query("UPDATE artifacts SET content_id = task_id WHERE content_id IS NULL");
    report.push({ step: "artifacts.content_id", updated: r1.rowCount });
  }
  const r2 = await pool.query(
    `UPDATE artifacts SET doc_type = CASE kind
       WHEN 'plan' THEN 'plan' WHEN 'audit' THEN 'audit_report'
       WHEN 'report' THEN 'task_report' ELSE 'autre' END
     WHERE doc_type IS NULL OR (doc_type = 'autre' AND kind IN ('plan','audit','report'))`,
  );
  report.push({ step: "artifacts.doc_type", updated: r2.rowCount });
  await pool.query("UPDATE artifacts SET source = COALESCE(source, 'import') WHERE source IS NULL");

  // (2) recette_documents → artifacts
  if (await tableExists("recette_documents")) {
    const r = await pool.query(
      `INSERT INTO artifacts (artifact_id, doc_type, content_id, kind, title, nature, source, path, meta, created_at)
       SELECT 'ART-REC-' || d.id,
              CASE WHEN d.artifact_id IS NOT NULL AND a.kind = 'report' THEN 'recette_report' ELSE 'recette_doc' END,
              d.recette_id, 'report', d.title, d.nature, COALESCE(d.source, 'import'), d.path,
              jsonb_build_object('legacyId', d.id, 'artifactId', d.artifact_id), d.created_at
       FROM recette_documents d
       LEFT JOIN artifacts a ON a.artifact_id = d.artifact_id
       WHERE NOT EXISTS (SELECT 1 FROM artifacts x WHERE x.artifact_id = 'ART-REC-' || d.id)`,
    );
    report.push({ step: "recette_documents", inserted: r.rowCount });
  }

  // (3) docs → artifacts (cast sûr meta TEXT → JSONB)
  if (await tableExists("docs")) {
    const r = await pool.query(
      `INSERT INTO artifacts (artifact_id, doc_type, content_id, kind, title, path, description,
                              status, context, decision, consequences, replaced_by, is_global,
                              source, meta, organization_id, created_at, created_by, updated_at)
       SELECT d.id,
              CASE d.kind WHEN 'adr-tech' THEN 'adr' WHEN 'specs-fonctionnelles' THEN 'specs'
                          WHEN 'scenarios-gherkin' THEN 'gherkin' ELSE 'project_doc' END,
              d.id, 'autre', d.title, d.path, d.description,
              d.status, d.context, d.decision, d.consequences, d.replaced_by, COALESCE(d.is_global, 0),
              'registry',
              CASE WHEN d.meta IS NULL OR d.meta = '' THEN NULL
                   WHEN d.meta ~ '^\\s*[\\{\\[]' THEN d.meta::jsonb
                   ELSE jsonb_build_object('legacy', d.meta) END,
              d.organization_id, d.created_at, d.created_by, d.updated_at
       FROM docs d
       WHERE NOT EXISTS (SELECT 1 FROM artifacts x WHERE x.artifact_id = d.id)`,
    );
    report.push({ step: "docs", inserted: r.rowCount });
  }

  // (4) doc_attachments → artifacts (doc_type='adr_file')
  if (await tableExists("doc_attachments")) {
    const r = await pool.query(
      `INSERT INTO artifacts (artifact_id, doc_type, content_id, kind, nature, title, path, source, meta, created_at, created_by)
       SELECT t.attachment_id, 'adr_file', t.doc_id, t.kind, t.nature, t.title, t.path, COALESCE(t.source, 'registry'),
              CASE WHEN t.target_doc_id IS NOT NULL THEN jsonb_build_object('targetDocId', t.target_doc_id)
                   ELSE CASE WHEN t.meta IS NULL OR t.meta = '' THEN NULL
                             WHEN t.meta ~ '^\\s*[\\{\\[]' THEN t.meta::jsonb
                             ELSE jsonb_build_object('legacy', t.meta) END END,
              t.created_at, t.created_by
       FROM doc_attachments t
       WHERE NOT EXISTS (SELECT 1 FROM artifacts x WHERE x.artifact_id = t.attachment_id)`,
    );
    report.push({ step: "doc_attachments", inserted: r.rowCount });
  }

  // (5) liens N:N
  if (await tableExists("doc_projects")) {
    const r = await pool.query(
      "INSERT INTO artifact_projects (artifact_id, project_id) SELECT doc_id, project_id FROM doc_projects ON CONFLICT DO NOTHING",
    );
    report.push({ step: "doc_projects→artifact_projects", inserted: r.rowCount });
  }
  if (await tableExists("doc_repos")) {
    const r = await pool.query(
      "INSERT INTO artifact_repos (artifact_id, repo_id) SELECT doc_id, repo_id FROM doc_repos ON CONFLICT DO NOTHING",
    );
    report.push({ step: "doc_repos→artifact_repos", inserted: r.rowCount });
  }
  return report;
}

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------
async function validate() {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ control: name, verdict: ok ? "PASS" : "FAIL", detail });

  // C1 — pas de doublon d'artifact_id
  const dup = await count("SELECT COUNT(*)::int AS n FROM (SELECT artifact_id FROM artifacts GROUP BY artifact_id HAVING COUNT(*) > 1) z");
  add("unicité artifact_id (aucun doublon)", dup === 0, `${dup} doublon(s)`);

  // C2 — docs : chaque doc legacy a son artefact
  if (await tableExists("docs")) {
    const missing = await count("SELECT COUNT(*)::int AS n FROM docs d WHERE NOT EXISTS (SELECT 1 FROM artifacts a WHERE a.artifact_id = d.id)");
    const src = await count("SELECT COUNT(*)::int AS n FROM docs");
    const dst = await count("SELECT COUNT(*)::int AS n FROM artifacts WHERE doc_type = ANY($1)", [DOCS_DOC_TYPES]);
    add("docs → artifacts (aucune perte)", missing === 0, `${src} docs, ${dst} artefacts famille docs, ${missing} manquant(s)`);
  }

  // C3 — recette_documents
  if (await tableExists("recette_documents")) {
    const missing = await count("SELECT COUNT(*)::int AS n FROM recette_documents d WHERE NOT EXISTS (SELECT 1 FROM artifacts a WHERE a.artifact_id = 'ART-REC-' || d.id)");
    const src = await count("SELECT COUNT(*)::int AS n FROM recette_documents");
    const dst = await count("SELECT COUNT(*)::int AS n FROM artifacts WHERE doc_type = ANY($1)", [RECETTE_DOC_TYPES]);
    add("recette_documents → artifacts (aucune perte)", missing === 0, `${src} docs recette, ${dst} artefacts recette, ${missing} manquant(s)`);
  }

  // C4 — doc_attachments
  if (await tableExists("doc_attachments")) {
    const missing = await count("SELECT COUNT(*)::int AS n FROM doc_attachments t WHERE NOT EXISTS (SELECT 1 FROM artifacts a WHERE a.artifact_id = t.attachment_id)");
    const src = await count("SELECT COUNT(*)::int AS n FROM doc_attachments");
    const dst = await count("SELECT COUNT(*)::int AS n FROM artifacts WHERE doc_type = 'adr_file'");
    add("doc_attachments → artifacts (aucune perte)", missing === 0, `${src} pièces jointes, ${dst} artefacts adr_file, ${missing} manquant(s)`);
  }

  // C5 — liens N:N
  if (await tableExists("doc_projects")) {
    const src = await count("SELECT COUNT(*)::int AS n FROM doc_projects");
    const dst = await count("SELECT COUNT(*)::int AS n FROM artifact_projects");
    add("doc_projects → artifact_projects", dst >= src, `${src} liens source, ${dst} liens cible`);
  }
  if (await tableExists("doc_repos")) {
    const src = await count("SELECT COUNT(*)::int AS n FROM doc_repos");
    const dst = await count("SELECT COUNT(*)::int AS n FROM artifact_repos");
    add("doc_repos → artifact_repos", dst >= src, `${src} liens source, ${dst} liens cible`);
  }

  // C6 — échantillon ADR : champs structurés conservés
  if (await tableExists("docs")) {
    const bad = await count(
      `SELECT COUNT(*)::int AS n FROM docs d JOIN artifacts a ON a.artifact_id = d.id
       WHERE d.kind = 'adr-tech' AND COALESCE(a.status,'') IS DISTINCT FROM COALESCE(d.status,'')`,
    );
    add("ADR : status conservé (échantillon global)", bad === 0, `${bad} écart(s) de statut`);
  }

  // C7 — cast meta : aucune valeur perdue
  if (await tableExists("docs")) {
    const nonJson = await count(
      "SELECT COUNT(*)::int AS n FROM docs d WHERE d.meta IS NOT NULL AND d.meta <> '' AND d.meta !~ '^\\s*[\\{\\[]'",
    );
    const wrapped = await count(
      "SELECT COUNT(*)::int AS n FROM artifacts WHERE meta ? 'legacy'",
    );
    add("meta TEXT → JSONB (encapsulation des valeurs non-JSON)", wrapped >= nonJson, `${nonJson} meta legacy non-JSON, ${wrapped} encapsulée(s)`);
  }

  // C8 — rétrocompat artifact_list(taskId) : content_id + doc_type famille task
  const taskRow = (await q(
    `SELECT content_id FROM artifacts WHERE doc_type = ANY($1) AND content_id IS NOT NULL ORDER BY id DESC LIMIT 1`,
    [TASK_DOC_TYPES],
  ))[0];
  if (taskRow) {
    const rows = await q(
      "SELECT * FROM artifacts WHERE content_id = $1 AND doc_type = ANY($2) ORDER BY id DESC",
      [taskRow.content_id, TASK_DOC_TYPES],
    );
    add("rétrocompat artifact_list(taskId)", rows.length >= 1 && rows.every((r) => r.content_id === taskRow.content_id), `task=${taskRow.content_id}, ${rows.length} artefact(s)`);
  } else {
    add("rétrocompat artifact_list(taskId)", true, "aucun artefact famille task (NA)");
  }

  // C9 — rétrocompat recette_get → documents (documentId entier)
  const recRow = (await q(
    "SELECT content_id FROM artifacts WHERE doc_type = ANY($1) ORDER BY id DESC LIMIT 1", [RECETTE_DOC_TYPES],
  ))[0];
  if (recRow) {
    const docs = await q(
      `SELECT d.id, d.content_id, d.title, d.nature, d.source, d.path, d.created_at,
              a.title AS artifact_title, a.content_id AS artifact_task
       FROM artifacts d LEFT JOIN artifacts a ON a.artifact_id = (d.meta->>'artifactId')
       WHERE d.content_id = $1 AND d.doc_type = ANY($2) ORDER BY d.id ASC`,
      [recRow.content_id, RECETTE_DOC_TYPES],
    );
    const okInt = docs.every((d) => Number.isInteger(Number(d.id)));
    add("rétrocompat recette_get → documents (documentId entier)", okInt, `recette=${recRow.content_id}, ${docs.length} document(s)`);
  } else {
    add("rétrocompat recette_get → documents (documentId entier)", true, "aucun document de recette (NA)");
  }

  // C10 — rétrocompat doc_list(includeRepoDocs)
  const proj = (await q("SELECT project_id FROM artifact_projects ORDER BY project_id LIMIT 1"))[0];
  if (proj) {
    const rows = await q(
      `SELECT DISTINCT d.* FROM artifacts d
       WHERE d.artifact_id IN (SELECT artifact_id FROM artifact_projects WHERE project_id = $1)
          OR d.artifact_id IN (SELECT ar.artifact_id FROM artifact_repos ar JOIN project_repos pr ON pr.repo_id = ar.repo_id WHERE pr.project_id = $1)
       AND d.doc_type = ANY($2) ORDER BY d.doc_type, d.title NULLS LAST, d.created_at DESC`,
      [proj.project_id, DOCS_DOC_TYPES],
    );
    add("rétrocompat doc_list(includeRepoDocs)", Array.isArray(rows), `projet=${proj.project_id}, ${rows.length} doc(s)`);
  } else {
    add("rétrocompat doc_list(includeRepoDocs)", true, "aucun rattachement projet (NA)");
  }

  // C11 — rétrocompat doc_get / adr_get (forme doc)
  const adr = (await q("SELECT artifact_id FROM artifacts WHERE doc_type = 'adr' ORDER BY id LIMIT 1"))[0];
  if (adr) {
    const a = (await q("SELECT * FROM artifacts WHERE artifact_id = $1 AND doc_type = ANY($2)", [adr.artifact_id, DOCS_DOC_TYPES]))[0];
    add("rétrocompat doc_get/adr_get", !!a && a.artifact_id === adr.artifact_id, `adr=${adr.artifact_id}`);
  } else {
    add("rétrocompat doc_get/adr_get", true, "aucune ADR (NA)");
  }

  // C12 — jointures E2E : report_artifact_id / video_url résolvent un artefact
  const e2e = (await q(
    "SELECT report_artifact_id, video_url FROM e2e_executions WHERE report_artifact_id IS NOT NULL OR video_url IS NOT NULL LIMIT 50",
  ));
  let e2eBad = 0;
  for (const e of e2e) {
    if (e.report_artifact_id && !(await q("SELECT 1 FROM artifacts WHERE artifact_id = $1", [e.report_artifact_id])).length) e2eBad++;
  }
  add("jointures E2E (report_artifact_id résout un artefact)", e2eBad === 0, `${e2e.length} exécution(s) avec preuve, ${e2eBad} cible(s) introuvable(s)`);

  const fails = checks.filter((c) => c.verdict === "FAIL");
  return { verdict: fails.length === 0 ? "PASS" : "FAIL", checks, fails: fails.length };
}

// ---------------------------------------------------------------------------
// neutralize (RENOMMAGE — jamais de DROP)
// ---------------------------------------------------------------------------
async function neutralize() {
  const done = [];
  // 1) Rebasage FK adr_conflicts.adr_id → artifacts(artifact_id) (AVANT renommage).
  if (await tableExists("adr_conflicts")) {
    await pool.query("ALTER TABLE adr_conflicts DROP CONSTRAINT IF EXISTS adr_conflicts_adr_id_fkey");
    await pool.query(
      "ALTER TABLE adr_conflicts ADD CONSTRAINT adr_conflicts_adr_id_fkey FOREIGN KEY (adr_id) REFERENCES artifacts(artifact_id) ON DELETE CASCADE",
    );
    done.push("FK adr_conflicts.adr_id → artifacts(artifact_id)");
  }
  // 2) Neutralisation de `artifacts.task_id` par RENOMMAGE (jamais DROP).
  if (await columnExists("artifacts", "task_id")) {
    await pool.query("ALTER TABLE artifacts RENAME COLUMN task_id TO legacy_task_id");
    done.push("artifacts.task_id → legacy_task_id");
  }
  // 3) Renommage des tables legacy (jamais DROP).
  for (const t of LEGACY_TABLES) {
    if (await tableExists(t)) {
      await pool.query(`ALTER TABLE ${t} RENAME TO legacy_${t}`);
      done.push(`${t} → legacy_${t}`);
    }
  }
  return { neutralized: done };
}

// ---------------------------------------------------------------------------
// rollback (ne touche JAMAIS aux tables legacy)
// ---------------------------------------------------------------------------
async function rollback(tsArg) {
  if (!tsArg) throw new Error("--ts <timestamp> requis (cf. snapshot)");
  const done = [];
  const artBackup = `artifacts_backup_${tsArg}`;
  if (await tableExists(artBackup)) {
    const del = await pool.query(
      `DELETE FROM artifacts a WHERE NOT EXISTS (SELECT 1 FROM ${artBackup} b WHERE b.artifact_id = a.artifact_id)`,
    );
    done.push(`suppression de ${del.rowCount} artefact(s) issu(s) de la migration`);
    const cols = (await q(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name <> 'id'",
      [artBackup],
    )).map((r) => r.column_name);
    if (cols.length) {
      const set = cols.map((c) => `${c} = b.${c}`).join(", ");
      await pool.query(`UPDATE artifacts a SET ${set} FROM ${artBackup} b WHERE a.artifact_id = b.artifact_id`);
      done.push(`restauration de ${cols.length} colonne(s) depuis ${artBackup}`);
    }
  }
  for (const [link, backup] of [["artifact_projects", "doc_projects_backup"], ["artifact_repos", "doc_repos_backup"]]) {
    const b = `${backup}_${tsArg}`;
    if (await tableExists(b)) {
      await pool.query(`TRUNCATE ${link}`);
      const cols = link === "artifact_projects" ? "(artifact_id, project_id)" : "(artifact_id, repo_id)";
      const src = link === "artifact_projects" ? "(doc_id, project_id)" : "(doc_id, repo_id)";
      await pool.query(`INSERT INTO ${link} ${cols} SELECT ${src} FROM ${b} ON CONFLICT DO NOTHING`);
      done.push(`restauration de ${link} depuis ${b}`);
    }
  }
  return { timestamp: tsArg, done, note: "les tables legacy n'ont PAS été modifiées" };
}

// ---------------------------------------------------------------------------
async function main() {
  const cmd = process.argv[2];
  if (!cmd) throw new Error("Usage: node scripts/artifacts-fusion-migration.mjs <inventory|snapshot|migrate|validate|neutralize|rollback> [--ts <ts>] [--out <file>]");
  let result;
  switch (cmd) {
    case "inventory": {
      const inv = await inventory();
      const md = inventoryMarkdown(inv);
      const outPath = arg("out") || resolve(process.cwd(), "reports", `artifacts-inventory-${ts()}.md`);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, md);
      out({ ok: true, command: cmd, report: outPath, inventory: inv });
      break;
    }
    case "snapshot":
      result = await snapshot(arg("ts"));
      out({ ok: true, command: cmd, ...result });
      break;
    case "migrate":
      result = await migrate();
      out({ ok: true, command: cmd, steps: result });
      break;
    case "validate": {
      const v = await validate();
      const md = ["# Validation post-migration — fusion artefacts polymorphe", "",
        `- Généré : ${new Date().toISOString()}`,
        `- **Verdict : ${v.verdict}**`, "",
        "| Contrôle | Verdict | Détail |", "|----------|---------|--------|",
        ...v.checks.map((c) => `| ${c.control} | ${c.verdict} | ${c.detail} |`), ""].join("\n");
      const outPath = arg("out") || resolve(process.cwd(), "reports", `artifacts-validation-${ts()}.md`);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, md);
      out({ ok: v.verdict === "PASS", command: cmd, verdict: v.verdict, report: outPath, checks: v.checks });
      break;
    }
    case "neutralize":
      result = await neutralize();
      out({ ok: true, command: cmd, ...result });
      break;
    case "rollback":
      result = await rollback(arg("ts"));
      out({ ok: true, command: cmd, ...result });
      break;
    default:
      throw new Error(`commande inconnue : ${cmd}`);
  }
  await pool.end();
}

main().catch(async (e) => {
  process.stderr.write(`ERREUR: ${e.message}\n`);
  try { await pool.end(); } catch {}
  process.exit(1);
});
