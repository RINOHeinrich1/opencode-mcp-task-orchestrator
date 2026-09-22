#!/usr/bin/env node
// Test de non-régression — STATUTS des FONCTIONNALITÉS (Intégration / Tests E2E
// / Statut de développement) et des RÈGLES MÉTIER (statut de RESPECT)
// (T-20260922-100651-m6va).
//
// Vérifie que :
//   1. le STATUT DE DÉVELOPPEMENT d'une fonctionnalité est posé/validé/effacé :
//      `markFeatureDevStatus` + `updateFeature` (statut + source + note + trace) ;
//   2. la SOURCE est OBLIGATOIRE pour poser un statut (jamais de statut orphelin)
//      et les vocabulaires sont validés strictement (devStatus/devStatusSource) ;
//   3. le STATUT DE RESPECT d'une règle est posé/validé/effacé (axe DISTINCT) ;
//   4. la RÉTROCOMPATIBILITÉ est STRICTE : `implemented`/`implementedOrigin`
//      (axe Intégration) et l'émergence restent INCHANGÉS ; les deux axes sont
//      indépendants (poser l'un n'écrit pas l'autre) ;
//   5. `listFeatures` expose `devStatus` + `gherkinTests` (liens E2E 1..N, bulk,
//      0 N+1) et `getFeature` expose `evaluationVerdicts` (lecture seule).
//
// Le test s'exécute dans une base PostgreSQL DÉDIÉE et JETABLE (créée puis
// supprimée par le process parent ; les assertions tournent dans un process
// enfant pour que ses connexions soient fermées avant le DROP) : aucune donnée
// du registre réel n'est touchée.
//
// Usage : node scripts/test-feature-rule-statuses.mjs
//   (ADMIN_DATABASE_URL surcharge l'URL admin ; défaut = DATABASE_URL global)
import pg from "pg";
import { spawnSync } from "node:child_process";

const ADMIN_URL =
  process.env.ADMIN_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "postgres://orchestrator:orchestrator@localhost:5432/task_registry";

