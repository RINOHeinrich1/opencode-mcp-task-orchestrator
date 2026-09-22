#!/usr/bin/env node
// Test de non-régression — SUPPRESSION d'une CADRAGE ENTIÈRE (cadrage technique)
// + nettoyage en CASCADE de sa famille polymorphe (T-20260922-100651-vq5c).
//
// Vérifie que `deleteCadrage(cadrageId)` :
//   1. supprime la cadrage ET tous ses liens/éléments : cadrage_items,
//      cadrage_tasks, cadrage_sprints/_fonctionnalites/_regles/_adr/_projects,
//      cadrage_recette_items, adr_vigilances, artifacts (cadrage_doc) ;
//   2. NE SUPPRIME PAS les objets rattachés : la tâche couverte et l'élément
//      d'évaluation RESTENT (seuls les liens disparaissent) ;
//   3. détache les batches liés (`batches.cadrage_id → NULL`, aucune FK) et
//      nettoie les signaux de cardinalité `open` de la cadrage (aucun orphelin) ;
//   4. ne touche PAS les autres cadrages (non-régression) ;
//   5. retourne `null` pour une cadrage inconnue (miroir deleteSprint).
//
// Le test s'exécute dans une base PostgreSQL DÉDIÉE et JETABLE (créée puis
// supprimée par le process parent ; les assertions tournent dans un process
// enfant pour que ses connexions soient fermées avant le DROP) : aucune donnée
// du registre réel n'est touchée.
//
// Usage : node scripts/test-delete-cadrage.mjs
//   (ADMIN_DATABASE_URL surcharge l'URL admin ; défaut = DATABASE_URL global)
import pg from "pg";
import { spawnSync } from "node:child_process";

const ADMIN_URL =
  process.env.ADMIN_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "postgres://orchestrator:orchestrator@localhost:5432/task_registry";

