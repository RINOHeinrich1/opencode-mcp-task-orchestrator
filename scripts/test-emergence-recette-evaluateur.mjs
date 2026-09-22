#!/usr/bin/env node
// Test de non-régression — ÉMERGENCE d'origine `recette` via le signal
// `fromRecette` (fonctionnalité / règle métier créée depuis une recette
// évaluateur ou un cadrage technique, sans identifiant de recette disponible).
//
// Vérifie que :
//   1. `registerFeature({ ..., fromRecette:true })` et
//      `registerRule({ ..., fromRecette:true })` marquent l'élément ÉMERGENT
//      avec origine `recette` lorsque le sprint courant est OUVERT ;
//   2. le chemin LEGACY `recetteId` (T6) est INCHANGÉ (origine `recette`) ;
//   3. la RÉTROCOMPATIBILITÉ est stricte : sans `fromRecette` ni `recetteId`,
//      une création dans un sprint OUVERT reste NON émergente (origine `null`)
//      et rattachée au sprint courant ;
//   4. la PRIORITÉ des origines est respectée : aucun sprint → `hors_sprint`,
//      dernier sprint clôturé → `apres_cloture`, même avec `fromRecette:true`.
//
// Le test s'exécute dans une base PostgreSQL DÉDIÉE et JETABLE (créée puis
// supprimée par le process parent ; les assertions tournent dans un process
// enfant pour que ses connexions soient fermées avant le DROP) : aucune donnée
// du registre réel n'est touchée.
//
// Usage : node scripts/test-emergence-recette-evaluateur.mjs
//   (ADMIN_DATABASE_URL surcharge l'URL admin ; défaut = DATABASE_URL global)
import pg from "pg";
import { spawnSync } from "node:child_process";

const ADMIN_URL =
  process.env.ADMIN_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "postgres://orchestrator:orchestrator@localhost:5432/task_registry";

const testDbName = `task_registry_emerge_${Date.now().toString(36)}_${process.pid}`;
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
  await db.listProjectSprints("emerge-test-project"); // force ensureSchema

  const ts = new Date().toISOString();
  const projectId = "emerge-test-project";
  const setup = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await setup.connect();
  await setup.query(
    "INSERT INTO projects (id, name, main_branch, created_at) VALUES ($1,$2,$3,$4)",
    [projectId, "Emergence recette test project", "main", ts],
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
  const em = (row) => ({ emergent: row.emergent, emergentOrigin: row.emergentOrigin });

  // -------------------------------------------------------------------------
  // 1. AUCUN sprint → `hors_sprint` (priorité 1), même avec fromRecette:true.
  // -------------------------------------------------------------------------
  const fNoSprint = await db.registerFeature({
    projectId, ref: "US-NOSPRINT", userStory: "sans sprint", fromRecette: true,
  });
  check("sans sprint + fromRecette → hors_sprint", em(fNoSprint), { emergent: true, emergentOrigin: "hors_sprint" });

  // -------------------------------------------------------------------------
  // 2. Sprint OUVERT : rétrocompat stricte (aucun signal → non émergent).
  // -------------------------------------------------------------------------
  await db.createSprint({
    projectId, title: "Sprint courant", startDate: ts,
    endDate: new Date(Date.now() + 7 * 86400000).toISOString(),
  });

  const fStd = await db.registerFeature({ projectId, ref: "US-STD", userStory: "création standard" });
  check("sprint ouvert, sans signal → non émergente (rétrocompat)", em(fStd), { emergent: false, emergentOrigin: null });

  const rStd = await db.registerRule({ projectId, ref: "RM-STD", content: "règle standard", roleGlobal: true });
  check("sprint ouvert, sans signal (règle) → non émergente (rétrocompat)", em(rStd), { emergent: false, emergentOrigin: null });

  // Nouveaux axes (T-20260922-100651-m6va) : NULL par défaut ⇒ rétrocompat stricte.
  check("axes devStatus/respectStatus NULL par défaut", { dev: fStd.devStatus, respect: rStd.respectStatus }, { dev: null, respect: null });

  // -------------------------------------------------------------------------
  // 3. Sprint OUVERT + `fromRecette:true` → origine `recette` (fonctionnalité).
  // -------------------------------------------------------------------------
  const fRec = await db.registerFeature({
    projectId, ref: "US-REC", userStory: "créée depuis une recette évaluateur", fromRecette: true,
  });
  check("sprint ouvert + fromRecette → fonctionnalité émergente `recette`", em(fRec), { emergent: true, emergentOrigin: "recette" });

  // -------------------------------------------------------------------------
  // 4. Sprint OUVERT + `recetteId` (chemin LEGACY T6) → origine `recette`.
  // -------------------------------------------------------------------------
  const fRecId = await db.registerFeature({
    projectId, ref: "US-RECID", userStory: "créée depuis une recette (recetteId)", recetteId: "RECT-legacy",
  });
  check("sprint ouvert + recetteId (legacy) → fonctionnalité émergente `recette`", em(fRecId), { emergent: true, emergentOrigin: "recette" });

  // -------------------------------------------------------------------------
  // 5. Sprint OUVERT + `fromRecette:true` → origine `recette` (règle métier).
  // -------------------------------------------------------------------------
  const rRec = await db.registerRule({
    projectId, ref: "RM-REC", content: "règle créée depuis une recette", roleGlobal: true, fromRecette: true,
  });
  check("sprint ouvert + fromRecette → règle émergente `recette`", em(rRec), { emergent: true, emergentOrigin: "recette" });

  // -------------------------------------------------------------------------
  // 6. Sprint OUVERT + `recetteId` (LEGACY) → origine `recette` (règle).
  // -------------------------------------------------------------------------
  const rRecId = await db.registerRule({
    projectId, ref: "RM-RECID", content: "règle créée via recetteId", roleGlobal: true, recetteId: "RECT-legacy",
  });
  check("sprint ouvert + recetteId (legacy) → règle émergente `recette`", em(rRecId), { emergent: true, emergentOrigin: "recette" });

  // -------------------------------------------------------------------------
  // 7. Dernier sprint CLÔTURÉ → `apres_cloture` (priorité 2), même fromRecette.
  // -------------------------------------------------------------------------
  const sprints = await db.listProjectSprints(projectId);
  for (const s of sprints) await db.closeSprint(s.id, { reason: "test" });

  const fClosed = await db.registerFeature({
    projectId, ref: "US-CLOSED", userStory: "après clôture", fromRecette: true,
  });
  check("sprint clôturé + fromRecette → apres_cloture (priorité)", em(fClosed), { emergent: true, emergentOrigin: "apres_cloture" });

  await setup.end();

  console.log(`\n=== Test non-régression — émergence recette évaluateur (db jetable ${testDbName}) ===`);
  for (const r of results) console.log(r);
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
    env: { ...process.env, EMERGE_RECETTE_CHILD: "1", DATABASE_URL: testConnString },
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

if (process.env.EMERGE_RECETTE_CHILD === "1") {
  childMain().catch((err) => {
    console.error("ERREUR test émergence recette (enfant) :", err?.stack || err?.message || err);
    process.exit(1);
  });
} else {
  parentMain().catch((err) => {
    console.error("ERREUR test émergence recette (parent) :", err?.stack || err?.message || err);
    process.exit(1);
  });
}
