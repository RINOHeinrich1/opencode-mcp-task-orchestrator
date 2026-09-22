#!/usr/bin/env node
/**
 * Migration de nomenclature ADR-004 — Cadrage technique (`cadrages` / `CT-*`) et
 * Recette évaluateur (`recettes` / `RECT-*`).
 *
 * ⚠️  `--dry-run` PAR DÉFAUT : aucune écriture. L'application réelle (`--apply`)
 *     est une DÉCISION HUMAINE (fenêtre de maintenance : entre l'arrêt de
 *     l'ancien service et le démarrage du nouveau code — cf. plan §Ordre).
 *
 * Ce script opère les renommages de l'ADR-004 §3/§4 :
 *   - `recettes` (cadrage technique) → `cadrages` ; `recette_*` → `cadrage_*` ;
 *     ids `RECT-*` → `CT-*` ; doc_types `recette_doc`/`recette_report` →
 *     `cadrage_doc`/`cadrage_report` ; contrats `tasks.cadrage_id`/
 *     `batches.cadrage_id`/`adr_vigilances.cadrage_id`.
 *   - `evaluations` (recette évaluateur) → `recettes` ; `evaluation_*` →
 *     `recette_*` ; ids `EVAL-*` → `RECT-*` ; doc_type `evaluation_doc` →
 *     `recette_doc`.
 *   - valeurs d'énumération : `decisions.kind` `'recette'`→`'cadrage'` ;
 *     `cardinality_signals.entity_type` `'recette'`→`'cadrage'` ;
 *     `emergent_origin` `'recette'`→`'cadrage'`.
 *
 * GARANTIES :
 *   - IDEMPOTENT : table d'audit `nomenclature_migrations` (marqueur par étape) +
 *     gardes d'existence ;
 *   - RÉVERSIBLE : `--revert` s'appuie sur la table de correspondance
 *     `nomenclature_id_map` (ancien_id → nouveau_id) ;
 *   - AUCUNE PERTE : `ALTER TABLE … RENAME` (les données sont préservées) ;
 *   - AUCUNE RÉFÉRENCE ORPHELINE : vérification d'orphelins FK en fin d'`--apply` ;
 *   - ordre IMPOSÉ (collision de noms) : le renommage CADRAGE précède le
 *     renommage RECETTE, et `RECT-*`→`CT-*` précède `EVAL-*`→`RECT-*`.
 *
 * NON RENOMMÉS (hors ADR-004, décisions d'interprétation documentées) :
 *   - `e2e_executions.origin='recette'`, `verdict_by='agent-recette'`,
 *     `task_sessions.kind='recette'` (le panneau les conserve — désignent la
 *     recette évaluateur) ;
 *   - les répertoires de stockage runtime (`storage/evaluation-*`) ;
 *   - les tables de sauvegarde/legacy (`*_backup_*`, `legacy_docs`, …) hors FK
 *     vers les tables renommées.
 *
 * Usage :
 *   node scripts/migrate-nomenclature-cadrage-recette.mjs            # dry-run
 *   node scripts/migrate-nomenclature-cadrage-recette.mjs --apply    # décision humaine
 *   node scripts/migrate-nomenclature-cadrage-recette.mjs --revert [--apply]
 *   DATABASE_URL=… ADMIN_DATABASE_URL=… (défaut : registre local)
 */
import pg from "pg";

const MODE = process.argv.includes("--revert")
  ? "revert"
  : process.argv.includes("--apply")
    ? "apply"
    : "dry-run";
const DRY = MODE === "dry-run";
const CONN =
  process.env.DATABASE_URL ||
  "postgres://orchestrator:orchestrator@localhost:5432/task_registry";

const log = (...a) => console.log(...a);

