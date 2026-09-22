#!/usr/bin/env node
// Test de migration ADR-004 — base PostgreSQL JETABLE (créée puis supprimée).
//
// Vérifie `scripts/migrate-nomenclature-cadrage-recette.mjs` :
//   1. `--dry-run` (défaut) : AUCUNE écriture (schéma legacy intact) ;
//   2. `--apply` : renommages `recettes→cadrages` / `evaluations→recettes`,
//      colonnes `cadrage_*`, ids `RECT-*→CT-*` et `EVAL-*→RECT-*`,
//      doc_types, `decisions.kind='cadrage'`, `cardinality_signals.entity_type`,
//      correspondance `nomenclature_id_map`, ORPHELINS FK = 0 ;
//   3. `--revert` : retour à l'état initial (données + ids + doc_types + kind).
//
// Le schéma LEGACY est rejoué depuis `git show <BASE>:schema.sql` (le schéma
// d'AVANT la nomenclature) : le test est donc indépendant du schéma courant.
//
// Usage : node scripts/test-migrate-nomenclature.mjs
//   BASE sha surchargeable par NOMENCLATURE_BASE_SHA (défaut 8a66dc5).
import pg from "pg";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const SCRIPT = join(__dirname, "migrate-nomenclature-cadrage-recette.mjs");
const BASE_SHA = process.env.NOMENCLATURE_BASE_SHA || "8a66dc5";

const ADMIN_URL =
  process.env.ADMIN_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "postgres://orchestrator:orchestrator@localhost:5432/task_registry";
const dbName = `task_registry_mignom_${Date.now().toString(36)}_${process.pid}`;
const conn = (() => { const u = new URL(ADMIN_URL); u.pathname = `/${dbName}`; return u.toString(); })();

let failures = 0;
const results = [];
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n        attendu: ${e}\n        obtenu : ${a}`}`);
}
const q = async (c, sql, params) => (await c.query(sql, params)).rows;
const n1 = async (c, sql, params) => Number((await c.query(sql, params)).rows[0].n);

