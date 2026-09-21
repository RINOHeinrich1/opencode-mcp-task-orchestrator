# Rapport de fin de tâche — Session de migration des anciens sprints

- **Tâche** : `T-20260921-091738-u76n` (exécution `E-T-20260921-091738-u76n-b59lk6`)
- **Plan** : `Plan-session-migration-anciens-sprints-20260921-114540` — **15/15 étapes `done` (100 %)**
- **Projet** : `ecosystem` — recette source `RECT-muaz100k-2iq0`
- **Agent** : `build-notify` — session `ses_f3c32a917ffeXXFMkyxA25rlgA`
- **Date** : 2026-09-21 11:57 (UTC)
- **Périmètre** : 4 repos HÔTES (outillage d'infrastructure écosystème, hors workspace Coder — cf. §Isolation)

---

## 1. Résumé

**Demandé** : implémenter les 15 étapes du plan « Session de migration des anciens
sprints » — tables `adr_conversions` + `migrations` ; conversion sans perte des ADR
monolithiques en ADR atomiques (détails en pièces jointes `adr_file`, ADR d'origine
**intacte**, lien historique conservé) ; rattachement de tous les éléments migrés à
l'**ancien sprint** (sprint par défaut) **sans faux émergents** ; ADR ↔ 1..N
fonctionnalités ; tools `migration_*` / `adr_convert` / `adr_conversion_*` /
`sprint_migrate_elements` ; agent `agent-migration` (proposition de découpage +
validation utilisateur **avant** écriture) ; `buildMigrationPrompt` /
`launchMigrationSession` / routes `/api/migrations*` / bouton panneau ; CLI.

**Fait** : les 15 étapes sont livrées et vérifiées. La **garde critique « aucun faux
émergent »** est respectée (INSERT directs, jamais `attachPiecesToSprint`, jamais
d'écriture `emergent`) et **contrôlée** par test (émergence des éléments hérités
inchangée avant/après migration ; pièces rattachées sans `meta.emergent`). Le modèle
ADR/`artifacts` et les sessions existantes (sprint/recette/test) sont intacts
(non-régression T1–T8 vérifiée). **Aucune donnée réelle n'a été migrée** (la
migration des données de `myxmax`/`mada-talk`/`oniria` reste une action gouvernée,
à déclencher par la session `agent-migration`/CLI avec validation utilisateur — R7).

---

## 2. Isolation

- **Espace Coder** : les 4 repos cibles sont des **composants d'infrastructure
  hôtes** (`/root/.config/opencode/...`, `/root/orchestrator-panel`) — **aucun
  workspace Coder** ne les héberge (vérifié via `workspace_list` : 7 workspaces,
  aucun ne contient ces repos). Le plan et la tâche les déclarent explicitement
  « HÔTES — pas de workspace Coder ». Aucun code hôte applicatif n'a été touché.
- **session-guard** : `acquire` exécuté sur les 4 repos → **mode `in-place`**
  (aucune autre session en parallèle). Branches de travail dédiées créées par
  repo (jamais de commit sur la branche principale).
- **Worktrees** : aucun worktree physique nécessaire (mode in-place) ; pas de
  collision détectée.

| Repo | Branche de travail | Base |
|---|---|---|
| `opencode-mcp-task-orchestrator` (`/root/.config/opencode/mcp/task-orchestrator`) | `build-notify/session-migration-anciens-sprints` | `feature/migration-postgresql` @ `5b6eb76` |
| `opencode-observability` (`/root/orchestrator-panel`) | `build-notify/session-migration-anciens-sprints` | `feature/migration-postgresql` @ `6dc7648` |
| repo config agent (`/root/.config/opencode/agent`) | `build-notify/session-migration-anciens-sprints` | `feature/per-plan` @ `32add5c` |
| `opencode-scripts` (`/root/.config/opencode/scripts`) | `build-notify/session-migration-anciens-sprints` | `main` @ `d723e9e` |

