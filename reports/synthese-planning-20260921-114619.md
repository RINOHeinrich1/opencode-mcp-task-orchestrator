# Synthèse de planification — `T-20260921-091738-u76n`

- **Tâche** : `T-20260921-091738-u76n` — « Session de migration des anciens sprints par projet »
- **Exécution** : `E-T-20260921-091738-u76n-b59lk6`
- **Projet** : `ecosystem` — recette source `RECT-muaz100k-2iq0` — batch `BATCH-mub1809u-06ow` (tâche 9/9)
- **Agent** : `atomic-plan` — date : 2026-09-21 11:46:19

## 1. Objectifs identifiés (Phase 0)

La demande a été analysée comme **un seul objectif cohérent** : les sous-exigences
(session de migration, rattachement à l'ancien sprint, conversion ADR atomique,
pièces jointes, lien historique, ADR ↔ fonctionnalités, tâches sans faux émergents,
agent de migration + déclenchement panneau) sont **interdépendantes** — la session
de migration **consomme** les primitives de conversion ADR (un seul plan, section
« Ordre & dépendances » explicite, conformément à la règle « objectifs dépendants =
un plan unique »).

| Objectif | Type | Plan |
|---|---|---|
| Session de migration des anciens sprints par projet (conversion ADR atomique sans perte + rattachement ancien sprint + agent + panneau) | Unique / interdépendant | `Plan-session-migration-anciens-sprints-20260921-114540` |

## 2. Plans produits

### `Plan-session-migration-anciens-sprints-20260921-114540`
- **Fichier** : `plans/Plan-session-migration-anciens-sprints-20260921-114540.md`
- **Persistance** : `plan_register` (Plan Manager, `taskId=T-20260921-091738-u76n`)
- **Artefact** : `ART-mub6j40q-6leg` (kind=plan)
- **15 étapes atomiques** réparties sur 4 repos :

| Étape | Élément de code | Fichier | Repo |
|---|---|---|---|
| A001 | table `adr_conversions` (+ miroir `schema.sql`) | `db.mjs` / `schema.sql` | opencode-mcp-task-orchestrator |
| A002 | table `migrations` (+ miroir `schema.sql`) | `db.mjs` / `schema.sql` | opencode-mcp-task-orchestrator |
| A003 | `linkAdrConversion` + `listAdrConversions` | `db.mjs` | opencode-mcp-task-orchestrator |
| A004 | `convertAdr` (ADR atomique + pièces jointes, original intact) | `db.mjs` | opencode-mcp-task-orchestrator |
| A005 | `startMigration` / `getMigration` / `listMigrations` | `db.mjs` | opencode-mcp-task-orchestrator |
| A006 | `setMigrationSession` / `finishMigration` | `db.mjs` | opencode-mcp-task-orchestrator |
| A007 | `migrateProjectElementsToDefaultSprint` (sans émergent) | `db.mjs` | opencode-mcp-task-orchestrator |
| A008 | tools `migration_*` + `sprint_migrate_elements` | `index.mjs` | opencode-mcp-task-orchestrator |
| A009 | tools `adr_convert` / `adr_conversion_link` / `adr_conversion_list` | `index.mjs` | opencode-mcp-task-orchestrator |
| A010 | agent `agent-migration` | `agent-migration.md` | `agent` (branche `feature/per-plan`) |
| A011 | `buildMigrationPrompt` | `session-bridge.mjs` | opencode-observability |
| A012 | `launchMigrationSession` + wrappers MCP | `pilot.mjs` | opencode-observability |
| A013 | routes `/api/migrations*` | `server.mjs` | opencode-observability |
| A014 | bouton `data-mg-session` + `openMigrationSession` | `public/app.js` | opencode-observability |
| A015 | CLI `migrate-old-sprints.mjs` | `migrate-old-sprints.mjs` | opencode-scripts |

- **Couverture** : table Exigence → Étape complète (100 % des exigences de la mission et des critères d'acceptation couvertes).

## 3. Vérifications de cohérence

### Intra-plan (Phases 6–7) — **Valid**
- Aucune action contradictoire (aucun `supprimer`/`renommer`/`déplacer`).
- Ordre des dépendances respecté (aucune étape ne lit un élément créé plus tard).
- Chaque étape cible **un** élément dans **un** fichier.
- **Garantie « pas de faux émergents »** : A007 utilise des `INSERT ... ON CONFLICT DO NOTHING` directs ; interdiction d'appeler `attachPiecesToSprint` (écrit `meta.emergent`) et d'écrire `emergent`/`emergent_origin` sur `fonctionnalites`/`regles_metier`/`tasks` ; aucun appel à `classifyEmergence` dans un chemin de migration.
- **Garantie « sans perte »** : A004 crée une **nouvelle** ADR (`registerAdr`) sans réécrire `doc_type`/`content_id`/`path`/`meta` de l'original ; le lien historique passe par `adr_conversions`.
- Non-régression : A006 calque `setSprintSession`, A013 calque les routes sprints ; aucune fonction/route existante modifiée.

### Globale (Phase 9) — **Aucune incohérence inter-plans**
Plan unique pour cette tâche. Les tâches du batch T1–T8 sont terminées et mergées
(`5b6eb76` MCP, `6dc7648` panneau, `512d1b6` agent) ; aucun conflit de scope ou
d'action détecté.

## 4. E2E (cadrage 08) — **NA**
Tâche d'outillage interne (registre MCP + panneau de pilotage + agent) : aucun
comportement utilisateur observable couvert par un spec Playwright. Vérifié :
`e2e_list({ project: "ecosystem" })` → 0 test. Aucun test E2E créé ni lié.

## 5. Traçabilité
- `task_event(T-20260921-091738-u76n, PLANNING_STARTED, by=atomic-plan)`
- `plan_register(taskId=T-20260921-091738-u76n, planId=Plan-session-migration-anciens-sprints-20260921-114540)`
- `task_event(T-20260921-091738-u76n, PLAN_CREATED, detail={planId, planFile})`
- `artifact_add(taskId=T-20260921-091738-u76n, kind=plan, title=Plan-session-migration-anciens-sprints-20260921-114540)`
- `participant_add(T-20260921-091738-u76n, atomic-plan, planner)`

## 6. Points d'attention pour l'exécution
- **Ordre inter-repos** : livrer `opencode-mcp-task-orchestrator` (A001–A009) avant `opencode-observability` (A011–A014) et `opencode-scripts` (A015) ; `agent-migration.md` (A010) après A009.
- **Branches dédiées par repo** (norme d'isolation v1.0) : jamais de modification directe de la branche principale.
- **Exécution de la migration des données** (`myxmax` 14/09/2026, `mada-talk` 07/09/2026, `oniria`) : via la session `agent-migration` (validation utilisateur obligatoire à chaque découpage ADR) et/ou le CLI A015 — non autonome par construction (gouvernance ADR).