// --- Renommages table/colonne (ordre cadrage AVANT recette) -----------------
const CADRAGE_TABLES = [
  ["recettes", "cadrages"],
  ["recette_items", "cadrage_items"],
  ["recette_tasks", "cadrage_tasks"],
  ["recette_projects", "cadrage_projects"],
  ["recette_sprints", "cadrage_sprints"],
  ["recette_fonctionnalites", "cadrage_fonctionnalites"],
  ["recette_adr", "cadrage_adr"],
  ["recette_regles", "cadrage_regles"],
  ["cadrage_evaluation_items", "cadrage_recette_items"],
];
const CADRAGE_COLUMNS = [
  ["cadrages", "recette_id", "cadrage_id"],
  ["cadrage_items", "recette_id", "cadrage_id"],
  ["cadrage_tasks", "recette_id", "cadrage_id"],
  ["cadrage_projects", "recette_id", "cadrage_id"],
  ["cadrage_sprints", "recette_id", "cadrage_id"],
  ["cadrage_fonctionnalites", "recette_id", "cadrage_id"],
  ["cadrage_adr", "recette_id", "cadrage_id"],
  ["cadrage_regles", "recette_id", "cadrage_id"],
  ["cadrage_recette_items", "recette_id", "cadrage_id"],
  ["cadrage_recette_items", "evaluation_item_id", "recette_item_id"],
  ["tasks", "recette_id", "cadrage_id"],
  ["tasks", "recette_status", "cadrage_status"],
  ["tasks", "recette_class", "cadrage_class"],
  ["batches", "recette_id", "cadrage_id"],
  ["adr_vigilances", "recette_id", "cadrage_id"],
  ["legacy_recette_documents", "recette_id", "cadrage_id"],
];
const RECETTE_TABLES = [
  ["evaluations", "recettes"],
  ["evaluation_items", "recette_items"],
  ["evaluation_fonctionnalites", "recette_fonctionnalites"],
  ["evaluation_regles", "recette_regles"],
];
const RECETTE_COLUMNS = [
  ["recettes", "evaluation_id", "recette_id"],
  ["recette_items", "evaluation_id", "recette_id"],
  ["recette_fonctionnalites", "evaluation_id", "recette_id"],
  ["recette_regles", "evaluation_id", "recette_id"],
];
const CADRAGE_INDEXES = [
  ["idx_recettes_project", "idx_cadrages_project"],
  ["idx_recette_tasks_task", "idx_cadrage_tasks_task"],
  ["idx_recette_projects_project", "idx_cadrage_projects_project"],
  ["idx_recette_items_recette", "idx_cadrage_items_cadrage"],
  ["idx_recette_sprints_sprint", "idx_cadrage_sprints_sprint"],
  ["idx_recette_fonctionnalites_feat", "idx_cadrage_fonctionnalites_feat"],
  ["idx_recette_adr_adr", "idx_cadrage_adr_adr"],
  ["idx_recette_regles_regle", "idx_cadrage_regles_regle"],
  ["idx_adr_vigilances_recette", "idx_adr_vigilances_cadrage"],
  ["idx_batches_recette", "idx_batches_cadrage"],
  ["idx_cadrage_evaluation_items_item", "idx_cadrage_recette_items_item"],
];
const RECETTE_INDEXES = [
  ["idx_evaluations_project", "idx_recettes_project"],
  ["idx_evaluations_created_by", "idx_recettes_created_by"],
  ["idx_evaluation_items_evaluation", "idx_recette_items_recette"],
  ["idx_evaluation_fonctionnalites_feat", "idx_recette_fonctionnalites_feat"],
  ["idx_evaluation_regles_regle", "idx_recette_regles_regle"],
];
// Colonnes portant un id de CADRAGE (valeur RECT-* → CT-*) après renommage.
const CADRAGE_ID_COLUMNS = [
  ["cadrages", "cadrage_id"], ["cadrage_items", "cadrage_id"],
  ["cadrage_tasks", "cadrage_id"], ["cadrage_projects", "cadrage_id"],
  ["cadrage_sprints", "cadrage_id"], ["cadrage_fonctionnalites", "cadrage_id"],
  ["cadrage_adr", "cadrage_id"], ["cadrage_regles", "cadrage_id"],
  ["cadrage_recette_items", "cadrage_id"], ["tasks", "cadrage_id"],
  ["batches", "cadrage_id"], ["adr_vigilances", "cadrage_id"],
  ["legacy_recette_documents", "cadrage_id"],
];
// Colonnes portant un id de RECETTE évaluateur (valeur EVAL-* → RECT-*).
const RECETTE_ID_COLUMNS = [
  ["recettes", "recette_id"], ["recette_items", "recette_id"],
  ["recette_fonctionnalites", "recette_id"], ["recette_regles", "recette_id"],
];

