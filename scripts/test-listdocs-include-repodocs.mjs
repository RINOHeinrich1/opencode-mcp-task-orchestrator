#!/usr/bin/env node
// Test de non-régression — INC-011 : précédence SQL dans `listDocs` (branche
// `includeRepoDocs`). Le filtre `status` (et tout `conds`) doit s'appliquer aux
// docs du PROJET comme à ceux des repos du projet.
//
// Contexte du bug : la clause était
//   WHERE d.artifact_id IN (docs projet) OR d.artifact_id IN (docs repos)
//     AND d.status = $n
// `AND` primant sur `OR`, le filtre ne s'appliquait qu'à la 2e branche.
// Correctif : parenthéser l'expression `OR` → `WHERE ( ... OR ... ) AND ...`.
//
// Le test s'exécute dans une base PostgreSQL DÉDIÉE et JETABLE (créée puis
// supprimée par le process parent ; les assertions tournent dans un process
// enfant pour que ses connexions soient fermées avant le DROP) : aucune donnée
// du registre réel n'est touchée.
//
// Usage : node scripts/test-listdocs-include-repodocs.mjs
//   (ADMIN_DATABASE_URL surcharge l'URL admin ; défaut = DATABASE_URL global)
import pg from "pg";
import { spawnSync } from "node:child_process";

const ADMIN_URL =
  process.env.ADMIN_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "postgres://orchestrator:orchestrator@localhost:5432/task_registry";

const testDbName = `task_registry_inc011_${Date.now().toString(36)}_${process.pid}`;
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
  await db.listDocs({}); // force ensureSchema dans la base jetable

  const ts = new Date().toISOString();
  const projectId = "inc011test-project";
  const repoId = "inc011test-repo";
  const otherRepoId = "inc011test-repo-other";

  // Jeu de données isolé : 1 projet, 2 repos liés au projet.
  const setup = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await setup.connect();
  await setup.query(
    "INSERT INTO projects (id, name, main_branch, created_at) VALUES ($1,$2,$3,$4)",
    [projectId, "INC-011 test project", "main", ts],
  );
  await setup.query(
    "INSERT INTO repos (id, name, created_at) VALUES ($1,$2,$3), ($4,$5,$6)",
    [repoId, "INC-011 test repo", ts, otherRepoId, "INC-011 other repo", ts],
  );
  await setup.query(
    "INSERT INTO project_repos (project_id, repo_id) VALUES ($1,$2), ($1,$3)",
    [projectId, repoId, otherRepoId],
  );

  // Docs :
  //  - projAccepte : rattaché au PROJET, statut Accepté  (exposait le bug)
  //  - projPropose : rattaché au PROJET, statut Proposé
  //  - repoPropose : rattaché au REPO,   statut Proposé
  //  - repoAccepte : rattaché au REPO,   statut Accepté
  const projAccepte = await db.registerDoc({
    kind: "adr-tech", title: "INC011 proj accepte", path: "docs/inc011-proj-accepte.md",
    projectId, status: "Accepté",
  });
  const projPropose = await db.registerDoc({
    kind: "adr-tech", title: "INC011 proj propose", path: "docs/inc011-proj-propose.md",
    projectId, status: "Proposé",
  });
  const repoPropose = await db.registerDoc({
    kind: "adr-tech", title: "INC011 repo propose", path: "docs/inc011-repo-propose.md",
    repoIds: [repoId], status: "Proposé",
  });
  const repoAccepte = await db.registerDoc({
    kind: "adr-tech", title: "INC011 repo accepte", path: "docs/inc011-repo-accepte.md",
    repoIds: [repoId], status: "Accepté",
  });

  const results = [];
  let failures = 0;
  const ids = (rows) => rows.map((r) => r.docId ?? r.id).sort();
  function check(name, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    const ok = a === e;
    if (!ok) failures += 1;
    results.push(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n        attendu: ${e}\n        obtenu : ${a}`}`);
  }

  // VÉRIFICATION CŒUR DU BUG — includeRepoDocs + status : le filtre doit
  // s'appliquer aux DEUX branches (docs du projet ET docs des repos).
  const accepte = await db.listDocs({ projectId, includeRepoDocs: true, status: "Accepté" });
  check(
    "includeRepoDocs + status=Accepté → projet ET repos filtrés",
    ids(accepte),
    ids([projAccepte, repoAccepte]),
  );
  const propose = await db.listDocs({ projectId, includeRepoDocs: true, status: "Proposé" });
  check(
    "includeRepoDocs + status=Proposé → projet ET repos filtrés",
    ids(propose),
    ids([projPropose, repoPropose]),
  );

  // RÉTROCOMPAT — includeRepoDocs SANS status : inchangé (les 4 docs).
  const sansStatus = await db.listDocs({ projectId, includeRepoDocs: true });
  check(
    "includeRepoDocs sans status → tous les docs projet + repos (inchangé)",
    ids(sansStatus),
    ids([projAccepte, projPropose, repoPropose, repoAccepte]),
  );

  // RÉTROCOMPAT — autres branches non touchées par le correctif.
  const projetSeul = await db.listDocs({ projectId });
  check("projectId seul (else) → docs du projet uniquement", ids(projetSeul), ids([projAccepte, projPropose]));

  const projetSeulStatus = await db.listDocs({ projectId, status: "Accepté" });
  check("projectId seul + status → filtré", ids(projetSeulStatus), ids([projAccepte]));

  const parRepo = await db.listDocs({ repoId });
  check("repoId seul → docs du repo uniquement", ids(parRepo), ids([repoPropose, repoAccepte]));

  const parRepoStatus = await db.listDocs({ repoId, status: "Accepté" });
  check("repoId seul + status → filtré", ids(parRepoStatus), ids([repoAccepte]));

  // Branche globale (sans filtre projet/repo) : inchangée.
  const global = await db.listDocs({});
  const globalIds = ids(global);
  check(
    "global (sans filtre) → les 4 docs présents",
    [projAccepte, projPropose, repoPropose, repoAccepte].every((d) => globalIds.includes(d.docId)),
    true,
  );

  await setup.end();

  console.log(`\n=== Test non-régression INC-011 (db jetable ${testDbName}) ===`);
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
    env: { ...process.env, INC011_CHILD: "1", DATABASE_URL: testConnString },
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

if (process.env.INC011_CHILD === "1") {
  childMain().catch((err) => {
    console.error("ERREUR test INC-011 (enfant) :", err?.stack || err?.message || err);
    process.exit(1);
  });
} else {
  parentMain().catch((err) => {
    console.error("ERREUR test INC-011 (parent) :", err?.stack || err?.message || err);
    process.exit(1);
  });
}