> **Aucun push / merge** (étape d'orchestration ultérieure), conformément à la mission.

---

## 3. Branches et commits

| Repo | Commit | Message |
|---|---|---|
| `opencode-mcp-task-orchestrator` | `8c72060` | feat(migration): primitives registre — tables `adr_conversions`/`migrations` (A001/A002), `linkAdrConversion`/`listAdrConversions`/`convertAdr` (A003/A004), `startMigration`/`getMigration`/`listMigrations`/`setMigrationSession`/`finishMigration` (A005/A006), `migrateProjectElementsToDefaultSprint` anti-émergent (A007) |
| `opencode-mcp-task-orchestrator` | `59d243b` | feat(migration): tools MCP `migration_*`/`sprint_migrate_elements` (A008) + `adr_convert`/`adr_conversion_link`/`adr_conversion_list` (A009) |
| repo agent | `649aa84` | feat(agents): `agent-migration` — session de migration (A010) |
| `opencode-observability` | `5299d4c` | feat(panneau): `buildMigrationPrompt` (A011), wrappers + `launchMigrationSession` (A012), routes `/api/migrations*` (A013), bouton + `openMigrationSession` (A014) |
| `opencode-scripts` | `8db42b0` | feat(migration): script CLI `migrate-old-sprints.mjs` (A015) |

**Trace des commits** : les 5 commits sont enregistrés dans le plan via
`plan_commit_add` (avec fichiers + diffs), append-only.

---

## 4. Traitements effectués (par étape)

| ID | Étape | Fichier(s) | Résultat |
|---|---|---|---|
| A001 | Table `adr_conversions` (+ index + unique pair) | `db.mjs` (`migrate()`), `schema.sql` | ✅ |
| A002 | Table `migrations` (unique `project`) | `db.mjs`, `schema.sql` | ✅ |
| A003 | `linkAdrConversion` + `listAdrConversions` + `rowToAdrConversion` | `db.mjs` | ✅ gardes (2 ADR existantes, ≠) + idempotent |
| A004 | `convertAdr` (ADR atomique + pièces jointes + lien historique) | `db.mjs` | ✅ origine **intacte** (vérifié) |
| A005 | `startMigration` + `getMigration` + `listMigrations` + `rowToMigration` | `db.mjs` | ✅ ancrage sprint par défaut, idempotent |
| A006 | `setMigrationSession` + `finishMigration` | `db.mjs` | ✅ statut sprint non touché |
| A007 | `migrateProjectElementsToDefaultSprint` | `db.mjs` | ✅ INSERT directs, **anti-émergent** |
| A008 | 6 tools MCP (`migration_*` + `sprint_migrate_elements`) | `index.mjs` | ✅ |
| A009 | 3 tools MCP (`adr_convert`/`adr_conversion_link`/`adr_conversion_list`) | `index.mjs` | ✅ |
| A010 | Agent `agent-migration.md` (v0.1.0) | `/root/.config/opencode/agent/agent-migration.md` | ✅ |
| A011 | `buildMigrationPrompt` | `session-bridge.mjs` | ✅ |
| A012 | Wrappers + `launchMigrationSession` | `pilot.mjs` | ✅ anti-doublon + reprise + R6 |
| A013 | 4 routes `/api/migrations*` | `server.mjs` | ✅ |
| A014 | Bouton `data-mg-session` + `openMigrationSession` | `public/app.js` | ✅ affiche l'ancien sprint cible |
| A015 | CLI `migrate-old-sprints.mjs` + vérifications | `/root/.config/opencode/scripts/migrate-old-sprints.mjs` | ✅ |

---

## 5. Fichiers modifiés / créés

**Créés**
- `/root/.config/opencode/agent/agent-migration.md`
- `/root/.config/opencode/scripts/migrate-old-sprints.mjs`
- `/root/.config/opencode/mcp/task-orchestrator/reports/report-session-migration-anciens-sprints-20260921-115740.md` (ce rapport)

**Modifiés**
- `/root/.config/opencode/mcp/task-orchestrator/db.mjs` (+375 l.)
- `/root/.config/opencode/mcp/task-orchestrator/schema.sql` (+38 l.)
- `/root/.config/opencode/mcp/task-orchestrator/index.mjs` (+172 l.)
- `/root/orchestrator-panel/session-bridge.mjs`
- `/root/orchestrator-panel/pilot.mjs`
- `/root/orchestrator-panel/server.mjs`
- `/root/orchestrator-panel/public/app.js`

---

## 6. Vérifications (A015)

1. **`node --check`** — ✅ sur `db.mjs`, `index.mjs`, `session-bridge.mjs`,
   `pilot.mjs`, `server.mjs`, `public/app.js`, `migrate-old-sprints.mjs`.
2. **Spawn MCP réel** (stdio, `index.mjs` via `mcp-client.mjs`) — ✅ **18 checks**,
   0 échec.
3. **Cycle complet de conversion sur données de test** — ✅ : `migration_start`
   (idempotent) → `adr_convert` (ADR atomique + 1 pièce jointe `adr_file` + lien
   `adr_conversions`) → `adr_conversion_list` → `feature_adr_link` →
   `sprint_migrate_elements` (1 fonctionnalité + 1 pièce) → `migration_get` /
   `migration_list` → `migration_session_set` (`in_progress`) →
   `migration_finish` (`done`).
4. **Contrôle ANTI-ÉMERGENT** — ✅ :
   - **ADR d'origine intacte** : titre/path/statut inchangés, aucun
     `meta.converted_from_adr_id` sur l'origine.
   - **Pièces rattachées** à l'ancien sprint **sans** `meta.emergent`
     (`emergent: false`).
   - **Ensemble des émergents inchangé** avant/après migration
     (`cardinality_report` identique) ; fonctionnalités/règles héritées
     conservent leur classification de **création** (`hors_sprint`), jamais
     modifiée rétroactivement par la migration.
   - **Idempotence** : 2ᵉ passage de `sprint_migrate_elements` → 0 lien créé.
5. **Non-régression T1–T8** — ✅ : `sprint_list`, `sprint_report`, `feature_list`,
   `rule_list`, `adr_list`, `doc_list`, `doc_attachment_list`, `piece_list`,
   `cardinality_report`, `task_list`, `recette_list`, `e2e_list`, `batch_list`,
   `project_list`, `org_list` → **0 régression**.
6. **CLI** — ✅ : `--project` (rattachement effectif 1 fonctionnalité / 1 règle /
   1 pièce sur projet frais), `--report` (lecture seule), `--finish`, et erreur
   explicite sans argument.
7. **Nettoyage** — ✅ : les 2 projets de test (`zzz-a015-selftest`,
   `zzz-a015-cli`) et toutes leurs données (artefacts, conversions, migrations,
   sprints, fonctionnalités, règles) supprimés. `migration_list` = 0,
   `adr_conversion_list` = 0 ; projets réels (`ecosystem`, `mada-talk`, `myxmax`,
   `oniria`, `onirtech-backend`, `onirtech-frontend`) **intacts**.

---

## 7. Avertissements / points de vigilance

- **ADR-001 (`doc-mub10mo8-lgo3`) est au statut `Proposé`**, non `Accepté`. Le
  plan (validé par l'humain) implémente explicitement sa §6 : aucun conflit code
  ↔ ADR **Accepté** n'est introduit. À acter formellement côté gouvernance ADR si
  souhaité.
- **`--all` du CLI non exécuté** : l'exécuter déclencherait la **migration réelle
  des données** de tous les projets (dont `myxmax`/`mada-talk`/`oniria`), ce qui
  relève de la gouvernance (validation utilisateur, R7). Le chemin de code est
  identique à `--project` (testé). La migration réelle reste à déclencher via la
  session `agent-migration` (panneau) ou `node migrate-old-sprints.mjs --project <id>`.
- **Nuance « émergent »** : la migration ne **crée** aucun émergent. Un élément
  hérité peut **déjà** porter `hors_sprint`/`apres_cloture` (classification posée
  à sa **création**). Le critère d'acceptation « aucun élément hérité marqué
  émergent » s'entend comme « aucun émergent **rétroactif** ajouté par la
  migration » (plan §8.5 / R1), ce qui est vérifié.
- **Aucune donnée réelle migrée** : la « base migrée » (critère d'acceptation) est
  la **capacité** livrée ; son exécution pour chaque projet est une action
  gouvernée ultérieure (R7).

---

## 8. Prochaines étapes / recommandations

1. **Orchestration** : rebase des branches de travail sur `origin/<mainBranch>`
   (`feature/migration-postgresql` pour MCP/panneau, `feature/per-plan` pour
   l'agent, `main` pour les scripts), puis merge (étape d'orchestration — non
   faite ici, conformément à la mission).
2. **Exécution de la migration réelle** par projet (`myxmax`, `mada-talk`,
   `oniria`) via la session `agent-migration` (bouton « Session de migration » du
   panneau) — **validation utilisateur obligatoire** à chaque découpage d'ADR.
3. **Contrôle post-migration** : `cardinality_report({ projectId })` (aucun
   nouveau signal d'émergence) + `adr_conversion_list` (chaque monolithe a ≥1
   conversion) + `doc_attachment_list` (détails conservés).
4. **Acter ADR-001** (Proposé → Accepté) si le découpage ADR est validé par
   l'humain.