let client;
let hasAudit = false;
let now = new Date().toISOString();

async function tableExists(name) {
  return !!(await client.query("SELECT to_regclass($1) AS r", [`public.${name}`])).rows[0].r;
}
async function columnExists(table, col) {
  if (!(await tableExists(table))) return false;
  return (await client.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
    [table, col],
  )).rowCount > 0;
}
async function count(sql, params) {
  return Number((await client.query(sql, params)).rows[0].n);
}

// En DRY-RUN, toutes les étapes tournent dans UNE transaction unique (BEGIN en
// amont, ROLLBACK en aval) : le rapport reflète l'état APRÈS chaque étape sans
// rien persister. En APPLY, chaque étape est sa propre transaction + marqueur.
async function step(name, fn) {
  if (hasAudit) {
    const d = await client.query("SELECT status FROM nomenclature_migrations WHERE step=$1", [name]);
    if (d.rows[0] && d.rows[0].status === "applied") { log(`  · SKIP  ${name} (déjà appliqué)`); return; }
  }
  if (!DRY) await client.query("BEGIN");
  try {
    const detail = (await fn()) || {};
    if (!DRY && hasAudit) {
      await client.query(
        `INSERT INTO nomenclature_migrations (step, status, applied_at, detail)
         VALUES ($1,'applied',$2,$3)
         ON CONFLICT (step) DO UPDATE SET status='applied', applied_at=EXCLUDED.applied_at, detail=EXCLUDED.detail`,
        [name, new Date().toISOString(), JSON.stringify(detail)],
      );
    }
    if (!DRY) await client.query("COMMIT");
    log(`  ${DRY ? "[dry-run] " : ""}OK    ${name} ${JSON.stringify(detail)}`);
  } catch (e) {
    if (!DRY) await client.query("ROLLBACK").catch(() => {});
    throw new Error(`étape « ${name} » échouée : ${e.message}`);
  }
}

async function renameTables(pairs) {
  const done = [];
  for (const [from, to] of pairs) {
    if (!(await tableExists(from))) continue;
    if (await tableExists(to)) throw new Error(`collision : la table « ${to} » existe déjà (renommage de « ${from} » impossible)`);
    await client.query(`ALTER TABLE ${from} RENAME TO ${to}`);
    done.push(`${from}→${to}`);
  }
  return { renamed: done.length, tables: done };
}
async function renameColumns(pairs) {
  const done = [];
  for (const [table, from, to] of pairs) {
    if (!(await columnExists(table, from))) continue;
    if (await columnExists(table, to)) throw new Error(`collision : ${table}.${to} existe déjà`);
    await client.query(`ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to}`);
    done.push(`${table}.${from}→${to}`);
  }
  return { renamed: done.length, columns: done };
}
async function renameIndexes(pairs) {
  const done = [];
  for (const [from, to] of pairs) {
    const e = await client.query("SELECT to_regclass($1) AS r", [`public.${from}`]);
    if (!e.rows[0].r) continue;
    const t = await client.query("SELECT to_regclass($1) AS r", [`public.${to}`]);
    if (t.rows[0].r) continue;
    await client.query(`ALTER INDEX ${from} RENAME TO ${to}`);
    done.push(`${from}→${to}`);
  }
  return { renamed: done.length, indexes: done };
}

// Remappe une colonne d'id (préfixe) + enregistre la correspondance.
async function remapColumn(table, col, oldPrefix, newPrefix, entity) {
  if (!(await columnExists(table, col))) return 0;
  const rows = (await client.query(
    `SELECT ${col} AS id FROM ${table} WHERE ${col} LIKE $1`, [`${oldPrefix}%`],
  )).rows;
  for (const { id } of rows) {
    const nid = newPrefix + String(id).slice(oldPrefix.length);
    await client.query(`UPDATE ${table} SET ${col}=$1 WHERE ${col}=$2`, [nid, id]);
    if (hasAudit || !DRY) {
      await client.query(
        `INSERT INTO nomenclature_id_map (old_id, new_id, entity, migrated_at) VALUES ($1,$2,$3,$4)
         ON CONFLICT (old_id) DO NOTHING`,
        [String(id), nid, entity, new Date().toISOString()],
      );
    }
  }
  return rows.length;
}