const testDbName = `task_registry_delcadrage_${Date.now().toString(36)}_${process.pid}`;
const testConnString = (() => {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${testDbName}`;
  return u.toString();
})();

// ---------------------------------------------------------------------------
// Mode ENFANT : assertions sur la base jetable (DATABASE_URL déjà positionnée).
// ---------------------------------------------------------------------------
async function childMain() {
  const db = await import("../db.mjs");
  await db.listProjectCadrages(null); // force ensureSchema

  const projectId = "del-cadrage-test";
  const ts = new Date().toISOString();
  const setup = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await setup.connect();
  await setup.query(
    "INSERT INTO projects (id, name, main_branch, created_at) VALUES ($1,$2,$3,$4)",
    [projectId, "Suppression cadrage test project", "main", ts],
  );

  const results = [];
  let failures = 0;
  function check(name, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    const ok = a === e;
    if (!ok) failures += 1;
    results.push(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n        attendu: ${e}\n        obtenu : ${a}`}`);
  }
  const sqlCount = async (sql, params) => Number((await setup.query(sql, params)).rows[0].n);

  // -------------------------------------------------------------------------
  // 0. Contexte : projet, tâche, fonctionnalité, règle, ADR, sprint.
  // -------------------------------------------------------------------------
  await db.createTask({ id: "T-DELREC-1", executionId: "E-DELREC-1", request: "tâche couverte", project: projectId });
  const feat = await db.registerFeature({ projectId, ref: "US-DEL-1", userStory: "comportement" });
  const rule = await db.registerRule({ projectId, ref: "RM-DEL-1", content: "règle", roleGlobal: true });
  const adr = await db.registerAdr({ projectId, title: "ADR test", path: "/tmp/adr-test.md", status: "Accepté" });
  const sprint = await db.createSprint({ projectId, title: "Sprint test" });
  const sprintId = sprint.sprint.id;

  // -------------------------------------------------------------------------
  // 1. Cadrage CIBLE + toute sa famille polymorphe.
  // -------------------------------------------------------------------------
  const target = await db.startCadrage({
    project: projectId,
    title: "Cadrage cible (doublon)",
    taskIds: ["T-DELREC-1"],
    sprintId: sprintId,
    featureIds: [feat.id],
    ruleIds: [rule.id],
    adrIds: [adr.docId],
  });
  check("cadrage cible créée", !!target.cadrageId, true);

  await db.addCadrageItem({ cadrageId: target.cadrageId, content: "élément de test" });
  await db.addCadrageDocument({ cadrageId: target.cadrageId, title: "doc test", nature: "annexe" });
  await db.reportAdrMissing({ cadrageId: target.cadrageId, entity: "entité test", description: "ADR manquante (test)" });

  const ev = await db.startRecette({ project: projectId, title: "Évaluation test" });
  const evItem = await db.addRecetteItem({ recetteId: ev.recetteId, content: "problème test", category: "probleme", severity: "low" });
  await db.setRecetteItemDecision({ itemId: evItem.itemId, decision: "a_traiter" });
  await db.linkCadrageRecetteItem({ cadrageId: target.cadrageId, itemId: evItem.itemId });

  const batch = await db.createBatch({ project: projectId, title: "Batch test", cadrageId: target.cadrageId });

  const before = await db.getCadrageById(target.cadrageId);
  check("famille avant suppression : items/tasks/docs/vigilances/éval", {
    items: before.items.length, tasks: before.tasks.length, docs: before.documents.length,
    vig: before.adrVigilances.length, eval: before.recetteItems.length,
    sprints: before.sprints.length, features: before.fonctionnalites.length,
    rules: before.regles.length, adrs: before.adrs.length,
  }, { items: 1, tasks: 1, docs: 1, vig: 1, eval: 1, sprints: 1, features: 1, rules: 1, adrs: 1 });

  // Cadrage de CONTRÔLE (ne doit pas être touchée).
  const control = await db.startCadrage({ project: projectId, title: "Cadrage contrôle" });

  // -------------------------------------------------------------------------
  // 2. SUPPRESSION + comptes détachés retournés.
  // -------------------------------------------------------------------------
  const res = await db.deleteCadrage(target.cadrageId);
  check("deleteCadrage → deleted:true", { deleted: res.deleted, cadrageId: res.cadrageId }, { deleted: true, cadrageId: target.cadrageId });
  check("detached : items/tasks/docs/vigilances/éval", {
    items: res.detached.items, tasks: res.detached.tasks, documents: res.detached.documents,
    vigilances: res.detached.vigilances, recetteItems: res.detached.recetteItems,
  }, { items: 1, tasks: 1, documents: 1, vigilances: 1, recetteItems: 1 });
  check("detached : liens sprint/feature/règle/ADR", {
    sprints: res.detached.sprints, features: res.detached.fonctionnalites,
    rules: res.detached.regles, adrs: res.detached.adrs,
  }, { sprints: 1, features: 1, rules: 1, adrs: 1 });
  check("detached : batch détaché", res.detached.batchesDetached, 1);

  // -------------------------------------------------------------------------
  // 3. Cadrage disparue + AUCUN résidu de sa famille (SQL direct).
  // -------------------------------------------------------------------------
  check("getCadrageById(cible) → null", await db.getCadrageById(target.cadrageId), null);
  check("cadrages cible supprimée", await sqlCount("SELECT count(*) AS n FROM cadrages WHERE cadrage_id = $1", [target.cadrageId]), 0);
  check("cadrage_items nettoyés", await sqlCount("SELECT count(*) AS n FROM cadrage_items WHERE cadrage_id = $1", [target.cadrageId]), 0);
  check("cadrage_tasks nettoyés", await sqlCount("SELECT count(*) AS n FROM cadrage_tasks WHERE cadrage_id = $1", [target.cadrageId]), 0);
  check("cadrage_sprints nettoyés", await sqlCount("SELECT count(*) AS n FROM cadrage_sprints WHERE cadrage_id = $1", [target.cadrageId]), 0);
  check("cadrage_fonctionnalites nettoyés", await sqlCount("SELECT count(*) AS n FROM cadrage_fonctionnalites WHERE cadrage_id = $1", [target.cadrageId]), 0);
  check("cadrage_regles nettoyés", await sqlCount("SELECT count(*) AS n FROM cadrage_regles WHERE cadrage_id = $1", [target.cadrageId]), 0);
  check("cadrage_adr nettoyés", await sqlCount("SELECT count(*) AS n FROM cadrage_adr WHERE cadrage_id = $1", [target.cadrageId]), 0);
  check("artifacts cadrage_doc nettoyés", await sqlCount("SELECT count(*) AS n FROM artifacts WHERE content_id = $1 AND doc_type = ANY($2)", [target.cadrageId, db.CADRAGE_DOC_TYPES]), 0);
  check("adr_vigilances liés nettoyés", await sqlCount("SELECT count(*) AS n FROM adr_vigilances WHERE cadrage_id = $1", [target.cadrageId]), 0);
  check("cadrage_recette_items nettoyés", await sqlCount("SELECT count(*) AS n FROM cadrage_recette_items WHERE cadrage_id = $1", [target.cadrageId]), 0);
  check("cardinality_signals open nettoyés", await sqlCount("SELECT count(*) AS n FROM cardinality_signals WHERE entity_type = 'cadrage' AND entity_id = $1 AND status = 'open'", [target.cadrageId]), 0);
  check("batch détaché (cadrage_id NULL)", await sqlCount("SELECT count(*) AS n FROM batches WHERE id = $1 AND cadrage_id IS NULL", [batch.batchId]), 1);

  // -------------------------------------------------------------------------
  // 4. OBJETS RATTACHÉS CONSERVÉS (seuls les liens ont disparu).
  // -------------------------------------------------------------------------
  check("tâche couverte conservée", !!(await db.getTask("T-DELREC-1")), true);
  const evAfter = await db.getRecetteById(ev.recetteId);
  check("évaluation + son élément conservés", evAfter.items.length, 1);

  // -------------------------------------------------------------------------
  // 5. NON-RÉGRESSION : la cadrage de contrôle reste intacte ; inconnue → null.
  // -------------------------------------------------------------------------
  check("cadrage contrôle intacte", !!(await db.getCadrageById(control.cadrageId)), true);
  check("deleteCadrage(inconnue) → null", await db.deleteCadrage("CT-inexistante-0000"), null);

  await setup.end();

  console.log(`\n=== Test non-régression — suppression cadrage entière (db jetable ${testDbName}) ===`);
  for (const line of results) console.log(line);
  console.log(`\n${failures === 0 ? "OK" : "ÉCHEC"} — ${results.length - failures}/${results.length} assertions passées`);
  process.exit(failures === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Mode PARENT : crée la base jetable, lance l'enfant, puis la supprime.
// ---------------------------------------------------------------------------
async function parentMain() {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${testDbName}`);
  await admin.end();

  const res = spawnSync(process.execPath, [new URL(import.meta.url).pathname], {
    env: { ...process.env, DELCADRAGE_CHILD: "1", DATABASE_URL: testConnString },
    stdio: "inherit",
  });

  const cleanup = new pg.Client({ connectionString: ADMIN_URL });
  await cleanup.connect();
  await cleanup.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
    [testDbName],
  );
  await cleanup.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`);
  await cleanup.end();

  process.exit(res.status === 0 ? 0 : 1);
}

if (process.env.DELCADRAGE_CHILD === "1") {
  childMain().catch((err) => {
    console.error("ERREUR test suppression cadrage (enfant) :", err?.stack || err?.message || err);
    process.exit(1);
  });
} else {
  parentMain().catch((err) => {
    console.error("ERREUR test suppression cadrage (parent) :", err?.stack || err?.message || err);
    process.exit(1);
  });
}