async function main() {
  // --- Schéma LEGACY (d'avant la nomenclature) ----------------------------
  const oldSchema = execFileSync("git", ["show", `${BASE_SHA}:schema.sql`], { cwd: repoRoot, encoding: "utf8" });

  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const c = new pg.Client({ connectionString: conn });
  await c.connect();

  // 1) Applique le schéma legacy.
  await c.query(oldSchema);
  // 2) Seed legacy (cadrage `RECT-*` + recette évaluateur `EVAL-*`).
  const ts = new Date().toISOString();
  await c.query("INSERT INTO projects (id,name,main_branch,created_at) VALUES ('p1','P','main',$1)", [ts]);
  await c.query("INSERT INTO tasks (id,request,project,created_at,recette_status,recette_class,recette_id) VALUES ('T-LEG-1','r','p1',$1,'pending','rework','RECT-leg-0001')", [ts]);
  await c.query("INSERT INTO fonctionnalites (id,project,ref,user_story,created_at) VALUES ('FEAT-1','p1','US-1','x',$1)", [ts]);
  await c.query("INSERT INTO regles_metier (id,project,ref,content,roles,created_at) VALUES ('RMET-1','p1','RM-1','r',ARRAY['dev'],$1)", [ts]);
  await c.query("INSERT INTO sprints (id,project,title,status,created_at) VALUES ('SPR-1','p1','S','open',$1)", [ts]);
  // Cadrage technique legacy
  await c.query("INSERT INTO recettes (recette_id,project,title,status,created_at) VALUES ('RECT-leg-0001','p1','Cadrage legacy','done',$1)", [ts]);
  await c.query("INSERT INTO recette_items (recette_id,project,content,created_at) VALUES ('RECT-leg-0001','p1','élément cadrage',$1)", [ts]);
  await c.query("INSERT INTO recette_tasks (recette_id,task_id) VALUES ('RECT-leg-0001','T-LEG-1')");
  await c.query("INSERT INTO recette_sprints (recette_id,sprint_id) VALUES ('RECT-leg-0001','SPR-1')");
  await c.query("INSERT INTO recette_fonctionnalites (recette_id,fonctionnalite_id) VALUES ('RECT-leg-0001','FEAT-1')");
  await c.query("INSERT INTO recette_regles (recette_id,regle_id) VALUES ('RECT-leg-0001','RMET-1')");
  // Recette évaluateur legacy
  await c.query("INSERT INTO evaluations (evaluation_id,project,title,status,created_at,created_by) VALUES ('EVAL-leg-0002','p1','Recette legacy','pending',$1,'u')", [ts]);
  const evItem = (await c.query("INSERT INTO evaluation_items (evaluation_id,content,created_at) VALUES ('EVAL-leg-0002','problème',$1) RETURNING id", [ts])).rows[0].id;
  await c.query("INSERT INTO evaluation_fonctionnalites (evaluation_id,fonctionnalite_id) VALUES ('EVAL-leg-0002','FEAT-1')");
  await c.query("INSERT INTO evaluation_regles (evaluation_id,regle_id) VALUES ('EVAL-leg-0002','RMET-1')");
  await c.query("INSERT INTO cadrage_evaluation_items (recette_id,evaluation_item_id,created_at) VALUES ('RECT-leg-0001',$1,$2)", [evItem, ts]);
  // Artefacts (docs cadrage + recette) — doc_types legacy.
  await c.query("INSERT INTO artifacts (artifact_id,doc_type,content_id,kind,source,created_at) VALUES ('ART-REC-1','recette_doc','RECT-leg-0001','autre','import',$1)", [ts]);
  await c.query("INSERT INTO artifacts (artifact_id,doc_type,content_id,kind,source,created_at) VALUES ('ART-EVAL-1','evaluation_doc','EVAL-leg-0002','autre','import',$1)", [ts]);
  // Contrats
  await c.query("INSERT INTO batches (id,project,title,recette_id,created_at) VALUES ('BATCH-1','p1','B','RECT-leg-0001',$1)", [ts]);
  await c.query("INSERT INTO adr_vigilances (vigilance_id,project,recette_id,type,status,description,created_at) VALUES ('adr-vig-1','p1','RECT-leg-0001','missing','open','d',$1)", [ts]);
  await c.query("INSERT INTO decisions (decision_id,task_id,kind,status,requested_at) VALUES ('DEC-1','T-LEG-1','recette','awaiting',$1)", [ts]);
  await c.query("INSERT INTO cardinality_signals (signal_id,project,entity_type,entity_id,missing,status,created_at) VALUES ('card-1','p1','recette','RECT-leg-0001','sprint','open',$1)", [ts]);

  const runMig = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { env: { ...process.env, DATABASE_URL: conn }, encoding: "utf8" });

  // --- 1. DRY-RUN (aucune écriture) ---------------------------------------
  const dry = runMig([]);
  check("dry-run code 0", dry.status, 0);
  check("dry-run : `cadrages` NON créé", await n1(c, "SELECT count(*) n FROM information_schema.tables WHERE table_schema='public' AND table_name='cadrages'"), 0);
  check("dry-run : `recettes` (cadrage) intacte", await n1(c, "SELECT count(*) n FROM recettes"), 1);
  check("dry-run : colonne tasks.recette_id intacte", await n1(c, "SELECT count(*) n FROM information_schema.columns WHERE table_name='tasks' AND column_name='recette_id'"), 1);
  check("dry-run : id RECT- intact", await n1(c, "SELECT count(*) n FROM recettes WHERE recette_id='RECT-leg-0001'"), 1);
  check("dry-run : doc_type recette_doc intact", await n1(c, "SELECT count(*) n FROM artifacts WHERE doc_type='recette_doc'"), 1);
  check("dry-run : aucune table d'audit créée", await n1(c, "SELECT count(*) n FROM information_schema.tables WHERE table_schema='public' AND table_name='nomenclature_migrations'"), 0);

  // --- 2. APPLY -----------------------------------------------------------
  const apply = runMig(["--apply"]);
  check("apply code 0", apply.status, 0);
  check("apply : `cadrages` créée", await n1(c, "SELECT count(*) n FROM information_schema.tables WHERE table_schema='public' AND table_name='cadrages'"), 1);
  check("apply : `recettes` (recette évaluateur) créée", await n1(c, "SELECT count(*) n FROM recettes"), 1);
  check("apply : plus de table `evaluations`", await n1(c, "SELECT count(*) n FROM information_schema.tables WHERE table_schema='public' AND table_name='evaluations'"), 0);
  check("apply : `cadrage_items` présente", await n1(c, "SELECT count(*) n FROM information_schema.tables WHERE table_schema='public' AND table_name='cadrage_items'"), 1);
  check("apply : `cadrage_recette_items` présente", await n1(c, "SELECT count(*) n FROM information_schema.tables WHERE table_schema='public' AND table_name='cadrage_recette_items'"), 1);
  check("apply : colonnes contrats `cadrage_*`", await q(c, "SELECT column_name FROM information_schema.columns WHERE table_name='tasks' AND column_name IN ('cadrage_id','cadrage_status','cadrage_class') ORDER BY 1"), [{ column_name: "cadrage_class" }, { column_name: "cadrage_id" }, { column_name: "cadrage_status" }]);
  check("apply : cadrage id CT-*", await n1(c, "SELECT count(*) n FROM cadrages WHERE cadrage_id='CT-leg-0001'"), 1);
  check("apply : recette id RECT-*", await n1(c, "SELECT count(*) n FROM recettes WHERE recette_id='RECT-leg-0002'"), 1);
  check("apply : plus d'id RECT- côté cadrage", await n1(c, "SELECT count(*) n FROM cadrages WHERE cadrage_id LIKE 'RECT-%'"), 0);
  check("apply : plus d'id EVAL-", await n1(c, "SELECT count(*) n FROM recettes WHERE recette_id LIKE 'EVAL-%'"), 0);
  check("apply : tasks.cadrage_id remappé", await q(c, "SELECT cadrage_id FROM tasks WHERE id='T-LEG-1'"), [{ cadrage_id: "CT-leg-0001" }]);
  check("apply : batches.cadrage_id remappé", await q(c, "SELECT cadrage_id FROM batches WHERE id='BATCH-1'"), [{ cadrage_id: "CT-leg-0001" }]);
  check("apply : adr_vigilances.cadrage_id remappé", await q(c, "SELECT cadrage_id FROM adr_vigilances WHERE vigilance_id='adr-vig-1'"), [{ cadrage_id: "CT-leg-0001" }]);
  check("apply : artifacts.content_id remappés", await q(c, "SELECT content_id FROM artifacts ORDER BY artifact_id"), [{ content_id: "RECT-leg-0002" }, { content_id: "CT-leg-0001" }]);
  check("apply : doc_types migrés", await q(c, "SELECT doc_type FROM artifacts ORDER BY artifact_id"), [{ doc_type: "recette_doc" }, { doc_type: "cadrage_doc" }]);
  check("apply : decisions.kind='cadrage'", await q(c, "SELECT kind FROM decisions WHERE decision_id='DEC-1'"), [{ kind: "cadrage" }]);
  check("apply : cardinality entity_type='cadrage' + id CT-", await q(c, "SELECT entity_type, entity_id FROM cardinality_signals WHERE signal_id='card-1'"), [{ entity_type: "cadrage", entity_id: "CT-leg-0001" }]);
  check("apply : cadrage_items conservés (1)", await n1(c, "SELECT count(*) n FROM cadrage_items"), 1);
  check("apply : liens cadrage conservés", { t: await n1(c, "SELECT count(*) n FROM cadrage_tasks"), f: await n1(c, "SELECT count(*) n FROM cadrage_fonctionnalites"), r: await n1(c, "SELECT count(*) n FROM cadrage_regles") }, { t: 1, f: 1, r: 1 });
  check("apply : recette_items conservés (1)", await n1(c, "SELECT count(*) n FROM recette_items"), 1);
  check("apply : cadrage_recette_items conservé (1)", await n1(c, "SELECT count(*) n FROM cadrage_recette_items"), 1);
  check("apply : correspondance id_map (2 entités)", await q(c, "SELECT old_id,new_id,entity FROM nomenclature_id_map ORDER BY old_id"), [{ old_id: "EVAL-leg-0002", new_id: "RECT-leg-0002", entity: "recette" }, { old_id: "RECT-leg-0001", new_id: "CT-leg-0001", entity: "cadrage" }]);
  check("apply : audit des étapes (>=10)", (await n1(c, "SELECT count(*) n FROM nomenclature_migrations WHERE status='applied'")) >= 10, true);
  // Orphelins FK = 0
  const orphanChecks = [
    ["cadrage_tasks", "cadrage_id", "cadrages", "cadrage_id"],
    ["cadrage_fonctionnalites", "cadrage_id", "cadrages", "cadrage_id"],
    ["cadrage_regles", "cadrage_id", "cadrages", "cadrage_id"],
    ["cadrage_items", "cadrage_id", "cadrages", "cadrage_id"],
    ["cadrage_recette_items", "cadrage_id", "cadrages", "cadrage_id"],
    ["adr_vigilances", "cadrage_id", "cadrages", "cadrage_id"],
    ["recette_items", "recette_id", "recettes", "recette_id"],
    ["recette_fonctionnalites", "recette_id", "recettes", "recette_id"],
    ["recette_regles", "recette_id", "recettes", "recette_id"],
  ];
  let orphanTotal = 0;
  for (const [t, cc, rt, rc] of orphanChecks) {
    orphanTotal += await n1(c, `SELECT count(*) n FROM ${t} x LEFT JOIN ${rt} r ON r.${rc}=x.${cc} WHERE x.${cc} IS NOT NULL AND r.${rc} IS NULL`);
  }
  check("apply : orphelins FK = 0", orphanTotal, 0);

  // --- 3. APPLY idempotent ------------------------------------------------
  const apply2 = runMig(["--apply"]);
  check("apply (2e) code 0 (idempotent)", apply2.status, 0);
  check("apply (2e) : cadrage id toujours CT-", await n1(c, "SELECT count(*) n FROM cadrages WHERE cadrage_id='CT-leg-0001'"), 1);

  // --- 4. REVERT ----------------------------------------------------------
  const rev = runMig(["--revert", "--apply"]);
  check("revert code 0", rev.status, 0);
  check("revert : `recettes` (cadrage) restaurée", await n1(c, "SELECT count(*) n FROM information_schema.tables WHERE table_schema='public' AND table_name='recettes'"), 1);
  check("revert : `evaluations` restaurée", await n1(c, "SELECT count(*) n FROM information_schema.tables WHERE table_schema='public' AND table_name='evaluations'"), 1);
  check("revert : plus de `cadrages`", await n1(c, "SELECT count(*) n FROM information_schema.tables WHERE table_schema='public' AND table_name='cadrages'"), 0);
  check("revert : id RECT- (cadrage) restauré", await n1(c, "SELECT count(*) n FROM recettes WHERE recette_id='RECT-leg-0001'"), 1);
  check("revert : id EVAL- (recette) restauré", await n1(c, "SELECT count(*) n FROM evaluations WHERE evaluation_id='EVAL-leg-0002'"), 1);
  check("revert : tasks.recette_id restauré", await n1(c, "SELECT count(*) n FROM information_schema.columns WHERE table_name='tasks' AND column_name='recette_id'"), 1);
  check("revert : doc_types restaurés", await q(c, "SELECT doc_type FROM artifacts ORDER BY artifact_id"), [{ doc_type: "evaluation_doc" }, { doc_type: "recette_doc" }]);
  check("revert : decisions.kind='recette'", await q(c, "SELECT kind FROM decisions WHERE decision_id='DEC-1'"), [{ kind: "recette" }]);

  await c.end();
  const drop = new pg.Client({ connectionString: ADMIN_URL });
  await drop.connect();
  await drop.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()", [dbName]);
  await drop.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await drop.end();

  console.log(`\n=== Test migration nomenclature (base jetable ${dbName}) ===`);
  for (const l of results) console.log(l);
  console.log(`\n${failures === 0 ? "OK" : "ÉCHEC"} — ${results.length - failures}/${results.length} assertions passées`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("ERREUR test migration :", e?.stack || e); process.exit(1); });