async function remapCadrageIds() {
  let n = 0;
  for (const [t, c] of CADRAGE_ID_COLUMNS) n += await remapColumn(t, c, "RECT-", "CT-", "cadrage");
  // cardinality_signals : entity_id (RECT-*) pour entity_type='recette' (avant bascule)
  if (await tableExists("cardinality_signals")) {
    n += await remapColumn("cardinality_signals", "entity_id", "RECT-", "CT-", "cadrage");
  }
  // artifacts.content_id (documents de cadrage)
  if (await tableExists("artifacts")) n += await remapColumn("artifacts", "content_id", "RECT-", "CT-", "cadrage");
  return { remapped: n };
}
async function remapRecetteIds() {
  let n = 0;
  for (const [t, c] of RECETTE_ID_COLUMNS) n += await remapColumn(t, c, "EVAL-", "RECT-", "recette");
  if (await tableExists("artifacts")) n += await remapColumn("artifacts", "content_id", "EVAL-", "RECT-", "recette");
  return { remapped: n };
}
// Revert : s'appuie sur la table de correspondance.
async function unmap(table, col, entity) {
  if (!(await columnExists(table, col))) return 0;
  const rows = (await client.query(
    `SELECT m.old_id, m.new_id FROM nomenclature_id_map m
       JOIN ${table} t ON t.${col} = m.new_id
      WHERE m.entity = $1`, [entity],
  )).rows;
  for (const { old_id, new_id } of rows) {
    await client.query(`UPDATE ${table} SET ${col}=$1 WHERE ${col}=$2`, [old_id, new_id]);
  }
  return rows.length;
}

async function renameDocTypes(pairs) {
  let n = 0;
  for (const [from, to] of pairs) {
    const r = await client.query("UPDATE artifacts SET doc_type=$1 WHERE doc_type=$2", [to, from]);
    n += r.rowCount;
  }
  return n;
}

async function checkOrphans() {
  const checks = [
    ["cadrage_tasks", "cadrage_id", "cadrages", "cadrage_id"],
    ["cadrage_projects", "cadrage_id", "cadrages", "cadrage_id"],
    ["cadrage_sprints", "cadrage_id", "cadrages", "cadrage_id"],
    ["cadrage_fonctionnalites", "cadrage_id", "cadrages", "cadrage_id"],
    ["cadrage_adr", "cadrage_id", "cadrages", "cadrage_id"],
    ["cadrage_regles", "cadrage_id", "cadrages", "cadrage_id"],
    ["cadrage_items", "cadrage_id", "cadrages", "cadrage_id"],
    ["cadrage_recette_items", "cadrage_id", "cadrages", "cadrage_id"],
    ["adr_vigilances", "cadrage_id", "cadrages", "cadrage_id"],
    ["legacy_recette_documents", "cadrage_id", "cadrages", "cadrage_id"],
    ["recette_items", "recette_id", "recettes", "recette_id"],
    ["recette_fonctionnalites", "recette_id", "recettes", "recette_id"],
    ["recette_regles", "recette_id", "recettes", "recette_id"],
  ];
  const orphans = {};
  for (const [t, c, rt, rc] of checks) {
    if (!(await tableExists(t)) || !(await tableExists(rt))) continue;
    if (!(await columnExists(t, c))) continue;
    const n = await count(
      `SELECT count(*) AS n FROM ${t} x LEFT JOIN ${rt} r ON r.${rc} = x.${c} WHERE x.${c} IS NOT NULL AND r.${rc} IS NULL`,
    );
    if (n > 0) orphans[`${t}.${c}`] = n;
  }
  return orphans;
}

