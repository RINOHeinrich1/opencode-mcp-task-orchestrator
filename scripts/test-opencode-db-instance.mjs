#!/usr/bin/env node
// Test de non-régression — résolution de la base opencode PAR INSTANCE pour
// `findTaskBySessionChain` (recette évaluateur item 31 / ADR-007).
//
// Contexte du bug : `findTaskBySessionChain` (db.mjs) ouvrait la base opencode
// `process.env.OPENCODE_DB || ~/.local/share/opencode/opencode.db` — soit
// TOUJOURS celle de l'instance PRINCIPALE — alors que chaque instance dédiée a
// la sienne sous `$XDG_DATA_HOME/opencode/opencode.db`. La chaîne parent n'était
// donc jamais résolue hors instance principale (aucune décision de permission
// écrite, donc aucun email).
//
// Deux volets :
//   1. `opencodeDbPathCandidates()` : priorité OPENCODE_DB > $XDG_DATA_HOME/
//      opencode/opencode.db > ~/.local/share/opencode/opencode.db, dédupliquée,
//      entrées non définies omises.
//   2. Bout-en-bout : une tâche est liée à la session PARENT ; une base SQLite
//      temporaire `<tmp>/opencode/opencode.db` porte la chaîne parent_id ; avec
//      `XDG_DATA_HOME=<tmp>`, `findTaskBySessionChain(<enfant>)` DOIT retourner
//      la tâche — prouvant que la base de l'instance EFFECTIVE est utilisée.
//
// Le volet 2 s'exécute dans une base PostgreSQL DÉDIÉE et JETABLE (créée puis
// supprimée par le process parent) + un SQLite temporaire sous /tmp : aucune
// donnée du registre réel n'est lue ni écrite.
//
// Usage : node scripts/test-opencode-db-instance.mjs
//   (ADMIN_DATABASE_URL surcharge l'URL admin ; défaut = DATABASE_URL global)
import pg from "pg";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const ADMIN_URL =
  process.env.ADMIN_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "postgres://orchestrator:orchestrator@localhost:5432/task_registry";

const testDbName = `task_registry_opencodedb_${Date.now().toString(36)}_${process.pid}`;
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
  const results = [];
  let failures = 0;
  function check(name, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    const ok = a === e;
    if (!ok) failures += 1;
    results.push(
      `${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n        attendu: ${e}\n        obtenu : ${a}`}`,
    );
  }

  const xdgDir = process.env.INC_DB_INSTANCE_XDG;
  const xdgDb = join(xdgDir, "opencode", "opencode.db");
  const fallback = join(homedir(), ".local", "share", "opencode", "opencode.db");
  const custom = join(xdgDir, "custom-opencode.db");

  // --- Volet 1 : priorités de opencodeDbPathCandidates() -------------------
  process.env.OPENCODE_DB = custom;
  process.env.XDG_DATA_HOME = xdgDir;
  check("OPENCODE_DB prioritaire", db.opencodeDbPathCandidates()[0], custom);
  check("ordre OPENCODE_DB > XDG > fallback", db.opencodeDbPathCandidates(), [
    custom,
    xdgDb,
    fallback,
  ]);

  delete process.env.OPENCODE_DB;
  check(
    "sans OPENCODE_DB → $XDG_DATA_HOME/opencode/opencode.db en tête",
    db.opencodeDbPathCandidates()[0],
    xdgDb,
  );

  delete process.env.XDG_DATA_HOME;
  check("sans OPENCODE_DB ni XDG → fallback ~/.local/share uniquement", db.opencodeDbPathCandidates(), [
    fallback,
  ]);

  process.env.OPENCODE_DB = xdgDb;
  process.env.XDG_DATA_HOME = xdgDir;
  check("déduplication (OPENCODE_DB == XDG)", db.opencodeDbPathCandidates(), [xdgDb, fallback]);

  // --- Volet 2 : bout-en-bout instance effective (XDG_DATA_HOME) ------------
  // Instance EFFECTIVE = xdgDir (aucun OPENCODE_DB positionné).
  delete process.env.OPENCODE_DB;
  process.env.XDG_DATA_HOME = xdgDir;

  await db.listTasks({}); // force ensureSchema dans la base jetable

  const parentSession = `ses_test_parent_${Date.now()}`;
  const childSession = `ses_test_child_${Date.now()}`;
  const taskId = `T-test-opencodedb-${Date.now().toString(36)}`;

  const setup = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await setup.connect();
  await setup.query(
    "INSERT INTO tasks (id, request, project, created_at, title, session_id) VALUES ($1,$2,$3,$4,$5,$6)",
    [
      taskId,
      "test résolution base opencode par instance",
      "ecosystem-test",
      new Date().toISOString(),
      "test opencode db instance",
      parentSession,
    ],
  );
  await setup.end();

  // Base opencode de l'instance EFFECTIVE : table session(id, parent_id).
  mkdirSync(join(xdgDir, "opencode"), { recursive: true });
  const odb = new Database(xdgDb);
  odb.exec("CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT)");
  odb.prepare("INSERT INTO session (id, parent_id) VALUES (?, ?)").run(childSession, parentSession);
  odb.close();

  const found = await db.findTaskBySessionChain(childSession);
  check(
    "bout-en-bout : chaîne enfant→parent résolue via $XDG_DATA_HOME (instance effective)",
    found?.id ?? null,
    taskId,
  );

  // Non-régression : sans XDG_DATA_HOME, on retombe sur l'instance principale,
  // qui ne contient PAS ces sessions → chaîne non résolue (comportement historique).
  delete process.env.XDG_DATA_HOME;
  const notFound = await db.findTaskBySessionChain(childSession);
  check("non-régression : sans XDG_DATA_HOME, l'instance principale ne résout pas la chaîne", notFound, null);

  console.log(`\n=== Test non-régression base opencode par instance (db jetable ${testDbName}) ===`);
  for (const r of results) console.log(r);
  console.log(
    `\n${failures === 0 ? "OK" : "ÉCHEC"} — ${results.length - failures}/${results.length} assertions passées`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Mode PARENT : crée la base jetable + le tmp XDG, lance l'enfant, nettoie.
// ---------------------------------------------------------------------------
async function parentMain() {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${testDbName}`);
  await admin.end();

  const xdgDir = mkdtempSync(join(tmpdir(), "opencode-db-instance-"));
  let status = 1;
  try {
    const res = spawnSync(process.execPath, [new URL(import.meta.url).pathname], {
      env: {
        ...process.env,
        INC_DB_INSTANCE_CHILD: "1",
        DATABASE_URL: testConnString,
        INC_DB_INSTANCE_XDG: xdgDir,
      },
      stdio: "inherit",
    });
    status = res.status ?? 1;
  } finally {
    rmSync(xdgDir, { recursive: true, force: true });
    const cleanup = new pg.Client({ connectionString: ADMIN_URL });
    await cleanup.connect();
    await cleanup.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [testDbName],
    );
    await cleanup.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`);
    await cleanup.end();
  }

  process.exit(status === 0 ? 0 : 1);
}

if (process.env.INC_DB_INSTANCE_CHILD === "1") {
  childMain().catch((err) => {
    console.error("ERREUR test base opencode par instance (enfant) :", err?.stack || err?.message || err);
    process.exit(1);
  });
} else {
  parentMain().catch((err) => {
    console.error("ERREUR test base opencode par instance (parent) :", err?.stack || err?.message || err);
    process.exit(1);
  });
}