const testDbName = `task_registry_statuses_${Date.now().toString(36)}_${process.pid}`;
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
  await db.listProjectSprints("statuses-test"); // force ensureSchema

  const projectId = "statuses-test-project";
  const ts = new Date().toISOString();
  const setup = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await setup.connect();
  await setup.query(
    "INSERT INTO projects (id, name, main_branch, created_at) VALUES ($1,$2,$3,$4)",
    [projectId, "Statuts FR/RM test project", "main", ts],
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
  const asyncThrows = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };

  // -------------------------------------------------------------------------
  // 1. État initial : statuts NULL (aucune donnée altérée).
  // -------------------------------------------------------------------------
  const f = await db.registerFeature({ projectId, ref: "US-1", userStory: "comportement" });
  check("fonctionnalité neuve → devStatus NULL", { s: f.devStatus, src: f.devStatusSource, at: f.devStatusAt }, { s: null, src: null, at: null });

  // -------------------------------------------------------------------------
  // 2. POSE du statut de développement (complet / analyse_code) + traçabilité.
  // -------------------------------------------------------------------------
  const f1 = await db.markFeatureDevStatus({ featureId: f.id, devStatus: "complet", source: "analyse_code", note: "revue code", by: "agent-code" });
  check("markFeatureDevStatus → complet/analyse_code + trace", {
    s: f1.devStatus, src: f1.devStatusSource, note: f1.devStatusNote, by: f1.devStatusBy, at: !!f1.devStatusAt,
  }, { s: "complet", src: "analyse_code", note: "revue code", by: "agent-code", at: true });

  // -------------------------------------------------------------------------
  // 3. MISE À JOUR via updateFeature (statut + source) ; note seule conserve.
  // -------------------------------------------------------------------------
  const f2 = await db.updateFeature({ featureId: f.id, devStatus: "partiel", devStatusSource: "evaluateur" });
  check("updateFeature → partiel/evaluateur", { s: f2.devStatus, src: f2.devStatusSource }, { s: "partiel", src: "evaluateur" });
  const f2b = await db.updateFeature({ featureId: f.id, devStatusNote: "note seule" });
  check("note seule → statut conservé", { s: f2b.devStatus, n: f2b.devStatusNote }, { s: "partiel", n: "note seule" });

  // -------------------------------------------------------------------------
  // 4. VALIDATIONS strictes : statut/source invalides, source manquante.
  // -------------------------------------------------------------------------
  const e1 = await asyncThrows(() => db.markFeatureDevStatus({ featureId: f.id, devStatus: "bogus", source: "agent" }));
  check("devStatus invalide → erreur", !!e1 && /devStatus/.test(e1), true);
  const e2 = await asyncThrows(() => db.markFeatureDevStatus({ featureId: f.id, devStatus: "complet" }));
  check("source manquante → erreur (statut orphelin interdit)", !!e2 && /source requise/.test(e2), true);
  const e3 = await asyncThrows(() => db.updateFeature({ featureId: f.id, devStatus: "complet", devStatusSource: "nope" }));
  check("devStatusSource invalide → erreur", !!e3 && /devStatusSource invalide/.test(e3), true);

  // -------------------------------------------------------------------------
  // 5. DÉQUALIFICATION (statut vide) → reset complet.
  // -------------------------------------------------------------------------
  const f3 = await db.updateFeature({ featureId: f.id, devStatus: "" });
  check("déqualification → reset des 5 champs", { s: f3.devStatus, src: f3.devStatusSource, n: f3.devStatusNote, at: f3.devStatusAt, by: f3.devStatusBy }, { s: null, src: null, n: null, at: null, by: null });

  // -------------------------------------------------------------------------
  // 6. RÉTROCOMPATIBILITÉ : `implemented` (axe Intégration) indépendant du dev.
  // -------------------------------------------------------------------------
  const f4 = await db.markFeatureImplemented({ featureId: f.id, origin: "hors_ecosystem" });
  check("implemented intact, devStatus non touché", { impl: f4.implemented, org: f4.implementedOrigin, dev: f4.devStatus }, { impl: true, org: "hors_ecosystem", dev: null });
  const f5 = await db.markFeatureDevStatus({ featureId: f.id, devStatus: "incoherent", source: "evaluateur" });
  check("devStatus posé, implemented non touché", { dev: f5.devStatus, impl: f5.implemented, org: f5.implementedOrigin }, { dev: "incoherent", impl: true, org: "hors_ecosystem" });

  // -------------------------------------------------------------------------
  // 7. RÈGLE MÉTIER — statut de RESPECT (axe distinct du développement).
  // -------------------------------------------------------------------------
  const r = await db.registerRule({ projectId, ref: "RM-1", content: "règle", roleGlobal: true });
  check("règle neuve → respectStatus NULL", { s: r.respectStatus, at: r.respectStatusAt }, { s: null, at: null });
  const r1 = await db.markRuleRespectStatus({ ruleId: r.id, respectStatus: "respectee", note: "ok", by: "agent" });
  check("markRuleRespectStatus → respectee + trace", { s: r1.respectStatus, n: r1.respectStatusNote, by: r1.respectStatusBy, at: !!r1.respectStatusAt }, { s: "respectee", n: "ok", by: "agent", at: true });
  const r2 = await db.updateRule({ ruleId: r.id, respectStatus: "non_respectee", respectStatusNote: "écart constaté" });
  check("updateRule → non_respectee + note", { s: r2.respectStatus, n: r2.respectStatusNote }, { s: "non_respectee", n: "écart constaté" });
  const e4 = await asyncThrows(() => db.markRuleRespectStatus({ ruleId: r.id, respectStatus: "bogus" }));
  check("respectStatus invalide → erreur", !!e4 && /respectStatus requis/.test(e4), true);
  const r3 = await db.updateRule({ ruleId: r.id, respectStatus: "" });
  check("déqualification respect → reset", { s: r3.respectStatus, n: r3.respectStatusNote, at: r3.respectStatusAt }, { s: null, n: null, at: null });

  // -------------------------------------------------------------------------
  // 8. LISTE : exposition additive `devStatus` + `gherkinTests` (liens E2E 1..N).
  // -------------------------------------------------------------------------
  const e2e = await db.upsertE2ETest({ project: projectId, specFile: "tests/e2e/statut.spec.ts", scenario: "vérifie le statut", title: "Statut" });
  await db.linkFeatureGherkin({ featureId: f.id, e2eTestId: e2e.id });
  const list = await db.listFeatures({ projectId });
  const row = list.find((x) => x.id === f.id);
  check("listFeatures expose devStatus", "devStatus" in row, true);
  check("listFeatures expose gherkinTests (id+titre+statut)", row.gherkinTests, [{ e2eTestId: e2e.id, title: "Statut", status: "ACTIVE" }]);
  check("links.gherkin inchangé (compteur)", row.links.gherkin, 1);
  const rules = await db.listRules({ projectId });
  const rrow = rules.find((x) => x.id === r.id);
  check("listRules expose respectStatus", "respectStatus" in rrow, true);

  // -------------------------------------------------------------------------
  // 9. DÉTAIL : `evaluationVerdicts` exposé (lecture seule), sans fusion.
  // -------------------------------------------------------------------------
  const gf = await db.getFeature(f.id);
  check("getFeature expose evaluationVerdicts []", Array.isArray(gf.evaluationVerdicts), true);
  const gr = await db.getRule(r.id);
  check("getRule expose respectStatus", "respectStatus" in gr, true);

  await setup.end();

  console.log(`\n=== Test non-régression — statuts fonctionnalités/règles (db jetable ${testDbName}) ===`);
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
    env: { ...process.env, STATUSES_CHILD: "1", DATABASE_URL: testConnString },
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

if (process.env.STATUSES_CHILD === "1") {
  childMain().catch((err) => {
    console.error("ERREUR test statuts FR/RM (enfant) :", err?.stack || err?.message || err);
    process.exit(1);
  });
} else {
  parentMain().catch((err) => {
    console.error("ERREUR test statuts FR/RM (parent) :", err?.stack || err?.message || err);
    process.exit(1);
  });
}