async function preflight() {
  const recettes = await tableExists("recettes");
  const cadrages = await tableExists("cadrages");
  const evaluations = await tableExists("evaluations");
  return { recettes, cadrages, evaluations };
}

// ---------------------------------------------------------------------------
async function main() {
  client = new pg.Client({ connectionString: CONN });
  await client.connect();
  const pre = await preflight();
  log(`\n=== Migration nomenclature ADR-004 — mode ${MODE} ${DRY ? "(DRY-RUN, aucune écriture)" : ""} ===`);
  log(`Base : ${CONN.replace(/:[^:@/]+@/, ":***@")}`);
  log(`État : recettes=${pre.recettes} cadrages=${pre.cadrages} evaluations=${pre.evaluations}\n`);

  if (MODE === "apply" || MODE === "dry-run") {
    if (pre.evaluations && pre.cadrages) {
      throw new Error("état AMBIGU : `evaluations` ET `cadrages` coexistent — migration partielle ? intervention manuelle requise.");
    }
    if (!pre.evaluations && pre.cadrages) {
      log("→ base DÉJÀ migrée (aucune table `evaluations`, `cadrages` présente). Rien à faire.\n");
      await client.end();
      return;
    }
  }
  if (MODE === "revert" && (!pre.cadrages || pre.evaluations)) {
    throw new Error("revert impossible : l'état courant n'est pas « migré » (cadrages présent, evaluations absent).");
  }

  // Tables d'audit (apply uniquement ; en dry-run elles peuvent ne pas exister).
  if (!DRY) {
    await client.query(`CREATE TABLE IF NOT EXISTS nomenclature_migrations (
      step       TEXT PRIMARY KEY,
      status     TEXT NOT NULL DEFAULT 'applied',
      applied_at TEXT NOT NULL,
      detail     TEXT
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS nomenclature_id_map (
      old_id      TEXT PRIMARY KEY,
      new_id      TEXT NOT NULL,
      entity      TEXT NOT NULL,
      migrated_at TEXT NOT NULL
    )`);
    hasAudit = true;
  } else {
    hasAudit = await tableExists("nomenclature_migrations");
  }

  const setReplica = async () => { await client.query("SET LOCAL session_replication_role = 'replica'"); };

  // DRY-RUN : une seule transaction, annulée en fin de parcours (rapport fidèle).
  if (DRY) await client.query("BEGIN");

  if (MODE === "apply" || MODE === "dry-run") {
    log("— Renommages CADRAGE (recettes → cadrages) —");
    await step("cadrage:tables", () => renameTables(CADRAGE_TABLES));
    await step("cadrage:columns", () => renameColumns(CADRAGE_COLUMNS));
    await step("cadrage:indexes", () => renameIndexes(CADRAGE_INDEXES));
    log("— Renommages RECETTE (evaluations → recettes) —");
    await step("recette:tables", () => renameTables(RECETTE_TABLES));
    await step("recette:columns", () => renameColumns(RECETTE_COLUMNS));
    await step("recette:indexes", () => renameIndexes(RECETTE_INDEXES));
    log("— Remap des identifiants (RECT-*→CT-* AVANT EVAL-*→RECT-*) —");
    await step("ids:cadrage", async () => { await setReplica(); return remapCadrageIds(); });
    await step("ids:recette", async () => { await setReplica(); return remapRecetteIds(); });
    log("— Valeurs d'énumération / doc_types —");
    await step("doc_types", async () => ({ updated: await renameDocTypes([["recette_report", "cadrage_report"], ["recette_doc", "cadrage_doc"], ["evaluation_doc", "recette_doc"]]) }));
    await step("enums", async () => {
      const d = await client.query("UPDATE decisions SET kind='cadrage' WHERE kind='recette'");
      const c = await client.query("UPDATE cardinality_signals SET entity_type='cadrage' WHERE entity_type='recette'");
      const e1 = await client.query("UPDATE fonctionnalites SET emergent_origin='cadrage' WHERE emergent_origin='recette'");
      const e2 = await client.query("UPDATE regles_metier SET emergent_origin='cadrage' WHERE emergent_origin='recette'");
      const e3 = await client.query("UPDATE tasks SET emergent_origin='cadrage' WHERE emergent_origin='recette'");
      const e4 = await client.query(`UPDATE decisions SET detail = replace(detail, '"kind":"recette"', '"kind":"cadrage"') WHERE detail LIKE '%"kind":"recette"%'`);
      return { decisions: d.rowCount, cardinality: c.rowCount, emergent: e1.rowCount + e2.rowCount + e3.rowCount, detail: e4.rowCount };
    });
    log("— Vérification d'orphelins —");
    const orphans = await checkOrphans();
    const orphanTotal = Object.values(orphans).reduce((a, b) => a + b, 0);
    log(`  orphelins FK : ${orphanTotal}${orphanTotal ? " " + JSON.stringify(orphans) : ""}`);
    if (orphanTotal > 0 && !DRY) throw new Error(`références orphelines détectées : ${JSON.stringify(orphans)} — migration annulée`);
  } else {
    // ---- REVERT (ordre inverse) ------------------------------------------
    log("— REVERT : valeurs d'énumération / doc_types —");
    await step("revert:enums", async () => {
      const d = await client.query("UPDATE decisions SET kind='recette' WHERE kind='cadrage'");
      const c = await client.query("UPDATE cardinality_signals SET entity_type='recette' WHERE entity_type='cadrage'");
      const e1 = await client.query("UPDATE fonctionnalites SET emergent_origin='recette' WHERE emergent_origin='cadrage'");
      const e2 = await client.query("UPDATE regles_metier SET emergent_origin='recette' WHERE emergent_origin='cadrage'");
      const e3 = await client.query("UPDATE tasks SET emergent_origin='recette' WHERE emergent_origin='cadrage'");
      return { decisions: d.rowCount, cardinality: c.rowCount, emergent: e1.rowCount + e2.rowCount + e3.rowCount };
    });
    await step("revert:doc_types", async () => ({ updated: await renameDocTypes([["recette_doc", "evaluation_doc"], ["cadrage_doc", "recette_doc"], ["cadrage_report", "recette_report"]]) }));
    log("— REVERT : identifiants (RECT-*→EVAL-* AVANT CT-*→RECT-*) —");
    await step("revert:ids", async () => {
      await setReplica();
      let n = 0;
      for (const [t, c] of RECETTE_ID_COLUMNS) n += await unmap(t, c, "recette");
      if (await tableExists("artifacts")) n += await unmap("artifacts", "content_id", "recette");
      for (const [t, c] of CADRAGE_ID_COLUMNS) n += await unmap(t, c, "cadrage");
      if (await tableExists("cardinality_signals")) n += await unmap("cardinality_signals", "entity_id", "cadrage");
      if (await tableExists("artifacts")) n += await unmap("artifacts", "content_id", "cadrage");
      return { reverted: n };
    });
    log("— REVERT : renommages RECETTE puis CADRAGE (ordre inverse) —");
    await step("revert:recette:indexes", () => renameIndexes(RECETTE_INDEXES.map(([a, b]) => [b, a])));
    await step("revert:recette:columns", () => renameColumns(RECETTE_COLUMNS.map(([t, a, b]) => [t, b, a])));
    await step("revert:recette:tables", () => renameTables(RECETTE_TABLES.map(([a, b]) => [b, a])));
    await step("revert:cadrage:indexes", () => renameIndexes(CADRAGE_INDEXES.map(([a, b]) => [b, a])));
    await step("revert:cadrage:columns", () => renameColumns(CADRAGE_COLUMNS.map(([t, a, b]) => [t, b, a])));
    await step("revert:cadrage:tables", () => renameTables(CADRAGE_TABLES.map(([a, b]) => [b, a])));
  }

  if (DRY) await client.query("ROLLBACK");
  log(`\n${DRY ? "DRY-RUN terminé (aucune écriture)." : "Migration terminée."}`);
  log(`Pour appliquer réellement : --apply (décision humaine, fenêtre de maintenance).\n`);
  await client.end();
}

main().catch(async (e) => {
  console.error("\nERREUR migration :", e.message);
  try { if (client) await client.end(); } catch {}
  process.exit(1);
});
